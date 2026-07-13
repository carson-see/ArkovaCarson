import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  assertDrainPassObservation,
  assertDrainWindowObservation,
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
      { fingerprint: FP_1, orgId: ORG_HEALTHY },
      { fingerprint: FP_2, orgId: trigger === 'global-flush' ? ORG_OTHER : ORG_HEALTHY },
      { fingerprint: FP_POISON, orgId: ORG_POISON },
    ],
  };
}

function observation(trigger: 'org-scheduler' | 'global-flush' = 'org-scheduler'): DrainPassObservation {
  const secondOrg = trigger === 'global-flush' ? ORG_OTHER : ORG_HEALTHY;
  const orgs = trigger === 'global-flush'
    ? [ORG_HEALTHY, ORG_OTHER, ORG_POISON]
    : [ORG_HEALTHY, ORG_POISON];
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
    pendingBefore: 3,
    pendingAfter: 1,
    passRows: [
      {
        fingerprint: FP_1,
        orgId: ORG_HEALTHY,
        batchId: BATCH_ID,
        schedulerExecutionId: EXECUTION_ID,
        claimOrder: 1,
        status: 'SUBMITTED',
        chainTxId: TX_ID,
        merkleRoot: ROOT,
        creditDenialReason: null,
        queueCreditChargedAt: null,
        queueCreditDeniedAt: null,
      },
      {
        fingerprint: FP_2,
        orgId: secondOrg,
        batchId: BATCH_ID,
        schedulerExecutionId: EXECUTION_ID,
        claimOrder: 2,
        status: 'SECURED',
        chainTxId: TX_ID,
        merkleRoot: ROOT,
        creditDenialReason: null,
        queueCreditChargedAt: null,
        queueCreditDeniedAt: null,
      },
      {
        fingerprint: FP_POISON,
        orgId: ORG_POISON,
        batchId: BATCH_ID,
        schedulerExecutionId: EXECUTION_ID,
        claimOrder: 3,
        status: 'PENDING',
        chainTxId: null,
        merkleRoot: null,
        creditDenialReason: 'insufficient_credits',
        queueCreditChargedAt: null,
        queueCreditDeniedAt: '2026-07-13T12:00:08.000Z',
      },
    ],
    transactions: [{
      txId: TX_ID,
      batchId: BATCH_ID,
      merkleRoot: ROOT,
      signedBytesSha256: TX_HASH,
      network: 'signet',
      nodeId: 'signet-node-fixture',
      chainState: 'mempool',
      acceptedAt: '2026-07-13T12:00:12.000Z',
    }],
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
    creditGateEvents: [
      {
        eventId: 'gate-1', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_1,
        orgId: ORG_HEALTHY, decision: 'not-required', reason: null, occurredAt: '2026-07-13T12:00:07.000Z',
      },
      {
        eventId: 'gate-2', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_2,
        orgId: secondOrg, decision: 'not-required', reason: null, occurredAt: '2026-07-13T12:00:07.000Z',
      },
      {
        eventId: 'gate-3', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_POISON,
        orgId: ORG_POISON, decision: 'denied', reason: 'insufficient_credits', occurredAt: '2026-07-13T12:00:08.000Z',
      },
    ],
    creditLedgerEvents: [],
    orgBalances: orgs.map((orgId) => ({
      schedulerExecutionId: EXECUTION_ID,
      orgId,
      before: 10,
      after: 10,
    })),
    ledgerDeltas: orgs.map((orgId) => ({ schedulerExecutionId: EXECUTION_ID, orgId, delta: 0 })),
  };
}

