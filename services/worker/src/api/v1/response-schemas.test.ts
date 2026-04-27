/**
 * SCRUM-1442 (R2-8 sub-E) — response-schemas.ts tests.
 *
 * Pin the contract that every v1 response Zod schema rejects banned-key
 * insertion (forward-compat: a future regression cannot reintroduce the
 * leak by adding a new field), and the `findBannedKeys` helper detects
 * the canonical leak set documented in CLAUDE.md §6.
 */

import { describe, it, expect } from 'vitest';
import {
  KeyResponseShape,
  AnchorReceiptShape,
  AttestationCreateResponseShape,
  AttestationEvidenceShape,
  InsufficientCreditsShape,
  BANNED_RESPONSE_KEYS,
  findBannedKeys,
} from './response-schemas.js';

describe('SCRUM-1442 — v1 response schemas', () => {
  it('KeyResponseShape rejects unknown fields (catches future leak regressions)', () => {
    const result = KeyResponseShape.safeParse({
      key_prefix: 'arkv_live_abc',
      name: 'Test',
      scopes: ['verify'],
      rate_limit_tier: 'paid',
      is_active: true,
      created_at: '2026-04-27T00:00:00Z',
      expires_at: null,
      // Future regression: someone adds the internal id field back.
      id: 'should-not-pass',
    });
    expect(result.success).toBe(false);
  });

  it('KeyResponseShape accepts the public-safe shape', () => {
    const result = KeyResponseShape.safeParse({
      key_prefix: 'arkv_live_abc',
      name: 'Test',
      scopes: ['verify'],
      rate_limit_tier: 'paid',
      is_active: true,
      created_at: '2026-04-27T00:00:00Z',
      expires_at: null,
    });
    expect(result.success).toBe(true);
  });

  it('AnchorReceiptShape pins ARK-YYYY-XXX public_id format', () => {
    const ok = AnchorReceiptShape.safeParse({
      public_id: 'ARK-2026-ABCDEF12',
      fingerprint: 'a'.repeat(64),
      status: 'PENDING',
      created_at: '2026-04-27T00:00:00Z',
      record_uri: 'https://arkova.ai/verify/ARK-2026-ABCDEF12',
    });
    expect(ok.success).toBe(true);

    const bad = AnchorReceiptShape.safeParse({
      public_id: 'wrong-format',
      fingerprint: 'a'.repeat(64),
      status: 'PENDING',
      created_at: '2026-04-27T00:00:00Z',
      record_uri: 'https://arkova.ai/verify/ARK-2026-ABCDEF12',
    });
    expect(bad.success).toBe(false);
  });

  it('AttestationCreateResponseShape accepts the public-safe shape', () => {
    const result = AttestationCreateResponseShape.safeParse({
      public_id: 'arkv_atte_abc',
      attestation_id: 'arkv_atte_abc', // v1 back-compat field — same as public_id
      attestation_type: 'employment',
      status: 'ACTIVE',
      fingerprint: 'a'.repeat(64),
      created_at: '2026-04-27T00:00:00Z',
      verify_url: 'https://arkova.ai/verify/arkv_atte_abc',
    });
    expect(result.success).toBe(true);
  });

  it('AttestationCreateResponseShape rejects unknown fields (strict shape)', () => {
    // Future regression: someone adds an `id` (internal UUID) field back.
    const result = AttestationCreateResponseShape.safeParse({
      public_id: 'arkv_atte_abc',
      attestation_id: 'arkv_atte_abc',
      attestation_type: 'employment',
      status: 'ACTIVE',
      fingerprint: 'a'.repeat(64),
      created_at: '2026-04-27T00:00:00Z',
      verify_url: 'https://arkova.ai/verify/arkv_atte_abc',
      id: 'attestation-internal-uuid', // banned
    });
    expect(result.success).toBe(false);
  });

  it('AttestationEvidenceShape strips the internal id (no field for it)', () => {
    const ok = AttestationEvidenceShape.safeParse({
      evidence_type: 'photo',
      description: 'Selfie of credential',
      fingerprint: 'b'.repeat(64),
      created_at: '2026-04-27T00:00:00Z',
    });
    expect(ok.success).toBe(true);

    const withId = AttestationEvidenceShape.safeParse({
      id: 'evidence-uuid',
      evidence_type: 'photo',
      description: 'Selfie',
      fingerprint: 'b'.repeat(64),
      created_at: '2026-04-27T00:00:00Z',
    });
    expect(withId.success).toBe(false);
  });

  it('InsufficientCreditsShape pins the SCRUM-1170-B 402 body', () => {
    const ok = InsufficientCreditsShape.safeParse({
      error: 'insufficient_credits',
      message: 'Organization has insufficient anchor credits for this cycle.',
      balance: 0,
      required: 1,
    });
    expect(ok.success).toBe(true);
  });
});

describe('findBannedKeys helper (SCRUM-1442 CI lint)', () => {
  it('returns empty array for a clean response body', () => {
    expect(
      findBannedKeys({
        public_id: 'arkv_anc_abc',
        fingerprint: 'a'.repeat(64),
        status: 'PENDING',
      }),
    ).toEqual([]);
  });

  it('detects every documented banned key', () => {
    const dirty: Record<string, unknown> = {};
    for (const key of BANNED_RESPONSE_KEYS) {
      dirty[key] = 'leak';
    }
    const hits = findBannedKeys(dirty);
    expect(new Set(hits)).toEqual(new Set(BANNED_RESPONSE_KEYS));
  });

  it('detects partial leaks (org_id only)', () => {
    expect(findBannedKeys({ public_id: 'x', org_id: 'leaked-org-uuid' })).toEqual(['org_id']);
  });

  it('does not flag legitimate UUID-shaped fields with non-banned names', () => {
    // chain_tx_id is a legitimate Bitcoin tx id, not banned.
    expect(findBannedKeys({ public_id: 'x', chain_tx_id: 'abc123' })).toEqual([]);
  });
});
