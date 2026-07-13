/**
 * Pure fail-closed assertions for evidence collected by a supervised drain
 * adapter. This module never queries a database, scheduler, chain node, or rig;
 * callers must supply the complete actual observation for the declared window.
 */

export type DrainTrigger = 'org-scheduler' | 'global-flush';
export type DrainClaimOutcome = 'drained' | 'credit-starved' | 'bad-fingerprint';
export type ObservedClaimOutcome = 'drained' | 'succeeded-no-broadcast' | 'failed-contained';

export interface DrainFaultWindow {
  id: string;
  startsAt: string;
  endsAt: string;
}

export interface ExpectedDrainClaim {
  fingerprint: string;
  orgId: string;
  outcome: DrainClaimOutcome;
}

export interface ExpectedTransactionLeaf {
  fingerprint: string;
  orgId: string;
  merkleIndex: number;
}

export interface ExpectedDrainTransaction {
  txId: string;
  batchId: string;
  merkleRoot: string;
  signedBytesSha256: string;
  leaves: ExpectedTransactionLeaf[];
}

export interface ExpectedLedgerDelta {
  orgId: string;
  delta: number;
}

export interface DrainPassExpectation {
  batchId: string;
  armedTrigger: DrainTrigger;
  schedulerExecutionId: string;
  faultWindow: DrainFaultWindow;
  claims: ExpectedDrainClaim[];
  transactions: ExpectedDrainTransaction[];
  ledgerDeltas: ExpectedLedgerDelta[];
}

export interface ObservedSchedulerExecution {
  schedulerExecutionId: string;
  armedTrigger: DrainTrigger;
  faultWindowId: string;
  startedAt: string;
  completedAt: string;
}

export interface ObservedTriggerFiring {
  trigger: DrainTrigger;
  schedulerExecutionId: string;
  batchId: string;
  firedAt: string;
}

export type ObservedAnchorStatus = 'PENDING' | 'BROADCASTING' | 'SUBMITTED' | 'SECURED' | 'FAILED';

export interface ObservedPassRow {
  fingerprint: string;
  orgId: string;
  batchId: string;
  schedulerExecutionId: string;
  status: ObservedAnchorStatus;
  chainTxId: string | null;
  merkleRoot: string | null;
  observedOutcome: ObservedClaimOutcome;
}

export interface ObservedDrainTransaction {
  txId: string;
  batchId: string;
  merkleRoot: string;
  signedBytesSha256: string;
}

export interface ObservedTransactionLeaf extends ExpectedTransactionLeaf {
  txId: string;
  batchId: string;
}

export interface ObservedAnchorProof extends ObservedTransactionLeaf {
  merkleRoot: string;
  verified: boolean;
}

export interface ObservedLedgerDelta extends ExpectedLedgerDelta {
  schedulerExecutionId: string;
}

export interface DrainPassObservation {
  execution: ObservedSchedulerExecution;
  triggerFirings: ObservedTriggerFiring[];
  passRows: ObservedPassRow[];
  transactions: ObservedDrainTransaction[];
  txLeaves: ObservedTransactionLeaf[];
  proofs: ObservedAnchorProof[];
  ledgerDeltas: ObservedLedgerDelta[];
}

