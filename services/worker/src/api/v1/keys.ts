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
import type { TypeSafeTablesUpdate } from '../../types/database-overrides.js';
import { logger } from '../../utils/logger.js';
import { generateApiKey } from '../../middleware/apiKeyAuth.js';
import { API_KEY_SCOPES, DEFAULT_API_KEY_SCOPES } from '../apiScopes.js';

const router = Router();

import { FERPA_EXCEPTION_CATEGORIES, INSTITUTION_TYPES } from '../../constants/ferpa.js';
import { recordAuditEvent } from '../../utils/auditEvent.js';

/**
 * Sanitize a key row for an outbound response.
 *
 * Strips the tenant id (`org_id`) and the secret (`key_hash`). It deliberately
 * KEEPS `id`.
 *
 * SCRUM-1271-D removed `id` here, reading CLAUDE.md §6 as a blanket ban. But
 * PATCH/DELETE address a key by `:keyId` (= `api_keys.id`), so a response
 * without `id` left an org admin able to SEE their keys and unable to NAME the
 * one they wanted revoked: `ApiKeySettings.tsx` passes `apiKey.id`, which was
 * `undefined` at runtime, so Revoke issued `PATCH /api/v1/keys/undefined` and
 * 404'd. That made the CC6.8 key-lifecycle control unreachable by customers —
 * FD-P7 / BUG-2026-08-12, found in the fullsoak-2026-08 Day-0 audit.
 *
 * §6's ban is about *public* surfaces. Every route in this file sits behind a
 * Supabase JWT + an ORG_ADMIN check + an org-scoped query, and the only `id` a
 * caller can see belongs to a key their own org owns. `org_id` stays stripped
 * because that one really is a tenant identifier, and `key_hash` because it is
 * the secret.
 *
 * This is also the state docs/runbooks/v1-uuid-leak-deprecation.md asks for:
 * Phase 3 has v1 carrying "both `id` AND `public_id`" through the deprecation
 * window. The id-free shape is Phase 4, gated on a v2 namespace and a
 * `public_id` column on `api_keys` — neither of which exists yet. Removing the
 * identifier before shipping its replacement is what broke revocation.
 *
 * Exported so keys-sanitizer.test.ts pins THIS function rather than a local
 * re-implementation of it.
 */
export function toPublicKey<T extends Record<string, unknown>>(row: T | null | undefined): Partial<T> {
  if (!row) return {};
  const sanitized = { ...row };
  delete (sanitized as Record<string, unknown>).org_id;
  delete (sanitized as Record<string, unknown>).key_hash;
  return sanitized;
}

/** Columns safe to return to an org admin (everything but org_id + key_hash). */
const KEY_RESPONSE_COLUMNS =
  'id, key_prefix, name, scopes, rate_limit_tier, is_active, created_at, expires_at, last_used_at, revoked_at, revocation_reason';

/** Zod schema for key creation */
const ApiKeyScopeSchema = z.enum(API_KEY_SCOPES);

export const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ApiKeyScopeSchema).min(1).default(DEFAULT_API_KEY_SCOPES),
  expires_in_days: z.number().int().positive().optional(),
  // REG-04: FERPA requester identity verification fields
  ferpa_exception_category: z.enum(FERPA_EXCEPTION_CATEGORIES).optional(),
  institution_type: z.enum(INSTITUTION_TYPES).optional(),
  access_purpose: z.string().max(500).optional(),
});

/**
 * Zod schema for key update.
 *
 * `revocation_reason` is additive and optional (CLAUDE.md §1.8 permits that
 * without a version bump). It exists so a revocation carries WHY alongside
 * WHEN — the pair an auditor asks for under CC6.8. Ignored unless the same
 * request revokes the key.
 */
export const UpdateKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
  revocation_reason: z.string().max(500).optional(),
});

/**
 * Log an audit event (fire-and-forget).
 */
