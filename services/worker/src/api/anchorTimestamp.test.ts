/**
 * BUG-2026-09-08-001 (SCRUM-4517) — `anchor_timestamp` is the chain's time.
 *
 * These tests are a RATCHET, not a description. The bug shipped because five
 * surfaces each decided the field's meaning independently and four picked
 * `created_at`; a careful reading of any one file would not have caught it.
 * So every case below uses a fixture where `created_at` and `chain_timestamp`
 * are DIFFERENT values, and asserts against the chain one — a future edit that
 * reintroduces the fallback fails here rather than in prod.
 *
 * The `created_at` value used throughout is the real prod value from the
 * anchor that exposed this (`ARK-SEC-RUJ2V7`), with its real chain time, so
 * the 10m24s gap under test is the gap that was actually published.
 */

import { describe, it, expect } from 'vitest';
import { publicAnchorTimestamp } from './anchorTimestamp.js';

/** Real prod values from `ARK-SEC-RUJ2V7` (project vzwyaatejekddvltxyye). */
const CREATED_AT = '2026-04-09T18:01:01.848397+00:00';
const CHAIN_TIMESTAMP = '2026-04-09T18:11:26+00:00';

describe('publicAnchorTimestamp', () => {
  it('returns the chain time, never created_at, for a SECURED anchor', () => {
    const result = publicAnchorTimestamp('SECURED', CHAIN_TIMESTAMP);
    expect(result).toBe(CHAIN_TIMESTAMP);
    expect(result).not.toBe(CREATED_AT);
  });

  it('returns null for PENDING even when a chain timestamp is somehow present', () => {
    // Mirrors the RPC's `status NOT IN ('PENDING')` gate. A PENDING row has no
    // anchoring moment to publish; if one is stored, the gate still wins, so
    // this surface can never contradict `get_public_anchor()`.
    expect(publicAnchorTimestamp('PENDING', CHAIN_TIMESTAMP)).toBeNull();
  });

  it('returns null — NOT created_at — when the chain time was never measured', () => {
    // The whole bug in one assertion. There is no created_at in scope to fall
    // back to, and there must never be one.
    expect(publicAnchorTimestamp('SECURED', null)).toBeNull();
    expect(publicAnchorTimestamp('REVOKED', null)).toBeNull();
    expect(publicAnchorTimestamp('SECURED', undefined)).toBeNull();
  });

  it('publishes the chain time for every non-PENDING status', () => {
    // SUBMITTED/REVOKED/EXPIRED/SUPERSEDED all pass the RPC's gate. A revoked
    // credential was still anchored at a real moment, and hiding that moment
    // would remove evidence rather than add honesty.
    for (const status of ['SECURED', 'SUBMITTED', 'REVOKED', 'EXPIRED', 'SUPERSEDED']) {
      expect(publicAnchorTimestamp(status, CHAIN_TIMESTAMP)).toBe(CHAIN_TIMESTAMP);
    }
  });

  it('returns null for an absent status rather than guessing', () => {
    expect(publicAnchorTimestamp(null, CHAIN_TIMESTAMP)).toBeNull();
    expect(publicAnchorTimestamp(undefined, CHAIN_TIMESTAMP)).toBeNull();
    expect(publicAnchorTimestamp('', CHAIN_TIMESTAMP)).toBeNull();
  });

});
