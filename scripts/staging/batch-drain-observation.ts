/**
 * Pure fail-closed assertions for evidence collected by a supervised drain
 * adapter. This module never queries a database, scheduler, chain node, or rig;
 * callers must supply the complete actual observation for the declared pass.
 */

import { createHash } from 'node:crypto';

export const R3_BATCH_SIZE = 10_000;

export type DrainTrigger = 'org-scheduler' | 'global-flush';
export type DrainClaimOutcome = 'drained' | 'credit-starved';
export type ObservedClaimOutcome = 'drained' | 'succeeded-no-broadcast';

export interface DrainFaultWindow {
  id: string;
  startsAt: string;
  endsAt: string;
}

export interface ExpectedDrainClaim {
  /** Ordered leaf identity: array order is the declared Merkle leaf order. */
  fingerprint: string;
  orgId: string;
  outcome: DrainClaimOutcome;
}

export interface DrainPassExpectation {
  batchId: string;
  armedTrigger: DrainTrigger;
  schedulerExecutionId: string;
  faultWindow: DrainFaultWindow;
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

export interface ObservedLedgerDelta {
  schedulerExecutionId: string;
  orgId: string;
  delta: number;
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
      next.push(doubleSha256(Buffer.concat([level[index]!, level[index + 1]!])));
    }
    level = next;
  }
  return level[0]!.toString('hex');
}

/** Recompute one positional proof, including odd-width duplication structure. */
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
  drainedClaims: ExpectedDrainClaim[];
  drainedOrgIds: Set<string>;
  derivedLedger: Map<string, number>;
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
  const outcomesByOrg = new Map<string, DrainClaimOutcome>();
  const derivedLedger = new Map<string, number>();
  for (const claim of expectation.claims) {
    requireHash(claim.fingerprint, 'claim fingerprint');
    requireId(claim.orgId, 'claim orgId');
    if (claim.outcome === ('bad-fingerprint' as DrainClaimOutcome)) {
      throw new Error('bad-fingerprint cohorts are DB-unseedable and cannot declare drain evidence.');
    }
    if (claim.outcome !== 'drained' && claim.outcome !== 'credit-starved') {
      throw new Error(`Unsupported claim outcome: ${String(claim.outcome)}.`);
    }
    if (claimsByFingerprint.has(claim.fingerprint)) throw new Error(`Duplicate claimed fingerprint ${claim.fingerprint}.`);
    const existingOutcome = outcomesByOrg.get(claim.orgId);
    if (existingOutcome && existingOutcome !== claim.outcome) {
      throw new Error(`Org ${claim.orgId} mixes eligible and poison claim outcomes.`);
    }
    claimsByFingerprint.set(claim.fingerprint, claim);
    outcomesByOrg.set(claim.orgId, claim.outcome);
    if (!derivedLedger.has(claim.orgId)) derivedLedger.set(claim.orgId, 0);
    if (claim.outcome === 'drained') {
      derivedLedger.set(claim.orgId, derivedLedger.get(claim.orgId)! - 1);
    }
  }
  const drainedClaims = expectation.claims.filter((claim) => claim.outcome === 'drained');
  if (drainedClaims.length === 0) throw new Error('R3 pass evidence requires at least one eligible drained claim.');
  return {
    startMs,
    endMs,
    claimsByFingerprint,
    drainedClaims,
    drainedOrgIds: new Set(drainedClaims.map((claim) => claim.orgId)),
    derivedLedger,
  };
}

/** Validate only caller-controlled declarations, before any adapter is armed. */
export function validateDrainPassExpectation(expectation: DrainPassExpectation): void {
  validateExpectation(expectation);
}

function assertInsideWindow(value: string, name: string, startMs: number, endMs: number): number {
  const actualMs = timestamp(value, name);
  if (actualMs < startMs || actualMs > endMs) throw new Error(`${name} is outside the declared fault window.`);
  return actualMs;
}

/** Assert the trigger-specific R3 shape from actual transactions and mappings. */
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
    if (transactions.length !== 1) {
      throw new Error('A global-flush pass must produce exactly one mixed-org transaction.');
    }
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

/**
 * Assert a complete actual pass. Transaction counts, roots, proofs, and ledger
 * deltas are derived here; none are accepted from caller expectations.
 */
