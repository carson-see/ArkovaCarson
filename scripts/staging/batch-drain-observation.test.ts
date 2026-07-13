import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertDrainPassObservation,
  validateDrainPassExpectation,
  type DrainPassExpectation,
  type DrainPassObservation,
} from './batch-drain-observation';

const BATCH_ID = 'batch-offline-r3';
const EXECUTION_ID = 'scheduler-offline-r3';
const FAULT_WINDOW_ID = 'fault-window-offline-r3';
const TX_ID = 'a'.repeat(64);
const TX_2 = 'd'.repeat(64);
const TX_HASH = 'b'.repeat(64);
const FP_1 = '1'.repeat(64);
const FP_2 = '2'.repeat(64);
const FP_POISON = '3'.repeat(64);
const ORG_HEALTHY = 'org-healthy';
const ORG_OTHER = 'org-other';
const ORG_POISON = 'org-poison';

function doubleSha256(bytes: Uint8Array): string {
  const first = createHash('sha256').update(bytes).digest();
  return createHash('sha256').update(first).digest('hex');
}

const ROOT = doubleSha256(Buffer.concat([Buffer.from(FP_1, 'hex'), Buffer.from(FP_2, 'hex')]));

function expectation(trigger: 'org-scheduler' | 'global-flush' = 'org-scheduler'): DrainPassExpectation {
  return {
    batchId: BATCH_ID,
    armedTrigger: trigger,
    schedulerExecutionId: EXECUTION_ID,
    faultWindow: {
      id: FAULT_WINDOW_ID,
      startsAt: '2026-07-13T12:00:00.000Z',
      endsAt: '2026-07-13T12:05:00.000Z',
    },
    claims: [
      { fingerprint: FP_1, orgId: ORG_HEALTHY, outcome: 'drained' },
      { fingerprint: FP_2, orgId: trigger === 'global-flush' ? ORG_OTHER : ORG_HEALTHY, outcome: 'drained' },
      { fingerprint: FP_POISON, orgId: ORG_POISON, outcome: 'credit-starved' },
    ],
  };
}

