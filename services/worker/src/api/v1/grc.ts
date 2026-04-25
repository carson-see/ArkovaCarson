/**
 * GRC Integration API Endpoints (CML-05)
 *
 * POST   /api/v1/grc/connect       — Initiate OAuth2 connection to GRC platform
 * POST   /api/v1/grc/callback       — OAuth2 callback (exchange code for tokens)
 * GET    /api/v1/grc/connections    — List active GRC connections for org
 * POST   /api/v1/grc/test/:id      — Test a connection
 * DELETE /api/v1/grc/connections/:id — Disconnect a GRC platform
 * GET    /api/v1/grc/sync-logs     — List recent sync logs
 *
 * Constitution refs:
 *   - 1.4: OAuth tokens server-side only
 *   - 1.8: Additive endpoint, no breaking changes
 *   - 1.10: Rate limited per tier
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { createGrcAdapter, loadGrcCredentials } from '../../integrations/grc/adapters.js';
import type { GrcConnection } from '../../integrations/grc/types.js';
import {
  createDefaultKmsClient,
  encryptTokens,
  decryptTokens,
  getIntegrationTokenKeyName,
} from '../../integrations/oauth/crypto.js';

const router = Router();

const VALID_PLATFORMS = ['vanta', 'drata', 'anecdotes'] as const;

// Note: grc_connections and grc_sync_logs not yet in database.types.ts (migration 0139).
// Use callRpc pattern / type assertions until types are regenerated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const grcDb = db as any;

// ─── Validators ─────────────────────────────────────────

const ConnectSchema = z.object({
  platform: z.enum(VALID_PLATFORMS),
  redirect_uri: z.string().url(),
});

const CallbackSchema = z.object({
  platform: z.enum(VALID_PLATFORMS),
  code: z.string().min(1),
  redirect_uri: z.string().url(),
  org_id: z.string().uuid(),
});

// ─── Helper: get user's org (admin/owner only) ──────────

async function getUserAdminOrgId(userId: string): Promise<string | null> {
  const { data } = await db
    .from('org_members')
    .select('org_id, role')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();

  if (!data || (data.role !== 'admin' && data.role !== 'owner')) return null;
  return data.org_id;
}

// ─── POST /connect — Get OAuth2 authorization URL ───────

router.post('/connect', async (req: Request, res: Response) => {
  const parsed = ConnectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { platform, redirect_uri } = parsed.data;
  const creds = loadGrcCredentials();

  try {
    const adapter = createGrcAdapter(platform, creds);
    const state = crypto.randomUUID();
    const authUrl = adapter.getAuthUrl(redirect_uri, state);

    res.json({ auth_url: authUrl, state });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ platform, error: msg }, 'GRC connect failed');
    res.status(400).json({ error: msg });
  }
});

// ─── POST /callback — Exchange OAuth2 code for tokens ───

router.post('/callback', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = CallbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }

  const { platform, code, redirect_uri, org_id } = parsed.data;

  const userOrgId = await getUserAdminOrgId(userId);
  if (userOrgId !== org_id) {
    res.status(403).json({ error: 'Must be org admin to connect GRC platforms' });
    return;
  }

  const creds = loadGrcCredentials();

  try {
    const adapter = createGrcAdapter(platform, creds);
    const tokens = await adapter.exchangeAuthCode(code, redirect_uri);
    const testResult = await adapter.testConnection(tokens.access_token);

    const kms = await createDefaultKmsClient();
    const keyName = getIntegrationTokenKeyName();
    const encrypted = await encryptTokens(
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
      },
      { kms, keyName },
    );

    const { data: connection, error: upsertError } = await grcDb
      .from('grc_connections')
      .upsert({
        org_id,
        platform,
        access_token_encrypted: `\\x${encrypted.ciphertext.toString('hex')}`,
        refresh_token_encrypted: null,
        token_kms_key_id: encrypted.keyId,
        token_expires_at: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
          : null,
        external_org_id: testResult.orgName ?? null,
        scopes: tokens.scope?.split(' ') ?? [],
        is_active: true,
        created_by: userId,
      }, {
        onConflict: 'org_id,platform',
      })
      .select('id, platform, is_active, external_org_id, created_at')
      .single();

    if (upsertError) {
      logger.error({ error: upsertError }, 'GRC connection upsert failed');
      res.status(500).json({ error: 'Failed to save connection' });
      return;
    }

    logger.info({ platform, orgId: org_id, connectionId: connection?.id }, 'GRC platform connected');
    res.json({ connection, test: testResult });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ platform, error: msg }, 'GRC callback failed');
    res.status(400).json({ error: msg });
  }
});

// ─── GET /connections — List org's GRC connections ──────

router.get('/connections', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const orgId = await getUserAdminOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: 'Must be org admin' });
    return;
  }

  const { data: connections, error } = await grcDb
    .from('grc_connections')
    .select('id, platform, is_active, external_org_id, last_sync_at, last_sync_status, sync_count, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: 'Failed to list connections' });
    return;
  }

  res.json({ connections: connections ?? [] });
});

// ─── POST /test/:id — Test connection validity ──────────

router.post('/test/:id', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const connectionId = req.params.id;

  const { data: conn, error } = await grcDb
    .from('grc_connections')
    .select('*')
    .eq('id', connectionId)
    .single() as { data: GrcConnection | null; error: unknown };

  if (error || !conn) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  const orgId = await getUserAdminOrgId(userId);
  if (orgId !== conn.org_id) {
    res.status(403).json({ error: 'Must be org admin' });
    return;
  }

  const creds = loadGrcCredentials();

  try {
    const adapter = createGrcAdapter(conn.platform, creds);

    const kms = await createDefaultKmsClient();
    const decrypted = conn.access_token_encrypted && conn.token_kms_key_id
      ? await decryptTokens(
          typeof conn.access_token_encrypted === 'string'
            ? Buffer.from(conn.access_token_encrypted.replace(/^\\x/, ''), 'hex')
            : Buffer.from(conn.access_token_encrypted),
          { kms, keyName: conn.token_kms_key_id },
        )
      : null;

    if (!decrypted) {
      res.json({ valid: false, error: 'No encrypted tokens found' });
      return;
    }

    let accessToken = decrypted.access_token;
    if (conn.token_expires_at && new Date(conn.token_expires_at) < new Date() && decrypted.refresh_token) {
      const refreshed = await adapter.refreshAccessToken(decrypted.refresh_token);
      accessToken = refreshed.access_token;

      const newEncrypted = await encryptTokens(
        { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token ?? decrypted.refresh_token },
        { kms, keyName: getIntegrationTokenKeyName() },
      );
      await grcDb.from('grc_connections').update({
        access_token_encrypted: `\\x${newEncrypted.ciphertext.toString('hex')}`,
        token_kms_key_id: newEncrypted.keyId,
        token_expires_at: refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
          : conn.token_expires_at,
      }).eq('id', connectionId);
    }

    const testResult = await adapter.testConnection(accessToken);
    res.json(testResult);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ valid: false, error: msg });
  }
});

// ─── DELETE /connections/:id — Disconnect platform ──────

router.delete('/connections/:id', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const connectionId = req.params.id;

  const { data: conn } = await grcDb
    .from('grc_connections')
    .select('org_id, platform')
    .eq('id', connectionId)
    .single() as { data: { org_id: string; platform: string } | null };

  if (!conn) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }

  const orgId = await getUserAdminOrgId(userId);
  if (orgId !== conn.org_id) {
    res.status(403).json({ error: 'Must be org admin' });
    return;
  }

  await grcDb.from('grc_connections').update({ is_active: false }).eq('id', connectionId);

  logger.info({ connectionId, platform: conn.platform }, 'GRC platform disconnected');
  res.json({ success: true });
});

// ─── GET /sync-logs — Recent sync activity ──────────────

router.get('/sync-logs', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const orgId = await getUserAdminOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: 'Must be org admin' });
    return;
  }

  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

  const { data: connections } = await grcDb
    .from('grc_connections')
    .select('id')
    .eq('org_id', orgId) as { data: { id: string }[] | null };

  if (!connections?.length) {
    res.json({ logs: [] });
    return;
  }

  const connectionIds = connections.map((c: { id: string }) => c.id);

  const { data: logs, error } = await grcDb
    .from('grc_sync_logs')
    .select('id, connection_id, anchor_id, status, evidence_type, external_evidence_id, error_message, duration_ms, created_at')
    .in('connection_id', connectionIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    res.status(500).json({ error: 'Failed to fetch sync logs' });
    return;
  }

  res.json({ logs: logs ?? [] });
});

export { router as grcRouter };
