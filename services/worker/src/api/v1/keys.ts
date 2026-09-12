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
import { deriveKeyStatus, isExpiredAt, keyExpiryFields, MAX_EXPIRES_IN_DAYS } from './keyExpiryStatus.js';

const router = Router();

import { FERPA_EXCEPTION_CATEGORIES, INSTITUTION_TYPES } from '../../constants/ferpa.js';
import { recordAuditEvent } from '../../utils/auditEvent.js';

/**
 * Strip secrets from outbound key responses: `key_hash` (the credential
 * derivative) and `org_id` (internal tenant UUID).
 *
 * `id` is deliberately KEPT (FD-P7, fullsoak 2026-08). SCRUM-1271-D stripped
 * it intending by-prefix v2 routes to follow; they never shipped, and the
 * frozen v1 PATCH/DELETE routes are addressed by `:keyId` — so no client
 * could revoke or delete a key at all (a CC6.8 control failure). `key_prefix`
 * cannot substitute as the address: it has no unique constraint and only 4
 * visible hex chars of entropy. This surface is ORG_ADMIN-only and org-scoped,
 * and the row's own id is not a secret.
 */
export function toPublicKey<T extends Record<string, unknown>>(row: T | null | undefined): Partial<T> {
  if (!row) return {};
  const sanitized = { ...row };
  delete (sanitized as Record<string, unknown>).org_id;
  delete (sanitized as Record<string, unknown>).key_hash;
  return sanitized;
}

/**
 * Columns safe to return to an org admin (everything but org_id + key_hash).
 * One constant, used by every route — the FD-P7 regression started as three
 * hand-maintained copies of this list drifting apart.
 */
const KEY_RESPONSE_COLUMNS =
  'id, key_prefix, name, scopes, rate_limit_tier, is_active, created_at, expires_at, last_used_at, revoked_at, revocation_reason';

/** Zod schema for key creation */
const ApiKeyScopeSchema = z.enum(API_KEY_SCOPES);

export const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ApiKeyScopeSchema).min(1).max(30).default(DEFAULT_API_KEY_SCOPES), // max mirrors docs/api/openapi.yaml maxItems (SCRUM-4984 PR)
  // SCRUM-5023: `.positive()` already forbids 0 and negatives, so this route
  // cannot write an expiry in the past — prod's one born-expired row (expiry
  // BEFORE creation) did not come from here. `.max()` is the new half: an
  // unbounded day count multiplies into a timestamp Postgres cannot store,
  // and a 100-year "expiry" is a null expiry wearing a costume.
  expires_in_days: z.number().int().positive().max(MAX_EXPIRES_IN_DAYS).optional(),
  // REG-04: FERPA requester identity verification fields
  ferpa_exception_category: z.enum(FERPA_EXCEPTION_CATEGORIES).optional(),
  institution_type: z.enum(INSTITUTION_TYPES).optional(),
  access_purpose: z.string().max(500).optional(),
});

