/**
 * DocuSign OAuth API (SCRUM-1101)
 *
 * User-facing endpoints:
 *   POST /api/v1/integrations/docusign/oauth/start
 *   GET  /api/v1/integrations/docusign/oauth/callback
 *   POST /api/v1/integrations/docusign/disconnect
 *
 * Mirrors the Drive OAuth router (drive-oauth.ts, SCRUM-1168). Access-token
 * metadata is encrypted with the reviewed OAuth crypto helper before storage;
 * long-lived refresh tokens live in Secret Manager and Postgres stores only
 * the secret resource name. Cleartext token payloads never reach Postgres or logs.
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
  refreshDocusignAccessToken,
  type DocusignClientDeps,
} from '../../../integrations/oauth/docusign.js';
import {
  createDefaultKmsClient,
  encryptTokens,
  type KmsClient,
} from '../../../integrations/oauth/crypto.js';
import {
  buildDocusignRefreshTokenSecretName,
  createGcpSecretManagerRefreshTokenStore,
  resolveDocusignSecretManagerProjectId,
  type DocusignRefreshTokenStore,
} from '../../../integrations/connectors/docusign-token-store.js';
import type { TypeSafeDatabase } from '../../../types/database-overrides.js';

type OrgMemberRow = TypeSafeDatabase['public']['Tables']['org_members']['Row'];
type OrgIntegrationRow = TypeSafeDatabase['public']['Tables']['org_integrations']['Row'];
type OrgIntegrationInsert = TypeSafeDatabase['public']['Tables']['org_integrations']['Insert'];
type OrgIntegrationUpdate = TypeSafeDatabase['public']['Tables']['org_integrations']['Update'];
type IntegrationEventInsert = TypeSafeDatabase['public']['Tables']['integration_events']['Insert'];
type AuditEventInsert = TypeSafeDatabase['public']['Tables']['audit_events']['Insert'];
type OrganizationRow = TypeSafeDatabase['public']['Tables']['organizations']['Row'];
type OrgMemberRoleRow = Pick<OrgMemberRow, 'role'>;
type OrganizationPublicIdLookupRow = Pick<OrganizationRow, 'id'>;
type DocusignIntegrationIdRow = Pick<OrgIntegrationRow, 'id'>;
type DocusignIntegrationLookupRow = Pick<
  OrgIntegrationRow,
  'id' | 'account_id' | 'token_secret_name'
>;
type DocusignIntegrationUpsert = Pick<
  OrgIntegrationInsert,
  | 'org_id'
  | 'provider'
  | 'account_id'
  | 'account_label'
  | 'base_uri'
  | 'encrypted_tokens'
  | 'token_kms_key_id'
  | 'token_secret_name'
  | 'scope'
  | 'connected_at'
  | 'revoked_at'
  | 'updated_at'
>;

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

interface DbTableQuery<T> {
  select(columns?: string): DbFilterQuery<T>;
  update(value: OrgIntegrationUpdate): DbFilterQuery<DocusignIntegrationIdRow[]>;
  insert(value: IntegrationEventInsert): PromiseLike<DbQueryResult<unknown>>;
  upsert(value: DocusignIntegrationUpsert, options?: { onConflict?: string }): DbFilterQuery<DocusignIntegrationIdRow>;
}

interface DbAuditTableQuery {
  insert(value: AuditEventInsert): PromiseLike<DbQueryResult<unknown>>;
}

interface DbClient {
  from(table: 'org_members'): DbTableQuery<OrgMemberRoleRow>;
  from(table: 'organizations'): DbTableQuery<OrganizationPublicIdLookupRow>;
  from(table: 'org_integrations'): DbTableQuery<DocusignIntegrationLookupRow[]>;
  from(table: 'integration_events'): DbTableQuery<unknown>;
  from(table: 'audit_events'): DbAuditTableQuery;
}

interface DocusignOAuthDeps {
  db?: DbClient;
  env?: NodeJS.ProcessEnv;
  kms?: KmsClient;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  stateSecret?: string;
  frontendUrl?: string;
  refreshTokenStore?: DocusignRefreshTokenStore;
}

interface StatePayload {
  orgId: string;
  userId: string;
  nonce: string;
  returnTo: string;
  iat: number;
}

type DocusignConnectReprovisionResult = {
  integration_id: string;
  status: 'success' | 'error';
  action?: 'created' | 'updated';
  connect_id?: string;
  error?: string;
};

const Provider = 'docusign' as const;
const StateTtlMs = 10 * 60 * 1000;
const StartSchema = z.object({
  org_id: z.string().uuid(),
  return_to: z.string().url().optional(),
});
const ReprovisionSchema = z.object({
  org_public_id: z.string().trim().min(1).max(128),
});
const DocusignApiTimeoutMs = 10_000;
const MinDocusignApiTimeoutMs = 1;

function getUserId(req: Request): string | undefined {
  return (req as unknown as { userId?: string }).userId;
}

function base64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function hmac(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function getStateSecret(deps: DocusignOAuthDeps): string {
  return deps.stateSecret ?? config.supabaseJwtSecret ?? config.supabaseServiceKey;
}

function signState(payload: StatePayload, deps: DocusignOAuthDeps): string {
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded, getStateSecret(deps))}`;
}

function verifyState(state: string, deps: DocusignOAuthDeps): StatePayload | null {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return null;

  const expected = hmac(encoded, getStateSecret(deps));
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    sigBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload;
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    if (!parsed.orgId || !parsed.userId || !parsed.iat || nowMs - parsed.iat > StateTtlMs) {
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
  return `${getRequestBaseUrl(req)}/api/v1/integrations/docusign/oauth/callback`;
}

function sanitizeReturnTo(returnTo: string | undefined, orgId: string, deps: DocusignOAuthDeps): string {
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

function isVerificationApiEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  const raw = env?.ENABLE_VERIFICATION_API;
  if (raw === undefined) return config.enableVerificationApi !== false;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

function docusignApiTimeoutMs(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.DOCUSIGN_REPROVISION_TIMEOUT_MS;
  if (!raw) return DocusignApiTimeoutMs;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MinDocusignApiTimeoutMs) return DocusignApiTimeoutMs;
  return parsed;
}

async function callDocusignWithTimeout<T>(args: {
  deps: DocusignClientDeps;
  label: string;
  operation: (deps: DocusignClientDeps) => Promise<T>;
  timeoutMs?: number;
}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? DocusignApiTimeoutMs);
  const fetchImpl = args.deps.fetchImpl ?? fetch;
  try {
    return await args.operation({
      ...args.deps,
      fetchImpl: (input, init) => fetchImpl(input, { ...init, signal: controller.signal }),
    });
  } catch (error) {
    if (
      (error instanceof DOMException && error.name === 'AbortError') ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw new Error(`${args.label} timed out after ${(args.timeoutMs ?? DocusignApiTimeoutMs) / 1000}s`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requireOrgAdmin(db: DbClient, userId: string, orgId: string): Promise<boolean> {
  const { data, error } = await db
    .from('org_members')
    .select('role')
    .eq('user_id', userId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) {
    logger.error({ error, orgId }, 'DocuSign OAuth admin lookup failed');
    return false;
  }
  return data?.role === 'admin' || data?.role === 'owner';
}

async function recordIntegrationEvent(db: DbClient, args: {
  orgId: string;
  integrationId?: string | null;
  eventType: string;
  status: 'success' | 'warning' | 'error';
  details?: IntegrationEventInsert['details'];
}): Promise<void> {
  const { error } = await db.from('integration_events').insert({
    org_id: args.orgId,
    integration_id: args.integrationId ?? null,
    provider: Provider,
    event_type: args.eventType,
    status: args.status,
    details: args.details ?? {},
  });
  if (error) {
    logger.warn({ error, orgId: args.orgId, eventType: args.eventType }, 'DocuSign integration event insert failed');
  }
}

async function reprovisionDocusignConnectIntegration(args: {
  db: DbClient;
  docusignDeps: DocusignClientDeps;
  env?: NodeJS.ProcessEnv;
  integration: DocusignIntegrationLookupRow;
  kms: KmsClient;
  now: Date;
  orgId: string;
  refreshTokenStore: DocusignRefreshTokenStore;
}): Promise<DocusignConnectReprovisionResult> {
  const { db, docusignDeps, env, integration, kms, now, orgId, refreshTokenStore } = args;
  const integrationId = integration.id;

  try {
    const accountId = integration.account_id;
    const tokenSecretName = integration.token_secret_name;
    if (!accountId || !tokenSecretName) {
      throw new Error('active DocuSign integration is missing account or refresh-token secret');
    }

    const refreshToken = await refreshTokenStore.get({ name: tokenSecretName });
    if (!refreshToken) {
      throw new Error('DocuSign refresh-token secret is empty or missing');
    }

    const tokens = await callDocusignWithTimeout({
      deps: docusignDeps,
      label: 'DocuSign token refresh request',
      timeoutMs: docusignApiTimeoutMs(env),
      operation: (boundedDeps) => refreshDocusignAccessToken({
        refreshToken,
        deps: boundedDeps,
      }),
    });
    if (tokens.refresh_token) {
      await refreshTokenStore.put({
        name: tokenSecretName,
        value: tokens.refresh_token,
      });
    }

    const info = await callDocusignWithTimeout({
      deps: docusignDeps,
      label: 'DocuSign userinfo request',
      timeoutMs: docusignApiTimeoutMs(env),
      operation: (boundedDeps) => getDocusignUserInfo({
        accessToken: tokens.access_token,
        deps: boundedDeps,
      }),
    });
    const account = info.accounts.find((candidate) => candidate.account_id === accountId);
    if (!account) {
      throw new Error('DocuSign userinfo did not include the stored account');
    }

    const expiresAt = new Date(now.getTime() + tokens.expires_in * 1000).toISOString();
    const encrypted = await encryptTokens({
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      expires_at: expiresAt,
      scope: tokens.scope,
    }, { kms, env });
    const { error: updateError } = await db
      .from('org_integrations')
      .update({
        base_uri: account.base_uri,
        encrypted_tokens: toPostgresBytea(encrypted.ciphertext),
        token_kms_key_id: encrypted.keyId,
        token_secret_name: tokenSecretName,
        scope: tokens.scope ?? null,
        updated_at: now.toISOString(),
      })
      .eq('id', integrationId)
      .eq('org_id', orgId);
    if (updateError) {
      throw new Error('DocuSign integration metadata update failed');
    }

    const provisionResult = await provisionConnectListener({
      accessToken: tokens.access_token,
      baseUri: account.base_uri,
      accountId,
      deps: docusignDeps,
    });
    await recordIntegrationEvent(db, {
      orgId,
      integrationId,
      eventType: 'connect_listener_reprovisioned',
      status: 'success',
      details: {
        connect_id: provisionResult.connectId,
        action: provisionResult.action,
      },
    });
    return {
      integration_id: integrationId,
      status: 'success',
      connect_id: provisionResult.connectId,
      action: provisionResult.action,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error: message, orgId, integrationId }, 'DocuSign Connect reprovision failed');
    await recordIntegrationEvent(db, {
      orgId,
      integrationId,
      eventType: 'connect_listener_reprovision_failed',
      status: 'error',
      details: { error: message },
    });
    return { integration_id: integrationId, status: 'error', error: message };
  }
}

export function createDocusignOAuthRouter(deps: DocusignOAuthDeps = {}): Router {
  const router = Router();
  const db = (deps.db ?? defaultDb) as DbClient;

  router.post('/docusign/oauth/start', async (req: Request, res: Response) => {
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
    if (!(await requireOrgAdmin(db, userId, orgId))) {
      res.status(403).json({ error: 'Must be org admin to connect DocuSign' });
      return;
    }

    try {
      const returnTo = sanitizeReturnTo(parsed.data.return_to, orgId, deps);
      const redirectUri = buildRedirectUri(req);
      const state = signState({
        orgId,
        userId,
        nonce: randomUUID(),
        returnTo,
        iat: (deps.now?.() ?? new Date()).getTime(),
      }, deps);
      const authorizationUrl = buildDocusignAuthorizationUrl({
        redirectUri,
        state,
        env: deps.env,
      });

      res.json({ authorizationUrl, url: authorizationUrl });
    } catch (error) {
      logger.error({ error, orgId }, 'DocuSign OAuth start failed');
      res.status(500).json({ error: 'Failed to start DocuSign connection' });
    }
  });

  router.get('/docusign/oauth/callback', async (req: Request, res: Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    const payload = verifyState(state, deps);
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

    if (!(await requireOrgAdmin(db, payload.userId, payload.orgId))) {
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
        logger.warn({ orgId: payload.orgId }, 'DocuSign userinfo did not include an account');
        res.redirect(302, appendResult(returnTo, 'docusign_error', 'no_account'));
        return;
      }
      if (!tokens.refresh_token) {
        logger.warn({ orgId: payload.orgId, accountId: account.account_id }, 'DocuSign token exchange did not include refresh_token');
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
      const tokenSecretName = buildDocusignRefreshTokenSecretName({
        projectId: resolveDocusignSecretManagerProjectId(deps.env),
        orgId: payload.orgId,
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

      // SCRUM-1101 handoff: Secret Manager must be written first because
      // Postgres stores only the resulting secret resource name. If the DB
      // upsert fails, best-effort cleanup below logs any stranded secret for
      // operator handoff.
      const { data: integration, error: upsertError } = await db
        .from('org_integrations')
        .upsert({
          org_id: payload.orgId,
          provider: Provider,
          account_id: account.account_id,
          // Prefer DocuSign's account name; fall back to account_id rather
          // than user email so org-wide settings do not expose personal PII.
          account_label: account.account_name ?? account.account_id ?? null,
          base_uri: account.base_uri,
          encrypted_tokens: toPostgresBytea(encrypted.ciphertext),
          token_kms_key_id: encrypted.keyId,
          token_secret_name: tokenSecretName,
          scope: tokens.scope ?? null,
          connected_at: (deps.now?.() ?? new Date()).toISOString(),
          revoked_at: null,
          updated_at: (deps.now?.() ?? new Date()).toISOString(),
        }, { onConflict: 'org_id,provider,account_id' })
        .select('id')
        .single();

      if (upsertError) {
        logger.error({ error: upsertError, orgId: payload.orgId }, 'DocuSign integration upsert failed');
        await refreshTokenStore.delete({ name: tokenSecretName }).catch((deleteError) => {
          logger.warn(
            { error: deleteError, orgId: payload.orgId, tokenSecretName },
            'DocuSign refresh-token secret cleanup failed after upsert error',
          );
        });
        res.redirect(302, appendResult(returnTo, 'docusign_error', 'save_failed'));
        return;
      }

      await recordIntegrationEvent(db, {
        orgId: payload.orgId,
        integrationId: integration?.id,
        eventType: 'oauth_connected',
        status: 'success',
        details: {
          account_label: account.account_name ?? account.account_id ?? null,
          account_id: account.account_id,
        },
      });

      // Auto-provision Connect listener (fire-and-forget, non-fatal).
      // Don't block the redirect — user shouldn't wait for DocuSign API calls.
      void provisionConnectListener({
        accessToken: tokens.access_token,
        baseUri: account.base_uri,
        accountId: account.account_id,
        deps: docusignDeps,
      }).then(async (provisionResult) => {
        await recordIntegrationEvent(db, {
          orgId: payload.orgId,
          integrationId: integration?.id,
          eventType: 'connect_listener_provisioned',
          status: 'success',
          details: {
            connect_id: provisionResult.connectId,
            action: provisionResult.action,
          },
        });
      }).catch(async (provisionError) => {
        logger.error(
          { message: provisionError instanceof Error ? provisionError.message : String(provisionError), orgId: payload.orgId },
          'DocuSign Connect listener provisioning failed',
        );
        try {
          await recordIntegrationEvent(db, {
            orgId: payload.orgId,
            integrationId: integration?.id,
            eventType: 'connect_listener_failed',
            status: 'error',
            details: {
              error: provisionError instanceof Error ? provisionError.message : String(provisionError),
            },
          });
        } catch (eventError) {
          logger.warn(
            { message: eventError instanceof Error ? eventError.message : String(eventError) },
            'Failed to record Connect provisioning failure event',
          );
        }
      });

      res.redirect(302, appendResult(returnTo, 'docusign', 'connected'));
    } catch (error) {
      logger.error(
        { orgId: payload.orgId, errorMessage: error instanceof Error ? error.message : 'Unknown error' },
        'DocuSign OAuth callback failed',
      );
      res.redirect(302, appendResult(returnTo, 'docusign_error', 'callback_failed'));
    }
  });

  router.post('/docusign/disconnect', async (req: Request, res: Response) => {
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
    if (!(await requireOrgAdmin(db, userId, orgId))) {
      res.status(403).json({ error: 'Must be org admin to disconnect DocuSign' });
      return;
    }

    const now = (deps.now?.() ?? new Date()).toISOString();
    const { data: existing, error: existingError } = await db
      .from('org_integrations')
      .select('id, token_secret_name')
      .eq('org_id', orgId)
      .eq('provider', Provider)
      .is('revoked_at', null);

    if (existingError) {
      logger.error({ error: existingError, orgId }, 'DocuSign disconnect existing integration lookup failed');
      res.status(500).json({ error: 'Failed to disconnect DocuSign' });
      return;
    }

    const existingRows = existing ?? [];
    const tokenSecretNames = existingRows
      .map((row) => row.token_secret_name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);

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
          tokenSecretNames: failedTokenSecretNames,
          errors: deleteResults.flatMap((result) =>
            result.status === 'rejected'
              ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
              : [],
          ),
        },
        'DocuSign refresh-token secret deletion failed during disconnect',
      );
      res.status(500).json({ error: 'Failed to delete DocuSign refresh token secret' });
      return;
    }

    // Secret Manager delete treats 404 as success, so if this DB update fails
    // the still-connected row can be retried and reconciled by rerunning disconnect.
    const { data, error } = await db
      .from('org_integrations')
      .update({
        revoked_at: now,
        encrypted_tokens: null,
        token_kms_key_id: null,
        token_secret_name: null,
        updated_at: now,
      })
      .eq('org_id', orgId)
      .eq('provider', Provider)
      .is('revoked_at', null)
      .select('id');

    if (error) {
      logger.error({ error, orgId }, 'DocuSign disconnect failed');
      res.status(500).json({ error: 'Failed to disconnect DocuSign' });
      return;
    }

    await recordIntegrationEvent(db, {
      orgId,
      integrationId: data?.[0]?.id,
      eventType: 'oauth_disconnected',
      status: 'success',
    });

    // SOC 2 CC7.2 — audit trail for integration disconnect (SCRUM-2039)
    const integrationId = data?.[0]?.id ?? null;
    void Promise.resolve(
      db.from('audit_events').insert({
        event_type: 'integration.docusign_disconnected',
        event_category: 'SECURITY',
        actor_id: userId,
        org_id: orgId,
        target_type: 'integration',
        target_id: integrationId,
        details: JSON.stringify({ provider: Provider, integration_id: integrationId }),
      }),
    ).then(({ error: auditErr }) => {
      if (auditErr) logger.error({ error: auditErr, orgId }, 'Failed to write DocuSign disconnect audit event');
    }).catch((err: unknown) => {
      logger.error({ error: err, orgId }, 'Failed to write DocuSign disconnect audit event (transport)');
    });

    res.json({ disconnected: true });
  });

  router.post('/docusign/connect/reprovision', async (req: Request, res: Response) => {
    if (!isVerificationApiEnabled(deps.env)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = ReprovisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const publicOrgId = parsed.data.org_public_id;
    const { data: org, error: orgLookupError } = await db
      .from('organizations')
      .select('id')
      .eq('public_id', publicOrgId)
      .maybeSingle();
    if (orgLookupError) {
      logger.error({ error: orgLookupError, publicOrgId }, 'DocuSign Connect reprovision org lookup failed');
      res.status(500).json({ error: 'Failed to reprovision DocuSign Connect' });
      return;
    }

    const orgId = org?.id;
    if (!orgId) {
      res.status(404).json({ error: 'Organization not found' });
      return;
    }

    if (!(await requireOrgAdmin(db, userId, orgId))) {
      res.status(403).json({ error: 'Must be org admin to reprovision DocuSign Connect' });
      return;
    }

    const { data: integrations, error: lookupError } = await db
      .from('org_integrations')
      .select('id, account_id, token_secret_name')
      .eq('org_id', orgId)
      .eq('provider', Provider)
      .is('revoked_at', null);

    if (lookupError) {
      logger.error({ error: lookupError, orgId }, 'DocuSign Connect reprovision integration lookup failed');
      res.status(500).json({ error: 'Failed to reprovision DocuSign Connect' });
      return;
    }

    const activeIntegrations = integrations ?? [];
    if (activeIntegrations.length === 0) {
      res.json({
        attempted: 0,
        succeeded: 0,
        failed: 0,
        results: [],
      });
      return;
    }

    const refreshTokenStore = deps.refreshTokenStore ?? createGcpSecretManagerRefreshTokenStore({
      env: deps.env,
      fetchImpl: deps.fetchImpl,
    });
    const docusignDeps: DocusignClientDeps = { env: deps.env, fetchImpl: deps.fetchImpl };
    const kms = deps.kms ?? await createDefaultKmsClient();
    const now = deps.now?.() ?? new Date();
    const results: DocusignConnectReprovisionResult[] = [];

    for (const integration of activeIntegrations) {
      results.push(await reprovisionDocusignConnectIntegration({
        db,
        docusignDeps,
        env: deps.env,
        integration,
        kms,
        now,
        orgId,
        refreshTokenStore,
      }));
    }

    const succeeded = results.filter((result) => result.status === 'success').length;
    const failed = results.length - succeeded;
    res.status(failed > 0 && succeeded === 0 && results.length > 0 ? 502 : 200).json({
      attempted: results.length,
      succeeded,
      failed,
      results,
    });
  });

  return router;
}

export const docusignOAuthRouter = createDocusignOAuthRouter();
