/**
 * SCRUM-2486 — CTID-invariance property tests.
 *
 * Property-style invariants for the fail-closed CTID guard shipped in
 * SCRUM-2373 (#1178). This file is NET-NEW and imports ONLY the long-stable
 * PUBLIC surface of `ctdl-ctid-guard.ts` — `isRealCtid`,
 * `assertRealCtidOrAbsent`, `REAL_CTID_PATTERN`, `FabricatedCtidError`. It makes
 * ZERO edits to the guard (locked by soaking #1412) and asserts behavioral
 * INVARIANTS rather than re-testing individual cases:
 *
 *   1. Normalization is idempotent (trim/whitespace collapse to one canonical).
 *   2. A real CE CTID passes through stably (same value in → same value out).
 *   3. Any non-real, non-absent value fails CLOSED (FabricatedCtidError).
 *   4. Error messages are value-free (never echo the offending CTID or an
 *      Arkova public_id) — the §1.13 R-7 / §1.5 claims-gate wording.
 *   5. Absence handling: cleanly-absent input stays absent (undefined).
 *
 * Per Constitution 1.7 the guard is pure — no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import {
  isRealCtid,
  assertRealCtidOrAbsent,
  REAL_CTID_PATTERN,
  FabricatedCtidError,
  type CtidSubject,
} from './ctdl-ctid-guard.js';

// ─── Corpora ─────────────────────────────────────────────────────────────

/** Canonical real CE CTIDs (ce- + v4-style UUID). */
const REAL_CTIDS = [
  'ce-a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  'ce-00000000-0000-4000-8000-000000000000',
  'ce-FFFFFFFF-FFFF-4FFF-BFFF-FFFFFFFFFFFF', // case-insensitive per REAL_CTID_PATTERN /i
];

/**
 * Fabricated / placeholder STRING values that must FAIL CLOSED. These model the
 * exact synthesized-placeholder classes the guard exists to reject: a non-empty
 * string that is not a real CE CTID.
 */
const FABRICATED_CTID_STRINGS: string[] = [
  'ce-not-a-uuid',
  'ce-xxxx',
  'ce-12345', // too short
  'urn:ctid:abc',
  'ce-a1b2c3d4e5f64a7b8c9d0e1f2a3b4c5d', // UUID with no hyphens
  'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', // valid UUID but missing ce- prefix
  'ce-a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d-extra', // trailing junk
  'ce-org_public_id_1234', // ce- + an arkova public id (the classic fabrication)
];

/**
 * Non-string / empty values that are treated as HONEST ABSENCE by the guard's
 * `normalize()` contract (non-string → null → undefined). A non-string CTID is
 * a type mismatch upstream, not a fabricated string reaching serialized output,
 * so the guard omits the field rather than throwing. Pinned here so a future
 * refactor cannot silently change absence-vs-throw for these.
 */
const ABSENCE_EQUIVALENT_VALUES: unknown[] = [undefined, null, '', '   ', '\t\n', 0, {}, [], true];

const SUBJECTS: CtidSubject[] = ['credential', 'issuer'];

// ─── Invariant 1: normalization is idempotent ────────────────────────────────

describe('CTID invariance — normalization idempotence (SCRUM-2486)', () => {
  it('a real CTID with surrounding whitespace normalizes to the same trimmed value, idempotently', () => {
    const real = 'ce-a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    for (const subject of SUBJECTS) {
      const once = assertRealCtidOrAbsent(`  ${real}  `, subject);
      expect(once).toBe(real);
      // Feeding the output back in is a fixed point.
      const twice = assertRealCtidOrAbsent(once, subject);
      expect(twice).toBe(real);
    }
  });

  it('isRealCtid is whitespace-invariant for a real CTID', () => {
    const real = 'ce-a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    expect(isRealCtid(real)).toBe(true);
    expect(isRealCtid(`  ${real}\n`)).toBe(true);
    expect(isRealCtid(`\t${real} `)).toBe(true);
  });
});

// ─── Invariant 2: real-CTID pass-through stability ───────────────────────────

