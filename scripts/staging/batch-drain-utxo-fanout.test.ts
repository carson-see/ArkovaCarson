import { describe, expect, it } from 'vitest';

import {
  assertOrgFanOutObservation,
  assertTreasuryPresplitObservation,
  planOrgFanOut,
  planTreasuryPresplit,
  type OrgFanOutObservation,
  type TreasuryPresplitObservation,
} from './batch-drain-utxo-fanout';

const TREASURY_ADDRESS = 'tb1qarkovas33rigb1treasuryfixture0000000000000';
const INPUTS = [
  { txId: 'b'.repeat(64), vout: 1, valueSats: 1_600_000, confirmations: 5 },
  { txId: 'a'.repeat(64), vout: 0, valueSats: 1_600_000, confirmations: 6 },
] as const;

function buildPlan() {
  return planTreasuryPresplit({
    planId: 's33-w3-b-rig-b1-presplit',
    network: 'signet',
    treasuryAddress: TREASURY_ADDRESS,
    inputs: INPUTS,
    outputCount: 32,
    feeSats: 3_200,
    minOutputSats: 1_000,
  });
}

function splitObservation(plan = buildPlan()): TreasuryPresplitObservation {
  return {
    planDigest: plan.planDigest,
    splitTxId: 'c'.repeat(64),
    network: 'signet',
    observedAt: '2026-07-16T12:00:00.000Z',
    inputsSpent: plan.inputs.map(({ txId, vout }) => ({ txId, vout })),
    outputs: plan.outputs.map((output) => ({
      vout: output.outputIndex,
      address: output.address,
      valueSats: output.valueSats,
      confirmations: 1,
      spent: false,
    })),
  };
}

function orgs(count = 30) {
  return Array.from({ length: count }, (_, index) => ({
    orgId: `org-${String(index + 1).padStart(2, '0')}`,
    rank: index + 1,
  }));
}

function fanOutObservation(
  fanOut: ReturnType<typeof planOrgFanOut>,
): OrgFanOutObservation {
  return {
    planDigest: fanOut.planDigest,
    observedAt: '2026-07-16T12:10:00.000Z',
    transactions: fanOut.reservations.map((reservation, index) => ({
      orgId: reservation.orgId,
      input: reservation.input,
      txId: (index + 1).toString(16).padStart(64, '0'),
      network: 'signet',
      accepted: true,
      tooLongMempoolChain: false,
    })),
    consolidation: {
      observedAt: '2026-07-16T12:11:00.000Z',
      spentOutpoints: [],
    },
  };
}