function observation(trigger: 'org-scheduler' | 'global-flush' = 'org-scheduler'): DrainPassObservation {
  const secondOrg = trigger === 'global-flush' ? ORG_OTHER : ORG_HEALTHY;
  return {
    execution: {
      schedulerExecutionId: EXECUTION_ID,
      armedTrigger: trigger,
      faultWindowId: FAULT_WINDOW_ID,
      startedAt: '2026-07-13T12:00:05.000Z',
      completedAt: '2026-07-13T12:00:20.000Z',
    },
    triggerFirings: [{
      trigger,
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
        orgId: secondOrg,
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
    transactions: [{ txId: TX_ID, batchId: BATCH_ID, merkleRoot: ROOT, signedBytesSha256: TX_HASH }],
    txLeaves: [
      { txId: TX_ID, batchId: BATCH_ID, fingerprint: FP_1, orgId: ORG_HEALTHY, merkleIndex: 0 },
      { txId: TX_ID, batchId: BATCH_ID, fingerprint: FP_2, orgId: secondOrg, merkleIndex: 1 },
    ],
    proofs: [
      {
        txId: TX_ID,
        batchId: BATCH_ID,
        fingerprint: FP_1,
        orgId: ORG_HEALTHY,
        merkleRoot: ROOT,
        merkleIndex: 0,
        leafCount: 2,
        proofPath: [{ hash: FP_2, position: 'right' }],
      },
      {
        txId: TX_ID,
        batchId: BATCH_ID,
        fingerprint: FP_2,
        orgId: secondOrg,
        merkleRoot: ROOT,
        merkleIndex: 1,
        leafCount: 2,
        proofPath: [{ hash: FP_1, position: 'left' }],
      },
    ],
    ledgerDeltas: trigger === 'global-flush'
      ? [
          { schedulerExecutionId: EXECUTION_ID, orgId: ORG_HEALTHY, delta: -1 },
          { schedulerExecutionId: EXECUTION_ID, orgId: ORG_OTHER, delta: -1 },
          { schedulerExecutionId: EXECUTION_ID, orgId: ORG_POISON, delta: 0 },
        ]
      : [
          { schedulerExecutionId: EXECUTION_ID, orgId: ORG_HEALTHY, delta: -2 },
          { schedulerExecutionId: EXECUTION_ID, orgId: ORG_POISON, delta: 0 },
        ],
  };
}

function splitIntoTwoTransactions(actual: DrainPassObservation): void {
  actual.transactions = [
    { txId: TX_ID, batchId: BATCH_ID, merkleRoot: FP_1, signedBytesSha256: TX_HASH },
    { txId: TX_2, batchId: BATCH_ID, merkleRoot: FP_2, signedBytesSha256: 'e'.repeat(64) },
  ];
  actual.txLeaves[0] = { ...actual.txLeaves[0]!, txId: TX_ID, merkleIndex: 0 };
  actual.txLeaves[1] = { ...actual.txLeaves[1]!, txId: TX_2, merkleIndex: 0 };
  actual.passRows[0] = { ...actual.passRows[0]!, chainTxId: TX_ID, merkleRoot: FP_1 };
  actual.passRows[1] = { ...actual.passRows[1]!, chainTxId: TX_2, merkleRoot: FP_2 };
  actual.proofs[0] = { ...actual.proofs[0]!, txId: TX_ID, merkleRoot: FP_1, merkleIndex: 0, leafCount: 1, proofPath: [] };
  actual.proofs[1] = { ...actual.proofs[1]!, txId: TX_2, merkleRoot: FP_2, merkleIndex: 0, leafCount: 1, proofPath: [] };
}

describe('assertDrainPassObservation — derived fail-closed R3 evidence', () => {
  it.each(['org-scheduler', 'global-flush'] as const)('accepts an actual valid %s pass', (trigger) => {
    expect(assertDrainPassObservation(expectation(trigger), observation(trigger))).toEqual({
      batchId: BATCH_ID,
      armedTrigger: trigger,
      schedulerExecutionId: EXECUTION_ID,
      faultWindowId: FAULT_WINDOW_ID,
      claimedLeaves: 3,
      drainedLeaves: 2,
      poisonLeaves: 1,
      transactionIds: [TX_ID],
      merkleRoots: [ROOT],
    });
  });

  it('enforces exactly one transaction per claimed org in an org-scheduler pass', () => {
    const actual = observation('org-scheduler');
    splitIntoTwoTransactions(actual);
    expect(() => assertDrainPassObservation(expectation('org-scheduler'), actual)).toThrow(
      /exactly one transaction per drained org per pass/,
    );
  });

  it('enforces exactly one mixed-org global transaction', () => {
    const actual = observation('global-flush');
    splitIntoTwoTransactions(actual);
    expect(() => assertDrainPassObservation(expectation('global-flush'), actual)).toThrow(
      /global-flush pass must produce exactly one mixed-org transaction/,
    );
  });

  it('rejects a global transaction above the 10k claim cap before sparse evidence can pass', () => {
    const claims = Array.from({ length: 10_001 }, (_, index) => ({
      fingerprint: (index + 1).toString(16).padStart(64, '0'),
      orgId: index % 2 === 0 ? ORG_HEALTHY : ORG_OTHER,
      outcome: 'drained' as const,
    }));
    const expected: DrainPassExpectation = { ...expectation('global-flush'), claims };
    const actual = observation('global-flush');
    actual.passRows = [];
    actual.txLeaves = claims.map((claim, merkleIndex) => ({
      txId: TX_ID,
      batchId: BATCH_ID,
      fingerprint: claim.fingerprint,
      orgId: claim.orgId,
      merkleIndex,
    }));
    actual.proofs = [];
    actual.ledgerDeltas = [];
    expect(() => assertDrainPassObservation(expected, actual)).toThrow(/at most 10000 leaves/);
  });

  it('independently recomputes the root from sibling paths instead of trusting a boolean', () => {
    const actual = observation();
    actual.proofs[0]!.proofPath[0]!.hash = 'f'.repeat(64);
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow(/proof.*recompute|recomputed proof/i);
  });

  it('rejects a reordered leaf set even when its actual root and proofs are internally consistent', () => {
    const actual = observation();
    const reversedRoot = doubleSha256(Buffer.concat([Buffer.from(FP_2, 'hex'), Buffer.from(FP_1, 'hex')]));
    actual.transactions[0]!.merkleRoot = reversedRoot;
    actual.txLeaves[0]!.merkleIndex = 1;
    actual.txLeaves[1]!.merkleIndex = 0;
    actual.passRows[0]!.merkleRoot = reversedRoot;
    actual.passRows[1]!.merkleRoot = reversedRoot;
    actual.proofs = [
      {
        ...actual.proofs[0]!,
        merkleRoot: reversedRoot,
        merkleIndex: 1,
        proofPath: [{ hash: FP_2, position: 'left' }],
      },
      {
        ...actual.proofs[1]!,
        merkleRoot: reversedRoot,
        merkleIndex: 0,
        proofPath: [{ hash: FP_1, position: 'right' }],
      },
    ];
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow(/declared claim order/);
  });

  it('derives credit deltas from drained counts and requires poison org zero', () => {
    const wrongHealthy = observation();
    wrongHealthy.ledgerDeltas[0]!.delta = -1;
    expect(() => assertDrainPassObservation(expectation(), wrongHealthy)).toThrow(/derived ledger delta/);

    const wrongPoison = observation();
    wrongPoison.ledgerDeltas[1]!.delta = -1;
    expect(() => assertDrainPassObservation(expectation(), wrongPoison)).toThrow(/derived ledger delta/);
  });

  it('rejects DB-unseedable bad-fingerprint evidence declarations', () => {
    const expected = expectation();
    expected.claims[2]!.outcome = 'bad-fingerprint' as never;
    expect(() => validateDrainPassExpectation(expected)).toThrow(/DB-unseedable/);
  });

  it('requires trigger firing chronology inside scheduler execution and the fault window', () => {
    const actual = observation();
    actual.triggerFirings[0]!.firedAt = '2026-07-13T12:00:04.000Z';
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow(/scheduler execution chronology/);
  });

  it.each([
    ['scheduler execution', (actual: DrainPassObservation) => { actual.execution.schedulerExecutionId = 'unrelated'; }],
    ['armed trigger', (actual: DrainPassObservation) => { actual.execution.armedTrigger = 'global-flush'; }],
    ['fault window', (actual: DrainPassObservation) => { actual.execution.faultWindowId = 'unrelated'; }],
    ['trigger firing', (actual: DrainPassObservation) => { actual.triggerFirings[0]!.batchId = 'unrelated'; }],
    ['pass row', (actual: DrainPassObservation) => { actual.passRows[0]!.batchId = 'unrelated'; }],
    ['tx leaf org', (actual: DrainPassObservation) => { actual.txLeaves[0]!.orgId = ORG_POISON; }],
  ])('rejects unrelated %s evidence', (_label, mutate) => {
    const actual = observation();
    mutate(actual);
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow();
  });
});