export interface DrainPassEvidenceSummary {
  batchId: string;
  armedTrigger: DrainTrigger;
  schedulerExecutionId: string;
  faultWindowId: string;
  claimedLeaves: number;
  drainedLeaves: number;
  poisonLeaves: number;
  transactionIds: string[];
  merkleRoots: string[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function requireId(value: string, name: string): void {
  if (!value?.trim()) throw new Error(`${name} is required.`);
}

function requireHash(value: string, name: string): void {
  if (!SHA256_HEX.test(value)) throw new Error(`${name} must be lowercase 64-hex.`);
}

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid timestamp.`);
  return parsed;
}

function assertWithinFaultWindow(
  value: string,
  name: string,
  startMs: number,
  endMs: number,
): number {
  const actualMs = timestamp(value, name);
  if (actualMs < startMs || actualMs > endMs) {
    throw new Error(`${name} is outside the declared fault window.`);
  }
  return actualMs;
}

function key(txId: string, fingerprint: string): string {
  return `${txId}:${fingerprint}`;
}

function expectedOutcome(outcome: DrainClaimOutcome): ObservedClaimOutcome {
  if (outcome === 'credit-starved') return 'succeeded-no-broadcast';
  if (outcome === 'bad-fingerprint') return 'failed-contained';
  return 'drained';
}

function validateExpectation(expectation: DrainPassExpectation): {
  startMs: number;
  endMs: number;
  claimsByFingerprint: Map<string, ExpectedDrainClaim>;
  txById: Map<string, ExpectedDrainTransaction>;
  expectedLeafByFingerprint: Map<string, ExpectedTransactionLeaf & { txId: string; merkleRoot: string }>;
} {
  requireId(expectation.batchId, 'batchId');
  requireId(expectation.schedulerExecutionId, 'schedulerExecutionId');
  requireId(expectation.faultWindow.id, 'faultWindow.id');
  const startMs = timestamp(expectation.faultWindow.startsAt, 'faultWindow.startsAt');
  const endMs = timestamp(expectation.faultWindow.endsAt, 'faultWindow.endsAt');
  if (endMs <= startMs) throw new Error('Declared fault window must end after it starts.');
  if (expectation.claims.length === 0) throw new Error('Drain expectation requires claimed leaves.');

  const claimsByFingerprint = new Map<string, ExpectedDrainClaim>();
  for (const claim of expectation.claims) {
    requireHash(claim.fingerprint, 'claim fingerprint');
    requireId(claim.orgId, 'claim orgId');
    if (claimsByFingerprint.has(claim.fingerprint)) {
      throw new Error(`Duplicate claimed fingerprint ${claim.fingerprint}.`);
    }
    claimsByFingerprint.set(claim.fingerprint, claim);
  }

  const txById = new Map<string, ExpectedDrainTransaction>();
  const expectedLeafByFingerprint = new Map<
    string,
    ExpectedTransactionLeaf & { txId: string; merkleRoot: string }
  >();
  for (const transaction of expectation.transactions) {
    requireHash(transaction.txId, 'expected txId');
    requireHash(transaction.merkleRoot, 'expected merkleRoot');
    requireHash(transaction.signedBytesSha256, 'expected signedBytesSha256');
    if (transaction.batchId !== expectation.batchId) {
      throw new Error('Expected transaction batchId does not match the declared batch.');
    }
    if (txById.has(transaction.txId)) throw new Error(`Duplicate expected txId ${transaction.txId}.`);
    txById.set(transaction.txId, transaction);

    const orgIds = new Set<string>();
    const indexes = new Set<number>();
    for (const leaf of transaction.leaves) {
      const claim = claimsByFingerprint.get(leaf.fingerprint);
      if (!claim || claim.orgId !== leaf.orgId || claim.outcome !== 'drained') {
        throw new Error('Expected transaction leaf must match one declared drained claim.');
      }
      if (!Number.isInteger(leaf.merkleIndex) || leaf.merkleIndex < 0 || indexes.has(leaf.merkleIndex)) {
        throw new Error('Expected transaction merkle indexes must be unique non-negative integers.');
      }
      if (expectedLeafByFingerprint.has(leaf.fingerprint)) {
        throw new Error(`Claimed fingerprint ${leaf.fingerprint} appears in multiple transactions.`);
      }
      indexes.add(leaf.merkleIndex);
      orgIds.add(leaf.orgId);
      expectedLeafByFingerprint.set(leaf.fingerprint, {
        ...leaf,
        txId: transaction.txId,
        merkleRoot: transaction.merkleRoot,
      });
    }
    const sortedIndexes = [...indexes].sort((left, right) => left - right);
    if (sortedIndexes.some((index, position) => index !== position)) {
      throw new Error('Expected transaction merkle indexes must be contiguous from zero.');
    }
    if (expectation.armedTrigger === 'org-scheduler' && orgIds.size > 1) {
      throw new Error('An org-scheduler transaction must contain leaves from exactly one org.');
    }
  }

  const drainedClaims = expectation.claims.filter((claim) => claim.outcome === 'drained');
  if (expectedLeafByFingerprint.size !== drainedClaims.length) {
    throw new Error('Every declared drained claim must map to exactly one expected transaction leaf.');
  }

  const claimedOrgIds = new Set(expectation.claims.map((claim) => claim.orgId));
  const ledgerOrgIds = new Set<string>();
  for (const ledger of expectation.ledgerDeltas) {
    requireId(ledger.orgId, 'expected ledger orgId');
    if (!Number.isFinite(ledger.delta)) throw new Error('Expected ledger delta must be finite.');
    if (ledgerOrgIds.has(ledger.orgId)) throw new Error(`Duplicate expected ledger org ${ledger.orgId}.`);
    ledgerOrgIds.add(ledger.orgId);
  }
  if (ledgerOrgIds.size !== claimedOrgIds.size || [...claimedOrgIds].some((orgId) => !ledgerOrgIds.has(orgId))) {
    throw new Error('Expected ledger deltas must cover exactly the claimed orgs, including zero deltas.');
  }

  return { startMs, endMs, claimsByFingerprint, txById, expectedLeafByFingerprint };
}

/** Validate a declaration before any adapter is armed or scheduler is started. */
export function validateDrainPassExpectation(expectation: DrainPassExpectation): void {
  validateExpectation(expectation);
}

/**
 * Assert a complete actual pass against its declared batch/trigger/window.
 * Every evidence collection is exact-set compared so unrelated rows cannot
 * make a sparse or partial observation pass.
 */
export function assertDrainPassObservation(
  expectation: DrainPassExpectation,
  observation: DrainPassObservation,
): DrainPassEvidenceSummary {
  const {
    startMs,
    endMs,
    claimsByFingerprint,
    txById,
    expectedLeafByFingerprint,
  } = validateExpectation(expectation);

  const execution = observation.execution;
  if (execution.schedulerExecutionId !== expectation.schedulerExecutionId) {
    throw new Error('Observed scheduler execution does not match the declaration.');
  }
  if (execution.armedTrigger !== expectation.armedTrigger) {
    throw new Error('Observed armed trigger does not match the declaration.');
  }
  if (execution.faultWindowId !== expectation.faultWindow.id) {
    throw new Error('Observed scheduler execution names an unrelated fault window.');
  }
  const startedMs = assertWithinFaultWindow(execution.startedAt, 'Scheduler start', startMs, endMs);
  const completedMs = assertWithinFaultWindow(execution.completedAt, 'Scheduler completion', startMs, endMs);
  if (completedMs < startedMs) throw new Error('Scheduler completion predates its start.');

  if (observation.triggerFirings.length !== 1) {
    throw new Error('Actual evidence must contain exactly one trigger firing in the declared fault window.');
  }
  const firing = observation.triggerFirings[0]!;
  if (
    firing.trigger !== expectation.armedTrigger
    || firing.schedulerExecutionId !== expectation.schedulerExecutionId
    || firing.batchId !== expectation.batchId
  ) {
    throw new Error('Observed trigger firing is not correlated to the declared trigger, execution, and batch.');
  }
  assertWithinFaultWindow(firing.firedAt, 'Trigger firing', startMs, endMs);

  if (observation.passRows.length !== expectation.claims.length) {
    throw new Error('Actual pass rows must exactly equal the declared claimed leaves.');
  }
  const actualRowsByFingerprint = new Map<string, ObservedPassRow>();
  for (const row of observation.passRows) {
    if (actualRowsByFingerprint.has(row.fingerprint)) throw new Error(`Duplicate actual pass row ${row.fingerprint}.`);
    actualRowsByFingerprint.set(row.fingerprint, row);
  }
  for (const claim of expectation.claims) {
    const row = actualRowsByFingerprint.get(claim.fingerprint);
    if (
      !row
      || row.orgId !== claim.orgId
      || row.batchId !== expectation.batchId
      || row.schedulerExecutionId !== expectation.schedulerExecutionId
    ) {
      throw new Error(`Actual pass row for ${claim.fingerprint} is missing or belongs to unrelated evidence.`);
    }
    if (row.observedOutcome !== expectedOutcome(claim.outcome)) {
      throw new Error(`Actual pass row outcome does not match claim ${claim.fingerprint}.`);
    }

    if (claim.outcome === 'drained') {
      const expectedLeaf = expectedLeafByFingerprint.get(claim.fingerprint)!;
      if (
        (row.status !== 'SUBMITTED' && row.status !== 'SECURED')
        || row.chainTxId !== expectedLeaf.txId
        || row.merkleRoot !== expectedLeaf.merkleRoot
      ) {
        throw new Error(`Drained pass row ${claim.fingerprint} lacks the expected terminal tx/root state.`);
      }
    } else if (row.status !== 'PENDING' || row.chainTxId !== null || row.merkleRoot !== null) {
      throw new Error(`Poison pass row ${claim.fingerprint} must remain PENDING without tx/root attribution.`);
    }
  }

  if (observation.transactions.length !== expectation.transactions.length) {
    throw new Error('Actual transactions must exactly equal the expected batch transactions.');
  }
  const actualTxIds = new Set<string>();
  for (const transaction of observation.transactions) {
    const expected = txById.get(transaction.txId);
    if (
      !expected
      || actualTxIds.has(transaction.txId)
      || transaction.batchId !== expectation.batchId
      || transaction.merkleRoot !== expected.merkleRoot
      || transaction.signedBytesSha256 !== expected.signedBytesSha256
    ) {
      throw new Error('Actual transaction is duplicate, unrelated, or mismatches tx/root/signed bytes.');
    }
    actualTxIds.add(transaction.txId);
  }

  const expectedLeafCount = [...txById.values()].reduce((sum, transaction) => sum + transaction.leaves.length, 0);
  if (observation.txLeaves.length !== expectedLeafCount) {
    throw new Error('Actual tx-to-leaf mapping is incomplete or contains unrelated leaves.');
  }
  const actualLeafKeys = new Set<string>();
  for (const leaf of observation.txLeaves) {
    const expectedLeaf = expectedLeafByFingerprint.get(leaf.fingerprint);
    if (
      !expectedLeaf
      || leaf.batchId !== expectation.batchId
      || leaf.txId !== expectedLeaf.txId
      || leaf.orgId !== expectedLeaf.orgId
      || leaf.merkleIndex !== expectedLeaf.merkleIndex
      || actualLeafKeys.has(key(leaf.txId, leaf.fingerprint))
    ) {
      throw new Error('Actual tx-to-leaf/org mapping is duplicate, unrelated, or mismatched.');
    }
    actualLeafKeys.add(key(leaf.txId, leaf.fingerprint));
  }

  if (observation.proofs.length !== expectedLeafCount) {
    throw new Error('Actual proofs must cover every drained leaf exactly once.');
  }
  const proofKeys = new Set<string>();
  for (const proof of observation.proofs) {
    const expectedLeaf = expectedLeafByFingerprint.get(proof.fingerprint);
    const proofKey = key(proof.txId, proof.fingerprint);
    if (
      !expectedLeaf
      || proof.batchId !== expectation.batchId
      || proof.txId !== expectedLeaf.txId
      || proof.orgId !== expectedLeaf.orgId
      || proof.merkleRoot !== expectedLeaf.merkleRoot
      || proof.merkleIndex !== expectedLeaf.merkleIndex
      || proof.verified !== true
      || proofKeys.has(proofKey)
    ) {
      throw new Error('Actual proof is duplicate, unverified, unrelated, or mismatches tx/leaf/org/root/index.');
    }
    proofKeys.add(proofKey);
  }

  if (observation.ledgerDeltas.length !== expectation.ledgerDeltas.length) {
    throw new Error('Actual ledger deltas must cover exactly the claimed orgs, including zeros.');
  }
  const expectedLedger = new Map(expectation.ledgerDeltas.map((delta) => [delta.orgId, delta.delta]));
  const actualLedgerOrgs = new Set<string>();
  for (const delta of observation.ledgerDeltas) {
    if (
      delta.schedulerExecutionId !== expectation.schedulerExecutionId
      || !expectedLedger.has(delta.orgId)
      || expectedLedger.get(delta.orgId) !== delta.delta
      || actualLedgerOrgs.has(delta.orgId)
    ) {
      throw new Error('Actual ledger delta is duplicate, unrelated, or mismatches the declared org delta.');
    }
    actualLedgerOrgs.add(delta.orgId);
  }

  return {
    batchId: expectation.batchId,
    armedTrigger: expectation.armedTrigger,
    schedulerExecutionId: expectation.schedulerExecutionId,
    faultWindowId: expectation.faultWindow.id,
    claimedLeaves: expectation.claims.length,
    drainedLeaves: expectedLeafByFingerprint.size,
    poisonLeaves: expectation.claims.length - expectedLeafByFingerprint.size,
    transactionIds: expectation.transactions.map((transaction) => transaction.txId),
    merkleRoots: expectation.transactions.map((transaction) => transaction.merkleRoot),
  };
}
