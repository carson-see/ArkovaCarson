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
      schedulerExecutionId: EXECUTION_ID,
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
        orgId: ORG_HEALTHY, decision: 'not-required', reason: null, referenceId: null,
        requiredAmount: 0, balanceBefore: null, balanceAfter: null, occurredAt: '2026-07-13T12:00:07.000Z',
      },
      {
        eventId: 'gate-2', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_2,
        orgId: secondOrg, decision: 'not-required', reason: null, referenceId: null,
        requiredAmount: 0, balanceBefore: null, balanceAfter: null, occurredAt: '2026-07-13T12:00:07.000Z',
      },
      {
        eventId: 'gate-3', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_POISON,
        orgId: ORG_POISON, decision: 'denied', reason: 'insufficient_credits', referenceId: 'anchor-poison',
        requiredAmount: 1, balanceBefore: 0, balanceAfter: 0, occurredAt: '2026-07-13T12:00:08.000Z',
      },
    ],
    creditLedgerEvents: [],
    orgBalances: orgs.map((orgId) => ({
      schedulerExecutionId: EXECUTION_ID,
      orgId,
      before: orgId === ORG_POISON ? 0 : 10,
      after: orgId === ORG_POISON ? 0 : 10,
    })),
    ledgerDeltas: orgs.map((orgId) => ({ schedulerExecutionId: EXECUTION_ID, orgId, delta: 0 })),
  };
}

