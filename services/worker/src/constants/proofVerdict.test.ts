/**
 * R3 — tri-state proof verdict vocabulary + mapping.
 *
 * These are the UNIT tests for the classifier itself. The route/response-level
 * tests (including the K1 `verified` <-> `verdict` invariant across every
 * branch) live in `api/v1/verify-proof.verdict.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  PROOF_VERDICT,
  PROOF_VERDICT_NOTE,
  classifyInclusionVerdict,
  proofVerdictFields,
  type ProofVerdict,
} from './proofVerdict.js';

describe('R3 — PROOF_VERDICT vocabulary', () => {
  it('has EXACTLY three values and no fourth', () => {
    expect(Object.values(PROOF_VERDICT).sort()).toEqual([
      'invalid',
      'unverifiable',
      'valid',
    ]);
  });

  it('every verdict has a measured / asserted / NOT-asserted note (§1.5)', () => {
    for (const verdict of Object.values(PROOF_VERDICT)) {
      const note = PROOF_VERDICT_NOTE[verdict];
      expect(note, `${verdict} has no note`).toBeTruthy();
      expect(note).toMatch(/Measured:/);
      expect(note).toMatch(/Asserted:/);
      expect(note).toMatch(/Not asserted:/);
    }
  });

  it('the unverifiable note explicitly refuses to read as an alarm', () => {
    // The whole point of splitting the boolean: `unverifiable` must never be
    // mistaken for `invalid`. A bare token can be; the note cannot.
    const note = PROOF_VERDICT_NOTE[PROOF_VERDICT.UNVERIFIABLE];
    expect(note).toMatch(/not a failed one/i);
    expect(note).toMatch(/still be correctly anchored/i);
  });

  it('the invalid note does not over-claim tampering', () => {
    // An alarm is a signal to investigate the record, NOT a determination
    // that the document was altered (R-7 claims gate).
    const note = PROOF_VERDICT_NOTE[PROOF_VERDICT.INVALID];
    expect(note).toMatch(/corrupt|recorded incorrectly/i);
    expect(note).toMatch(/not as a determination about the document/i);
  });

  it('the valid note does NOT claim the root was checked against the network', () => {
    // `verdict` covers the app-tree inclusion recompute only. Claiming the
    // committed root is confirmed on-chain would be a §1.5 / R-7 defect.
    const note = PROOF_VERDICT_NOTE[PROOF_VERDICT.VALID];
    expect(note).toMatch(/Not asserted:[\s\S]*confirmed/i);
  });

  it('no note uses a §1.3-banned term', () => {
    const banned = /\b(wallet|gas|blockchain|bitcoin|testnet|mainnet|utxo|broadcast|crypto)\b/i;
    for (const verdict of Object.values(PROOF_VERDICT)) {
      expect(PROOF_VERDICT_NOTE[verdict], verdict).not.toMatch(banned);
    }
  });
});

describe('R3 — classifyInclusionVerdict is total and one-way', () => {
  // The mapping has exactly three inputs it can distinguish. Enumerate ALL of
  // them so a future branch cannot be added without a test.
  const cases: Array<{
    name: string;
    inclusion: { valid: boolean; reason?: string };
    guardArmed: boolean;
    expected: ProofVerdict;
  }> = [
    {
      name: 'check ran, passed, guard armed',
      inclusion: { valid: true },
      guardArmed: true,
      expected: PROOF_VERDICT.VALID,
    },
    {
      name: 'check ran, passed, guard NOT armed',
      inclusion: { valid: true },
      guardArmed: false,
      expected: PROOF_VERDICT.UNVERIFIABLE,
    },
    {
      name: 'check ran, FAILED, guard armed',
      inclusion: { valid: false, reason: 'recomputed root does not match committed merkle_root' },
      guardArmed: true,
      expected: PROOF_VERDICT.INVALID,
    },
    {
      name: 'check ran, FAILED, guard NOT armed',
      inclusion: { valid: false, reason: 'recomputed root does not match committed merkle_root' },
      guardArmed: false,
      expected: PROOF_VERDICT.INVALID,
    },
  ];

  for (const c of cases) {
    it(`${c.name} => ${c.expected}`, () => {
      expect(classifyInclusionVerdict(c.inclusion, c.guardArmed)).toBe(c.expected);
    });
  }

  it('a FAILED check is INVALID regardless of whether the guard armed', () => {
    // `invalid` is an alarm and must come from a completed check that
    // genuinely failed. Guard-arming can only ever downgrade a PASS; it must
    // never launder a failure into "unverifiable".
    for (const guardArmed of [true, false]) {
      expect(classifyInclusionVerdict({ valid: false, reason: 'x' }, guardArmed)).toBe(
        PROOF_VERDICT.INVALID,
      );
    }
  });

  it('never returns valid when the guard did not arm (K4 honesty)', () => {
    expect(classifyInclusionVerdict({ valid: true }, false)).not.toBe(PROOF_VERDICT.VALID);
  });
});

describe('R3 — proofVerdictFields emits class + note indivisibly', () => {
  it('returns both fields for every verdict', () => {
    for (const verdict of Object.values(PROOF_VERDICT)) {
      expect(proofVerdictFields(verdict)).toEqual({
        verdict,
        verdict_note: PROOF_VERDICT_NOTE[verdict],
      });
    }
  });

  it('the note is the one from the shared table, never a copy', () => {
    // A second literal is how a reword drifts. Identity, not equality.
    expect(proofVerdictFields(PROOF_VERDICT.UNVERIFIABLE).verdict_note).toBe(
      PROOF_VERDICT_NOTE[PROOF_VERDICT.UNVERIFIABLE],
    );
  });
});
