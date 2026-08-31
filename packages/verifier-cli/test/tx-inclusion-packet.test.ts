/**
 * B3 (migration 0427) — the bitcoin-tree inclusion evidence must REACH the
 * verifier's packet contract.
 *
 * `anchor_proofs.tx_inclusion_branch` / `tx_block_index` exist so a holder can
 * close the transaction→block half of the proof LOCALLY instead of asking a
 * Bitcoin node. That goal is only met if the evidence survives every hop from
 * the database to the auditor's hands: API bundle → exported audit packet →
 * SDK → this CLI. It did not: `git grep tx_inclusion_branch` returned zero hits
 * anywhere under `packages/`, so the columns were written and then dropped by
 * every shipped client.
 *
 * SCOPE, STATED HONESTLY (§1.5). These tests pin that the packet CONTRACT
 * carries the fields and that a packet carrying them still verifies unchanged.
 * They do NOT claim the CLI folds the branch — it does not. The
 * transaction-inclusion verdict still comes from `confirmInclusion` against an
 * INDEPENDENT node, which is stronger evidence than folding toward a header the
 * packet supplies about itself. See the docstring on `ProofPacket`.
 */

import { describe, it, expect } from 'vitest';
import { verifyProof } from '../src/verify.js';
import { loadSyntheticFixtures } from './helpers.js';
import type { ProofPacket, VerifierFixture } from '../src/types.js';

/** [right, left] ⇒ index bit0 = 0, bit1 = 1 ⇒ the only coherent index is 2. */
const TX_BRANCH = [
  { hash: '11'.repeat(32), position: 'right' as const },
  { hash: '22'.repeat(32), position: 'left' as const },
];

function firstPassingRecomputeFixture(): VerifierFixture {
  const fixture = loadSyntheticFixtures().find((f) => f.expect.ok);
  if (!fixture) throw new Error('no passing synthetic fixture available');
  return fixture;
}

describe('B3 — ProofPacket carries the layer-2 bitcoin-tree evidence', () => {
  // A RUNTIME detector, not a type-level one: this package's `typecheck` script
  // excludes `test/`, so an object-literal assertion here would be checked by
  // nothing at all — precisely the false-confidence shape the rest of this
  // change is removing. The report field is the observable surface.
  it('surfaces the packet\'s branch + index on the report instead of dropping them', async () => {
    const fixture = firstPassingRecomputeFixture();
    const report = await verifyProof({
      ...fixture.packet,
      tx_inclusion_branch: TX_BRANCH,
      tx_block_index: 2,
    });
    expect(report.packetTxInclusion).toEqual({ branchLength: 2, blockIndex: 2 });
  });

  it('reports null when the packet predates migration 0427', async () => {
    const fixture = firstPassingRecomputeFixture();
    const report = await verifyProof(fixture.packet);
    expect(report.packetTxInclusion).toBeNull();
  });

  it('an EMPTY branch with index 0 is complete evidence for a single-transaction block', async () => {
    const fixture = firstPassingRecomputeFixture();
    const report = await verifyProof({
      ...fixture.packet,
      tx_inclusion_branch: [],
      tx_block_index: 0,
    });
    expect(report.packetTxInclusion).toEqual({ branchLength: 0, blockIndex: 0 });
  });

  it.each([
    ['non-array branch', 'nope' as unknown, 2],
    ['empty sibling hash', [{ hash: '', position: 'right' }, TX_BRANCH[1]] as unknown, 2],
    ['non-hex sibling', [{ hash: 'z'.repeat(64), position: 'right' }, TX_BRANCH[1]] as unknown, 2],
    ['index out of range', TX_BRANCH as unknown, 17],
    ['index contradicts sides', TX_BRANCH as unknown, 1],
    ['branch without index', TX_BRANCH as unknown, null],
  ])('reports null for an unusable pair (%s) rather than presenting it as evidence', async (
    _label,
    branch,
    index,
  ) => {
    const fixture = firstPassingRecomputeFixture();
    const report = await verifyProof({
      ...fixture.packet,
      tx_inclusion_branch: branch as ProofPacket['tx_inclusion_branch'],
      tx_block_index: index as ProofPacket['tx_block_index'],
    });
    expect(report.packetTxInclusion).toBeNull();
  });

  it('a packet carrying the new fields verifies EXACTLY as it did without them (§1.8 additive)', async () => {
    const fixture = firstPassingRecomputeFixture();

    const before = await verifyProof(fixture.packet);
    const after = await verifyProof({
      ...fixture.packet,
      tx_inclusion_branch: TX_BRANCH,
      tx_block_index: 2,
      block_header: '00'.repeat(80),
    });

    expect(after.ok).toBe(before.ok);
    expect(after.reasonCode).toBe(before.reasonCode);
    expect(after.steps.map((s) => `${s.id}:${s.status}`)).toEqual(
      before.steps.map((s) => `${s.id}:${s.status}`),
    );
  });

  it('the schema step still reads version 1 — the additive fields do NOT bump it', async () => {
    const fixture = firstPassingRecomputeFixture();
    const report = await verifyProof({
      ...fixture.packet,
      tx_inclusion_branch: TX_BRANCH,
      tx_block_index: 2,
    });
    const schemaStep = report.steps.find((s) => s.id === 'schema');
    expect(schemaStep?.status).toBe('pass');
  });

  it('an unusable pair cannot change the verdict — the CLI does not fold it (stated, not assumed)', async () => {
    const fixture = firstPassingRecomputeFixture();
    // Deliberately incoherent: a 2-entry branch labelled index 17. If the CLI
    // ever starts folding, this fixture is where that behaviour must be
    // decided explicitly rather than inherited by accident.
    const report = await verifyProof({
      ...fixture.packet,
      tx_inclusion_branch: TX_BRANCH,
      tx_block_index: 17,
    });
    const baseline = await verifyProof(fixture.packet);
    expect(report.ok).toBe(baseline.ok);
    expect(report.steps.map((s) => s.id)).toEqual(baseline.steps.map((s) => s.id));
  });
});
