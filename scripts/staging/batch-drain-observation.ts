/**
 * Fail-closed assertions for Scheduler, database, credit-ledger, Merkle, and
 * signet facts collected by a supervised rig adapter. Expectations identify
 * seeded rows and the armed trigger only: pass outcome is derived exclusively
 * from observed DB state, gate decisions, balance snapshots, ledger events,
 * and chain acceptance.
 */

import { createHash } from 'node:crypto';

export const R3_BATCH_SIZE = 10_000;

export type DrainTrigger = 'org-scheduler' | 'global-flush';
export type DerivedClaimOutcome = 'drained' | 'credit-starved' | 'refunded-failure';

export interface DrainFaultWindow {
  id: string;
  startsAt: string;
  endsAt: string;
}

export interface ExpectedDrainClaim {
  fingerprint: string;
  orgId: string;
}

export interface DrainPassExpectation {
  batchId: string;
  armedTrigger: DrainTrigger;
  schedulerExecutionId: string;
  faultWindow: DrainFaultWindow;
  /** Identity set only. Outcome and committed order are observed facts. */
  claims: ExpectedDrainClaim[];
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
  /** One-based durable ordering used to reconstruct the committed leaf identity. */
  claimOrder: number;
  status: ObservedAnchorStatus;
  chainTxId: string | null;
  merkleRoot: string | null;
  creditDenialReason: string | null;
  queueCreditChargedAt: string | null;
  queueCreditDeniedAt: string | null;
}

export interface ObservedDrainTransaction {
  txId: string;
  batchId: string;
  schedulerExecutionId: string;
  merkleRoot: string;
  signedBytesSha256: string;
  network: 'signet';
  nodeId: string;
  chainState: 'mempool' | 'confirmed';
  acceptedAt: string;
}

export interface ObservedTransactionLeaf {
  txId: string;
  batchId: string;
  fingerprint: string;
  orgId: string;
  merkleIndex: number;
}

export interface MerkleProofSibling {
  hash: string;
  position: 'left' | 'right';
}

export interface ObservedAnchorProof extends ObservedTransactionLeaf {
  merkleRoot: string;
  leafCount: number;
  proofPath: MerkleProofSibling[];
}

export interface ObservedCreditGateEvent {
  eventId: string;
  schedulerExecutionId: string;
  fingerprint: string;
  orgId: string;
  decision: 'not-required' | 'allowed' | 'denied';
  reason: string | null;
  referenceId: string | null;
  requiredAmount: number;
  balanceBefore: number | null;
  balanceAfter: number | null;
  occurredAt: string;
}

export interface ObservedCreditLedgerEvent {
  eventId: string;
  schedulerExecutionId: string;
  fingerprint: string;
  orgId: string;
  kind: 'debit' | 'refund';
  amount: number;
  referenceId: string;
  occurredAt: string;
}

export interface ObservedOrgBalance {
  schedulerExecutionId: string;
  orgId: string;
  before: number;
  after: number;
}

export interface ObservedLedgerDelta {
  schedulerExecutionId: string;
  orgId: string;
  delta: number;
}

export interface DrainPassObservation {
  execution: ObservedSchedulerExecution;
  triggerFirings: ObservedTriggerFiring[];
  pendingBefore: number;
  pendingAfter: number;
  passRows: ObservedPassRow[];
  transactions: ObservedDrainTransaction[];
  txLeaves: ObservedTransactionLeaf[];
  proofs: ObservedAnchorProof[];
  creditGateEvents: ObservedCreditGateEvent[];
  creditLedgerEvents: ObservedCreditLedgerEvent[];
  orgBalances: ObservedOrgBalance[];
  ledgerDeltas: ObservedLedgerDelta[];
}

export interface DrainPassEvidenceSummary {
  batchId: string;
  armedTrigger: DrainTrigger;
  schedulerExecutionId: string;
  faultWindowId: string;
  pendingBefore: number;
  pendingAfter: number;
  claimedLeaves: number;
  drainedLeaves: number;
  poisonLeaves: number;
  creditStarvedLeaves: number;
  refundedFailureLeaves: number;
  transactionIds: string[];
  merkleRoots: string[];
  startedAt: string;
  completedAt: string;
}

export type DrainWindowKind = 'eligible-10000' | 'eligible-12500' | 'poison-isolation';

export interface DrainWindowExpectation {
  scenarioId: string;
  kind: DrainWindowKind;
  armedTrigger: DrainTrigger;
  expectedInitialPending: number;
  expectedFinalPending: number;
  passes: DrainPassExpectation[];
}

