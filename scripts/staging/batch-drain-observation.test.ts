import { describe, expect, it } from 'vitest';

import {
  assertDrainPassObservation,
  type DrainPassExpectation,
  type DrainPassObservation,
} from './batch-drain-observation';

const BATCH_ID = 'batch-offline-r3';
const EXECUTION_ID = 'scheduler-offline-r3';
const FAULT_WINDOW_ID = 'fault-window-offline-r3';
const TX_ID = 'a'.repeat(64);
const TX_HASH = 'b'.repeat(64);
const ROOT = 'c'.repeat(64);
const FP_1 = '1'.repeat(64);
const FP_2 = '2'.repeat(64);
const FP_POISON = '3'.repeat(64);
const ORG_HEALTHY = 'org-healthy';
const ORG_POISON = 'org-poison';

function expectation(): DrainPassExpectation {
  return {
    batchId: BATCH_ID,
    armedTrigger: 'org-scheduler',
    schedulerExecutionId: EXECUTION_ID,
    faultWindow: {
      id: FAULT_WINDOW_ID,
      startsAt: '2026-07-13T12:00:00.000Z',
      endsAt: '2026-07-13T12:05:00.000Z',
    },
    claims: [
      { fingerprint: FP_1, orgId: ORG_HEALTHY, outcome: 'drained' },
      { fingerprint: FP_2, orgId: ORG_HEALTHY, outcome: 'drained' },
      { fingerprint: FP_POISON, orgId: ORG_POISON, outcome: 'credit-starved' },
    ],
    transactions: [{
      txId: TX_ID,
      batchId: BATCH_ID,
      merkleRoot: ROOT,
      signedBytesSha256: TX_HASH,
      leaves: [
        { fingerprint: FP_1, orgId: ORG_HEALTHY, merkleIndex: 0 },
        { fingerprint: FP_2, orgId: ORG_HEALTHY, merkleIndex: 1 },
      ],
    }],
    ledgerDeltas: [
      { orgId: ORG_HEALTHY, delta: -2 },
      { orgId: ORG_POISON, delta: 0 },
    ],
  };
}

function observation(): DrainPassObservation {
  return {
    execution: {
      schedulerExecutionId: EXECUTION_ID,
      armedTrigger: 'org-scheduler',
      faultWindowId: FAULT_WINDOW_ID,
      startedAt: '2026-07-13T12:00:05.000Z',
      completedAt: '2026-07-13T12:00:20.000Z',
    },
    triggerFirings: [{
      trigger: 'org-scheduler',
      schedulerExecutionId: EXECUTION_ID,
      batchId: BATCH_ID,
      firedAt: '2026-07-13T12:00:06.000Z',
    }],
    passRows: [
      {
        fingerprint: FP_1,
        orgId: ORG_HEALTHY,
        batchId: BATCH_ID,
        schedulerExecutionId: EXECUTION_ID,
        status: 'SUBMITTED',
        chainTxId: TX_ID,
        merkleRoot: ROOT,
        observedOutcome: 'drained',
      },
      {
        fingerprint: FP_2,
        orgId: ORG_HEALTHY,
        batchId: BATCH_ID,
        schedulerExecutionId: EXECUTION_ID,
        status: 'SECURED',
        chainTxId: TX_ID,
        merkleRoot: ROOT,
        observedOutcome: 'drained',
      },
      {
        fingerprint: FP_POISON,
        orgId: ORG_POISON,
        batchId: BATCH_ID,
        schedulerExecutionId: EXECUTION_ID,
        status: 'PENDING',
        chainTxId: null,
        merkleRoot: null,
        observedOutcome: 'succeeded-no-broadcast',
      },
    ],
    transactions: [{
      txId: TX_ID,
      batchId: BATCH_ID,
      merkleRoot: ROOT,
      signedBytesSha256: TX_HASH,
    }],
    txLeaves: [
      { txId: TX_ID, batchId: BATCH_ID, fingerprint: FP_1, orgId: ORG_HEALTHY, merkleIndex: 0 },
      { txId: TX_ID, batchId: BATCH_ID, fingerprint: FP_2, orgId: ORG_HEALTHY, merkleIndex: 1 },
    ],
    proofs: [
      {
        txId: TX_ID,
        batchId: BATCH_ID,
        fingerprint: FP_1,
        orgId: ORG_HEALTHY,
        merkleRoot: ROOT,
        merkleIndex: 0,
        verified: true,
      },
      {
        txId: TX_ID,
        batchId: BATCH_ID,
        fingerprint: FP_2,
        orgId: ORG_HEALTHY,
        merkleRoot: ROOT,
        merkleIndex: 1,
        verified: true,
      },
    ],
    ledgerDeltas: [
      { schedulerExecutionId: EXECUTION_ID, orgId: ORG_HEALTHY, delta: -2 },
      { schedulerExecutionId: EXECUTION_ID, orgId: ORG_POISON, delta: 0 },
    ],
  };
}