/** Zod schema for key update */
export const UpdateKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
  revocation_reason: z.string().max(500).optional(),
  /**
   * SCRUM-5023 — ONE field controls the expiry, and it is a DURATION counted
   * from now on the server: `n` sets the expiry n days out, `null` removes it
   * entirely. A client-supplied timestamp is never accepted — it would trust
   * the caller's clock and re-open the exact door this story closes, letting
   * an owner write an already-past expiry and re-create the silent lapse by
   * hand. Same bounds as creation.
   */
  expires_in_days: z.number().int().positive().max(MAX_EXPIRES_IN_DAYS).nullable().optional(),
  /**
   * NOT a way to set the expiry — a REJECTER. `expires_at` is the response
   * field's name, so a client that reads a key and PUTs part of it back will
   * reach for it; without this it would be stripped as an unknown key and the
   * request would 200 having changed nothing. `z.null()` makes any value a
   * loud 400 pointing at `expires_in_days`, and a literal `null` is a no-op.
   */
  expires_at: z.null({
    message: 'expires_at cannot be set directly. Use expires_in_days (a number of days from now, or null to remove the expiry).',
  }).optional(),
  /**
   * SCRUM-5023 — acknowledge that the new expiry is EARLIER than the current
   * one. Off by default: `expires_in_days` replaces the expiry rather than
   * adding to it, so `30` on a key with eleven months left silently cuts ten
   * of them, and on a key with no expiry at all it invents one. Both are
   * indistinguishable from an extend at the call site and both break a live
   * partner integration. The route 409s instead unless this says otherwise.
   */
  allow_shorten: z.boolean().optional(),
}).refine(
  (d) => d.revocation_reason === undefined || d.is_active === false,
  {
    message: 'revocation_reason is only accepted when is_active is false',
    path: ['revocation_reason'],
  },
).refine(
  // One intent per request — but ONLY against a REACTIVATION. The original
  // form of this rule also rejected `{is_active: false, expires_in_days: n}`,
  // which used to revoke the key and now 400s without revoking it: the request
  // that stops a leaked credential turned into a no-op because it carried a
  // second field. A revoke is always safe to honour, so the expiry is dropped
  // (see the handler) rather than the whole request.
  (d) => !(d.expires_in_days !== undefined && d.is_active === true),
  {
    message: 'An expiry change cannot be combined with reactivating a key',
    path: ['expires_in_days'],
  },
);

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

    // Calculate expiry. ONE clock for the write and the response below: two
    // `new Date()` reads make `now + 30d` land a few milliseconds short of 30
    // whole days once `days_until_expiry` floors it, so a freshly created
    // 30-day key reports 29 and a 1-day key reports "expires today".
    const now = new Date();
    const expiresAt = expires_in_days
      ? new Date(now.getTime() + expires_in_days * 24 * 60 * 60 * 1000).toISOString()
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

    // Return raw key ONCE — Constitution 1.4.
    res.status(201).json({
      ...toPublicKey(inserted),
      ...keyExpiryFields(inserted, now),
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

    // SCRUM-5023: one clock for the whole page, so two rows with the same
    // `expires_at` can never report different `expires_in_days` because the
    // loop straddled midnight.
    const now = new Date();
    res.json({
      keys: (keys ?? []).map((row) => ({ ...toPublicKey(row), ...keyExpiryFields(row, now) })),
    });
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
      .select('id, org_id, revoked_at, expires_at, is_active')
      .eq('id', keyId)
      .eq('org_id', profile.org_id)
      .single();

    if (!existing) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    // ONE clock for this request: the expiry written below and the status
    // derived for the response are computed from the same instant.
    const now = new Date();

    const updateData: TypeSafeTablesUpdate<'api_keys'> = {};
    if (parsed.data.name !== undefined) updateData.name = parsed.data.name;

    // ── SCRUM-5023: expiry change (extend / set / clear) ──────────────────
    // A REVOKE WINS. `{is_active: false, expires_in_days: n}` is honoured as a
    // revoke with the expiry dropped: refusing the whole request would turn
    // the call that stops a leaked credential into a 400, and writing the
    // expiry too would stamp a future date on a key revocation has made
    // permanently unusable. The schema already forbids pairing an expiry with
    // a REACTIVATION, which has no safe reading either way.
    const revoking = parsed.data.is_active === false;
    const requestedDays = revoking ? undefined : parsed.data.expires_in_days;
    const wantsExpiryChange = requestedDays !== undefined;
    let expiryChange: { old: string | null; next: string | null } | null = null;

    if (wantsExpiryChange) {
      // Revocation is terminal (see the 409 below for the is_active path):
      // validate_api_key never authenticates a key with revoked_at set, so an
      // extended expiry on a revoked key would be a field the owner can read
      // and can never use. Refuse LOUDLY rather than write a lie.
      //
      // `is_active === false` is checked TOO, not just the stamp. Revocation
      // used to flip the boolean without stamping `revoked_at` (pre-FD-P7), so
      // prod holds withdrawn-but-unstamped rows; auth reads `is_active` and
      // would go on refusing one of those while the owner stared at a freshly
      // extended expiry — the same contradiction between stored state and
      // usability that this story exists to remove.
      if (deriveKeyStatus(existing) === 'revoked') {
        res.status(409).json({
          error: 'api_key_already_revoked',
          message: 'This API key was revoked and cannot be extended. Create a new key instead.',
        });
        return;
      }

      const next = requestedDays !== null
        // Counted from NOW, never from the OLD expiry. Stacking onto a stale
        // base is the failure this story is about: HakiChain's key expired
        // 2026-07-01, and `old + 30d` would land it in the past again — an
        // "extend" that visibly succeeds and changes nothing.
        //
        // ONE `now` for the write and the response. Reading the clock twice
        // makes `now + 30d` fall a few milliseconds short of 30 whole days by
        // the time the response is derived, so a 30-day key reports 29 and a
        // 1-day key reports 0 — "expires today" on a key just created.
        ? new Date(now.getTime() + requestedDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

      // AN EXTEND MUST NOT SHORTEN. `expires_in_days` REPLACES the expiry, so
      // `30` on a key with eleven months left cuts ten of them, and on a key
      // with no expiry it invents one — and the caller cannot tell either from
      // a genuine extend, because the request looks identical. A key already
      // in the past is exempt: every forward move is an improvement there, and
      // that is the remedy path the dashboard offers from the failure itself.
      if (!parsed.data.allow_shorten && next !== null && !isExpiredAt(existing.expires_at, now)) {
        const currentMs = existing.expires_at ? new Date(existing.expires_at).getTime() : Infinity;
        if (new Date(next).getTime() < currentMs) {
          res.status(409).json({
            error: 'api_key_expiry_would_shorten',
            message: existing.expires_at
              ? 'That expiry is earlier than the key\'s current one. Send allow_shorten: true to shorten it deliberately.'
              : 'This key has no expiry, so setting one shortens its life. Send allow_shorten: true to do that deliberately.',
            current_expires_at: existing.expires_at ?? null,
            requested_expires_at: next,
          });
          return;
        }
      }

      updateData.expires_at = next;
      expiryChange = { old: existing.expires_at ?? null, next };
    }

    if (parsed.data.is_active === false) {
      updateData.is_active = false;
      // CC6.8: a revoke stamps the designation, not just the boolean — the
      // first revocation wins so a repeat PATCH cannot rewrite the record.
      // The stamp is its own UPDATE guarded by `revoked_at IS NULL`: the
      // ownership probe above is read-then-write, so two concurrent first
      // revokes could both observe NULL and both stamp, the later write
      // silently shifting the timestamp and replacing the reason. With the
      // guard the database arbitrates — the losing stamp matches zero rows
      // and the persisted record survives.
      if (!existing.revoked_at) {
        const { error: stampError } = await db.from('api_keys')
          .update({
            revoked_at: new Date().toISOString(),
            revocation_reason: parsed.data.revocation_reason ?? null,
          })
          .eq('id', keyId)
          .eq('org_id', profile.org_id)
          .is('revoked_at', null);

        if (stampError) {
          res.status(500).json({ error: 'Failed to update API key' });
          return;
        }
      }
    } else if (parsed.data.is_active === true) {
      // Revocation is one-way: validate_api_key (migration 0382) never
      // authenticates a key with revoked_at set, so flipping is_active back
      // would create a row that claims active while every auth path refuses
      // it. Issue a new key instead.
      if (existing.revoked_at) {
        res.status(409).json({
          // Machine-readable code, matching apiKeyAuth's error style
          // (`api_key_revoked` / `api_key_expired`).
          error: 'api_key_already_revoked',
          message: 'This API key was revoked and cannot be reactivated. Create a new key instead.',
        });
        return;
      }
      updateData.is_active = true;
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

    // Log revocation to audit_events. The payload carries the PERSISTED
    // designation — `updated` is the post-update row — so a repeat revoke
    // logs the original revoked_at/revocation_reason rather than whatever
    // the repeat request supplied. An audit row must never contradict the
    // table it describes.
    if (parsed.data.is_active === false) {
      logAuditEvent(
        userId,
        'api_key.revoked',
        'api_key',
        keyId,
        JSON.stringify({
          key_prefix: updated.key_prefix,
          revoked_at: updated.revoked_at ?? null,
          revocation_reason: updated.revocation_reason ?? null,
        }),
        profile.org_id,
      );
    }

    // SCRUM-5023: an expiry change is a security-relevant lifecycle event —
    // it is how a key that auth had started refusing becomes usable again.
    // Like the revoke row above, the payload carries the PERSISTED value
    // (`updated`), never what the request asked for.
    if (expiryChange) {
      logAuditEvent(
        userId,
        'api_key.expiry_changed',
        'api_key',
        keyId,
        JSON.stringify({
          key_prefix: updated.key_prefix,
          old_expires_at: expiryChange.old,
          new_expires_at: updated.expires_at ?? null,
        }),
        profile.org_id,
      );
    }

    res.json({ ...toPublicKey(updated), ...keyExpiryFields(updated, now) });
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
