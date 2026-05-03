/**
 * SCRUM-1442 (R2-8 sub-E) — Zod response schemas for v1 API endpoints.
 *
 * Foundational module the rest of the SCRUM-1271 sub-tickets build on:
 *   - sub-D (keys.ts) → uses `KeyResponseShape`
 *   - sub-B (attestations.ts) → uses `AttestationResponseShape`
 *   - sub-C (webhooks.ts) → uses `WebhookEndpointResponseShape`
 *
 * Schemas are `.strict()` so a future regression that tries to pass an
 * internal UUID through (e.g. a fresh `id` field) will fail Zod parse +
 * the route returns the wrong shape (caught by tests). The CI lint hook
 * lives in `scripts/ci/check-v1-response-shapes.ts` (separate ticket).
 *
 * **Frozen-API note (CLAUDE.md §1.8):** these schemas describe the v1
 * shape that customer integrations rely on. Adding a new optional/nullable
 * field is OK; renaming or removing a field is a breaking change that
 * requires a v2 namespace and 12-month deprecation. Update this file
 * carefully — every change is a customer-facing contract change.
 */

import { z } from 'zod';

// ─── Shared primitives ────────────────────────────────────────────────────
const PublicId = z.string().min(3).max(120);
const Timestamp = z.string().datetime({ offset: true });

// ─── /api/v1/keys — list / detail / create response shape ────────────────
//
// SCRUM-1271-D — `key_prefix` is the public identifier; `id` (UUID) and
// `key_hash` (HMAC) are stripped from the body. The DELETE / PATCH path
// param still takes `:keyId` because v1 routes are frozen — full rename
// → key_prefix-only happens in /api/v2/keys (SCRUM-1441).
export const KeyResponseShape = z
  .object({
    key_prefix: z.string().regex(/^arkv_[a-z]+_[a-z0-9]+$/i, 'expected arkv_<env>_<random>'),
    name: z.string().max(200),
    scopes: z.array(z.string()).min(1),
    rate_limit_tier: z.enum(['free', 'paid', 'enterprise']),
    is_active: z.boolean(),
    created_at: Timestamp,
    expires_at: Timestamp.nullable(),
    last_used_at: Timestamp.nullable().optional(),
    // Present only on POST (create) — the raw key, shown ONCE.
    key: z.string().optional(),
    warning: z.string().optional(),
  })
  .strict();

export type KeyResponse = z.infer<typeof KeyResponseShape>;

// ─── /api/v1/attestations — create / detail response shape ───────────────
//
// SCRUM-1271-B — drop internal `id` UUID. `attestation_id` is preserved
// in v1 for back-compat but holds the same value as `public_id` (no UUID
// surface). Evidence items keep a legacy `id` key, but it is the same public
// evidence identifier as `public_id` and never the internal evidence UUID.
export const AttestationEvidenceShape = z
  .object({
    id: PublicId,
    public_id: PublicId,
    evidence_type: z.string().max(60),
    description: z.string().nullable().optional(),
    fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/),
    mime: z.string().nullable(),
    size: z.number().int().nonnegative().nullable(),
    created_at: Timestamp,
  })
  .strict()
  .refine((item) => item.id === item.public_id, {
    message: 'evidence id must mirror public_id',
    path: ['id'],
  });

export const AttestationCreateResponseShape = z
  .object({
    public_id: PublicId,
    attestation_id: PublicId, // v1 back-compat field — same value as public_id
    attestation_type: z.string().max(60),
    status: z.string().max(20),
    fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/),
    created_at: Timestamp,
    verify_url: z.string().url(),
    evidence_count: z.number().int().nonnegative().optional(),
    warning: z.string().optional(),
  })
  .strict();

export type AttestationCreateResponse = z.infer<typeof AttestationCreateResponseShape>;
export type AttestationEvidence = z.infer<typeof AttestationEvidenceShape>;

// ─── /api/v1/anchor — submit response shape ──────────────────────────────
export const AnchorReceiptShape = z
  .object({
    public_id: z.string().regex(/^ARK-\d{4}-[A-Z0-9]+$/),
    fingerprint: z.string().regex(/^[a-fA-F0-9]{64}$/),
    status: z.enum(['PENDING', 'BATCHED', 'SUBMITTED', 'CONFIRMED', 'SECURED', 'REVOKED', 'EXPIRED', 'SUPERSEDED']),
    created_at: Timestamp,
    record_uri: z.string().url(),
  })
  .strict();

export type AnchorReceipt = z.infer<typeof AnchorReceiptShape>;

// ─── /api/v1/anchor — insufficient_credits 402 shape (SCRUM-1170-B) ──────
export const InsufficientCreditsShape = z
  .object({
    error: z.literal('insufficient_credits'),
    message: z.string(),
    balance: z.number().int().nonnegative(),
    required: z.number().int().positive(),
  })
  .strict();

export type InsufficientCredits = z.infer<typeof InsufficientCreditsShape>;

// ─── Banned-keys allowlist for the CI lint ───────────────────────────────
//
// scripts/ci/check-v1-response-shapes.ts walks every v1 handler's
// `res.json(...)` arg and asserts no key in the literal matches this list.
// Add new banned keys here when a new internal UUID surface is identified.
export const BANNED_RESPONSE_KEYS = [
  'org_id',         // internal organization UUID
  'user_id',        // internal auth.users UUID
  'actor_id',       // internal auth.users UUID (audit_events FK)
  'registered_by',  // internal auth.users UUID (agents.registered_by)
  'granted_by',     // internal auth.users UUID (org_credit_allocations)
  'key_hash',       // HMAC of the raw API key
  'secret_hash',    // HMAC of webhook secrets
  'parent_org_id',  // internal organization UUID (only safe inside RPC results, not response bodies)
  'child_org_id',   // same
] as const;

export type BannedResponseKey = (typeof BANNED_RESPONSE_KEYS)[number];

/**
 * Pure helper — returns a list of banned keys present in `obj`. Used by both
 * runtime tests and the CI lint to assert no v1 response body leaks an
 * internal-UUID field.
 */
export function findBannedKeys(obj: Record<string, unknown>): BannedResponseKey[] {
  const hits: BannedResponseKey[] = [];
  for (const key of BANNED_RESPONSE_KEYS) {
    if (key in obj) hits.push(key);
  }
  return hits;
}
