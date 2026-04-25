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

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
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
  orgId: string;
  userId: string;
  nonce: string;
  returnTo: string;
  iat: number;
}

const Provider = 'google_drive' as const;
const StateTtlMs = 10 * 60 * 1000;
const StartSchema = z.object({
  org_id: z.string().uuid(),
  return_to: z.string().url().optional(),
});

function getUserId(req: Request): string | undefined {
  return (req as unknown as { userId?: string }).userId;
}

function base64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function hmac(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function getStateSecret(deps: DriveOAuthDeps): string {
  return deps.stateSecret ?? config.supabaseJwtSecret ?? config.supabaseServiceKey;
}

function signState(payload: StatePayload, deps: DriveOAuthDeps): string {
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${hmac(encoded, getStateSecret(deps))}`;
}

function verifyState(state: string, deps: DriveOAuthDeps): StatePayload | null {
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
  return `${getRequestBaseUrl(req)}/api/v1/integrations/google_drive/oauth/callback`;
}

function buildWebhookAddress(req: Request): string {
  // Must match the path the v1 router mounts the Drive webhook handler at;
  // drift here produces silent 404s on every Drive push.
  return `${getRequestBaseUrl(req)}${WEBHOOK_PATHS.GOOGLE_DRIVE}`;
}

function sanitizeReturnTo(returnTo: string | undefined, orgId: string, deps: DriveOAuthDeps): string {
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

    const orgId = parsed.data.org_id;
    if (!(await requireOrgAdmin(db, userId, orgId))) {
      res.status(403).json({ error: 'Must be org admin to connect Google Drive' });
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
    const payload = verifyState(state, deps);
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

    if (!(await requireOrgAdmin(db, payload.userId, payload.orgId))) {
      res.redirect(302, appendResult(returnTo, 'drive_error', 'not_authorized'));
      return;
    }

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
      let subscription: { resourceId: string; expiration: string } | null = null;
      try {
        subscription = await createChangesWatch({
          accessToken: tokens.access_token,
          channelId,
          address: buildWebhookAddress(req),
          token: payload.orgId,
          deps: driveDeps,
        });
      } catch (watchError) {
        logger.warn({ watchError, orgId: payload.orgId }, 'Drive changes.watch failed; saving OAuth connection without subscription');
      }

      const accountLabelJson = JSON.stringify({
        email: identity.accountLabel,
        channel_token: payload.orgId,
        resource_id: subscription?.resourceId ?? null,
      });

      const { data: integration, error: upsertError } = await db
        .from('org_integrations')
        .upsert({
          org_id: payload.orgId,
          provider: Provider,
          account_id: identity.accountId,
          account_label: accountLabelJson,
          encrypted_tokens: toPostgresBytea(encrypted.ciphertext),
          token_kms_key_id: encrypted.keyId,
          scope: tokens.scope ?? null,
          connected_at: (deps.now?.() ?? new Date()).toISOString(),
          revoked_at: null,
          subscription_id: subscription ? channelId : null,
          subscription_expires_at: subscription?.expiration ?? null,
          last_renewal_error: subscription ? null : 'changes.watch registration failed during OAuth callback',
          updated_at: (deps.now?.() ?? new Date()).toISOString(),
        }, { onConflict: 'org_id,provider,account_id' })
        .select('id')
        .single();

      if (upsertError) {
        logger.error({ error: upsertError, orgId: payload.orgId }, 'Drive integration upsert failed');
        res.redirect(302, appendResult(returnTo, 'drive_error', 'save_failed'));
        return;
      }

      await recordIntegrationEvent(db, {
        orgId: payload.orgId,
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
      logger.error({ error, orgId: payload.orgId }, 'Drive OAuth callback failed');
      res.redirect(302, appendResult(returnTo, 'drive_error', 'callback_failed'));
    }
  });

  router.post('/google_drive/disconnect', async (req: Request, res: Response) => {
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

export const driveOAuthRouter = createDriveOAuthRouter();
