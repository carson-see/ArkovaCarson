/**
 * Adobe Sign OAuth API (SCRUM-1148 follow-up).
 *
 * User-facing endpoints:
 *   POST /api/v1/integrations/adobe-sign/oauth/start
 *   GET  /api/v1/integrations/adobe-sign/oauth/callback
 *   POST /api/v1/integrations/adobe-sign/disconnect
 *
 * Mirrors `docusign-oauth.ts` (SCRUM-1101) — same org-admin + verified-org
 * gates, same signed-state HMAC, same token split (access token KMS-encrypted
 * into `org_integrations.encrypted_tokens`, refresh token in GCP Secret Manager
 * with only the resource name in `token_secret_name`). Cleartext tokens never
 * reach Postgres or logs.
 *
 * ── THE ONE STRUCTURAL DIFFERENCE FROM DOCUSIGN ─────────────────────────
 *
 * DocuSign provisions its Connect listener fire-and-forget AFTER the upsert and
 * throws the resulting `connectId` away into an `integration_events` row,
 * because `webhooks/docusign.ts` resolves deliveries by `account_id`.
 *
 * Adobe Sign cannot do that. `webhooks/adobe-sign.ts::findIntegration()`
 * resolves by `org_integrations.webhook_id` and by NOTHING ELSE. So here the
 * webhook registration is:
 *
 *   1. BLOCKING, not fire-and-forget — a connection we cannot receive
 *      deliveries for is not a connection, and a row claiming otherwise is the
 *      "UI says Connected, nothing works" state this connector was stuck in.
 *   2. BEFORE the upsert — the id is an input to the row, not an afterthought.
 *   3. COMPENSATED on failure — if the upsert then fails, the webhook we just
 *      created is deleted Adobe-side, so Adobe is never left pushing at a
 *      webhook id no row will ever hold.
 *
 * Before this router existed, `org_integrations.webhook_id` was NULL in every
 * environment (prod included) and 100% of Adobe deliveries fell through to the
 * orphan branch. See `api/v1/webhooks/agents.md`, 2026-08-30.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../../../config.js';
import { logger } from '../../../utils/logger.js';
import { db as defaultDb } from '../../../utils/db.js';
import {
  AdobeSignApiError,
  AdobeSignConfigError,
  buildAdobeSignAuthorizationUrl,
  createAdobeSignWebhook,
  deleteAdobeSignWebhook,
  exchangeAdobeSignCode,
  fetchAdobeSignUserInfo,
  refreshAdobeSignAccessToken,
  revokeAdobeSignToken,
  type AdobeSignClientDeps,
} from '../../../integrations/oauth/adobe-sign.js';
import {
  createDefaultKmsClient,
  encryptTokens,
  type KmsClient,
} from '../../../integrations/oauth/crypto.js';
import {
  buildAdobeSignRefreshTokenSecretName,
  createAdobeSignRefreshTokenStore,
  resolveAdobeSignSecretManagerProjectId,
  type AdobeSignRefreshTokenStore,
} from '../../../integrations/connectors/adobe-sign-token-store.js';
import type { TypeSafeDatabase } from '../../../types/database-overrides.js';
import { resolveIntegrationStateSecret, createLazyOAuthRouter } from './oauth-state.js';

type OrgMemberRow = TypeSafeDatabase['public']['Tables']['org_members']['Row'];
type OrgIntegrationRow = TypeSafeDatabase['public']['Tables']['org_integrations']['Row'];
type OrgIntegrationInsert = TypeSafeDatabase['public']['Tables']['org_integrations']['Insert'];
type OrgIntegrationUpdate = TypeSafeDatabase['public']['Tables']['org_integrations']['Update'];
type IntegrationEventInsert = TypeSafeDatabase['public']['Tables']['integration_events']['Insert'];
type AuditEventInsert = TypeSafeDatabase['public']['Tables']['audit_events']['Insert'];
type OrganizationRow = TypeSafeDatabase['public']['Tables']['organizations']['Row'];
type OrgMemberRoleRow = Pick<OrgMemberRow, 'role'>;
type OrganizationVerificationRow = Pick<OrganizationRow, 'id' | 'verification_status' | 'suspended'>;
type AdobeIntegrationIdRow = Pick<OrgIntegrationRow, 'id'>;
type AdobeIntegrationLookupRow = Pick<
  OrgIntegrationRow,
  'id' | 'account_id' | 'token_secret_name' | 'webhook_id' | 'base_uri'
>;
type AdobeIntegrationUpsert = Pick<
  OrgIntegrationInsert,
  | 'org_id'
  | 'provider'
  | 'account_id'
  | 'account_label'
  | 'base_uri'
  | 'encrypted_tokens'
  | 'token_kms_key_id'
  | 'token_secret_name'
  | 'webhook_id'
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
  update(value: OrgIntegrationUpdate): DbFilterQuery<AdobeIntegrationIdRow[]>;
  insert(value: IntegrationEventInsert): PromiseLike<DbQueryResult<unknown>>;
  upsert(value: AdobeIntegrationUpsert, options?: { onConflict?: string }): DbFilterQuery<AdobeIntegrationIdRow>;
}

interface DbAuditTableQuery {
  insert(value: AuditEventInsert): PromiseLike<DbQueryResult<unknown>>;
}

interface DbClient {
  from(table: 'org_members'): DbTableQuery<OrgMemberRoleRow>;
  from(table: 'organizations'): DbTableQuery<OrganizationVerificationRow>;
  from(table: 'org_integrations'): DbTableQuery<AdobeIntegrationLookupRow[]>;
  from(table: 'integration_events'): DbTableQuery<unknown>;
  from(table: 'audit_events'): DbAuditTableQuery;
}

export interface AdobeSignOAuthDeps {
  db?: DbClient;
  env?: NodeJS.ProcessEnv;
  kms?: KmsClient;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  stateSecret?: string;
  frontendUrl?: string;
  refreshTokenStore?: AdobeSignRefreshTokenStore;
}

interface StatePayload {
  orgId: string;
  userId: string;
  nonce: string;
  returnTo: string;
  iat: number;
}

const Provider = 'adobe_sign' as const;
const StateTtlMs = 10 * 60 * 1000;
const StartSchema = z.object({
  org_id: z.string().uuid(),
  return_to: z.string().url().optional(),
});

/** Postgres unique-violation. Here it means migration 0426's partial index fired. */
const PG_UNIQUE_VIOLATION = '23505';