export interface DrainWindowEvidenceSummary {
  scenarioId: string;
  kind: DrainWindowKind;
  armedTrigger: DrainTrigger;
  schedulerTicks: number;
  drainedLeaves: number;
  poisonLeaves: number;
  initialPending: number;
  finalPending: number;
  schedulerExecutionIds: string[];
  transactionIds: string[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function requireId(value: string, name: string): void {
  if (!value?.trim()) throw new Error(`${name} is required.`);
}

function requireHash(value: string, name: string): void {
  if (!SHA256_HEX.test(value)) throw new Error(`${name} must be lowercase 64-hex.`);
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
}

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid timestamp.`);
  return parsed;
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function doubleSha256(bytes: Uint8Array): Buffer {
  return sha256(sha256(bytes));
}

/** Independently compute the production Merkle rule from ordered leaf hashes. */
export function computeMerkleRootFromFingerprints(fingerprints: string[]): string {
  if (fingerprints.length === 0) throw new Error('Cannot compute a Merkle root without leaves.');
  let level: Buffer[] = fingerprints.map((fingerprint) => {
    requireHash(fingerprint, 'Merkle leaf fingerprint');
    return Buffer.from(fingerprint, 'hex');
  });
  while (level.length > 1) {
    if (level.length % 2 === 1) level = [...level, level[level.length - 1]!];
    const next: Buffer[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(doubleSha256(Buffer.concat([level[index]!, level[index + 1]!] )));
    }
    level = next;
  }
  return level[0]!.toString('hex');
}

function recomputeProofRoot(proof: ObservedAnchorProof): string {
  requireHash(proof.fingerprint, 'Proof fingerprint');
  if (!Number.isInteger(proof.leafCount) || proof.leafCount <= 0) {
    throw new Error('Proof leafCount must be a positive integer.');
  }
  if (!Number.isInteger(proof.merkleIndex) || proof.merkleIndex < 0 || proof.merkleIndex >= proof.leafCount) {
    throw new Error('Proof merkleIndex must address one declared leaf.');
  }

  let current: Buffer = Buffer.from(proof.fingerprint, 'hex');
  let index = proof.merkleIndex;
  let width = proof.leafCount;
  let pathIndex = 0;
  while (width > 1) {
    const sibling = proof.proofPath[pathIndex];
    if (!sibling) throw new Error('Proof path is shorter than the declared leafCount requires.');
    requireHash(sibling.hash, 'Proof sibling hash');
    const expectedPosition: 'left' | 'right' = index % 2 === 0 ? 'right' : 'left';
    if (sibling.position !== expectedPosition) {
      throw new Error('Proof sibling position is inconsistent with merkleIndex and leafCount.');
    }
    if (index % 2 === 0 && index + 1 >= width && sibling.hash !== current.toString('hex')) {
      throw new Error('Proof odd-width duplicate sibling does not match the current node.');
    }
    const siblingBytes = Buffer.from(sibling.hash, 'hex');
    current = sibling.position === 'left'
      ? doubleSha256(Buffer.concat([siblingBytes, current]))
      : doubleSha256(Buffer.concat([current, siblingBytes]));
    index = Math.floor(index / 2);
    width = Math.ceil(width / 2);
    pathIndex += 1;
  }
  if (pathIndex !== proof.proofPath.length) {
    throw new Error('Proof path is longer than the declared leafCount allows.');
  }
  return current.toString('hex');
}

interface ValidatedExpectation {
  startMs: number;
  endMs: number;
  claimsByFingerprint: Map<string, ExpectedDrainClaim>;
  claimedOrgIds: Set<string>;
}

function validateExpectation(expectation: DrainPassExpectation): ValidatedExpectation {
  requireId(expectation.batchId, 'batchId');
  requireId(expectation.schedulerExecutionId, 'schedulerExecutionId');
  if (expectation.armedTrigger !== 'org-scheduler' && expectation.armedTrigger !== 'global-flush') {
    throw new Error(`Unsupported armed trigger: ${String(expectation.armedTrigger)}.`);
  }
  requireId(expectation.faultWindow.id, 'faultWindow.id');
  const startMs = timestamp(expectation.faultWindow.startsAt, 'faultWindow.startsAt');
  const endMs = timestamp(expectation.faultWindow.endsAt, 'faultWindow.endsAt');
  if (endMs <= startMs) throw new Error('Declared fault window must end after it starts.');
  if (expectation.claims.length === 0) throw new Error('Drain expectation requires claimed leaves.');

  const claimsByFingerprint = new Map<string, ExpectedDrainClaim>();
  const claimedOrgIds = new Set<string>();
  for (const claim of expectation.claims) {
    requireHash(claim.fingerprint, 'claim fingerprint');
    requireId(claim.orgId, 'claim orgId');
    if (claimsByFingerprint.has(claim.fingerprint)) throw new Error(`Duplicate claimed fingerprint ${claim.fingerprint}.`);
    claimsByFingerprint.set(claim.fingerprint, claim);
    claimedOrgIds.add(claim.orgId);
  }
  return { startMs, endMs, claimsByFingerprint, claimedOrgIds };
}

export function validateDrainPassExpectation(expectation: DrainPassExpectation): void {
  validateExpectation(expectation);
}

function assertInsideWindow(value: string, name: string, startMs: number, endMs: number): number {
  const actualMs = timestamp(value, name);
  if (actualMs < startMs || actualMs > endMs) throw new Error(`${name} is outside the declared fault window.`);
  return actualMs;
}

function assertR3TransactionInvariant(
  trigger: DrainTrigger,
  transactions: ObservedDrainTransaction[],
  leavesByTx: Map<string, ObservedTransactionLeaf[]>,
  drainedOrgIds: Set<string>,
): void {
  for (const transaction of transactions) {
    const leaves = leavesByTx.get(transaction.txId) ?? [];
    if (leaves.length === 0) throw new Error(`Transaction ${transaction.txId} has no actual leaves.`);
    if (leaves.length > R3_BATCH_SIZE) throw new Error('An R3 transaction may contain at most 10000 leaves.');
  }

  if (trigger === 'global-flush') {
    if (transactions.length !== 1) throw new Error('A global-flush pass must produce exactly one mixed-org transaction.');
    const orgs = new Set((leavesByTx.get(transactions[0]!.txId) ?? []).map((leaf) => leaf.orgId));
    if (orgs.size < 2) throw new Error('A global-flush transaction must be mixed-org (at least two orgs).');
    return;
  }

  if (transactions.length !== drainedOrgIds.size) {
    throw new Error('An org-scheduler pass requires exactly one transaction per drained org per pass.');
  }
  const txOrgIds = new Set<string>();
  for (const transaction of transactions) {
    const orgs = new Set((leavesByTx.get(transaction.txId) ?? []).map((leaf) => leaf.orgId));
    if (orgs.size !== 1) throw new Error('An org-scheduler transaction must contain exactly one org.');
    const orgId = [...orgs][0]!;
    if (!drainedOrgIds.has(orgId) || txOrgIds.has(orgId)) {
      throw new Error('An org-scheduler pass requires exactly one transaction per drained org per pass.');
    }
    txOrgIds.add(orgId);
  }
}

interface DerivedClaims {
  orderedDrainedRows: ObservedPassRow[];
  outcomes: Map<string, DerivedClaimOutcome>;
  rawLedgerByOrg: Map<string, number>;
}

function deriveClaimsFromObservedEvents(
  expectation: DrainPassExpectation,
  observation: DrainPassObservation,
  validated: ValidatedExpectation,
  leafByFingerprint: Map<string, ObservedTransactionLeaf>,
  transactionsById: Map<string, ObservedDrainTransaction>,
  executionStartedMs: number,
  executionCompletedMs: number,
): DerivedClaims {
  if (observation.passRows.length !== expectation.claims.length) {
    throw new Error('Actual pass rows must exactly equal the declared claimed identity set.');
  }
  const rowsByFingerprint = new Map<string, ObservedPassRow>();
  const claimOrders = new Set<number>();
  for (const row of observation.passRows) {
    const claim = validated.claimsByFingerprint.get(row.fingerprint);
    if (
      !claim
      || claim.orgId !== row.orgId
      || row.batchId !== expectation.batchId
      || row.schedulerExecutionId !== expectation.schedulerExecutionId
      || rowsByFingerprint.has(row.fingerprint)
    ) {
      throw new Error('Actual pass row is duplicate, unrelated, or mismatches the claimed identity set.');
    }
    if (!Number.isInteger(row.claimOrder) || row.claimOrder <= 0 || claimOrders.has(row.claimOrder)) {
      throw new Error('Observed durable claimOrder must be unique positive integers.');
    }
    rowsByFingerprint.set(row.fingerprint, row);
    claimOrders.add(row.claimOrder);
  }
  const orderedRows = [...observation.passRows].sort((left, right) => left.claimOrder - right.claimOrder);
  if (orderedRows.some((row, index) => row.claimOrder !== index + 1)) {
    throw new Error('Observed durable claimOrder must be contiguous from one.');
  }

  const gateByFingerprint = new Map<string, ObservedCreditGateEvent>();
  for (const gate of observation.creditGateEvents) {
    const claim = validated.claimsByFingerprint.get(gate.fingerprint);
    if (
      !claim
      || claim.orgId !== gate.orgId
      || gate.schedulerExecutionId !== expectation.schedulerExecutionId
      || gateByFingerprint.has(gate.fingerprint)
    ) {
      throw new Error('Credit gate event is duplicate, cross-org, or unrelated to this pass.');
    }
    requireId(gate.eventId, 'credit gate eventId');
    const gateMs = assertInsideWindow(gate.occurredAt, 'Credit gate event', validated.startMs, validated.endMs);
    if (gateMs < executionStartedMs || gateMs > executionCompletedMs) {
      throw new Error('Credit gate event is outside the correlated Scheduler execution.');
    }
    if (gate.decision === 'not-required') {
      if (
        gate.reason !== null
        || gate.referenceId !== null
        || gate.requiredAmount !== 0
        || gate.balanceBefore !== null
        || gate.balanceAfter !== null
      ) {
        throw new Error('A not-required credit gate must not carry a reason, reference, amount, or balance claim.');
      }
    } else if (
      !gate.reason?.trim()
      ||
      !gate.referenceId?.trim()
      || !Number.isInteger(gate.requiredAmount)
      || gate.requiredAmount <= 0
      || !Number.isInteger(gate.balanceBefore)
      || !Number.isInteger(gate.balanceAfter)
      || gate.balanceBefore! < 0
      || gate.balanceAfter! < 0
    ) {
      throw new Error('An observed credit decision requires a reference, positive amount, and non-negative integer balances.');
    }
    gateByFingerprint.set(gate.fingerprint, gate);
  }
  if (gateByFingerprint.size !== expectation.claims.length) {
    throw new Error('Every claimed row requires one observed credit gate decision, including not-required.');
  }

  const ledgerByFingerprint = new Map<string, ObservedCreditLedgerEvent[]>();
  const rawLedgerByOrg = new Map([...validated.claimedOrgIds].map((orgId) => [orgId, 0]));
  const ledgerEventIds = new Set<string>();
  for (const event of observation.creditLedgerEvents) {
    const claim = validated.claimsByFingerprint.get(event.fingerprint);
    if (
      !claim
      || claim.orgId !== event.orgId
      || event.schedulerExecutionId !== expectation.schedulerExecutionId
      || ledgerEventIds.has(event.eventId)
    ) {
      throw new Error('Credit ledger event is duplicate, cross-org, or unrelated to this pass.');
    }
    requireId(event.eventId, 'credit ledger eventId');
    requireId(event.referenceId, 'credit ledger referenceId');
    if (!Number.isInteger(event.amount) || event.amount <= 0) throw new Error('Credit ledger amount must be a positive integer.');
    const eventMs = assertInsideWindow(event.occurredAt, 'Credit ledger event', validated.startMs, validated.endMs);
    if (eventMs < executionStartedMs || eventMs > executionCompletedMs) {
      throw new Error('Credit ledger event is outside the correlated Scheduler execution.');
    }
    ledgerEventIds.add(event.eventId);
    const events = ledgerByFingerprint.get(event.fingerprint) ?? [];
    events.push(event);
    ledgerByFingerprint.set(event.fingerprint, events);
    const signedAmount = event.kind === 'debit' ? -event.amount : event.amount;
    rawLedgerByOrg.set(event.orgId, rawLedgerByOrg.get(event.orgId)! + signedAmount);
  }

  const outcomes = new Map<string, DerivedClaimOutcome>();
  for (const row of orderedRows) {
    const gate = gateByFingerprint.get(row.fingerprint)!;
    const ledger = ledgerByFingerprint.get(row.fingerprint) ?? [];
    const debits = ledger.filter((event) => event.kind === 'debit').reduce((sum, event) => sum + event.amount, 0);
    const refunds = ledger.filter((event) => event.kind === 'refund').reduce((sum, event) => sum + event.amount, 0);
    const leaf = leafByFingerprint.get(row.fingerprint);
    const terminal = row.status === 'SUBMITTED' || row.status === 'SECURED';
    const chargedAtMs = row.queueCreditChargedAt === null
      ? null
      : assertInsideWindow(row.queueCreditChargedAt, 'queueCreditChargedAt', executionStartedMs, executionCompletedMs);
    const deniedAtMs = row.queueCreditDeniedAt === null
      ? null
      : assertInsideWindow(row.queueCreditDeniedAt, 'queueCreditDeniedAt', executionStartedMs, executionCompletedMs);
    if (row.queueCreditChargedAt !== null && (row.queueCreditDeniedAt !== null || row.creditDenialReason !== null)) {
      throw new Error('Observed DB credit metadata cannot be both charged and denied.');
    }
    if (ledger.some((event) => event.referenceId !== gate.referenceId)) {
      throw new Error('Credit gate and debit/refund events must share the exact reference identity.');
    }
    const gateMs = timestamp(gate.occurredAt, 'Credit gate occurredAt');
    const debitEvents = ledger.filter((event) => event.kind === 'debit');
    const refundEvents = ledger.filter((event) => event.kind === 'refund');
    if (ledger.some((event) => timestamp(event.occurredAt, 'Credit ledger occurredAt') < gateMs)) {
      throw new Error('Credit debit/refund event predates its gate decision.');
    }
    if (
      debitEvents.length > 0
      && refundEvents.length > 0
      && Math.min(...refundEvents.map((event) => timestamp(event.occurredAt, 'refund occurredAt')))
        <= Math.max(...debitEvents.map((event) => timestamp(event.occurredAt, 'debit occurredAt')))
    ) {
      throw new Error('Credit refund must occur strictly after its debit.');
    }
    if (
      gate.decision === 'denied'
      && gate.reason === 'insufficient_credits'
      && (gate.balanceBefore! >= gate.requiredAmount || gate.balanceAfter !== gate.balanceBefore)
    ) {
      throw new Error('Denied insufficient-credit balance must be below required amount and remain unchanged.');
    }

    if (terminal) {
      if (!leaf) throw new Error('Terminal drained row has no observed transaction leaf.');
      const transaction = transactionsById.get(leaf.txId)!;
      if (row.chainTxId !== transaction.txId || row.merkleRoot !== transaction.merkleRoot) {
        throw new Error('Drained pass row lacks the derived terminal tx/root state.');
      }
      if (gate.decision === 'denied') throw new Error('A denied credit gate cannot produce a terminal drained row.');
      if (gate.decision === 'allowed') {
        if (
          gate.balanceAfter !== gate.balanceBefore! - gate.requiredAmount
          || debits !== gate.requiredAmount
          || refunds !== 0
          || chargedAtMs === null
          || chargedAtMs < gateMs
          || debitEvents.some((event) => timestamp(event.occurredAt, 'debit occurredAt') > chargedAtMs)
          || row.creditDenialReason !== null
        ) {
          throw new Error('Credit-gated drained row requires one observed debit and charged DB metadata.');
        }
      } else if (
        gate.decision !== 'not-required'
        || debits !== 0
        || refunds !== 0
        || row.queueCreditChargedAt !== null
        || row.queueCreditDeniedAt !== null
        || row.creditDenialReason !== null
      ) {
        throw new Error('Non-credit-gated drained row must have zero ledger events and zero credit metadata.');
      }
      outcomes.set(row.fingerprint, 'drained');
      continue;
    }

    if (row.status !== 'PENDING' || leaf || row.chainTxId !== null || row.merkleRoot !== null) {
      throw new Error('Non-drained claimed row must remain PENDING with zero tx/root attribution.');
    }
    if (
      gate.decision === 'denied'
      && gate.reason === 'insufficient_credits'
      && gate.balanceBefore! < gate.requiredAmount
      && gate.balanceAfter === gate.balanceBefore
      && debits === 0
      && refunds === 0
      && row.creditDenialReason === 'insufficient_credits'
      && deniedAtMs !== null
      && deniedAtMs >= gateMs
    ) {
      outcomes.set(row.fingerprint, 'credit-starved');
      continue;
    }
    if (
      gate.decision === 'allowed'
      && gate.balanceAfter === gate.balanceBefore! - gate.requiredAmount
      && debits === gate.requiredAmount
      && refunds === gate.requiredAmount
      && chargedAtMs !== null
      && chargedAtMs >= gateMs
      && debitEvents.every((event) => timestamp(event.occurredAt, 'debit occurredAt') <= chargedAtMs)
      && refundEvents.every((event) => timestamp(event.occurredAt, 'refund occurredAt') > chargedAtMs)
      && row.queueCreditDeniedAt === null
      && row.creditDenialReason === null
    ) {
      outcomes.set(row.fingerprint, 'refunded-failure');
      continue;
    }
    throw new Error('Pending poison truth is not supported by observed gate, refund, and DB facts.');
  }

  const orderedDrainedRows = orderedRows.filter((row) => outcomes.get(row.fingerprint) === 'drained');
  if (orderedDrainedRows.length === 0) throw new Error('R3 pass evidence requires at least one observed eligible drained claim.');

  const claimOrderByFingerprint = new Map(orderedRows.map((row) => [row.fingerprint, row.claimOrder]));
  for (const balance of observation.orgBalances) {
    const gates = [...gateByFingerprint.values()]
      .filter((gate) => gate.orgId === balance.orgId && gate.decision !== 'not-required')
      .sort((left, right) => (
        timestamp(left.occurredAt, 'gate occurredAt') - timestamp(right.occurredAt, 'gate occurredAt')
        || claimOrderByFingerprint.get(left.fingerprint)! - claimOrderByFingerprint.get(right.fingerprint)!
      ));
    const refunds = observation.creditLedgerEvents
      .filter((event) => event.orgId === balance.orgId && event.kind === 'refund')
      .sort((left, right) => timestamp(left.occurredAt, 'refund occurredAt') - timestamp(right.occurredAt, 'refund occurredAt'));
    let refundIndex = 0;
    let cursor = balance.before;
    for (const gate of gates) {
      const gateAt = timestamp(gate.occurredAt, 'gate occurredAt');
      while (refundIndex < refunds.length && timestamp(refunds[refundIndex]!.occurredAt, 'refund occurredAt') < gateAt) {
        cursor += refunds[refundIndex]!.amount;
        refundIndex += 1;
      }
      if (gate.balanceBefore !== cursor) {
        throw new Error('Observed per-org credit gate balances do not form one coherent chronological sequence.');
      }
      cursor = gate.balanceAfter!;
    }
    while (refundIndex < refunds.length) {
      cursor += refunds[refundIndex]!.amount;
      refundIndex += 1;
    }
    if (cursor !== balance.after) {
      throw new Error('Observed per-org final balance does not follow the chronological gate/refund sequence.');
    }
  }
  return { orderedDrainedRows, outcomes, rawLedgerByOrg };
}

export function assertDrainPassObservation(
  expectation: DrainPassExpectation,
  observation: DrainPassObservation,
): DrainPassEvidenceSummary {
  const validated = validateExpectation(expectation);
  const { startMs, endMs, claimsByFingerprint, claimedOrgIds } = validated;
  requireNonNegativeInteger(observation.pendingBefore, 'pendingBefore');
  requireNonNegativeInteger(observation.pendingAfter, 'pendingAfter');
  if (observation.pendingBefore < expectation.claims.length) {
    throw new Error('pendingBefore cannot be smaller than the observed claimed set.');
  }

  const execution = observation.execution;
  if (execution.schedulerExecutionId !== expectation.schedulerExecutionId) {
    throw new Error('Observed scheduler execution does not match the declaration.');
  }
  if (execution.armedTrigger !== expectation.armedTrigger) throw new Error('Observed armed trigger does not match the declaration.');
  if (execution.faultWindowId !== expectation.faultWindow.id) throw new Error('Observed execution names an unrelated fault window.');
  const startedMs = assertInsideWindow(execution.startedAt, 'Scheduler start', startMs, endMs);
  const completedMs = assertInsideWindow(execution.completedAt, 'Scheduler completion', startMs, endMs);
  if (completedMs < startedMs) throw new Error('Scheduler completion predates its start.');

  if (observation.triggerFirings.length !== 1) throw new Error('Actual evidence must contain exactly one trigger firing.');
  const firing = observation.triggerFirings[0]!;
  if (
    firing.trigger !== expectation.armedTrigger
    || firing.schedulerExecutionId !== expectation.schedulerExecutionId
    || firing.batchId !== expectation.batchId
  ) {
    throw new Error('Trigger firing is unrelated to the declared trigger, execution, or batch.');
  }
  const firedMs = assertInsideWindow(firing.firedAt, 'Trigger firing', startMs, endMs);
  if (firedMs < startedMs || firedMs > completedMs) throw new Error('Trigger firing violates scheduler execution chronology.');

  const transactionsById = new Map<string, ObservedDrainTransaction>();
  for (const transaction of observation.transactions) {
    requireHash(transaction.txId, 'Actual txId');
    requireHash(transaction.merkleRoot, 'Actual merkleRoot');
    requireHash(transaction.signedBytesSha256, 'Actual signedBytesSha256');
    requireId(transaction.nodeId, 'signet nodeId');
    if (transaction.network !== 'signet' || (transaction.chainState !== 'mempool' && transaction.chainState !== 'confirmed')) {
      throw new Error('Actual chain result must be an accepted signet mempool or confirmation observation.');
    }
    const acceptedMs = assertInsideWindow(transaction.acceptedAt, 'Signet acceptance', startMs, endMs);
    if (acceptedMs < startedMs || acceptedMs > completedMs) {
      throw new Error('Signet acceptance is outside the correlated Scheduler execution.');
    }
    if (transaction.batchId !== expectation.batchId || transactionsById.has(transaction.txId)) {
      throw new Error('Actual transaction is duplicate or belongs to an unrelated batch.');
    }
    if (transaction.schedulerExecutionId !== expectation.schedulerExecutionId) {
      throw new Error('Actual signet transaction is unrelated to the exact Scheduler execution.');
    }
    transactionsById.set(transaction.txId, transaction);
  }

  const leavesByTx = new Map<string, ObservedTransactionLeaf[]>();
  const leafByFingerprint = new Map<string, ObservedTransactionLeaf>();
  for (const leaf of observation.txLeaves) {
    if (!transactionsById.has(leaf.txId) || leaf.batchId !== expectation.batchId) {
      throw new Error('Actual tx leaf belongs to an unrelated transaction or batch.');
    }
    const claim = claimsByFingerprint.get(leaf.fingerprint);
    if (!claim || claim.orgId !== leaf.orgId || leafByFingerprint.has(leaf.fingerprint)) {
      throw new Error('Actual tx-to-leaf/org mapping is duplicate, unclaimed, or mismatched.');
    }
    if (!Number.isInteger(leaf.merkleIndex) || leaf.merkleIndex < 0) throw new Error('Actual merkleIndex must be non-negative.');
    leafByFingerprint.set(leaf.fingerprint, leaf);
    const group = leavesByTx.get(leaf.txId) ?? [];
    group.push(leaf);
    leavesByTx.set(leaf.txId, group);
  }

  const derived = deriveClaimsFromObservedEvents(
    expectation,
    observation,
    validated,
    leafByFingerprint,
    transactionsById,
    startedMs,
    completedMs,
  );
  for (const transaction of observation.transactions) {
    const acceptedMs = timestamp(transaction.acceptedAt, 'Signet acceptance');
    if (acceptedMs <= firedMs) throw new Error('Signet acceptance must occur after the observed Scheduler trigger.');
    for (const leaf of leavesByTx.get(transaction.txId) ?? []) {
      const gate = observation.creditGateEvents.find((event) => event.fingerprint === leaf.fingerprint);
      if (!gate || acceptedMs <= timestamp(gate.occurredAt, 'Credit gate event')) {
        throw new Error('Signet acceptance must occur after the exact credit gate for every transaction leaf.');
      }
      const debits = observation.creditLedgerEvents.filter((event) => (
        event.fingerprint === leaf.fingerprint && event.kind === 'debit'
      ));
      if (debits.some((event) => acceptedMs <= timestamp(event.occurredAt, 'Credit debit event'))) {
        throw new Error('Signet acceptance must occur after the exact credit debit for every transaction leaf.');
      }
    }
  }
  const drainedOrgIds = new Set(derived.orderedDrainedRows.map((row) => row.orgId));
  assertR3TransactionInvariant(expectation.armedTrigger, observation.transactions, leavesByTx, drainedOrgIds);
  if (leafByFingerprint.size !== derived.orderedDrainedRows.length) {
    throw new Error('Actual tx mapping must cover every event-derived drained claim exactly once.');
  }

  for (const transaction of observation.transactions) {
    const leaves = [...(leavesByTx.get(transaction.txId) ?? [])].sort((left, right) => left.merkleIndex - right.merkleIndex);
    if (leaves.some((leaf, index) => leaf.merkleIndex !== index)) {
      throw new Error('Actual transaction merkle indexes must be contiguous from zero.');
    }
    const expectedFingerprints = expectation.armedTrigger === 'global-flush'
      ? derived.orderedDrainedRows.map((row) => row.fingerprint)
      : derived.orderedDrainedRows
          .filter((row) => row.orgId === leaves[0]!.orgId)
          .map((row) => row.fingerprint);
    if (
      expectedFingerprints.length !== leaves.length
      || leaves.some((leaf, index) => leaf.fingerprint !== expectedFingerprints[index])
    ) {
      throw new Error('Actual Merkle leaves do not preserve observed durable claim order for this transaction.');
    }
    const recomputedRoot = computeMerkleRootFromFingerprints(leaves.map((leaf) => leaf.fingerprint));
    if (recomputedRoot !== transaction.merkleRoot) {
      throw new Error('Actual transaction root does not match the independently recomputed ordered leaves.');
    }
  }

  if (observation.proofs.length !== derived.orderedDrainedRows.length) {
    throw new Error('Actual proofs must cover every event-derived drained leaf exactly once.');
  }
  const proofFingerprints = new Set<string>();
  for (const proof of observation.proofs) {
    const leaf = leafByFingerprint.get(proof.fingerprint);
    const transaction = transactionsById.get(proof.txId);
    const txLeafCount = leavesByTx.get(proof.txId)?.length;
    if (
      !leaf
      || !transaction
      || proofFingerprints.has(proof.fingerprint)
      || proof.batchId !== expectation.batchId
      || proof.txId !== leaf.txId
      || proof.orgId !== leaf.orgId
      || proof.merkleIndex !== leaf.merkleIndex
      || proof.merkleRoot !== transaction.merkleRoot
      || proof.leafCount !== txLeafCount
    ) {
      throw new Error('Actual proof is duplicate, unrelated, or mismatches tx/leaf/org/root/index/count.');
    }
    if (recomputeProofRoot(proof) !== transaction.merkleRoot) {
      throw new Error('Independently recomputed proof root does not match the transaction root.');
    }
    proofFingerprints.add(proof.fingerprint);
  }

  if (
    observation.orgBalances.length !== claimedOrgIds.size
    || observation.ledgerDeltas.length !== claimedOrgIds.size
  ) {
    throw new Error('Balance and ledger observations must cover exactly every claimed org.');
  }
  const balancesByOrg = new Map<string, ObservedOrgBalance>();
  for (const balance of observation.orgBalances) {
    const rawDelta = derived.rawLedgerByOrg.get(balance.orgId);
    if (
      balance.schedulerExecutionId !== expectation.schedulerExecutionId
      || rawDelta === undefined
      || balancesByOrg.has(balance.orgId)
      || balance.after - balance.before !== rawDelta
    ) {
      throw new Error('Observed org balance is duplicate, cross-org, or mismatches raw debit/refund events.');
    }
    balancesByOrg.set(balance.orgId, balance);
  }
  const seenLedgerOrgs = new Set<string>();
  for (const delta of observation.ledgerDeltas) {
    if (
      delta.schedulerExecutionId !== expectation.schedulerExecutionId
      || !derived.rawLedgerByOrg.has(delta.orgId)
      || delta.delta !== derived.rawLedgerByOrg.get(delta.orgId)
      || seenLedgerOrgs.has(delta.orgId)
    ) {
      throw new Error('Actual ledger delta is duplicate, cross-org, or mismatches raw debit/refund events.');
    }
    seenLedgerOrgs.add(delta.orgId);
  }

  const drainedLeaves = derived.orderedDrainedRows.length;
  if (observation.pendingAfter !== observation.pendingBefore - drainedLeaves) {
    throw new Error('Observed pending remainder does not equal pending-before minus event-derived drained leaves.');
  }
  const creditStarvedLeaves = [...derived.outcomes.values()].filter((value) => value === 'credit-starved').length;
  const refundedFailureLeaves = [...derived.outcomes.values()].filter((value) => value === 'refunded-failure').length;
  return {
    batchId: expectation.batchId,
    armedTrigger: expectation.armedTrigger,
    schedulerExecutionId: expectation.schedulerExecutionId,
    faultWindowId: expectation.faultWindow.id,
    pendingBefore: observation.pendingBefore,
    pendingAfter: observation.pendingAfter,
    claimedLeaves: expectation.claims.length,
    drainedLeaves,
    poisonLeaves: creditStarvedLeaves + refundedFailureLeaves,
    creditStarvedLeaves,
    refundedFailureLeaves,
    transactionIds: observation.transactions.map((transaction) => transaction.txId),
    merkleRoots: observation.transactions.map((transaction) => transaction.merkleRoot),
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
  };
}

/** Join multiple observed Scheduler ticks into the named exact or poison wave. */
export function assertDrainWindowObservation(
  expectation: DrainWindowExpectation,
  observations: DrainPassObservation[],
): DrainWindowEvidenceSummary {
  requireId(expectation.scenarioId, 'scenarioId');
  if (expectation.passes.length === 0 || expectation.passes.length !== observations.length) {
    throw new Error('Drain window requires one actual observation for every declared Scheduler tick.');
  }
  if (expectation.passes.some((pass) => pass.armedTrigger !== expectation.armedTrigger)) {
    throw new Error('Every drain-window pass must use the declared armed trigger.');
  }
  requireNonNegativeInteger(expectation.expectedInitialPending, 'expectedInitialPending');
  requireNonNegativeInteger(expectation.expectedFinalPending, 'expectedFinalPending');

  const batchIds = expectation.passes.map((pass) => pass.batchId);
  const faultWindowIds = expectation.passes.map((pass) => pass.faultWindow.id);
  const claimFingerprints = expectation.passes.flatMap((pass) => pass.claims.map((claim) => claim.fingerprint));
  if (
    new Set(batchIds).size !== batchIds.length
    || new Set(faultWindowIds).size !== faultWindowIds.length
    || new Set(claimFingerprints).size !== claimFingerprints.length
  ) {
    throw new Error('Claim, batch, or fault-window identity was reused across Scheduler passes.');
  }

  const summaries = expectation.passes.map((pass, index) => assertDrainPassObservation(pass, observations[index]!));
  const executionIds = summaries.map((summary) => summary.schedulerExecutionId);
  if (new Set(executionIds).size !== executionIds.length) throw new Error('Every Scheduler tick requires a distinct execution id.');
  const transactionIds = summaries.flatMap((summary) => summary.transactionIds);
  if (new Set(transactionIds).size !== transactionIds.length) {
    throw new Error('A transaction identity was reused across Scheduler passes.');
  }
  if (summaries[0]!.pendingBefore !== expectation.expectedInitialPending) {
    throw new Error('First observed pending count does not match the named drain-window entry count.');
  }
  if (summaries[summaries.length - 1]!.pendingAfter !== expectation.expectedFinalPending) {
    throw new Error('Final observed pending remainder does not match the drain-window declaration.');
  }
  for (let index = 1; index < summaries.length; index += 1) {
    const previous = summaries[index - 1]!;
    const current = summaries[index]!;
    if (current.pendingBefore !== previous.pendingAfter) {
      throw new Error('Observed pending remainder does not join across Scheduler ticks.');
    }
    if (timestamp(current.startedAt, 'Scheduler start') <= timestamp(previous.completedAt, 'Scheduler completion')) {
      throw new Error('Observed Scheduler ticks are not chronological and non-overlapping.');
    }
  }

  const drainedLeaves = summaries.reduce((sum, summary) => sum + summary.drainedLeaves, 0);
  const poisonLeaves = summaries.reduce((sum, summary) => sum + summary.poisonLeaves, 0);
  if (expectation.kind === 'eligible-10000') {
    if (
      expectation.armedTrigger !== 'global-flush'
      || summaries.length !== 1
      || expectation.expectedInitialPending !== 10_000
      || expectation.expectedFinalPending !== 0
      || summaries[0]!.drainedLeaves !== 10_000
      || poisonLeaves !== 0
    ) {
      throw new Error('eligible-10000 requires one poison-free global Scheduler tick draining exactly 10000 leaves.');
    }
  } else if (expectation.kind === 'eligible-12500') {
    if (
      expectation.armedTrigger !== 'global-flush'
      || summaries.length !== 2
      || expectation.expectedInitialPending !== 12_500
      || expectation.expectedFinalPending !== 0
      || summaries[0]!.drainedLeaves !== 10_000
      || summaries[0]!.pendingAfter !== 2_500
      || summaries[1]!.drainedLeaves !== 2_500
      || poisonLeaves !== 0
    ) {
      throw new Error('eligible-12500 requires observed poison-free 10000 and 2500 Scheduler ticks with joined remainder.');
    }
  } else if (expectation.kind === 'poison-isolation') {
    if (poisonLeaves === 0 || drainedLeaves === 0 || expectation.expectedFinalPending === 0) {
      throw new Error('poison-isolation requires observed poison rows, healthy drained neighbors, and a pending remainder.');
    }
  } else {
    throw new Error(`Unsupported drain window kind: ${String(expectation.kind)}.`);
  }

  return {
    scenarioId: expectation.scenarioId,
    kind: expectation.kind,
    armedTrigger: expectation.armedTrigger,
    schedulerTicks: summaries.length,
    drainedLeaves,
    poisonLeaves,
    initialPending: summaries[0]!.pendingBefore,
    finalPending: summaries[summaries.length - 1]!.pendingAfter,
    schedulerExecutionIds: executionIds,
    transactionIds: summaries.flatMap((summary) => summary.transactionIds),
  };
}
