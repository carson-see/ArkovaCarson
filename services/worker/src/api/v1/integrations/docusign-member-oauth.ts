/**
 * SCRUM-2044 — Member-level DocuSign OAuth API.
 *
 * Mirrors the org-level router (docusign-oauth.ts) but:
 *   - Requires org membership (any role), not admin.
 *   - Writes to `member_integrations` instead of `org_integrations`.
 *   - State payload includes `scope: 'member'`.
 *   - Audit events use member-specific event types.
 *   - Secret Manager naming uses member-level convention.
 *
 * Endpoints:
 *   POST /docusign/member/oauth/start
 *   GET  /docusign/member/oauth/callback
 *   POST /docusign/member/disconnect
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../../../config.js';
import { logger } from '../../../utils/logger.js';
import { db as defaultDb } from '../../../utils/db.js';
import {
  buildDocusignAuthorizationUrl,
  exchangeDocusignCode,
  getDocusignUserInfo,
  provisionConnectListener,
  type DocusignClientDeps,
} from '../../../integrations/oauth/docusign.js';
import {
  createDefaultKmsClient,
  encryptTokens,
  type KmsClient,
} from '../../../integrations/oauth/crypto.js';
import {
  buildDocusignMemberRefreshTokenSecretName,
  createGcpSecretManagerRefreshTokenStore,
  resolveDocusignSecretManagerProjectId,
  type DocusignRefreshTokenStore,
} from '../../../integrations/connectors/docusign-token-store.js';
import { resolveIntegrationStateSecret, createLazyOAuthRouter } from './oauth-state.js';
import { getCallerOrgId } from '../../_org-auth.js';

const Provider = 'docusign' as const;
const StateTtlMs = 10 * 60 * 1000;
const StartSchema = z.object({
  org_id: z.string().uuid(),
  return_to: z.string().url().optional(),
});

/* ------------------------------------------------------------------ */
/*  Minimal DB abstractions (same pattern as org-level router)        */
/* ------------------------------------------------------------------ */

interface DbQueryResult<T> {
  data: T | null;
  error: unknown;
}

interface DbFilterQuery<T> extends PromiseLike<DbQueryResult<T>> {
  select(columns?: string): DbFilterQuery<T>;
  eq(field: string, value: unknown): DbFilterQuery<T>;
  is(field: string, value: unknown): DbFilterQuery<T>;
  single(): Promise<DbQueryResult<T extends Array<infer Row> ? Row : T>>;
  maybeSingle(): Promise<DbQueryResult<T extends Array<infer Row> ? Row : T>>;
}

interface MemberIntegrationIdRow { id: string }
interface MemberIntegrationLookupRow { id: string; token_secret_name: string | null }
interface OrgMemberRoleRow { role: string }

interface MemberIntegrationUpsert {
  user_id: string;
  org_id: string;
  provider: string;
  account_id: string;
  account_label: string | null;
  base_uri: string;
  encrypted_tokens: string;
  token_kms_key_id: string;
  token_secret_name: string;
  scope: string | null;
  connected_at: string;
  revoked_at: null;
  updated_at: string;
}

interface IntegrationEventInsert {
  org_id: string;
  integration_id: string | null;
  provider: string;
  event_type: string;
  status: string;
  details: Record<string, unknown>;
}

interface AuditEventInsert {
  event_type: string;
  event_category: string;
  actor_id: string;
  org_id: string;
  target_type: string;
  target_id: string | null;
  details: string;
}

interface DbTableQuery<T> {
  select(columns?: string): DbFilterQuery<T>;
  update(value: Record<string, unknown>): DbFilterQuery<MemberIntegrationIdRow[]>;
  insert(value: IntegrationEventInsert | AuditEventInsert | MemberIntegrationUpsert): DbFilterQuery<MemberIntegrationIdRow>;
}

interface DbClient {
  from(table: 'org_members'): DbTableQuery<OrgMemberRoleRow>;
  from(table: 'member_integrations'): DbTableQuery<MemberIntegrationLookupRow[]>;
  from(table: 'integration_events'): DbTableQuery<unknown>;
  from(table: 'audit_events'): DbTableQuery<unknown>;
}

/* ------------------------------------------------------------------ */
/*  Dependency injection                                               */
/* ------------------------------------------------------------------ */