function splitIntoTwoTransactions(actual: DrainPassObservation): void {
  const common = {
    batchId: BATCH_ID,
    schedulerExecutionId: EXECUTION_ID,
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

  it('rejects contradictory denied-credit balances and a debit with a different reference', () => {
    const wrongBalance = observation();
    Object.assign(wrongBalance.creditGateEvents[2]!, {
      referenceId: 'anchor-poison',
      requiredAmount: 1,
      balanceBefore: 3,
      balanceAfter: 3,
    });
    expect(() => assertDrainPassObservation(expectation(), wrongBalance)).toThrow(/insufficient.*balance/i);

    const wrongReference = observation();
    Object.assign(wrongReference.creditGateEvents[0]!, {
      decision: 'allowed',
      reason: 'rule.auto_anchor_queue_run',
      referenceId: 'anchor-expected',
      requiredAmount: 1,
      balanceBefore: 10,
      balanceAfter: 9,
    });
    wrongReference.passRows[0]!.queueCreditChargedAt = '2026-07-13T12:00:09.000Z';
    wrongReference.creditLedgerEvents.push({
      eventId: 'ledger-wrong-reference', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_1,
      orgId: ORG_HEALTHY, kind: 'debit', amount: 1, referenceId: 'anchor-other',
      occurredAt: '2026-07-13T12:00:08.000Z',
    });
    wrongReference.orgBalances.find((row) => row.orgId === ORG_HEALTHY)!.after = 9;
    wrongReference.ledgerDeltas.find((row) => row.orgId === ORG_HEALTHY)!.delta = -1;
    expect(() => assertDrainPassObservation(expectation(), wrongReference)).toThrow(/reference/i);
  });

  it('derives credit debit and balance truth from raw events', () => {
    const actual = observation();
    actual.creditGateEvents[0] = {
      ...actual.creditGateEvents[0]!, decision: 'allowed', reason: 'rule.auto_anchor_queue_run',
      referenceId: 'anchor-1', requiredAmount: 1, balanceBefore: 10, balanceAfter: 9,
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
      referenceId: 'anchor-poison', requiredAmount: 1, balanceBefore: 1, balanceAfter: 0,
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
    actual.orgBalances.find((row) => row.orgId === ORG_POISON)!.before = 1;
    actual.orgBalances.find((row) => row.orgId === ORG_POISON)!.after = 1;
    expect(assertDrainPassObservation(expectation(), actual)).toMatchObject({
      poisonLeaves: 1,
      creditStarvedLeaves: 0,
      refundedFailureLeaves: 1,
    });
  });

  it('rejects charged+denied DB metadata and refund-before-debit chronology', () => {
    const contradictoryMetadata = observation();
    contradictoryMetadata.passRows[2]!.queueCreditChargedAt = '2026-07-13T12:00:08.500Z';
    expect(() => assertDrainPassObservation(expectation(), contradictoryMetadata)).toThrow(/both charged and denied/);

    const reversed = observation();
    reversed.creditGateEvents[2] = {
      ...reversed.creditGateEvents[2]!,
      decision: 'allowed',
      reason: 'rule.auto_anchor_queue_run',
      referenceId: 'anchor-poison',
      requiredAmount: 1,
      balanceBefore: 1,
      balanceAfter: 0,
    };
    reversed.passRows[2] = {
      ...reversed.passRows[2]!,
      creditDenialReason: null,
      queueCreditDeniedAt: null,
      queueCreditChargedAt: '2026-07-13T12:00:09.000Z',
    };
    reversed.creditLedgerEvents.push(
      {
        eventId: 'ledger-debit-reversed', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_POISON,
        orgId: ORG_POISON, kind: 'debit', amount: 1, referenceId: 'anchor-poison',
        occurredAt: '2026-07-13T12:00:09.000Z',
      },
      {
        eventId: 'ledger-refund-reversed', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_POISON,
        orgId: ORG_POISON, kind: 'refund', amount: 1, referenceId: 'anchor-poison',
        occurredAt: '2026-07-13T12:00:08.500Z',
      },
    );
    reversed.orgBalances.find((row) => row.orgId === ORG_POISON)!.before = 1;
    reversed.orgBalances.find((row) => row.orgId === ORG_POISON)!.after = 1;
    expect(() => assertDrainPassObservation(expectation(), reversed)).toThrow(/refund must occur strictly after its debit/);
  });

  it('rejects per-org gate balances that do not form one chronological sequence', () => {
    const actual = observation();
    for (const [index, fingerprint] of [FP_1, FP_2].entries()) {
      actual.creditGateEvents[index] = {
        ...actual.creditGateEvents[index]!,
        decision: 'allowed',
        reason: 'rule.auto_anchor_queue_run',
        referenceId: `anchor-${index + 1}`,
        requiredAmount: 1,
        balanceBefore: 10,
        balanceAfter: 9,
        occurredAt: `2026-07-13T12:00:0${7 + index}.000Z`,
      };
      actual.passRows[index]!.queueCreditChargedAt = `2026-07-13T12:00:0${8 + index}.000Z`;
      actual.creditLedgerEvents.push({
        eventId: `ledger-sequence-${index}`, schedulerExecutionId: EXECUTION_ID, fingerprint,
        orgId: ORG_HEALTHY, kind: 'debit', amount: 1, referenceId: `anchor-${index + 1}`,
        occurredAt: `2026-07-13T12:00:0${8 + index}.000Z`,
      });
    }
    actual.orgBalances.find((row) => row.orgId === ORG_HEALTHY)!.after = 8;
    actual.ledgerDeltas.find((row) => row.orgId === ORG_HEALTHY)!.delta = -2;
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow(/coherent chronological sequence/);
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

    const earlySignet = observation();
    earlySignet.transactions[0]!.acceptedAt = '2026-07-13T12:00:04.000Z';
    expect(() => assertDrainPassObservation(expectation(), earlySignet)).toThrow(/signet.*Scheduler execution/i);

    const beforeTrigger = observation();
    beforeTrigger.transactions[0]!.acceptedAt = '2026-07-13T12:00:05.500Z';
    expect(() => assertDrainPassObservation(expectation(), beforeTrigger)).toThrow(/signet.*trigger|trigger.*signet/i);

    const beforeGate = observation();
    beforeGate.transactions[0]!.acceptedAt = '2026-07-13T12:00:06.500Z';
    expect(() => assertDrainPassObservation(expectation(), beforeGate)).toThrow(/signet.*credit gate|credit gate.*signet/i);

    const lateDenial = observation();
    lateDenial.passRows[2]!.queueCreditDeniedAt = '2026-07-13T12:00:21.000Z';
    expect(() => assertDrainPassObservation(expectation(), lateDenial)).toThrow(/queueCreditDeniedAt|credit.*Scheduler execution/i);
  });

  it('requires signet acceptance after the exact debit for every leaf in its transaction', () => {
    const actual = observation();
    actual.creditGateEvents[0] = {
      ...actual.creditGateEvents[0]!, decision: 'allowed', reason: 'rule.auto_anchor_queue_run',
      referenceId: 'anchor-1', requiredAmount: 1, balanceBefore: 10, balanceAfter: 9,
      occurredAt: '2026-07-13T12:00:07.000Z',
    };
    actual.passRows[0]!.queueCreditChargedAt = '2026-07-13T12:00:09.000Z';
    actual.creditLedgerEvents.push({
      eventId: 'ledger-debit-after-signet', schedulerExecutionId: EXECUTION_ID, fingerprint: FP_1,
      orgId: ORG_HEALTHY, kind: 'debit', amount: 1, referenceId: 'anchor-1',
      occurredAt: '2026-07-13T12:00:09.000Z',
    });
    actual.orgBalances.find((row) => row.orgId === ORG_HEALTHY)!.after = 9;
    actual.ledgerDeltas.find((row) => row.orgId === ORG_HEALTHY)!.delta = -1;
    actual.transactions[0]!.acceptedAt = '2026-07-13T12:00:08.000Z';
    expect(() => assertDrainPassObservation(expectation(), actual)).toThrow(/signet.*debit|debit.*signet/i);
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

  it('rejects one transaction and claimed identity set reused across passes', () => {
    const expectedFirst = expectation();
    const expectedSecond = structuredClone(expectedFirst);
    expectedSecond.schedulerExecutionId = 'scheduler-offline-r3-second';
    expectedSecond.faultWindow.id = 'fault-window-offline-r3-second';

    const first = observation();
    first.pendingBefore = 5;
    first.pendingAfter = 3;

    const second = observation();
    second.pendingBefore = 3;
    second.pendingAfter = 1;
    second.execution.schedulerExecutionId = expectedSecond.schedulerExecutionId;
    second.execution.faultWindowId = expectedSecond.faultWindow.id;
    second.execution.startedAt = '2026-07-13T12:00:21.000Z';
    second.execution.completedAt = '2026-07-13T12:00:40.000Z';
    second.triggerFirings[0]!.schedulerExecutionId = expectedSecond.schedulerExecutionId;
    second.triggerFirings[0]!.firedAt = '2026-07-13T12:00:22.000Z';
    for (const row of second.passRows) row.schedulerExecutionId = expectedSecond.schedulerExecutionId;
    for (const gate of second.creditGateEvents) {
      gate.schedulerExecutionId = expectedSecond.schedulerExecutionId;
      gate.occurredAt = '2026-07-13T12:00:23.000Z';
    }
    second.passRows[2]!.queueCreditDeniedAt = '2026-07-13T12:00:23.000Z';
    second.transactions[0]!.acceptedAt = '2026-07-13T12:00:30.000Z';
    for (const balance of second.orgBalances) balance.schedulerExecutionId = expectedSecond.schedulerExecutionId;
    for (const delta of second.ledgerDeltas) delta.schedulerExecutionId = expectedSecond.schedulerExecutionId;

    expect(() => assertDrainWindowObservation({
      scenarioId: 'replay-window',
      kind: 'poison-isolation',
      armedTrigger: 'org-scheduler',
      expectedInitialPending: 5,
      expectedFinalPending: 1,
      passes: [expectedFirst, expectedSecond],
    }, [first, second])).toThrow(/reused.*transaction|claim.*reused/i);
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