function logAuditEvent(actorId: string, eventType: string, targetType: string, targetId: string, details?: string, orgId?: string) {
  void recordAuditEvent({
      actor_id: actorId,
      org_id: orgId ?? undefined,
      event_type: eventType,
      event_category: 'API',
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

  const { name, scopes, expires_in_days, ...ferpaFields } = parsed.data;
  const { ferpa_exception_category, institution_type, access_purpose } = ferpaFields;
  const hmacSecret = req.hmacSecret;
  if (!hmacSecret) {
    logger.error('API_KEY_HMAC_SECRET not configured');
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  try {
    // Look up user's org + role (AUTH-06: require ORG_ADMIN)
    const { data: profile } = await db
      .from('profiles')
      .select('org_id, role')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'User must belong to an organization to create API keys' });
      return;
    }

    if (profile.role !== 'ORG_ADMIN') {
      res.status(403).json({ error: 'Only organization admins can manage API keys' });
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
        ferpa_exception_category: ferpa_exception_category ?? null,
        institution_type: institution_type ?? null,
        access_purpose: access_purpose ?? null,
        ferpa_verified: !!ferpa_exception_category,
      })
      .select(KEY_RESPONSE_COLUMNS)
      .single();

    if (error || !inserted) {
      logger.error({ error }, 'Failed to create API key');
      res.status(500).json({ error: 'Failed to create API key' });
      return;
    }

    // Log audit event
    logAuditEvent(userId, 'api_key.created', 'api_key', inserted.id, JSON.stringify({ key_prefix: prefix, name, scopes }), profile.org_id);

    // Return raw key ONCE — Constitution 1.4. SCRUM-1271-D: omit internal id.
    res.status(201).json({
      ...toPublicKey(inserted),
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
      .select('org_id, role')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'User must belong to an organization' });
      return;
    }

    if (profile.role !== 'ORG_ADMIN') {
      res.status(403).json({ error: 'Only organization admins can manage API keys' });
      return;
    }

    const { data: keys, error } = await db.from('api_keys')
      .select(KEY_RESPONSE_COLUMNS)
      .eq('org_id', profile.org_id)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error({ error }, 'Failed to list API keys');
      res.status(500).json({ error: 'Failed to list API keys' });
      return;
    }

    res.json({ keys: (keys ?? []).map(toPublicKey) });
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
      .select('org_id, role')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'User must belong to an organization' });
      return;
    }

    if (profile.role !== 'ORG_ADMIN') {
      res.status(403).json({ error: 'Only organization admins can manage API keys' });
      return;
    }

    // Verify key belongs to user's org
    const { data: existing } = await db.from('api_keys')
      .select('id, org_id, revoked_at')
      .eq('id', keyId)
      .eq('org_id', profile.org_id)
      .single();

    if (!existing) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    // Revocation is terminal. Un-revoking a key that was pulled because it
    // leaked hands the leak back, and it would also split the two auth paths
    // apart: migration 0382 adds `revoked_at IS NULL` to `validate_api_key`,
    // so a row with is_active=true AND revoked_at set authenticates on the
    // worker and fails on the edge/MCP path. Issue a new key instead.
    if (parsed.data.is_active === true && existing.revoked_at) {
      res.status(409).json({
        error: 'api_key_already_revoked',
        message: 'This API key was revoked and cannot be reactivated. Create a new key instead.',
      });
      return;
    }

    const updateData: TypeSafeTablesUpdate<'api_keys'> = {};
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
    if (parsed.data.is_active !== undefined) updateData.is_active = parsed.data.is_active;

    // Stamp the revocation. Only on the first one — re-revoking an already
    // revoked key must not overwrite the timestamp that says when access
    // actually ended. Keys revoked before this fix carry a NULL `revoked_at`,
    // so a re-revoke backfills them.
    if (parsed.data.is_active === false && !existing.revoked_at) {
      updateData.revoked_at = new Date().toISOString();
      updateData.revocation_reason = parsed.data.revocation_reason ?? null;
    }

    const { data: updated, error } = await db.from('api_keys')
      .update(updateData)
      .eq('id', keyId)
      .eq('org_id', profile.org_id)
      .select(KEY_RESPONSE_COLUMNS)
      .single();

    if (error || !updated) {
      res.status(500).json({ error: 'Failed to update API key' });
      return;
    }

    // Log revocation to audit_events
    if (parsed.data.is_active === false) {
      logAuditEvent(
        userId,
        'api_key.revoked',
        'api_key',
        keyId,
        JSON.stringify({
          key_prefix: updated.key_prefix,
          revoked_at: updateData.revoked_at ?? existing.revoked_at,
          revocation_reason: parsed.data.revocation_reason ?? null,
        }),
        profile.org_id,
      );
    }

    res.json(toPublicKey(updated));
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
      .select('org_id, role')
      .eq('id', userId)
      .single();

    if (!profile?.org_id) {
      res.status(403).json({ error: 'User must belong to an organization' });
      return;
    }

    if (profile.role !== 'ORG_ADMIN') {
      res.status(403).json({ error: 'Only organization admins can manage API keys' });
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
    logAuditEvent(userId, 'api_key.deleted', 'api_key', keyId, undefined, profile.org_id);

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