function splitIntoTwoTransactions(actual: DrainPassObservation): void {
  const common = {
    batchId: BATCH_ID,
    network: 'signet' as const,
    nodeId: 'signet-node-fixture',
    chainState: 'mempool' as const,
    acceptedAt: '2026-07-13T12:00:12.000Z',
  };
  actual.transactions = [
    { ...common, txId: TX_ID, merkleRoot: FP_1, signedBytesSha256: TX_HASH },
    { ...common, txId: TX_2, merkleRoot: FP_2, signedBytesSha256: 'e'.repeat(64) },
  ];
  actual.txLeaves[0] = { ...actual.txLeaves[0]!, txId: TX_ID, merkleIndex: 0 };
  actual.txLeaves[1] = { ...actual.txLeaves[1]!, txId: TX_2, merkleIndex: 0 };
  actual.passRows[0] = { ...actual.passRows[0]!, chainTxId: TX_ID, merkleRoot: FP_1 };
  actual.passRows[1] = { ...actual.passRows[1]!, chainTxId: TX_2, merkleRoot: FP_2 };
  actual.proofs[0] = { ...actual.proofs[0]!, txId: TX_ID, merkleRoot: FP_1, merkleIndex: 0, leafCount: 1, proofPath: [] };
  actual.proofs[1] = { ...actual.proofs[1]!, txId: TX_2, merkleRoot: FP_2, merkleIndex: 0, leafCount: 1, proofPath: [] };
}