function getUserId(req: Request): string | undefined {
  return (req as unknown as { userId?: string }).userId;
}

function base64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function hmac(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function signState(payload: StatePayload, secret: string): string {
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded, secret)}`;
}

function verifyState(state: string, secret: string, deps: AdobeSignOAuthDeps): StatePayload | null {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return null;

  const expected = hmac(encoded, secret);
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
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

/**
 * The redirect URI Adobe must have registered on the application.
 *
 * Request-host derived, exactly like DocuSign's — which means any NEW host
 * fronting the worker needs this exact path registered on the Adobe app or the
 * callback is rejected before it reaches us (the SCRUM-3015 lesson).
 */
function buildRedirectUri(req: Request): string {
  return `${getRequestBaseUrl(req)}/api/v1/integrations/adobe-sign/oauth/callback`;
}

function sanitizeReturnTo(returnTo: string | undefined, orgId: string, deps: AdobeSignOAuthDeps): string {
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

function appendResult(url: string, key: 'adobe_sign' | 'adobe_sign_error', value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('tab', 'settings');
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

function toPostgresBytea(buffer: Buffer): string {
  return `\\x${buffer.toString('hex')}`;
}

async function requireOrgAdmin(db: DbClient, userId: string, orgId: string): Promise<boolean> {
  const { data, error } = await db
    .from('org_members')
    .select('role')
    .eq('user_id', userId)
    .eq('org_id', orgId)
    .maybeSingle();

  if (error) {
    logger.error({ error, orgId }, 'Adobe Sign OAuth admin lookup failed');
    return false;
  }
  return data?.role === 'admin' || data?.role === 'owner';
}

/**
 * Verified-organization entitlement gate — parity with DocuSign's DS-01
 * (SCRUM-2361). Only a VERIFIED, non-suspended organization may connect a
 * document source. Re-evaluated on the callback because a signed state is
 * replayable inside its TTL and verification can be revoked in between.
 * Disconnect is never gated.
 */
type VerifiedOrgGate =
  | { allowed: true }
  | { allowed: false; reason: 'org_unverified' | 'org_suspended' | 'org_not_found' | 'lookup_failed' };

async function requireVerifiedOrg(db: DbClient, orgId: string): Promise<VerifiedOrgGate> {
  const { data, error } = await db
    .from('organizations')
    .select('id, verification_status, suspended')
    .eq('id', orgId)
    .maybeSingle();

  if (error) {
    logger.error({ error, orgId }, 'Adobe Sign OAuth org-verification lookup failed');
    return { allowed: false, reason: 'lookup_failed' };
  }
  if (!data) return { allowed: false, reason: 'org_not_found' };
  if (data.verification_status !== 'VERIFIED') return { allowed: false, reason: 'org_unverified' };
  if (data.suspended === true) return { allowed: false, reason: 'org_suspended' };
  return { allowed: true };
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
    logger.warn({ error, orgId: args.orgId, eventType: args.eventType }, 'Adobe Sign integration event insert failed');
  }
}

/**
 * Best-effort Adobe-side webhook teardown.
 *
 * Used as compensation on the connect path (the upsert failed after the webhook
 * was created) and as the first step of disconnect. Never throws: on the
 * connect path the user is already being redirected to an error, and on the
 * disconnect path the local teardown must complete regardless (see the
 * disconnect handler's note). Returns whether Adobe actually removed it so the
 * caller can surface a stranded webhook instead of silently accepting one.
 */
async function tryDeleteAdobeWebhook(args: {
  apiAccessPoint: string;
  accessToken: string;
  webhookId: string;
  clientDeps: AdobeSignClientDeps;
  orgId: string;
}): Promise<boolean> {
  try {
    await deleteAdobeSignWebhook({
      apiAccessPoint: args.apiAccessPoint,
      accessToken: args.accessToken,
      webhookId: args.webhookId,
      deps: args.clientDeps,
    });
    return true;
  } catch (error) {
    logger.error(
      {
        orgId: args.orgId,
        adobeStatus: error instanceof AdobeSignApiError ? error.status : undefined,
        detail: error instanceof AdobeSignApiError ? error.detail : undefined,
      },
      'Adobe Sign webhook delete failed — a webhook may still be delivering to this worker',
    );
    return false;
  }
}

export function createAdobeSignOAuthRouter(deps: AdobeSignOAuthDeps = {}): Router {
  const router = Router();
  const db = (deps.db ?? defaultDb) as DbClient;
  // Audit H1: resolve at construction so a misconfigured deploy fails at boot,
  // not at the first OAuth attempt. Mirrors docusign-oauth.ts / drive-oauth.ts.
  const stateSecret = resolveIntegrationStateSecret(deps, 'Adobe Sign');

  const clientDeps = (): AdobeSignClientDeps => ({ env: deps.env, fetchImpl: deps.fetchImpl });
  const tokenStore = (): AdobeSignRefreshTokenStore =>
    deps.refreshTokenStore ?? createAdobeSignRefreshTokenStore({ env: deps.env, fetchImpl: deps.fetchImpl });

  router.post('/adobe-sign/oauth/start', async (req: Request, res: Response) => {
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
      res.status(403).json({ error: 'Must be org admin to connect Adobe Sign' });
      return;
    }

    const orgGate = await requireVerifiedOrg(db, orgId);
    if (!orgGate.allowed) {
      if (orgGate.reason === 'lookup_failed') {
        res.status(500).json({ error: 'Failed to start Adobe Sign connection', code: 'verification_lookup_failed' });
        return;
      }
      res.status(403).json({
        error: 'Your organization must be verified before connecting Adobe Sign.',
        code: orgGate.reason,
      });
      return;
    }

    try {
      const returnTo = sanitizeReturnTo(parsed.data.return_to, orgId, deps);
      const state = signState({
        orgId,
        userId,
        nonce: randomUUID(),
        returnTo,
        iat: (deps.now?.() ?? new Date()).getTime(),
      }, stateSecret);
      const authorizationUrl = buildAdobeSignAuthorizationUrl({
        redirectUri: buildRedirectUri(req),
        state,
        env: deps.env,
      });

      res.json({ authorizationUrl, url: authorizationUrl });
    } catch (error) {
      // As of 2026-08-30 this is the LIVE prod path: no Adobe application has
      // been registered, so there is no ADOBE_SIGN_CLIENT_ID to build a consent
      // URL from. Answer with a specific code rather than a bare 500 so the UI
      // can say "not available yet" instead of "something went wrong".
      if (error instanceof AdobeSignConfigError) {
        logger.error({ orgId, message: error.message }, 'Adobe Sign OAuth start: connector not configured');
        res.status(500).json({
          error: 'Adobe Sign is not configured on this deployment.',
          code: 'adobe_sign_unconfigured',
        });
        return;
      }
      logger.error({ error, orgId }, 'Adobe Sign OAuth start failed');
      res.status(500).json({ error: 'Failed to start Adobe Sign connection' });
    }
  });

  router.get('/adobe-sign/oauth/callback', async (req: Request, res: Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    const payload = verifyState(state, stateSecret, deps);
    const returnTo = payload?.returnTo ?? `${deps.frontendUrl ?? config.frontendUrl}/organizations`;

    if (!payload) {
      res.redirect(302, appendResult(returnTo, 'adobe_sign_error', 'invalid_state'));
      return;
    }
    if (errorParam) {
      res.redirect(302, appendResult(returnTo, 'adobe_sign_error', errorParam));
      return;
    }
    if (!code) {
      res.redirect(302, appendResult(returnTo, 'adobe_sign_error', 'missing_code'));
      return;
    }
    if (!(await requireOrgAdmin(db, payload.userId, payload.orgId))) {
      res.redirect(302, appendResult(returnTo, 'adobe_sign_error', 'not_authorized'));
      return;
    }

    const callbackOrgGate = await requireVerifiedOrg(db, payload.orgId);
    if (!callbackOrgGate.allowed) {
      res.redirect(302, appendResult(returnTo, 'adobe_sign_error', callbackOrgGate.reason));
      return;
    }

    try {
      const tokens = await exchangeAdobeSignCode({
        code,
        redirectUri: buildRedirectUri(req),
        deps: clientDeps(),
      });

      if (!tokens.refresh_token) {
        logger.warn({ orgId: payload.orgId }, 'Adobe Sign token exchange did not include refresh_token');
        res.redirect(302, appendResult(returnTo, 'adobe_sign_error', 'missing_refresh_token'));
        return;
      }
      // Without the shard access point every later REST call would have to
      // guess a host. Refuse rather than persist a row we can never act on.
      const apiAccessPoint = tokens.api_access_point;
      if (!apiAccessPoint) {
        logger.warn({ orgId: payload.orgId }, 'Adobe Sign token exchange did not include api_access_point');
        res.redirect(302, appendResult(returnTo, 'adobe_sign_error', 'missing_access_point'));
        return;
      }

      const info = await fetchAdobeSignUserInfo({
        apiAccessPoint,
        accessToken: tokens.access_token,
        deps: clientDeps(),
      });
      // Adobe's /users/me always carries an id; fall back to the account id so
      // the upsert conflict key is never null (a null account_id would collide
      // on idx_org_integrations_org_provider_active_null_account).
      const accountId = info.id ?? info.accountId;
      if (!accountId) {
        logger.warn({ orgId: payload.orgId }, 'Adobe Sign userinfo did not include an account identifier');
        res.redirect(302, appendResult(returnTo, 'adobe_sign_error', 'no_account'));
        return;
      }

      const now = deps.now?.() ?? new Date();
      const kms = deps.kms ?? await createDefaultKmsClient();
      const refreshTokenStore = tokenStore();
      const tokenSecretName = buildAdobeSignRefreshTokenSecretName({
        projectId: resolveAdobeSignSecretManagerProjectId(deps.env),
        orgId: payload.orgId,
        accountId,
      });
      const encrypted = await encryptTokens({
        access_token: tokens.access_token,
        token_type: tokens.token_type,
        expires_at: new Date(now.getTime() + tokens.expires_in * 1000).toISOString(),
        scope: tokens.scope,
      }, { kms, env: deps.env });

      // Secret Manager first: Postgres stores only the resulting resource name,
      // so the secret has to exist before the row can reference it. Every
      // failure path below cleans it up.
      await refreshTokenStore.put({ name: tokenSecretName, value: tokens.refresh_token });

      const cleanupSecret = async (reason: string) => {
        await refreshTokenStore.delete({ name: tokenSecretName }).catch((deleteError: unknown) => {
          logger.warn(
            { error: deleteError, orgId: payload.orgId, tokenSecretName, reason },
            'Adobe Sign refresh-token secret cleanup failed',
          );
        });
      };

      // ── Register the webhook BEFORE the upsert ──────────────────────────
      // This is the whole point of the connector. Blocking and fatal: an
      // integration row without a webhook_id can never receive a delivery, and
      // shipping one would recreate the exact "connected but inert" state that
      // made Adobe Sign non-functional in every environment.
      let webhookId: string;
      try {
        const created = await createAdobeSignWebhook({
          apiAccessPoint,
          accessToken: tokens.access_token,
          deps: clientDeps(),
        });
        webhookId = created.webhookId;
      } catch (webhookError) {
        const adobeStatus = webhookError instanceof AdobeSignApiError ? webhookError.status : undefined;
        logger.error(
          {
            orgId: payload.orgId,
            adobeStatus,
            detail: webhookError instanceof AdobeSignApiError ? webhookError.detail : undefined,
          },
          'Adobe Sign webhook registration failed — connection refused',
        );
        await cleanupSecret('webhook_registration_failed');
        await recordIntegrationEvent(db, {
          orgId: payload.orgId,
          eventType: 'webhook_registration_failed',
          status: 'error',
          details: {
            adobe_status: adobeStatus ?? null,
            // A 403 here is almost always "the account tier does not grant
            // webhook_write"; keeping the bounded detail is what makes that
            // legible instead of a mystery.
            adobe_detail: webhookError instanceof AdobeSignApiError ? webhookError.detail ?? null : null,
          },
        });
        res.redirect(302, appendResult(returnTo, 'adobe_sign_error', 'webhook_registration_failed'));
        return;
      }

      const { data: integration, error: upsertError } = await db
        .from('org_integrations')
        .upsert({
          org_id: payload.orgId,
          provider: Provider,
          account_id: accountId,
          // Company name, never the admin's email — org-wide settings render
          // this and a personal address there is a PII leak.
          account_label: info.company ?? accountId,
          base_uri: apiAccessPoint,
          encrypted_tokens: toPostgresBytea(encrypted.ciphertext),
          token_kms_key_id: encrypted.keyId,
          token_secret_name: tokenSecretName,
          // THE line this connector was missing.
          webhook_id: webhookId,
          scope: tokens.scope ?? null,
          connected_at: now.toISOString(),
          revoked_at: null,
          updated_at: now.toISOString(),
        }, { onConflict: 'org_id,provider,account_id' })
        .select('id')
        .single();

      if (upsertError) {
        // Compensate: the webhook exists Adobe-side but no row will ever hold
        // its id, so leaving it would push every future agreement at an
        // endpoint that can only orphan it.
        await tryDeleteAdobeWebhook({
          apiAccessPoint,
          accessToken: tokens.access_token,
          webhookId,
          clientDeps: clientDeps(),
          orgId: payload.orgId,
        });
        await cleanupSecret('upsert_failed');

        // Migration 0426's partial unique index on (provider, webhook_id)
        // WHERE revoked_at IS NULL is a tenant-isolation invariant: at most one
        // ACTIVE integration may claim a given Adobe webhook id, so a stray or
        // malicious duplicate registration cannot shadow another org's events.
        // Report that distinctly — it is not a transient save failure.
        const isUniqueViolation = (upsertError as { code?: string }).code === PG_UNIQUE_VIOLATION;
        logger.error(
          { error: upsertError, orgId: payload.orgId, uniqueViolation: isUniqueViolation },
          'Adobe Sign integration upsert failed',
        );
        res.redirect(
          302,
          appendResult(returnTo, 'adobe_sign_error', isUniqueViolation ? 'webhook_already_claimed' : 'save_failed'),
        );
        return;
      }

      await recordIntegrationEvent(db, {
        orgId: payload.orgId,
        integrationId: integration?.id,
        eventType: 'oauth_connected',
        status: 'success',
        details: {
          account_id: accountId,
          account_label: info.company ?? accountId,
          // Not a secret — Adobe puts this id in every notification body — and
          // it is the join key an operator needs to trace a delivery.
          webhook_id: webhookId,
        },
      });

      res.redirect(302, appendResult(returnTo, 'adobe_sign', 'connected'));
    } catch (error) {
      logger.error(
        {
          orgId: payload.orgId,
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
          adobeStatus: error instanceof AdobeSignApiError ? error.status : undefined,
        },
        'Adobe Sign OAuth callback failed',
      );
      res.redirect(302, appendResult(returnTo, 'adobe_sign_error', 'callback_failed'));
    }
  });

  router.post('/adobe-sign/disconnect', async (req: Request, res: Response) => {
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
    // Deliberately NOT gated on requireVerifiedOrg: a lapsed or suspended org
    // must always be able to remove its connection.
    if (!(await requireOrgAdmin(db, userId, orgId))) {
      res.status(403).json({ error: 'Must be org admin to disconnect Adobe Sign' });
      return;
    }

    const now = (deps.now?.() ?? new Date()).toISOString();
    const { data: existing, error: existingError } = await db
      .from('org_integrations')
      .select('id, account_id, token_secret_name, webhook_id, base_uri')
      .eq('org_id', orgId)
      .eq('provider', Provider)
      .is('revoked_at', null);

    if (existingError) {
      logger.error({ error: existingError, orgId }, 'Adobe Sign disconnect integration lookup failed');
      res.status(500).json({ error: 'Failed to disconnect Adobe Sign' });
      return;
    }

    const existingRows = existing ?? [];
    if (existingRows.length === 0) {
      // Idempotent: nothing connected is the state disconnect wants.
      res.json({ disconnected: true, adobe_webhook_removed: true });
      return;
    }

    const refreshTokenStore = tokenStore();

    // ── Adobe-side teardown ─────────────────────────────────────────────
    //
    // Ordering matters: refresh -> delete webhook -> revoke. The stored access
    // token is at most an hour old and is very likely expired, so we mint a
    // fresh one first; revoking before the delete would destroy the credential
    // the delete needs.
    //
    // This whole block is BEST-EFFORT. If Adobe is unreachable we still
    // complete the local teardown, because leaving an org permanently
    // "connected" because a third party is down is worse than a stranded
    // webhook — the security-relevant half (tokens revoked, secret deleted,
    // row revoked) is entirely ours and always completes. The stranded webhook
    // is REPORTED, not swallowed: it needs a manual removal in Adobe's console,
    // and until then its deliveries will orphan into `webhook_dlq` (which
    // nothing drains — see webhooks/agents.md). A later reconnect mints a
    // second webhook; the old one keeps orphaning while the new one resolves.
    let adobeWebhookRemoved = true;
    const teardownFailures: string[] = [];

    for (const row of existingRows) {
      const tokenSecretName = row.token_secret_name;
      const webhookId = row.webhook_id;
      const apiAccessPoint = row.base_uri;

      let accessToken: string | null = null;
      if (tokenSecretName) {
        try {
          const refreshToken = await refreshTokenStore.get({ name: tokenSecretName });
          if (refreshToken) {
            // Only needed when there is something to tear down Adobe-side.
            if (webhookId && apiAccessPoint) {
              const refreshed = await refreshAdobeSignAccessToken({ refreshToken, deps: clientDeps() });
              accessToken = refreshed.access_token;
            }
            await revokeAdobeSignToken({ token: refreshToken, deps: clientDeps() }).catch((revokeError: unknown) => {
              logger.warn(
                { orgId, integrationId: row.id, message: revokeError instanceof Error ? revokeError.message : 'unknown' },
                'Adobe Sign token revoke failed during disconnect (non-fatal)',
              );
              teardownFailures.push('token_revoke');
            });
          }
        } catch (error) {
          logger.warn(
            { orgId, integrationId: row.id, message: error instanceof Error ? error.message : 'unknown' },
            'Adobe Sign disconnect could not obtain a fresh access token',
          );
          teardownFailures.push('token_refresh');
        }
      }

      if (webhookId && apiAccessPoint) {
        if (accessToken) {
          const removed = await tryDeleteAdobeWebhook({
            apiAccessPoint,
            accessToken,
            webhookId,
            clientDeps: clientDeps(),
            orgId,
          });
          if (!removed) {
            adobeWebhookRemoved = false;
            teardownFailures.push('webhook_delete');
          }
        } else {
          adobeWebhookRemoved = false;
          teardownFailures.push('webhook_delete_no_token');
        }
      }

      if (tokenSecretName) {
        await refreshTokenStore.delete({ name: tokenSecretName }).catch((deleteError: unknown) => {
          logger.error(
            { error: deleteError, orgId, tokenSecretName },
            'Adobe Sign refresh-token secret deletion failed during disconnect',
          );
          teardownFailures.push('secret_delete');
        });
      }
    }

    // Clearing `webhook_id` matters as much as clearing the credentials: a
    // revoked row that kept its id would keep matching the handler's lookup
    // (which filters on revoked_at IS NULL, so it would not — but the partial
    // unique index would still hold the id and block a legitimate reconnect).
    const { data, error } = await db
      .from('org_integrations')
      .update({
        revoked_at: now,
        encrypted_tokens: null,
        token_kms_key_id: null,
        token_secret_name: null,
        webhook_id: null,
        updated_at: now,
      })
      .eq('org_id', orgId)
      .eq('provider', Provider)
      .is('revoked_at', null)
      .select('id');

    if (error) {
      logger.error({ error, orgId }, 'Adobe Sign disconnect failed');
      res.status(500).json({ error: 'Failed to disconnect Adobe Sign' });
      return;
    }

    const integrationId = data?.[0]?.id ?? null;
    await recordIntegrationEvent(db, {
      orgId,
      integrationId,
      eventType: 'oauth_disconnected',
      status: 'success',
    });

    if (teardownFailures.length > 0) {
      await recordIntegrationEvent(db, {
        orgId,
        integrationId,
        eventType: 'webhook_teardown_failed',
        status: 'warning',
        details: {
          failures: teardownFailures,
          adobe_webhook_removed: adobeWebhookRemoved,
          remediation: 'Remove the Arkova webhook manually in the Adobe Acrobat Sign admin console.',
        },
      });
    }

    // SOC 2 CC7.2 — audit trail for every integration lifecycle event.
    void Promise.resolve(
      db.from('audit_events').insert({
        event_type: 'integration.adobe_sign_disconnected',
        event_category: 'SECURITY',
        actor_id: userId,
        org_id: orgId,
        target_type: 'integration',
        target_id: integrationId,
        details: JSON.stringify({
          provider: Provider,
          integration_id: integrationId,
          adobe_webhook_removed: adobeWebhookRemoved,
        }),
      }),
    ).then(({ error: auditErr }) => {
      if (auditErr) logger.error({ error: auditErr, orgId }, 'Failed to write Adobe Sign disconnect audit event');
    }).catch((err: unknown) => {
      logger.error({ error: err, orgId }, 'Failed to write Adobe Sign disconnect audit event (transport)');
    });

    res.json({ disconnected: true, adobe_webhook_removed: adobeWebhookRemoved });
  });

  return router;
}

// Lazy router export — `createAdobeSignOAuthRouter()` validates
// INTEGRATION_STATE_HMAC_SECRET at construction and throws when missing (audit
// H1). Defer construction to the first request so importing this module without
// the env var doesn't crash unrelated tests.
export const adobeSignOAuthRouter: Router = createLazyOAuthRouter(() => createAdobeSignOAuthRouter());
