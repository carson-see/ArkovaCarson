/**
 * Google Drive OAuth API (SCRUM-1168)
 *
 * User-facing endpoints:
 *   POST /api/v1/integrations/google_drive/oauth/start
 *   GET  /api/v1/integrations/google_drive/oauth/callback
 *   POST /api/v1/integrations/google_drive/disconnect
 *
 * Tokens are encrypted with the reviewed OAuth crypto helper before storage.
 * The cleartext access/refresh token payload never reaches Postgres or logs.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../../../config.js';
import { logger } from '../../../utils/logger.js';
import { db as defaultDb } from '../../../utils/db.js';
import {
  buildAuthorizationUrl,
  createChangesWatch,
  exchangeCode,
  stopDriveChannel,
  // revokeOAuthToken intentionally NOT imported — see SCRUM-1237 / AUDIT-0424-12
  type DriveClientDeps,
} from '../../../integrations/oauth/drive.js';
import {
  createDefaultKmsClient,
  decryptTokens,
  encryptTokens,
  type KmsClient,
} from '../../../integrations/oauth/crypto.js';
import { WEBHOOK_PATHS } from '../../../constants/webhook-paths.js';
import {
  assertDriveConnectAllowed,
  DriveConnectDenied,
  type DriveConnectDenyReason,
  type DriveEligibilityDb,
} from '../../../integrations/connectors/drive-connect-eligibility.js';

// org_integrations landed after generated worker DB types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

interface DriveOAuthDeps {
  db?: DbClient;
  env?: NodeJS.ProcessEnv;
  kms?: KmsClient;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  stateSecret?: string;
  frontendUrl?: string;
}

interface StatePayload {
  // null when the caller connects a PERSONAL Drive (paid-verified individual,
  // no org). Present for the org-admin connect path.
  orgId: string | null;
  userId: string;
  nonce: string;
  returnTo: string;
  iat: number;
}

const Provider = 'google_drive' as const;
const StateTtlMs = 10 * 60 * 1000;
const StartSchema = z.object({
  // Optional: absent → paid-verified individual connecting a personal Drive.
  org_id: z.string().uuid().optional(),
  return_to: z.string().url().optional(),
});
// Disconnect is always org-scoped (org_integrations rows are org-keyed): org_id
// is required, unlike the connect start where it is optional (personal path).
const DisconnectSchema = z.object({ org_id: z.string().uuid() });

function getUserId(req: Request): string | undefined {
  return (req as unknown as { userId?: string }).userId;
}

function base64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function hmac(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

/**
 * GH #1836 (SECURITY, pen-test scope): mint a cryptographically random Drive
 * `changes.watch` channel token. Previously this reused `callbackOrgId` — the
 * org's UUID — as the token, but an org UUID is not a secret (it appears in
 * URLs, API responses, and client-side state throughout the product), so
 * anyone who learned/guessed an org UUID could forge a push notification to
 * the webhook and pass the `X-Goog-Channel-Token` check. 256 bits of entropy,
 * URL-safe so it survives Drive's `token` field verbatim.
 */
function generateChannelToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Resolve the dedicated HMAC secret for OAuth state signing.
 *
 * SCRUM-1236 (AUDIT-0424-11): Previously this fell back to
 * `config.supabaseJwtSecret` and `config.supabaseServiceKey` — both
 * general-purpose secrets used for unrelated paths. Coupling state validity
 * to those rotations meant rotating the Supabase JWT silently invalidated
 * every in-flight OAuth flow, and reusing a verification secret as a
 * signing secret violates least-privilege. We now require a dedicated
 * `INTEGRATION_STATE_HMAC_SECRET` env var (or an explicit `stateSecret`
 * override for tests). Fail-closed if neither is provided.
 */
function resolveStateSecret(deps: DriveOAuthDeps): string {
  if (deps.stateSecret) return deps.stateSecret;
  const envSecret = (deps.env ?? process.env).INTEGRATION_STATE_HMAC_SECRET;
  if (envSecret && envSecret.length > 0) return envSecret;
  throw new Error(
    'INTEGRATION_STATE_HMAC_SECRET is required for Drive OAuth state signing — fail-closed (SCRUM-1236)',
  );
}