describe('deterministic RIG-B1 treasury pre-split', () => {
  it('builds the same exact 32-output plan regardless of input RPC ordering', () => {
    const first = buildPlan();
    const second = planTreasuryPresplit({
      planId: first.planId,
      network: 'signet',
      treasuryAddress: TREASURY_ADDRESS,
      inputs: [...INPUTS].reverse(),
      outputCount: 32,
      feeSats: 3_200,
      minOutputSats: 1_000,
    });

    expect(first).toEqual(second);
    expect(first.inputs.map(({ txId }) => txId)).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(first.outputs).toHaveLength(32);
    expect(first.outputs.map(({ outputIndex }) => outputIndex)).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    );
    expect(first.outputs.every(({ valueSats }) => valueSats === 99_900)).toBe(true);
    expect(first.outputs.reduce((sum, output) => sum + output.valueSats, 0) + first.feeSats)
      .toBe(3_200_000);
    expect(first.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('fails closed on unconfirmed, duplicate, unsafe, or dust-producing inputs', () => {
    expect(() => planTreasuryPresplit({
      planId: 'unconfirmed', network: 'signet', treasuryAddress: TREASURY_ADDRESS,
      inputs: [{ ...INPUTS[0], confirmations: 0 }], outputCount: 32, feeSats: 1,
      minOutputSats: 1_000,
    })).toThrow(/confirmed/i);
    expect(() => planTreasuryPresplit({
      planId: 'duplicate', network: 'signet', treasuryAddress: TREASURY_ADDRESS,
      inputs: [INPUTS[0], INPUTS[0]], outputCount: 32, feeSats: 1,
      minOutputSats: 1_000,
    })).toThrow(/duplicate/i);
    expect(() => planTreasuryPresplit({
      planId: 'unsafe', network: 'signet', treasuryAddress: TREASURY_ADDRESS,
      inputs: [{ ...INPUTS[0], valueSats: Number.MAX_SAFE_INTEGER + 1 }], outputCount: 32,
      feeSats: 1, minOutputSats: 1_000,
    })).toThrow(/safe integer/i);
    expect(() => planTreasuryPresplit({
      planId: 'dust', network: 'signet', treasuryAddress: TREASURY_ADDRESS,
      inputs: [{ ...INPUTS[0], valueSats: 32_000 }], outputCount: 32, feeSats: 1_000,
      minOutputSats: 1_000,
    })).toThrow(/minimum|dust|insufficient/i);
  });

  it('accepts only the exact confirmed 32-output observation', () => {
    const plan = buildPlan();
    const confirmed = assertTreasuryPresplitObservation(plan, splitObservation(plan));
    expect(confirmed).toMatchObject({
      planDigest: plan.planDigest,
      splitTxId: 'c'.repeat(64),
      confirmedOutputCount: 32,
    });

    const wrongValue = splitObservation(plan);
    wrongValue.outputs[7] = { ...wrongValue.outputs[7]!, valueSats: wrongValue.outputs[7]!.valueSats - 1 };
    expect(() => assertTreasuryPresplitObservation(plan, wrongValue)).toThrow(/output|value/i);

    const unconfirmed = splitObservation(plan);
    unconfirmed.outputs[0] = { ...unconfirmed.outputs[0]!, confirmations: 0 };
    expect(() => assertTreasuryPresplitObservation(plan, unconfirmed)).toThrow(/confirmed/i);
  });
});

describe('greater-than-25 organization fan-out and consolidation guard', () => {
  it('reserves one distinct confirmed split output for each of 30 ranked orgs', () => {
    const split = assertTreasuryPresplitObservation(buildPlan(), splitObservation());
    const fanOut = planOrgFanOut({
      planId: 's33-w3-b-fanout',
      confirmedSplit: split,
      orgs: orgs(30),
    });

    expect(fanOut.reservations).toHaveLength(30);
    expect(new Set(fanOut.reservations.map(({ input }) => `${input.txId}:${input.vout}`)).size).toBe(30);
    expect(fanOut.reservations.map(({ rank }) => rank)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );
    expect(assertOrgFanOutObservation(fanOut, fanOutObservation(fanOut))).toMatchObject({
      acceptedOrganizations: 30,
      uniqueInputs: 30,
      consolidationInterference: false,
    });
  });

  it('rejects a 25-org plan, reused inputs, descendant-chain failure, or consolidation overlap', () => {
    const split = assertTreasuryPresplitObservation(buildPlan(), splitObservation());
    expect(() => planOrgFanOut({ planId: 'too-small', confirmedSplit: split, orgs: orgs(25) }))
      .toThrow(/more than 25/i);

    const fanOut = planOrgFanOut({ planId: 'fanout', confirmedSplit: split, orgs: orgs(30) });
    const reused = fanOutObservation(fanOut);
    reused.transactions[1] = { ...reused.transactions[1]!, input: reused.transactions[0]!.input };
    expect(() => assertOrgFanOutObservation(fanOut, reused)).toThrow(/reuse|input|reservation/i);

    const chained = fanOutObservation(fanOut);
    chained.transactions[26] = { ...chained.transactions[26]!, accepted: false, tooLongMempoolChain: true };
    expect(() => assertOrgFanOutObservation(fanOut, chained)).toThrow(/mempool|chain|accepted/i);

    const consolidated = fanOutObservation(fanOut);
    consolidated.consolidation.spentOutpoints = [fanOut.reservations[0]!.input];
    expect(() => assertOrgFanOutObservation(fanOut, consolidated)).toThrow(/consolidation|reserved/i);
  });
});
