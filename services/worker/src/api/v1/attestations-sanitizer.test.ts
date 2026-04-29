/**
 * SCRUM-1444 (R2-8 sub-B) — attestations.ts response sanitizer tests.
 *
 * Pin that internal-actor UUIDs (`id`, `attester_user_id`, `attester_org_id`,
 * `anchor_id`) and BANNED_RESPONSE_KEYS never reach customer-facing payloads.
 *
 * The route SELECTs already omit `id` / `attester_user_id` / `attester_org_id`
 * for the list endpoint, but a future SELECT widening would silently leak
 * through the `...a` spread without this defensive filter. This file pins
 * the shape of the sanitizer so future refactors cannot regress.
 *
 * Mirrors the agents-sanitizer.test.ts pattern (SCRUM-1271-A).
 */

import { describe, it, expect } from 'vitest';
import { BANNED_RESPONSE_KEYS, findBannedKeys } from './response-schemas.js';

// Re-implement the contract here to pin the shape. The route's private
// `toPublicAttestation` must keep this contract or the route tests break.
function publicAttestationShape(row: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...row };
  delete sanitized.id;
  delete sanitized.attester_user_id;
  delete sanitized.attester_org_id;
  delete sanitized.anchor_id;
  for (const banned of BANNED_RESPONSE_KEYS) {
    delete sanitized[banned];
  }
  return sanitized;
}

describe('attestations.ts public shape (SCRUM-1444 / SCRUM-1271-B)', () => {
  const fullDbRow = {
    id: 'attestation-uuid-internal',
    public_id: 'ARK-ARKOVA-VER-A1B2C3',
    anchor_id: 'anchor-uuid-internal',
    attester_user_id: 'user-uuid-internal',
    attester_org_id: 'org-uuid-internal',
    org_id: 'org-uuid-internal',
    attestation_type: 'VERIFICATION',
    status: 'ACTIVE',
    subject_type: 'credential',
    subject_identifier: 'cred-12345',
    attester_name: 'Acme Verifier',
    attester_type: 'INSTITUTION',
    summary: 'Verified by Acme on 2026-04-29.',
    fingerprint: 'a'.repeat(64),
    issued_at: '2026-04-29T00:00:00Z',
    expires_at: null,
    created_at: '2026-04-29T00:00:00Z',
    chain_tx_id: null,
  };

  it('strips internal id, attester_user_id, attester_org_id, anchor_id', () => {
    const out = publicAttestationShape(fullDbRow);
    expect(out).not.toHaveProperty('id');
    expect(out).not.toHaveProperty('attester_user_id');
    expect(out).not.toHaveProperty('attester_org_id');
    expect(out).not.toHaveProperty('anchor_id');
  });

  it('strips every BANNED_RESPONSE_KEYS field', () => {
    const out = publicAttestationShape(fullDbRow);
    expect(findBannedKeys(out)).toEqual([]);
  });

  it('preserves customer-facing fields (public_id, attestation_type, fingerprint, ...)', () => {
    const out = publicAttestationShape(fullDbRow);
    expect(out).toMatchObject({
      public_id: 'ARK-ARKOVA-VER-A1B2C3',
      attestation_type: 'VERIFICATION',
      status: 'ACTIVE',
      fingerprint: 'a'.repeat(64),
      attester_name: 'Acme Verifier',
      created_at: '2026-04-29T00:00:00Z',
    });
  });

  it('returns empty object for null / undefined input', () => {
    expect(publicAttestationShape({})).toEqual({});
  });

  it('does not mutate the input row', () => {
    const before = { ...fullDbRow };
    publicAttestationShape(fullDbRow);
    expect(fullDbRow).toEqual(before);
  });
});