function signState(payload: StatePayload, secret: string): string {
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded, secret)}`;
}

function verifyState(state: string, secret: string, deps: DriveOAuthDeps): StatePayload | null {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return null;

  const expected = hmac(encoded, secret);
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
    // orgId may legitimately be null (personal-Drive individual path); userId +
    // iat are always required and the token must be within TTL.
    if (!parsed.userId || !parsed.iat || nowMs - parsed.iat > StateTtlMs) {
      return null;
    }
    // Normalize a missing/absent orgId to null so downstream checks are explicit.
    return { ...parsed, orgId: parsed.orgId ?? null };
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
  return `${getRequestBaseUrl(req)}/api/v1/integrations/google_drive/oauth/callback`;
}

function buildWebhookAddress(req: Request): string {
  // Must match the path the v1 router mounts the Drive webhook handler at;
  // drift here produces silent 404s on every Drive push.
  return `${getRequestBaseUrl(req)}${WEBHOOK_PATHS.GOOGLE_DRIVE}`;
}

function sanitizeReturnTo(returnTo: string | undefined, orgId: string | null, deps: DriveOAuthDeps): string {
  const base = deps.frontendUrl ?? config.frontendUrl;
  // Org connect returns to the org settings; personal connect to account settings.
  const fallback = orgId
    ? `${base}/organizations/${orgId}?tab=settings`
    : `${base}/account?tab=settings`;
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

function appendResult(url: string, key: 'drive' | 'drive_error', value: string): string {
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
    logger.error({ error, orgId }, 'Drive OAuth admin lookup failed');
    return false;
  }
  return data?.role === 'admin' || data?.role === 'owner';
}

/**
 * DRIVE-01 (SCRUM-2366) — build the `DriveEligibilityDb` adapter over the route
 * `db`. The org-verification + individual-entitlement lookups the resolver
 * needs run through the route's Supabase client; the owner-inclusive admin /
 * org-membership resolution runs through the canonical `_org-auth.ts` helpers
 * (which use the service-role singleton) INSIDE the eligibility module — we
 * never re-resolve org from `org_members` alone here (the #1325/#1326 drift
 * class). `error:true` on a DB failure so the resolver fails closed to
 * `lookup_failed` (retryable) rather than a hard denial.
 */
function makeEligibilityDb(db: DbClient): DriveEligibilityDb {
  return {
    async getOrganization(orgId: string) {
      const { data, error } = await db
        .from('organizations')
        .select('verification_status, suspended')
        .eq('id', orgId)
        .maybeSingle();
      if (error) {
        logger.error({ error, orgId }, 'Drive OAuth org-verification lookup failed');
        return { row: null, error: true };
      }
      return { row: data ?? null, error: false };
    },
    async getProfileEntitlement(userId: string) {
      const { data, error } = await db
        .from('profiles')
        .select('subscription_tier, identity_verified_at')
        .eq('id', userId)
        .maybeSingle();
      if (error) {
        logger.error({ error, userId }, 'Drive OAuth profile-entitlement lookup failed');
        return { row: null, error: true };
      }
      return { row: data ?? null, error: false };
    },
  };
}

/**
 * Map a connect-denial reason to an HTTP status + stable error code. A
 * `lookup_failed` is a transient/operational fault (→ 500, retryable); every
 * other reason is a definitive entitlement denial (→ 403). Callback denials
 * reuse the same `code` as the `drive_error` query param.
 */
const DENY_HTTP: Record<DriveConnectDenyReason, { status: 403 | 500; code: string }> = {
  not_admin: { status: 403, code: 'not_authorized' },
  org_unverified: { status: 403, code: 'org_unverified' },
  org_suspended: { status: 403, code: 'org_suspended' },
  needs_paid_plan: { status: 403, code: 'needs_paid_plan' },
  individual_not_verified: { status: 403, code: 'individual_not_verified' },
  lookup_failed: { status: 500, code: 'lookup_failed' },
};

async function fetchGoogleIdentity(accessToken: string, deps: DriveOAuthDeps): Promise<{
  accountId: string;
  accountLabel: string | null;
}> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json().catch(() => null)) as {
    sub?: string;
    email?: string;
  } | null;

  if (!res.ok) {
    logger.warn({ status: res.status }, 'Drive OAuth userinfo lookup failed');
  }

  return {
    accountId: json?.sub ?? json?.email ?? 'google_drive',
    accountLabel: json?.email ?? null,
  };
}

async function recordIntegrationEvent(db: DbClient, args: {
  orgId: string;
  integrationId?: string | null;
  eventType: string;
  status: 'success' | 'warning' | 'error';
  details?: Record<string, unknown>;
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
    logger.warn({ error, orgId: args.orgId, eventType: args.eventType }, 'Drive integration event insert failed');
  }
}

export function createDriveOAuthRouter(deps: DriveOAuthDeps = {}): Router {
  const router = Router();
  const db = deps.db ?? defaultDb;
  // SCRUM-1236: resolve at construction time so a misconfigured deploy fails
  // fast (server boot) rather than at the first OAuth attempt.
  const stateSecret = resolveStateSecret(deps);

  router.post('/google_drive/oauth/start', async (req: Request, res: Response) => {
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

    const orgId = parsed.data.org_id ?? null;

    // DRIVE-01 (SCRUM-2366): verified-only connect gate. Org path → owner-
    // inclusive admin of a VERIFIED, non-suspended org; personal path (no
    // org_id) → paid + identity-verified individual. Routes through the
    // canonical owner-inclusive resolver, NOT org_members alone.
    try {
      await assertDriveConnectAllowed({ userId, orgId, db: makeEligibilityDb(db) });
    } catch (gateErr) {
      if (gateErr instanceof DriveConnectDenied) {
        const { status, code } = DENY_HTTP[gateErr.reason];
        res.status(status).json({ error: 'Not eligible to connect Google Drive', code });
        return;
      }
      logger.error({ error: gateErr, orgId }, 'Drive OAuth start eligibility gate errored');
      res.status(500).json({ error: 'Failed to start Google Drive connection' });
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
      }, stateSecret);
      const authorizationUrl = buildAuthorizationUrl({
        redirectUri,
        state,
        env: deps.env,
      });

      res.json({ authorizationUrl, url: authorizationUrl });
    } catch (error) {
      logger.error({ error, orgId }, 'Drive OAuth start failed');
      res.status(500).json({ error: 'Failed to start Google Drive connection' });
    }
  });

  router.get('/google_drive/oauth/callback', async (req: Request, res: Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const errorParam = typeof req.query.error === 'string' ? req.query.error : '';
    const payload = verifyState(state, stateSecret, deps);
    const returnTo = payload?.returnTo ?? `${deps.frontendUrl ?? config.frontendUrl}/organizations`;

    if (!payload) {
      res.redirect(302, appendResult(returnTo, 'drive_error', 'invalid_state'));
      return;
    }

    if (errorParam) {
      res.redirect(302, appendResult(returnTo, 'drive_error', errorParam));
      return;
    }

    if (!code) {
      res.redirect(302, appendResult(returnTo, 'drive_error', 'missing_code'));
      return;
    }

    // DRIVE-01 (SCRUM-2366): RE-EVALUATE the connect gate at the callback leg,
    // not just at start. A caller holding a still-valid `state` token whose
    // entitlement lapsed between start and callback (org de-verified/suspended,
    // plan downgraded, identity verification revoked) is denied HERE, at persist
    // time — an existing/stale token cannot bypass a lapsed entitlement.
    try {
      await assertDriveConnectAllowed({
        userId: payload.userId,
        orgId: payload.orgId,
        db: makeEligibilityDb(db),
      });
    } catch (gateErr) {
      if (gateErr instanceof DriveConnectDenied) {
        const { code } = DENY_HTTP[gateErr.reason];
        res.redirect(302, appendResult(returnTo, 'drive_error', code));
        return;
      }
      logger.error({ error: gateErr, orgId: payload.orgId }, 'Drive OAuth callback eligibility gate errored');
      res.redirect(302, appendResult(returnTo, 'drive_error', 'lookup_failed'));
      return;
    }

    // The persisted connection is org-scoped (org_integrations.org_id is NOT
    // NULL). A personal-Drive individual passes the gate but has no org row to
    // write — deny persistence here until the personal-connect storage path
    // (separate story) lands, rather than crash on a NOT NULL insert.
    if (!payload.orgId) {
      logger.warn({ userId: payload.userId }, 'Drive OAuth callback: personal-Drive connect not yet persistable');
      res.redirect(302, appendResult(returnTo, 'drive_error', 'personal_connect_unavailable'));
      return;
    }
    const callbackOrgId: string = payload.orgId;

    try {
      const driveDeps: DriveClientDeps = { env: deps.env, fetchImpl: deps.fetchImpl };
      const tokens = await exchangeCode({
        code,
        redirectUri: buildRedirectUri(req),
        deps: driveDeps,
      });
      const identity = await fetchGoogleIdentity(tokens.access_token, deps);
      const kms = deps.kms ?? await createDefaultKmsClient();
      const expiresAt = new Date((deps.now?.() ?? new Date()).getTime() + tokens.expires_in * 1000).toISOString();
      const encrypted = await encryptTokens({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        expires_at: expiresAt,
        scope: tokens.scope,
      }, { kms, env: deps.env });

      const channelId = randomUUID();
      // GH #1836: high-entropy per-channel secret, NOT the org UUID (see
      // generateChannelToken doc comment). Stored below in account_label and
      // compared constant-time against X-Goog-Channel-Token by the webhook.
      const channelToken = generateChannelToken();
      // DRIVE B1: `startPageToken` must be captured here. It is the cursor the
      // changes pipeline starts from, and connect time is the ONLY moment it can
      // be seeded — `advancePageToken` is the only other writer, and it runs
      // exclusively inside `processDriveChanges`, which refuses to run without a
      // token. Dropping it made the pipeline unreachable by construction.
      let subscription:
        | { resourceId: string; expiration: string; startPageToken: string }
        | null = null;
      try {
        subscription = await createChangesWatch({
          accessToken: tokens.access_token,
          channelId,
          address: buildWebhookAddress(req),
          token: channelToken,
          deps: driveDeps,
        });
      } catch (watchError) {
        logger.warn({ watchError, orgId: callbackOrgId }, 'Drive changes.watch failed; saving OAuth connection without subscription');
      }

      // Every column derived from the watch result, resolved ONCE. These four
      // must agree with each other — a row claiming an active subscription but
      // carrying a renewal error, or vice versa, is a lie about the connector's
      // state — and deriving each one inline meant four independent chances to
      // get that wrong. Note the asymmetry in the failure arm: it deliberately
      // omits `last_page_token`.
      //
      // Seed the changes cursor (DRIVE B1) only when the watch SUCCEEDED. This
      // is an upsert, so unconditionally writing null on a failed re-watch
      // would wipe a working org's cursor, and nothing else can re-seed it —
      // `advancePageToken` is the only other writer and it refuses to run
      // without a token. Leaving the column untouched keeps the existing
      // cursor so no change window is silently skipped.
      const watchColumns = subscription
        ? {
          subscription_id: channelId,
          subscription_expires_at: subscription.expiration,
          last_page_token: subscription.startPageToken,
          last_renewal_error: null,
        }
        : {
          subscription_id: null,
          subscription_expires_at: null,
          last_renewal_error: 'changes.watch registration failed during OAuth callback',
        };

      const accountLabelJson = JSON.stringify({
        email: identity.accountLabel,
        // GH #1836: random secret, not the org UUID. Never returned by any
        // API response — see connector-health.ts's sanitizeAccountLabel.
        channel_token: channelToken,
        resource_id: subscription?.resourceId ?? null,
      });

      const { data: integration, error: upsertError } = await db
        .from('org_integrations')
        .upsert({
          org_id: callbackOrgId,
          provider: Provider,
          account_id: identity.accountId,
          account_label: accountLabelJson,
          encrypted_tokens: toPostgresBytea(encrypted.ciphertext),
          token_kms_key_id: encrypted.keyId,
          scope: tokens.scope ?? null,
          connected_at: (deps.now?.() ?? new Date()).toISOString(),
          revoked_at: null,
          ...watchColumns,
          updated_at: (deps.now?.() ?? new Date()).toISOString(),
        }, { onConflict: 'org_id,provider,account_id' })
        .select('id')
        .single();

      if (upsertError) {
        logger.error({ error: upsertError, orgId: callbackOrgId }, 'Drive integration upsert failed');
        res.redirect(302, appendResult(returnTo, 'drive_error', 'save_failed'));
        return;
      }

      await recordIntegrationEvent(db, {
        orgId: callbackOrgId,
        integrationId: integration?.id,
        eventType: 'oauth_connected',
        status: subscription ? 'success' : 'warning',
        details: {
          account_label: identity.accountLabel,
          subscription_active: Boolean(subscription),
        },
      });

      res.redirect(302, appendResult(returnTo, 'drive', 'connected'));
    } catch (error) {
      logger.error({ error, orgId: callbackOrgId }, 'Drive OAuth callback failed');
      res.redirect(302, appendResult(returnTo, 'drive_error', 'callback_failed'));
    }
  });

  router.post('/google_drive/disconnect', async (req: Request, res: Response) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const parsed = DisconnectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const orgId = parsed.data.org_id;
    if (!(await requireOrgAdmin(db, userId, orgId))) {
      res.status(403).json({ error: 'Must be org admin to disconnect Google Drive' });
      return;
    }

    // Read the integration row BEFORE clearing — need tokens + subscription_id
    // for remote cleanup at Google.
    const { data: existing } = await db
      .from('org_integrations')
      .select('id, subscription_id, account_label, encrypted_tokens, token_kms_key_id')
      .eq('org_id', orgId)
      .eq('provider', Provider)
      .is('revoked_at', null)
      .maybeSingle();

    // Best-effort remote cleanup — stop the watch channel and revoke OAuth.
    // Failures here must NOT block the local disconnect; the user clicked
    // "Disconnect" and the local row must always be cleaned.
    const driveDeps: DriveClientDeps = { env: deps.env, fetchImpl: deps.fetchImpl };
    if (existing) {
      let accessToken: string | undefined;
      if (existing.encrypted_tokens && existing.token_kms_key_id) {
        try {
          const kms = deps.kms ?? await createDefaultKmsClient();
          const ct = typeof existing.encrypted_tokens === 'string'
            ? Buffer.from(existing.encrypted_tokens.replace(/^\\x/, ''), 'hex')
            : Buffer.from(existing.encrypted_tokens);
          const tokens = await decryptTokens(ct, { kms, keyName: existing.token_kms_key_id });
          accessToken = tokens.access_token;
        } catch (err) {
          logger.warn({ err, orgId }, 'Drive disconnect: could not decrypt tokens for remote cleanup');
        }
      }

      // Stop the watch channel at Google if we have the required identifiers
      if (accessToken && existing.subscription_id) {
        let resourceId: string | undefined;
        try {
          const label = existing.account_label ? JSON.parse(existing.account_label) : null;
          resourceId = label?.resource_id;
        } catch { /* label may not be JSON */ }

        if (resourceId) {
          try {
            await stopDriveChannel({
              accessToken,
              channelId: existing.subscription_id,
              resourceId,
              deps: driveDeps,
            });
          } catch (err) {
            logger.warn({ err, orgId }, 'Drive disconnect: stopChannel failed (best-effort)');
          }
        }
      }

      // SCRUM-1237 (AUDIT-0424-12): do NOT call revokeOAuthToken at Google.
      // Google OAuth refresh tokens are scoped per (Google account, OAuth
      // client), not per Arkova org. If the same Google identity is linked
      // to multiple Arkova orgs (one user across two tenants), revoking
      // here would yank the refresh token globally — every other Arkova
      // org that has connected the same Google account would lose access
      // immediately. Per-org disconnect MUST be local: stop our watch
      // channel above, null the encrypted_tokens row below, and let
      // Google retain the underlying grant for any sibling integration.
    }

    const now = (deps.now?.() ?? new Date()).toISOString();
    const { data, error } = await db
      .from('org_integrations')
      .update({
        revoked_at: now,
        encrypted_tokens: null,
        token_kms_key_id: null,
        subscription_id: null,
        subscription_expires_at: null,
        last_renewal_error: null,
        updated_at: now,
      })
      .eq('org_id', orgId)
      .eq('provider', Provider)
      .is('revoked_at', null)
      .select('id');

    if (error) {
      logger.error({ error, orgId }, 'Drive disconnect failed');
      res.status(500).json({ error: 'Failed to disconnect Google Drive' });
      return;
    }

    await recordIntegrationEvent(db, {
      orgId,
      integrationId: data?.[0]?.id ?? existing?.id,
      eventType: 'oauth_disconnected',
      status: 'success',
    });

    res.json({ disconnected: true });
  });

  return router;
}

// Lazy router export — `createDriveOAuthRouter()` validates
// `INTEGRATION_STATE_HMAC_SECRET` at construction time and throws when
// missing (SCRUM-1236). Eager construction at module-import time would
// crash unrelated tests that import the module without setting the env
// var. We expose a wrapper Router that defers real construction until the
// first request mounts on it.
let cachedRouter: Router | null = null;
export const driveOAuthRouter: Router = Router();
driveOAuthRouter.use((req, res, next) => {
  if (!cachedRouter) cachedRouter = createDriveOAuthRouter();
  return cachedRouter(req, res, next);
});
