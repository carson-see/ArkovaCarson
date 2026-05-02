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

import express from 'express';
import request from 'supertest';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { toPublicAttestation } from './attestationResponse.js';
import { findBannedKeys } from './response-schemas.js';
import { attestationsRouter } from './attestations.js';

const mockRange = vi.hoisted(() => vi.fn());

vi.mock('../../utils/db.js', () => {
  const queryChain: Record<string, unknown> = {};
  queryChain.eq = vi.fn(() => queryChain);
  queryChain.ilike = vi.fn(() => queryChain);
  queryChain.lt = vi.fn(() => queryChain);
  queryChain.order = vi.fn(() => queryChain);
  queryChain.range = mockRange;

  return {
    db: {
      from: vi.fn(() => ({
        select: vi.fn(() => queryChain),
      })),
    },
  };
});

vi.mock('../../utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai', bitcoinNetwork: 'signet' },
}));

vi.mock('../../auth.js', () => ({
  verifyAuthToken: vi.fn(),
}));

vi.mock('../../webhooks/delivery.js', () => ({
  dispatchWebhookEvent: vi.fn(),
}));

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

  beforeEach(() => {
    mockRange.mockResolvedValue({ data: [fullDbRow], count: 1, error: null });
  });

  it('strips internal id, attester_user_id, attester_org_id, anchor_id', () => {
    const out = toPublicAttestation(fullDbRow);
    expect(out).not.toHaveProperty('id');
    expect(out).not.toHaveProperty('attester_user_id');
    expect(out).not.toHaveProperty('attester_org_id');
    expect(out).not.toHaveProperty('anchor_id');
    expect(out).not.toHaveProperty('org_id');
  });

  it('drops unapproved future columns instead of relying on a blacklist', () => {
    const out = toPublicAttestation({
      ...fullDbRow,
      internal_review_notes: 'never expose this',
      raw_claim_payload: { pii: true },
    });
    expect(out).not.toHaveProperty('internal_review_notes');
    expect(out).not.toHaveProperty('raw_claim_payload');
  });

  it('strips every BANNED_RESPONSE_KEYS field', () => {
    const out = toPublicAttestation(fullDbRow);
    expect(findBannedKeys(out)).toEqual([]);
  });

  it('preserves customer-facing fields (public_id, attestation_type, fingerprint, ...)', () => {
    const out = toPublicAttestation(fullDbRow);
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
    expect(toPublicAttestation(null)).toEqual({});
    expect(toPublicAttestation(undefined)).toEqual({});
    expect(toPublicAttestation({})).toEqual({});
  });

  it('does not mutate the input row', () => {
    const before = { ...fullDbRow };
    toPublicAttestation(fullDbRow);
    expect(fullDbRow).toEqual(before);
  });

  it('sanitizes list endpoint items before adding verify_url', async () => {
    const app = express();
    app.use('/api/v1/attestations', attestationsRouter);

    const res = await request(app).get('/api/v1/attestations').expect(200);
    const item = res.body.attestations[0];

    expect(findBannedKeys(item)).toEqual([]);
    expect(item).not.toHaveProperty('id');
    expect(item).not.toHaveProperty('attester_user_id');
    expect(item).not.toHaveProperty('attester_org_id');
    expect(item).not.toHaveProperty('anchor_id');
    expect(item).not.toHaveProperty('org_id');
    expect(item.verify_url).toBe('https://app.arkova.ai/verify/attestation/ARK-ARKOVA-VER-A1B2C3');
  });
});