export interface DocusignMemberOAuthDeps {
  db?: DbClient;
  env?: NodeJS.ProcessEnv;
  kms?: KmsClient;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  stateSecret?: string;
  frontendUrl?: string;
  refreshTokenStore?: DocusignRefreshTokenStore;
}

interface MemberStatePayload {
  orgId: string;
  userId: string;
  scope: 'member';
  nonce: string;
  returnTo: string;
  iat: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers (mirror org-level patterns)                                */
/* ------------------------------------------------------------------ */

function getUserId(req: Request): string | undefined {
  return (req as unknown as { userId?: string }).userId;
}

function base64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function hmacSign(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function signState(payload: MemberStatePayload, secret: string): string {
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${hmacSign(encoded, secret)}`;
}

function verifyState(state: string, secret: string, deps: DocusignMemberOAuthDeps): MemberStatePayload | null {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return null;

  const expected = hmacSign(encoded, secret);
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    sigBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as MemberStatePayload;
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    if (!parsed.orgId || !parsed.userId || !parsed.iat || parsed.scope !== 'member' || nowMs - parsed.iat > StateTtlMs) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getRequestBaseUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? req.protocol;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return `${proto}://${host}`;
}

function buildRedirectUri(req: Request): string {
  return `${getRequestBaseUrl(req)}/api/v1/integrations/docusign/member/oauth/callback`;
}

function sanitizeReturnTo(returnTo: string | undefined, orgId: string, deps: DocusignMemberOAuthDeps): string {
  const fallback = `${deps.frontendUrl ?? config.frontendUrl}/organizations/${orgId}?tab=settings`;
  if (!returnTo) return fallback;
  try {
    const parsed = new URL(returnTo);
    const frontendOrigin = new URL(deps.frontendUrl ?? config.frontendUrl).origin;
    if (parsed.origin !== frontendOrigin) return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function appendResult(url: string, key: 'docusign' | 'docusign_error', value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('tab', 'settings');
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

function toPostgresBytea(buffer: Buffer): string {
  return `\\x${buffer.toString('hex')}`;
}

async function requireOrgMember(db: DbClient, userId: string, orgId: string): Promise<boolean> {
  // Owner-inclusive resolution. An org OWNER is linked via `profiles.org_id`
  // and is NOT guaranteed to have an `org_members` row, so a direct
  // `org_members` lookup 403s owners on their own org. Resolve the caller's org
  // via the canonical `getCallerOrgId` (reads `profiles.org_id`) and treat a
  // caller whose profile org matches `orgId` as a member — owners included.
  // `getCallerOrgId` fails closed (null) on a DB/operational error, preserving
  // the previous fail-closed-on-error behaviour of this gate.
  // (The `db` param is retained for signature/call-site stability; the canonical
  // resolver uses its own service_role client.)
  void db;
  const callerOrgId = await getCallerOrgId(userId);
  // Any caller whose org is `orgId` qualifies — not admin-only like org-level OAuth.
  return callerOrgId != null && callerOrgId === orgId;
}

async function recordIntegrationEvent(db: DbClient, args: {
  orgId: string;
  integrationId?: string | null;
  eventType: string;
  status: 'success' | 'warning' | 'error';
  details?: Record<string, unknown>;
}): Promise<void> {
  // eslint-disable-next-line arkova/missing-org-filter -- service_role insert with explicit org_id; no tenant-filter needed
  const { error } = await db.from('integration_events').insert({
    org_id: args.orgId,
    integration_id: args.integrationId ?? null,
    provider: Provider,
    event_type: args.eventType,
    status: args.status,
    details: args.details ?? {},
  } as IntegrationEventInsert);
  if (error) {
    logger.warn({ error, orgId: args.orgId, eventType: args.eventType }, 'DocuSign member integration event insert failed');
  }
}

/* ------------------------------------------------------------------ */
/*  Router factory                                                     */
/* ------------------------------------------------------------------ */

export function createDocusignMemberOAuthRouter(deps: DocusignMemberOAuthDeps = {}): Router {
  const router = Router();
  const db = (deps.db ?? defaultDb) as DbClient;
  // Audit H1: resolve at construction time so a misconfigured deploy fails fast.
  const stateSecret = resolveIntegrationStateSecret(deps, 'DocuSign member');

  // ─── POST /docusign/member/oauth/start ───
  router.post('/docusign/member/oauth/start', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = StartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const orgId = parsed.data.org_id;
    if (!(await requireOrgMember(db, userId, orgId))) {
      res.status(403).json({ error: 'Must be an org member to connect a personal DocuSign account' });
      return;
    }

    try {
      const returnTo = sanitizeReturnTo(parsed.data.return_to, orgId, deps);
      const redirectUri = buildRedirectUri(req);
      const state = signState({
        orgId,
        userId,
        scope: 'member',
        nonce: randomUUID(),
        returnTo,
        iat: (deps.now?.() ?? new Date()).getTime(),
      }, stateSecret);
      const authorizationUrl = buildDocusignAuthorizationUrl({
        redirectUri,
        state,
        env: deps.env,
      });

      res.json({ authorizationUrl, url: authorizationUrl });
    } catch (error) {
      logger.error({ error, orgId }, 'DocuSign member OAuth start failed');
      res.status(500).json({ error: 'Failed to start DocuSign member connection' });
    }
  });

  // ─── GET /docusign/member/oauth/callback ───
  router.get('/docusign/member/oauth/callback', async (req: Request, res: Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    const payload = verifyState(state, stateSecret, deps);
    const returnTo = payload?.returnTo ?? `${deps.frontendUrl ?? config.frontendUrl}/organizations`;

    if (!payload) {
      res.redirect(302, appendResult(returnTo, 'docusign_error', 'invalid_state'));
      return;
    }

    if (errorParam) {
      res.redirect(302, appendResult(returnTo, 'docusign_error', errorParam));
      return;
    }

    if (!code) {
      res.redirect(302, appendResult(returnTo, 'docusign_error', 'missing_code'));
      return;
    }

    if (!(await requireOrgMember(db, payload.userId, payload.orgId))) {
      res.redirect(302, appendResult(returnTo, 'docusign_error', 'not_authorized'));
      return;
    }

    try {
      const docusignDeps: DocusignClientDeps = { env: deps.env, fetchImpl: deps.fetchImpl };
      const tokens = await exchangeDocusignCode({
        code,
        redirectUri: buildRedirectUri(req),
        deps: docusignDeps,
      });
      const info = await getDocusignUserInfo({
        accessToken: tokens.access_token,
        deps: docusignDeps,
      });
      const account = info.accounts.find((candidate) => candidate.is_default) ?? info.accounts[0];
      if (!account) {
        logger.warn({ orgId: payload.orgId, userId: payload.userId }, 'DocuSign member userinfo did not include an account');
        res.redirect(302, appendResult(returnTo, 'docusign_error', 'no_account'));
        return;
      }
      if (!tokens.refresh_token) {
        logger.warn({ orgId: payload.orgId, userId: payload.userId }, 'DocuSign member token exchange did not include refresh_token');
        res.redirect(302, appendResult(returnTo, 'docusign_error', 'missing_refresh_token'));
        return;
      }

      const kms = deps.kms ?? await createDefaultKmsClient();
      const expiresAt = new Date(
        (deps.now?.() ?? new Date()).getTime() + tokens.expires_in * 1000,
      ).toISOString();
      const refreshTokenStore = deps.refreshTokenStore ?? createGcpSecretManagerRefreshTokenStore({
        env: deps.env,
        fetchImpl: deps.fetchImpl,
      });
      const tokenSecretName = buildDocusignMemberRefreshTokenSecretName({
        projectId: resolveDocusignSecretManagerProjectId(deps.env),
        userId: payload.userId,
        accountId: account.account_id,
      });
      const encrypted = await encryptTokens({
        access_token: tokens.access_token,
        token_type: tokens.token_type,
        expires_at: expiresAt,
        scope: tokens.scope,
      }, { kms, env: deps.env });
      await refreshTokenStore.put({
        name: tokenSecretName,
        value: tokens.refresh_token,
      });

      // Soft-revoke any existing active row before inserting the new one.
      // Cannot use upsert: the partial unique index (WHERE revoked_at IS NULL)
      // is not usable as a PostgREST conflict target.
      const now = (deps.now?.() ?? new Date()).toISOString();
      await db
        .from('member_integrations')
        .update({ revoked_at: now, updated_at: now })
        .eq('user_id', payload.userId)
        .eq('org_id', payload.orgId)
        .eq('provider', Provider)
        .eq('account_id', account.account_id)
        .is('revoked_at', null);

      const { data: integration, error: insertError } = await db
        .from('member_integrations')
        .insert({
          user_id: payload.userId,
          org_id: payload.orgId,
          provider: Provider,
          account_id: account.account_id,
          account_label: account.account_name ?? account.account_id ?? null,
          base_uri: account.base_uri,
          encrypted_tokens: toPostgresBytea(encrypted.ciphertext),
          token_kms_key_id: encrypted.keyId,
          token_secret_name: tokenSecretName,
          scope: tokens.scope ?? null,
          connected_at: now,
          revoked_at: null,
          updated_at: now,
        })
        .select('id')
        .single();

      if (insertError) {
        logger.error({ error: insertError, orgId: payload.orgId, userId: payload.userId }, 'DocuSign member integration insert failed');
        await refreshTokenStore.delete({ name: tokenSecretName }).catch((deleteError) => {
          logger.warn(
            { error: deleteError, orgId: payload.orgId, tokenSecretName },
            'DocuSign member refresh-token secret cleanup failed after upsert error',
          );
        });
        res.redirect(302, appendResult(returnTo, 'docusign_error', 'save_failed'));
        return;
      }

      await recordIntegrationEvent(db, {
        orgId: payload.orgId,
        integrationId: integration?.id,
        eventType: 'member_oauth_connected',
        status: 'success',
        details: {
          user_id: payload.userId,
          account_label: account.account_name ?? account.account_id ?? null,
          account_id: account.account_id,
        },
      });

      // SOC 2 CC7.2 — audit trail for member integration connect
      // eslint-disable-next-line arkova/missing-org-filter -- service_role insert with explicit org_id
      void Promise.resolve(db.from('audit_events').insert({
        event_type: 'integration.docusign_member_connected',
        event_category: 'SECURITY',
        actor_id: payload.userId,
        org_id: payload.orgId,
        target_type: 'integration',
        target_id: integration?.id ?? null,
        details: JSON.stringify({ provider: Provider, integration_id: integration?.id ?? null }),
      } as AuditEventInsert)).then(({ error: auditErr }) => {
        if (auditErr) logger.error({ error: auditErr, orgId: payload.orgId }, 'Failed to write DocuSign member connect audit event');
      }).catch(() => { /* non-fatal */ });

      // Auto-provision Connect listener on member's DocuSign account (fire-and-forget)
      void provisionConnectListener({
        accessToken: tokens.access_token,
        baseUri: account.base_uri,
        accountId: account.account_id,
        deps: docusignDeps,
      }).then(async (provisionResult) => {
        await recordIntegrationEvent(db, {
          orgId: payload.orgId,
          integrationId: integration?.id,
          eventType: 'member_connect_listener_provisioned',
          status: 'success',
          details: {
            connect_id: provisionResult.connectId,
            action: provisionResult.action,
          },
        });
      }).catch(async (provisionError) => {
        logger.error(
          { message: provisionError instanceof Error ? provisionError.message : String(provisionError), orgId: payload.orgId, userId: payload.userId },
          'DocuSign member Connect listener provisioning failed',
        );
        try {
          await recordIntegrationEvent(db, {
            orgId: payload.orgId,
            integrationId: integration?.id,
            eventType: 'member_connect_listener_failed',
            status: 'error',
            details: {
              error: provisionError instanceof Error ? provisionError.message : String(provisionError),
            },
          });
        } catch (eventError) {
          logger.warn(
            { message: eventError instanceof Error ? eventError.message : String(eventError) },
            'Failed to record member Connect provisioning failure event',
          );
        }
      });

      res.redirect(302, appendResult(returnTo, 'docusign', 'connected'));
    } catch (error) {
      logger.error(
        { orgId: payload.orgId, userId: payload.userId, errorMessage: error instanceof Error ? error.message : 'Unknown error' },
        'DocuSign member OAuth callback failed',
      );
      res.redirect(302, appendResult(returnTo, 'docusign_error', 'callback_failed'));
    }
  });

  // ─── POST /docusign/member/disconnect ───
  router.post('/docusign/member/disconnect', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = StartSchema.pick({ org_id: true }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const orgId = parsed.data.org_id;
    if (!(await requireOrgMember(db, userId, orgId))) {
      res.status(403).json({ error: 'Must be an org member to disconnect a personal DocuSign account' });
      return;
    }

    const now = (deps.now?.() ?? new Date()).toISOString();
    const { data: existing, error: existingError } = await db
      .from('member_integrations')
      .select('id, token_secret_name')
      .eq('user_id', userId)
      .eq('org_id', orgId)
      .eq('provider', Provider)
      .is('revoked_at', null);

    if (existingError) {
      logger.error({ error: existingError, orgId, userId }, 'DocuSign member disconnect lookup failed');
      res.status(500).json({ error: 'Failed to disconnect DocuSign member account' });
      return;
    }

    const existingRows = (existing ?? []) as MemberIntegrationLookupRow[];
    const tokenSecretNames = existingRows
      .map((row) => row.token_secret_name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);

    // Revoke DB row FIRST — if secret deletion later fails, the row is already
    // revoked (safe state) and secrets can be retried. The reverse (delete
    // secrets first) leaves an active-looking row with missing tokens.
    const { data, error } = await db
      .from('member_integrations')
      .update({
        revoked_at: now,
        encrypted_tokens: null,
        token_kms_key_id: null,
        token_secret_name: null,
        updated_at: now,
      })
      .eq('user_id', userId)
      .eq('org_id', orgId)
      .eq('provider', Provider)
      .is('revoked_at', null)
      .select('id');

    if (error) {
      logger.error({ error, orgId, userId }, 'DocuSign member disconnect failed');
      res.status(500).json({ error: 'Failed to disconnect DocuSign member account' });
      return;
    }

    const refreshTokenStore = deps.refreshTokenStore ?? createGcpSecretManagerRefreshTokenStore({
      env: deps.env,
      fetchImpl: deps.fetchImpl,
    });
    const deleteResults = await Promise.allSettled(
      tokenSecretNames.map((name) => refreshTokenStore.delete({ name })),
    );
    const failedTokenSecretNames = deleteResults.flatMap((result, index) =>
      result.status === 'rejected' ? [tokenSecretNames[index]] : [],
    );
    if (failedTokenSecretNames.length > 0) {
      logger.error(
        {
          orgId,
          userId,
          tokenSecretNames: failedTokenSecretNames,
          errors: deleteResults.flatMap((result) =>
            result.status === 'rejected'
              ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
              : [],
          ),
        },
        'DocuSign member refresh-token secret deletion failed during disconnect (row already revoked)',
      );
    }

    await recordIntegrationEvent(db, {
      orgId,
      integrationId: (data as MemberIntegrationIdRow[] | null)?.[0]?.id,
      eventType: 'member_oauth_disconnected',
      status: 'success',
    });

    // SOC 2 CC7.2 — audit trail for member integration disconnect
    const integrationId = (data as MemberIntegrationIdRow[] | null)?.[0]?.id ?? null;
    // eslint-disable-next-line arkova/missing-org-filter -- service_role insert with explicit org_id
    void Promise.resolve(db.from('audit_events').insert({
      event_type: 'integration.docusign_member_disconnected',
      event_category: 'SECURITY',
      actor_id: userId,
      org_id: orgId,
      target_type: 'integration',
      target_id: integrationId,
      details: JSON.stringify({ provider: Provider, integration_id: integrationId }),
    } as AuditEventInsert)).then(({ error: auditErr }) => {
      if (auditErr) logger.error({ error: auditErr, orgId }, 'Failed to write DocuSign member disconnect audit event');
    }).catch(() => { /* non-fatal */ });

    res.json({ disconnected: true });
  });

  return router;
}

// Lazy router export — defer construction (which validates
// INTEGRATION_STATE_HMAC_SECRET and throws when missing) to the first request,
// not module import. Audit H1: NEVER fall back to config.supabaseJwtSecret (the
// previous eager export hardcoded it, collapsing two trust boundaries).
export const docusignMemberOAuthRouter: Router = createLazyOAuthRouter(
  () => createDocusignMemberOAuthRouter(),
);