describe('assertDrainPassObservation — event-derived fail-closed R3 evidence', () => {
  it.each(['org-scheduler', 'global-flush'] as const)('accepts an actual valid %s pass', (trigger) => {
    expect(assertDrainPassObservation(expectation(trigger), observation(trigger))).toMatchObject({
      batchId: BATCH_ID,
      armedTrigger: trigger,
      schedulerExecutionId: EXECUTION_ID,
      pendingBefore: 3,
      pendingAfter: 1,
      claimedLeaves: 3,
      drainedLeaves: 2,
      poisonLeaves: 1,
      creditStarvedLeaves: 1,
      refundedFailureLeaves: 0,
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

  it('independently recomputes proof paths', () => {
    const actual = observation();
    actual.proofs[0]!.proofPath[0]!.hash = 'f'.repeat(64);
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow(/recomputed proof/i);
  });

  it('rejects a reordered leaf set even when root and proofs are internally consistent', () => {
    const actual = observation();
    const reversedRoot = doubleSha256(Buffer.concat([Buffer.from(FP_2, 'hex'), Buffer.from(FP_1, 'hex')]));
    actual.transactions[0]!.merkleRoot = reversedRoot;
    actual.txLeaves[0]!.merkleIndex = 1;
    actual.txLeaves[1]!.merkleIndex = 0;
    actual.passRows[0]!.merkleRoot = reversedRoot;
    actual.passRows[1]!.merkleRoot = reversedRoot;
    actual.proofs = [
      { ...actual.proofs[0]!, merkleRoot: reversedRoot, merkleIndex: 1, proofPath: [{ hash: FP_2, position: 'left' }] },
      { ...actual.proofs[1]!, merkleRoot: reversedRoot, merkleIndex: 0, proofPath: [{ hash: FP_1, position: 'right' }] },
    ];
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow(/observed durable claim order/);
  });

  it('derives credit-starvation from gate and DB facts, never an expected outcome', () => {
    expect(expectation().claims.every((claim) => !('outcome' in claim))).toBe(true);
    const wrong = observation();
    wrong.creditGateEvents[2]!.reason = 'operator-declared-poison';
    expect(() => assertDrainPassObservation(expectation(), wrong)).toThrow(/gate, refund, and DB facts/);
  });

  it('derives credit debit and balance truth from raw events', () => {
    const actual = observation();
    actual.creditGateEvents[0] = {
      ...actual.creditGateEvents[0]!, decision: 'allowed', reason: 'rule.auto_anchor_queue_run',
    };
    actual.passRows[0]!.queueCreditChargedAt = '2026-07-13T12:00:08.000Z';
    actual.creditLedgerEvents.push({
      eventId: 'ledger-debit-1', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_1,
      orgId: ORG_HEALTHY, kind: 'debit', amount: 1, referenceId: 'anchor-1', occurredAt: '2026-07-13T12:00:08.000Z',
    });
    actual.orgBalances.find((row) => row.orgId === ORG_HEALTHY)!.after = 9;
    actual.ledgerDeltas.find((row) => row.orgId === ORG_HEALTHY)!.delta = -1;
    expect(assertDrainPassObservation(expectation(), actual).drainedLeaves).toBe(2);

    actual.ledgerDeltas.find((row) => row.orgId === ORG_HEALTHY)!.delta = 0;
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow(/raw debit\/refund events/);
  });

  it('derives a refunded failure from observed debit+refund and pending DB state', () => {
    const actual = observation();
    actual.creditGateEvents[2] = {
      ...actual.creditGateEvents[2]!, decision: 'allowed', reason: 'rule.auto_anchor_queue_run',
    };
    actual.passRows[2] = {
      ...actual.passRows[2]!, creditDenialReason: null, queueCreditDeniedAt: null,
      queueCreditChargedAt: '2026-07-13T12:00:08.000Z',
    };
    actual.creditLedgerEvents.push(
      {
        eventId: 'ledger-debit-poison', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_POISON,
        orgId: ORG_POISON, kind: 'debit', amount: 1, referenceId: 'anchor-poison', occurredAt: '2026-07-13T12:00:08.000Z',
      },
      {
        eventId: 'ledger-refund-poison', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_POISON,
        orgId: ORG_POISON, kind: 'refund', amount: 1, referenceId: 'anchor-poison', occurredAt: '2026-07-13T12:00:09.000Z',
      },
    );
    expect(assertDrainPassObservation(expectation(), actual)).toMatchObject({
      poisonLeaves: 1,
      creditStarvedLeaves: 0,
      refundedFailureLeaves: 1,
    });
  });

  it('rejects malformed declaration identities before any adapter can arm', () => {
    const expected = expectation();
    expected.claims[2]!.fingerprint = 'not-a-fingerprint';
    expect(() => validateDrainPassExpectation(expected)).toThrow(/fingerprint/);
  });

  it('requires durable claim order and Scheduler chronology', () => {
    const reordered = observation();
    reordered.passRows[2]!.claimOrder = 2;
    expect(() => assertDrainPassObservation(expectation(), reordered)).toThrow(/claimOrder/);

    const early = observation();
    early.triggerFirings[0]!.firedAt = '2026-07-13T12:00:04.000Z';
    expect(() => assertDrainPassObservation(expectation(), early)).toThrow(/scheduler execution chronology/);
  });

  it('joins poison isolation only from actual pass and remainder facts', () => {
    const expectedPass = expectation();
    expect(assertDrainWindowObservation({
      scenarioId: 'poison-window',
      kind: 'poison-isolation',
      armedTrigger: 'org-scheduler',
      expectedInitialPending: 3,
      expectedFinalPending: 1,
      passes: [expectedPass],
    }, [observation()])).toMatchObject({
      schedulerTicks: 1,
      drainedLeaves: 2,
      poisonLeaves: 1,
      finalPending: 1,
    });
  });

  it.each([
    ['scheduler execution', (actual: DrainPassObservation) => { actual.execution.schedulerExecutionId = 'unrelated'; }],
    ['armed trigger', (actual: DrainPassObservation) => { actual.execution.armedTrigger = 'global-flush'; }],
    ['fault window', (actual: DrainPassObservation) => { actual.execution.faultWindowId = 'unrelated'; }],
    ['trigger firing', (actual: DrainPassObservation) => { actual.triggerFirings[0]!.batchId = 'unrelated'; }],
    ['pass row', (actual: DrainPassObservation) => { actual.passRows[0]!.batchId = 'unrelated'; }],
    ['tx leaf org', (actual: DrainPassObservation) => { actual.txLeaves[0]!.orgId = ORG_POISON; }],
    ['credit gate org', (actual: DrainPassObservation) => { actual.creditGateEvents[0]!.orgId = ORG_POISON; }],
  ])('rejects unrelated %s evidence', (_label, mutate) => {
    const actual = observation();
    mutate(actual);
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow();
  });
});
