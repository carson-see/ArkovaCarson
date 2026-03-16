/**
 * API Key CRUD Endpoints (P4.5-TS-07)
 *
 * Manages API keys for the Verification API.
 * All key operations require Supabase JWT auth (org admin).
 *
 * Constitution 1.4: Raw keys are shown ONCE at creation, then only
 * the HMAC-SHA256 hash is stored. Raw keys cannot be retrieved later.
 *
 * Key lifecycle events (create, revoke) are logged to audit_events.
 *
 */

import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { generateApiKey } from '../../middleware/apiKeyAuth.js';

const router = Router();

/** Zod schema for key creation */
const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).default(['verify']),
  expires_in_days: z.number().int().positive().optional(),
});

/** Zod schema for key update */
const UpdateKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
});

/**
 * Log an audit event (fire-and-forget).
 */
function logAuditEvent(actorId: string, eventType: string, targetType: string, targetId: string, details?: string) {
  void db.from('audit_events')
    .insert({
      actor_id: actorId,
      event_type: eventType,
      event_category: 'api_key',
      target_type: targetType,
      target_id: targetId,
      details: details ?? null,
    });
}

/**
 * POST /api/v1/keys — Create a new API key
 *
 * Returns the raw key ONCE. It cannot be retrieved again.
 */
router.post('/', async (req, res) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = CreateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { name, scopes, expires_in_days } = parsed.data;
  const hmacSecret = req.hmacSecret;
  if (!hmacSecret) {
    logger.error('API_KEY_HMAC_SECRET not configured');
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  try {
    // Look up user's org
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'User must belong to an organization to create API keys' });
      return;
    }

    // Generate key
    const { raw, hash, prefix } = generateApiKey(hmacSecret);

    // Calculate expiry
    const expiresAt = expires_in_days
      ? new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    // Insert into DB (hash only — raw key never stored)
    const { data: inserted, error } = await db.from('api_keys')
      .insert({
        org_id: profile.org_id,
        key_prefix: prefix,
        key_hash: hash,
        name,
        scopes,
        expires_at: expiresAt,
        created_by: userId,
      })
      .select('id, key_prefix, name, scopes, rate_limit_tier, is_active, created_at, expires_at')
      .single();

    if (error || !inserted) {
      logger.error({ error }, 'Failed to create API key');
      res.status(500).json({ error: 'Failed to create API key' });
      return;
    }

    // Log audit event
    logAuditEvent(userId, 'api_key.created', 'api_key', inserted.id, JSON.stringify({ key_prefix: prefix, name, scopes }));

    // Return raw key ONCE — Constitution 1.4
    res.status(201).json({
      ...inserted,
      key: raw,
      warning: 'Save this key now. It cannot be retrieved again.',
    });
  } catch (err) {
    logger.error({ error: err }, 'API key creation failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/keys — List API keys for the user's org
 *
 * Returns key metadata only (never the raw key or hash).
 */
router.get('/', async (req, res) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'User must belong to an organization' });
      return;
    }

    const { data: keys, error } = await db.from('api_keys')
      .select('id, key_prefix, name, scopes, rate_limit_tier, is_active, created_at, expires_at, last_used_at')
      .eq('org_id', profile.org_id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ error }, 'Failed to list API keys');
      res.status(500).json({ error: 'Failed to list API keys' });
      return;
    }

    res.json({ keys: keys ?? [] });
  } catch (err) {
    logger.error({ error: err }, 'API key listing failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/v1/keys/:keyId — Update key name or revoke
 */
router.patch('/:keyId', async (req, res) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const parsed = UpdateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { keyId } = req.params;

  try {
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'User must belong to an organization' });
      return;
    }

    // Verify key belongs to user's org
    const { data: existing } = await db.from('api_keys')
      .select('id, org_id')
      .eq('id', keyId)
      .eq('org_id', profile.org_id)
      .single();

    if (!existing) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    const updateData: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
    if (parsed.data.is_active !== undefined) updateData.is_active = parsed.data.is_active;

    const { data: updated, error } = await db.from('api_keys')
      .update(updateData)
      .eq('id', keyId)
      .select('id, key_prefix, name, scopes, rate_limit_tier, is_active, created_at, expires_at, last_used_at')
      .single();

    if (error || !updated) {
      res.status(500).json({ error: 'Failed to update API key' });
      return;
    }

    // Log revocation to audit_events
    if (parsed.data.is_active === false) {
      logAuditEvent(userId, 'api_key.revoked', 'api_key', keyId, JSON.stringify({ key_prefix: updated.key_prefix }));
    }

    res.json(updated);
  } catch (err) {
    logger.error({ error: err }, 'API key update failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/v1/keys/:keyId — Permanently delete a key
 */
router.delete('/:keyId', async (req, res) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { keyId } = req.params;

  try {
    const { data: profile } = await db
      .from('profiles')
      .select('org_id')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'User must belong to an organization' });
      return;
    }

    const { error } = await db.from('api_keys')
      .delete()
      .eq('id', keyId)
      .eq('org_id', profile.org_id);

    if (error) {
      res.status(500).json({ error: 'Failed to delete API key' });
      return;
    }

    // Log deletion to audit_events
    logAuditEvent(userId, 'api_key.deleted', 'api_key', keyId);

    res.status(204).end();
  } catch (err) {
    logger.error({ error: err }, 'API key deletion failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Extend Express Request for auth user ID and HMAC secret
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUserId?: string;
      hmacSecret?: string;
    }
  }
}

export { router as keysRouter };