export function assertDrainPassObservation(
  expectation: DrainPassExpectation,
  observation: DrainPassObservation,
): DrainPassEvidenceSummary {
  const validated = validateExpectation(expectation);
  const { startMs, endMs, claimsByFingerprint, drainedClaims, drainedOrgIds, derivedLedger } = validated;

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
  if (firedMs < startedMs || firedMs > completedMs) {
    throw new Error('Trigger firing violates scheduler execution chronology.');
  }

  const transactionsById = new Map<string, ObservedDrainTransaction>();
  for (const transaction of observation.transactions) {
    requireHash(transaction.txId, 'Actual txId');
    requireHash(transaction.merkleRoot, 'Actual merkleRoot');
    requireHash(transaction.signedBytesSha256, 'Actual signedBytesSha256');
    if (transaction.batchId !== expectation.batchId || transactionsById.has(transaction.txId)) {
      throw new Error('Actual transaction is duplicate or belongs to an unrelated batch.');
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
    if (!claim || claim.outcome !== 'drained' || claim.orgId !== leaf.orgId || leafByFingerprint.has(leaf.fingerprint)) {
      throw new Error('Actual tx-to-leaf/org mapping is duplicate, unclaimed, poison, or mismatched.');
    }
    if (!Number.isInteger(leaf.merkleIndex) || leaf.merkleIndex < 0) throw new Error('Actual merkleIndex must be non-negative.');
    leafByFingerprint.set(leaf.fingerprint, leaf);
    const group = leavesByTx.get(leaf.txId) ?? [];
    group.push(leaf);
    leavesByTx.set(leaf.txId, group);
  }

  // Enforce the actual trigger invariant before later sparse evidence checks.
  assertR3TransactionInvariant(expectation.armedTrigger, observation.transactions, leavesByTx, drainedOrgIds);
  if (leafByFingerprint.size !== drainedClaims.length) {
    throw new Error('Actual tx mapping must cover every eligible drained claim exactly once.');
  }

  for (const transaction of observation.transactions) {
    const leaves = [...(leavesByTx.get(transaction.txId) ?? [])].sort((left, right) => left.merkleIndex - right.merkleIndex);
    if (leaves.some((leaf, index) => leaf.merkleIndex !== index)) {
      throw new Error('Actual transaction merkle indexes must be contiguous from zero.');
    }
    const expectedFingerprints = expectation.armedTrigger === 'global-flush'
      ? drainedClaims.map((claim) => claim.fingerprint)
      : drainedClaims
          .filter((claim) => claim.orgId === leaves[0]!.orgId)
          .map((claim) => claim.fingerprint);
    if (
      expectedFingerprints.length !== leaves.length
      || leaves.some((leaf, index) => leaf.fingerprint !== expectedFingerprints[index])
    ) {
      throw new Error('Actual Merkle leaves do not preserve the declared claim order for this transaction.');
    }
    const recomputedRoot = computeMerkleRootFromFingerprints(leaves.map((leaf) => leaf.fingerprint));
    if (recomputedRoot !== transaction.merkleRoot) {
      throw new Error('Actual transaction root does not match the independently recomputed ordered leaves.');
    }
  }

  if (observation.passRows.length !== expectation.claims.length) {
    throw new Error('Actual pass rows must exactly equal the declared claimed leaves.');
  }
  const rowsByFingerprint = new Map<string, ObservedPassRow>();
  for (const row of observation.passRows) {
    if (rowsByFingerprint.has(row.fingerprint)) throw new Error(`Duplicate actual pass row ${row.fingerprint}.`);
    rowsByFingerprint.set(row.fingerprint, row);
  }
  for (const claim of expectation.claims) {
    const row = rowsByFingerprint.get(claim.fingerprint);
    if (
      !row
      || row.orgId !== claim.orgId
      || row.batchId !== expectation.batchId
      || row.schedulerExecutionId !== expectation.schedulerExecutionId
    ) {
      throw new Error(`Actual pass row for ${claim.fingerprint} is missing or unrelated.`);
    }
    if (claim.outcome === 'credit-starved') {
      if (
        row.observedOutcome !== 'succeeded-no-broadcast'
        || row.status !== 'PENDING'
        || row.chainTxId !== null
        || row.merkleRoot !== null
      ) {
        throw new Error('Credit-starved poison row must stay PENDING with zero tx/root attribution.');
      }
      continue;
    }
    const leaf = leafByFingerprint.get(claim.fingerprint)!;
    const transaction = transactionsById.get(leaf.txId)!;
    if (
      row.observedOutcome !== 'drained'
      || (row.status !== 'SUBMITTED' && row.status !== 'SECURED')
      || row.chainTxId !== transaction.txId
      || row.merkleRoot !== transaction.merkleRoot
    ) {
      throw new Error('Drained pass row lacks the derived terminal tx/root state.');
    }
  }

  if (observation.proofs.length !== drainedClaims.length) {
    throw new Error('Actual proofs must cover every drained leaf exactly once.');
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

  if (observation.ledgerDeltas.length !== derivedLedger.size) {
    throw new Error('Actual ledger deltas must cover exactly all claimed orgs, including poison zeros.');
  }
  const seenLedgerOrgs = new Set<string>();
  for (const delta of observation.ledgerDeltas) {
    if (
      delta.schedulerExecutionId !== expectation.schedulerExecutionId
      || !derivedLedger.has(delta.orgId)
      || delta.delta !== derivedLedger.get(delta.orgId)
      || seenLedgerOrgs.has(delta.orgId)
    ) {
      throw new Error('Actual derived ledger delta is duplicate, unrelated, or mismatches eligible drained counts.');
    }
    seenLedgerOrgs.add(delta.orgId);
  }

  return {
    batchId: expectation.batchId,
    armedTrigger: expectation.armedTrigger,
    schedulerExecutionId: expectation.schedulerExecutionId,
    faultWindowId: expectation.faultWindow.id,
    claimedLeaves: expectation.claims.length,
    drainedLeaves: drainedClaims.length,
    poisonLeaves: expectation.claims.length - drainedClaims.length,
    transactionIds: observation.transactions.map((transaction) => transaction.txId),
    merkleRoots: observation.transactions.map((transaction) => transaction.merkleRoot),
  };
}
