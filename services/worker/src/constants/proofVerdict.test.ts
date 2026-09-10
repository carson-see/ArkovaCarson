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
  isStructuralGuardEffective,
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

  it('the invalid note does NOT claim a recompute that may never have run', () => {
    // §1.5: "Measured" must name what was actually measured. Five of the
    // verifier's failure reasons (leaf/root/sibling not 64-hex, bad position,
    // branch not an array) and the leafIndex range check all return BEFORE a
    // single SHA-256 call, so a note asserting "the fingerprint was recomputed"
    // is false for those records. The honest statement is that the check ran to
    // a conclusion and did not pass.
    const note = PROOF_VERDICT_NOTE[PROOF_VERDICT.INVALID];
    expect(note).not.toMatch(/was recomputed/i);
    expect(note).toMatch(/did not pass/i);
  });

  it('the valid note does NOT presuppose an anchor receipt exists', () => {
    // R-7 / §1.5: `verdict` is gated on the app-tree recompute ONLY and never
    // consults `chain_tx_id`. A batch whose anchor_proofs rows are written
    // before broadcast/confirmation reads `valid` with tx_id/block_height null,
    // so asserting inclusion "under the root committed by the record's anchor
    // receipt" names a receipt that may not exist yet.
    const note = PROOF_VERDICT_NOTE[PROOF_VERDICT.VALID];
    expect(note).not.toMatch(/committed by the record's anchor receipt/i);
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

describe('R3 — isStructuralGuardEffective: armed is not the same as exercised', () => {
  // The verifier turns its structural mode ON when {leafIndex, leafCount>=1}
  // are supplied — but "on" is not "ran". `verifyMerkleInclusion` short-circuits
  // an EMPTY branch before the structural walk, and its level arithmetic
  // (levelSize = ceil(levelSize/2), floored at 1) stops constraining anything
  // once it bottoms out. `valid` claims the guard passed, so it may only be
  // emitted when the claimed tree shape actually describes this branch.

  it('is false without a leaf index', () => {
    expect(isStructuralGuardEffective(null, 4, 2)).toBe(false);
    expect(isStructuralGuardEffective(undefined, 4, 2)).toBe(false);
  });

  it('is false without a leaf count, or with a count below 1', () => {
    expect(isStructuralGuardEffective(0, null, 2)).toBe(false);
    expect(isStructuralGuardEffective(0, 0, 2)).toBe(false);
    expect(isStructuralGuardEffective(0, -1, 2)).toBe(false);
  });

  it('is true when the branch length is exactly the claimed tree depth', () => {
    expect(isStructuralGuardEffective(0, 1, 0)).toBe(true); // single leaf, no siblings
    expect(isStructuralGuardEffective(0, 2, 1)).toBe(true);
    expect(isStructuralGuardEffective(0, 3, 2)).toBe(true); // odd level, dup last
    expect(isStructuralGuardEffective(0, 4, 2)).toBe(true);
    expect(isStructuralGuardEffective(0, 5, 3)).toBe(true);
    expect(isStructuralGuardEffective(0, 6, 3)).toBe(true);
    expect(isStructuralGuardEffective(0, 1024, 10)).toBe(true);
  });

  it('is FALSE for an empty branch in a tree the record claims has >1 leaf', () => {
    // The verifier returns at `branch.length === 0` before the structural walk,
    // so nothing was inspected — yet a record whose stored merkle_root equals
    // its own fingerprint recomputes clean. Claiming `valid` there asserts a
    // check that provably did not run.
    expect(isStructuralGuardEffective(0, 4, 0)).toBe(false);
    expect(isStructuralGuardEffective(0, 2, 0)).toBe(false);
  });

  it('is FALSE for a branch longer than the claimed tree can produce', () => {
    // Past the real root the level size is pinned at 1, which makes
    // `isRightmostOddNode` true at every extra level — the guard stops
    // rejecting self-pairs entirely.
    expect(isStructuralGuardEffective(0, 1, 3)).toBe(false);
    expect(isStructuralGuardEffective(0, 4, 5)).toBe(false);
  });

  it('is FALSE for a branch shorter than the claimed tree depth', () => {
    expect(isStructuralGuardEffective(0, 1024, 3)).toBe(false);
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