describe('CTID invariance — real-CTID pass-through stability', () => {
  it('every real CTID is recognized and returned unchanged (modulo trim) for both subjects', () => {
    for (const ctid of REAL_CTIDS) {
      expect(isRealCtid(ctid)).toBe(true);
      expect(REAL_CTID_PATTERN.test(ctid)).toBe(true);
      for (const subject of SUBJECTS) {
        expect(assertRealCtidOrAbsent(ctid, subject)).toBe(ctid);
      }
    }
  });

  it('assertRealCtidOrAbsent is a fixed point on its own real output', () => {
    for (const ctid of REAL_CTIDS) {
      const out = assertRealCtidOrAbsent(ctid, 'credential');
      expect(assertRealCtidOrAbsent(out, 'credential')).toBe(out);
    }
  });
});

// ─── Invariant 3: fabricated values fail closed ──────────────────────────────

describe('CTID invariance — fabricated values fail CLOSED', () => {
  it('every non-real, non-empty STRING throws FabricatedCtidError for both subjects', () => {
    for (const bad of FABRICATED_CTID_STRINGS) {
      for (const subject of SUBJECTS) {
        expect(() => assertRealCtidOrAbsent(bad, subject)).toThrow(FabricatedCtidError);
      }
      expect(isRealCtid(bad)).toBe(false);
    }
  });

  it('the thrown error carries the subject it was raised for', () => {
    for (const subject of SUBJECTS) {
      try {
        assertRealCtidOrAbsent('ce-fabricated', subject);
        throw new Error('expected FabricatedCtidError');
      } catch (err) {
        expect(err).toBeInstanceOf(FabricatedCtidError);
        expect((err as FabricatedCtidError).subject).toBe(subject);
      }
    }
  });
});

// ─── Invariant 4: error messages are value-free ──────────────────────────────

describe('CTID invariance — value-free error messages (R-7 / §1.5)', () => {
  it('never echoes the offending CTID or an Arkova public_id into the message', () => {
    const leaky = 'ce-SUPER_SECRET_public_id_should_not_leak';
    try {
      assertRealCtidOrAbsent(leaky, 'credential');
      throw new Error('expected FabricatedCtidError');
    } catch (err) {
      expect(err).toBeInstanceOf(FabricatedCtidError);
      const msg = (err as FabricatedCtidError).message;
      // The offending value must NOT appear anywhere in the error text.
      expect(msg).not.toContain('SUPER_SECRET');
      expect(msg).not.toContain(leaky);
      expect(msg).not.toContain('public_id');
    }
  });

  it('message is stable and generic regardless of the (secret) input value', () => {
    let msgA = '';
    let msgB = '';
    try { assertRealCtidOrAbsent('ce-aaaa-secret-1', 'credential'); } catch (e) { msgA = (e as Error).message; }
    try { assertRealCtidOrAbsent('ce-bbbb-secret-2', 'credential'); } catch (e) { msgB = (e as Error).message; }
    expect(msgA).toBe(msgB);
    expect(msgA.length).toBeGreaterThan(0);
  });
});

// ─── Invariant 5: absence handling ───────────────────────────────────────────

describe('CTID invariance — absence stays absent', () => {
  it('cleanly-absent AND non-string inputs return undefined (honest omission), never throw', () => {
    // Contract: normalize() maps non-string / empty / whitespace-only to null,
    // which assertRealCtidOrAbsent returns as undefined — the field is omitted,
    // NOT treated as a fabricated string. A non-string CTID is an upstream type
    // mismatch, not a fabricated value reaching serialized output.
    for (const value of ABSENCE_EQUIVALENT_VALUES) {
      for (const subject of SUBJECTS) {
        expect(assertRealCtidOrAbsent(value, subject)).toBeUndefined();
      }
      expect(isRealCtid(value)).toBe(false);
    }
  });

  it('undefined in → undefined out is a fixed point', () => {
    const out = assertRealCtidOrAbsent(undefined, 'issuer');
    expect(out).toBeUndefined();
    expect(assertRealCtidOrAbsent(out, 'issuer')).toBeUndefined();
  });
});
