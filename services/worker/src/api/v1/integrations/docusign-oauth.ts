/**
 * DocuSign OAuth API (SCRUM-1101)
 *
 * User-facing endpoints:
 *   POST /api/v1/integrations/docusign/oauth/start
 *   GET  /api/v1/integrations/docusign/oauth/callback
 *   POST /api/v1/integrations/docusign/disconnect
 *
 * Mirrors the Drive OAuth router (drive-oauth.ts, SCRUM-1168). Tokens are
 * encrypted with the reviewed OAuth crypto helper before storage. Cleartext
 * access/refresh token payload never reaches Postgres or logs.
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
  type DocusignClientDeps,
} from '../../../integrations/oauth/docusign.js';
import {
  createDefaultKmsClient,
  encryptTokens,
  type KmsClient,
} from '../../../integrations/oauth/crypto.js';

// org_integrations landed after generated worker DB types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = any;

interface DocusignOAuthDeps {
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

const Provider = 'docusign' as const;
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
    logger.warn({ error, orgId: args.orgId, eventType: args.eventType }, 'DocuSign integration event insert failed');
  }
}

export function createDocusignOAuthRouter(deps: DocusignOAuthDeps = {}): Router {
  const router = Router();
  const db = deps.db ?? defaultDb;

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

      const kms = deps.kms ?? await createDefaultKmsClient();
      const expiresAt = new Date(
        (deps.now?.() ?? new Date()).getTime() + tokens.expires_in * 1000,
      ).toISOString();
      const encrypted = await encryptTokens({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        expires_at: expiresAt,
        scope: tokens.scope,
      }, { kms, env: deps.env });

      const { data: integration, error: upsertError } = await db
        .from('org_integrations')
        .upsert({
          org_id: payload.orgId,
          provider: Provider,
          account_id: account.account_id,
          account_label: account.account_name ?? info.email ?? null,
          base_uri: account.base_uri,
          encrypted_tokens: toPostgresBytea(encrypted.ciphertext),
          token_kms_key_id: encrypted.keyId,
          scope: tokens.scope ?? null,
          connected_at: (deps.now?.() ?? new Date()).toISOString(),
          revoked_at: null,
          updated_at: (deps.now?.() ?? new Date()).toISOString(),
        }, { onConflict: 'org_id,provider,account_id' })
        .select('id')
        .single();

      if (upsertError) {
        logger.error({ error: upsertError, orgId: payload.orgId }, 'DocuSign integration upsert failed');
        res.redirect(302, appendResult(returnTo, 'docusign_error', 'save_failed'));
        return;
      }

      await recordIntegrationEvent(db, {
        orgId: payload.orgId,
        integrationId: integration?.id,
        eventType: 'oauth_connected',
        status: 'success',
        details: {
          account_label: account.account_name ?? null,
          account_id: account.account_id,
        },
      });

      res.redirect(302, appendResult(returnTo, 'docusign', 'connected'));
    } catch (error) {
      logger.error({ error, orgId: payload.orgId }, 'DocuSign OAuth callback failed');
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
    const { data, error } = await db
      .from('org_integrations')
      .update({
        revoked_at: now,
        encrypted_tokens: null,
        token_kms_key_id: null,
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

    res.json({ disconnected: true });
  });

  return router;
}

export const docusignOAuthRouter = createDocusignOAuthRouter();