describe('assertDrainPassObservation — fail-closed actual-evidence correlation', () => {
  it('accepts one exactly-correlated pass and returns an auditable summary', () => {
    expect(assertDrainPassObservation(expectation(), observation())).toEqual({
      batchId: BATCH_ID,
      armedTrigger: 'org-scheduler',
      schedulerExecutionId: EXECUTION_ID,
      faultWindowId: FAULT_WINDOW_ID,
      claimedLeaves: 3,
      drainedLeaves: 2,
      poisonLeaves: 1,
      transactionIds: [TX_ID],
      merkleRoots: [ROOT],
    });
  });

  it.each([
    ['scheduler execution', (actual: DrainPassObservation) => { actual.execution.schedulerExecutionId = 'unrelated'; }],
    ['armed trigger', (actual: DrainPassObservation) => { actual.execution.armedTrigger = 'global-flush'; }],
    ['fault window', (actual: DrainPassObservation) => { actual.execution.faultWindowId = 'unrelated'; }],
    ['trigger firing', (actual: DrainPassObservation) => { actual.triggerFirings[0]!.batchId = 'unrelated'; }],
    ['pass row', (actual: DrainPassObservation) => { actual.passRows[0]!.batchId = 'unrelated'; }],
    ['tx leaf org', (actual: DrainPassObservation) => { actual.txLeaves[0]!.orgId = ORG_POISON; }],
    ['proof', (actual: DrainPassObservation) => { actual.proofs[0]!.verified = false; }],
    ['ledger delta', (actual: DrainPassObservation) => { actual.ledgerDeltas[0]!.delta = -1; }],
  ])('rejects unrelated or incomplete %s evidence', (_label, mutate) => {
    const actual = observation();
    mutate(actual);
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow();
  });

  it('rejects an extra trigger firing or pass row outside the declared claim set', () => {
    const extraFiring = observation();
    extraFiring.triggerFirings.push({ ...extraFiring.triggerFirings[0]!, trigger: 'global-flush' });
    expect(() => assertDrainPassObservation(expectation(), extraFiring)).toThrow(/exactly one trigger firing/);

    const extraRow = observation();
    extraRow.passRows.push({ ...extraRow.passRows[0]!, fingerprint: '4'.repeat(64) });
    expect(() => assertDrainPassObservation(expectation(), extraRow)).toThrow(/pass rows.*claimed leaves/);
  });

  it('rejects an org-scheduler transaction that spans orgs', () => {
    const expected = expectation();
    expected.claims[2] = { fingerprint: FP_POISON, orgId: ORG_POISON, outcome: 'drained' };
    expected.transactions[0]!.leaves.push({ fingerprint: FP_POISON, orgId: ORG_POISON, merkleIndex: 2 });
    expected.ledgerDeltas[1]!.delta = -1;
    expect(() => assertDrainPassObservation(expected, observation())).toThrow(/org-scheduler transaction.*one org/);
  });

  it('rejects scheduler activity outside the declared fault window', () => {
    const actual = observation();
    actual.execution.startedAt = '2026-07-13T11:59:59.999Z';
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow(/fault window/);
  });
});
