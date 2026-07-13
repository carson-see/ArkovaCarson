/**
 * Offline port contract for a supervised crash matrix. This module validates
 * evidence ordering and correlation but has no process, network, DB, broadcast,
 * secret, or rig adapter. Passing these assertions is never itself rig evidence.
 */

import {
  assertDrainPassObservation,
  computeMerkleRootFromFingerprints,
  validateDrainPassExpectation,
  type DrainPassEvidenceSummary,
  type DrainPassExpectation,
  type DrainPassObservation,
  type DrainTrigger,
} from './batch-drain-observation';

export const CRASH_KILLPOINTS = [
  'after-claim',
  'after-merkle-tree',
  'after-intent-persist',
  'after-broadcast-before-submit',
  'after-submit-persist',
] as const;

export type CrashKillpoint = typeof CRASH_KILLPOINTS[number];

export interface PostIntentIdentity {
  txId: string;
  signedBytesSha256: string;
}

export interface CrashCaseInput {
  runId: string;
  killpoint: CrashKillpoint;
  /** Pre-intent declaration: never includes a future transaction identity. */
  expectation: DrainPassExpectation;
  /** Required only at/after durable intent; forbidden before intent exists. */
  postIntent?: PostIntentIdentity;
}

export interface CrashClaimIdentity {
  fingerprint: string;
  orgId: string;
}

export interface NetworkAcceptanceEvidence {
  txId: string;
  /** SHA-256 of raw transaction bytes returned by the observing node. */
  rawTxSha256: string;
  nodeId: string;
  state: 'mempool' | 'confirmed';
  observedAt: string;
}

export interface Phase4PersistenceEvidence {
  batchId: string;
  txId: string;
  rowCount: number;
  persistedAt: string;
}

export interface CrashBarrier {
  runId: string;
  killpoint: CrashKillpoint;
  batchId: string;
  armedTrigger: DrainTrigger;
  schedulerExecutionId: string;
  faultWindowId: string;
  workerId: string;
  claimedLeaves: CrashClaimIdentity[];
  claimedAt: string;
  reachedAt: string;
  merkleRoot?: string;
  merkleBuiltAt?: string;
  intentTxId?: string;
  signedBytesSha256?: string;
  intentPersistedAt?: string;
  networkAcceptance?: NetworkAcceptanceEvidence;
  phase4Persisted?: Phase4PersistenceEvidence;
}

export interface CrashBroadcastAttempt {
  batchId: string;
  schedulerExecutionId: string;
  txId: string;
  signedBytesSha256: string;
}

export interface CrashObservation {
  runId: string;
  finalWorkerId: string;
  drain: DrainPassObservation;
  broadcastAttempts: CrashBroadcastAttempt[];
}

export interface CrashControlPort {
  arm(input: CrashCaseInput): Promise<void>;
  start(input: CrashCaseInput): Promise<void>;
  waitForKillpoint(input: CrashCaseInput): Promise<CrashBarrier>;
  terminate(input: CrashCaseInput & { workerId: string }): Promise<void>;
  waitForRestart(input: CrashCaseInput & { previousWorkerId: string }): Promise<{ workerId: string }>;
  recover(input: CrashCaseInput): Promise<void>;
  inspect(input: CrashCaseInput): Promise<CrashObservation>;
  disarm(input: CrashCaseInput): Promise<void>;
}

export interface CrashCaseEvidence extends DrainPassEvidenceSummary {
  runId: string;
  killpoint: CrashKillpoint;
  verdict: 'pass';
  uniqueNetworkTxIds: string[];
  broadcastAttempts: number;
  restartedFrom: string;
  restartedTo: string;
}

export class CrashDisarmAggregateError extends AggregateError {
  readonly primaryError: unknown;
  readonly disarmError: unknown;

  constructor(primaryError: unknown, disarmError: unknown) {
    super([primaryError, disarmError], 'Crash orchestration failed and barrier disarm also failed.');
    this.name = 'CrashDisarmAggregateError';
    this.primaryError = primaryError;
    this.disarmError = disarmError;
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const POST_INTENT = new Set<CrashKillpoint>([
  'after-intent-persist',
  'after-broadcast-before-submit',
  'after-submit-persist',
]);

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid timestamp.`);
  return parsed;
}

function withinWindow(input: CrashCaseInput, value: string, name: string): number {
  const startMs = timestamp(input.expectation.faultWindow.startsAt, 'faultWindow.startsAt');
  const endMs = timestamp(input.expectation.faultWindow.endsAt, 'faultWindow.endsAt');
  const actualMs = timestamp(value, name);
  if (actualMs < startMs || actualMs > endMs) throw new Error(`${name} is outside the declared fault window.`);
  return actualMs;
}

function drainedClaims(input: CrashCaseInput): CrashClaimIdentity[] {
  return input.expectation.claims
    .filter((claim) => claim.outcome === 'drained')
    .map(({ fingerprint, orgId }) => ({ fingerprint, orgId }));
}

function expectedRoot(input: CrashCaseInput): string {
  return computeMerkleRootFromFingerprints(drainedClaims(input).map((claim) => claim.fingerprint));
}

function validateInput(input: CrashCaseInput): void {
  if (!input.runId?.trim()) throw new Error('Crash case runId is required.');
  if (!(CRASH_KILLPOINTS as readonly string[]).includes(input.killpoint)) {
    throw new Error(`Unsupported crash killpoint: ${input.killpoint}.`);
  }
  validateDrainPassExpectation(input.expectation);

  const isPostIntent = POST_INTENT.has(input.killpoint);
  if (!isPostIntent && input.postIntent) {
    throw new Error('A pre-intent crash case must not declare a future post-intent transaction identity.');
  }
  if (isPostIntent && !input.postIntent) throw new Error('A post-intent crash case requires its durable post-intent identity.');
  if (input.postIntent && (
    !SHA256_HEX.test(input.postIntent.txId)
    || !SHA256_HEX.test(input.postIntent.signedBytesSha256)
  )) {
    throw new Error('Post-intent identity requires lowercase 64-hex txId and signedBytesSha256.');
  }

  const drained = drainedClaims(input);
  const orgs = new Set(drained.map((claim) => claim.orgId));
  if (input.expectation.armedTrigger === 'org-scheduler' && orgs.size !== 1) {
    throw new Error('A crash case represents one org-scheduler batch and therefore exactly one drained org.');
  }
  if (input.expectation.armedTrigger === 'global-flush' && orgs.size < 2) {
    throw new Error('A global crash case requires the mixed-org R3 invariant.');
  }
  if (drained.length > 10_000) throw new Error('A crash case transaction may contain at most 10000 leaves.');
}

function sameClaims(expected: CrashClaimIdentity[], actual: CrashClaimIdentity[]): boolean {
  if (expected.length !== actual.length) return false;
  const expectedMap = new Map(expected.map((claim) => [claim.fingerprint, claim.orgId]));
  return actual.every((claim) => expectedMap.get(claim.fingerprint) === claim.orgId)
    && new Set(actual.map((claim) => claim.fingerprint)).size === actual.length;
}

function forbidLaterStageEvidence(barrier: CrashBarrier, fields: Array<keyof CrashBarrier>): void {
  if (fields.some((field) => barrier[field] !== undefined)) {
    throw new Error(`${barrier.killpoint} barrier contains later-stage evidence and cannot prove an exact kill boundary.`);
  }
}

function validateBarrier(input: CrashCaseInput, barrier: CrashBarrier): void {
  const expected = input.expectation;
  if (barrier.runId !== input.runId || barrier.killpoint !== input.killpoint) {
    throw new Error('Crash barrier does not match the armed runId and killpoint.');
  }
  if (!barrier.workerId?.trim()) throw new Error('Crash barrier must identify the worker to terminate.');
  if (
    barrier.batchId !== expected.batchId
    || barrier.armedTrigger !== expected.armedTrigger
    || barrier.schedulerExecutionId !== expected.schedulerExecutionId
    || barrier.faultWindowId !== expected.faultWindow.id
  ) {
    throw new Error('Crash barrier is unrelated to the declared batch, trigger, execution, or fault window.');
  }
  if (!sameClaims(expected.claims, barrier.claimedLeaves)) {
    throw new Error('Crash barrier claimed leaves/orgs do not exactly match the declaration.');
  }

  const chronology: number[] = [withinWindow(input, barrier.claimedAt, 'Claim stage')];
  const root = expectedRoot(input);
  if (input.killpoint === 'after-claim') {
    forbidLaterStageEvidence(barrier, [
      'merkleRoot', 'merkleBuiltAt', 'intentTxId', 'signedBytesSha256',
      'intentPersistedAt', 'networkAcceptance', 'phase4Persisted',
    ]);
  } else {
    if (barrier.merkleRoot !== root) {
      throw new Error('Crash barrier root does not match the independently recomputed claimed-leaf root.');
    }
    if (!barrier.merkleBuiltAt) throw new Error('Post-Merkle barrier requires merkleBuiltAt.');
    chronology.push(withinWindow(input, barrier.merkleBuiltAt, 'Merkle stage'));
  }

  if (input.killpoint === 'after-merkle-tree') {
    forbidLaterStageEvidence(barrier, [
      'intentTxId', 'signedBytesSha256', 'intentPersistedAt', 'networkAcceptance', 'phase4Persisted',
    ]);
  }

  if (POST_INTENT.has(input.killpoint)) {
    if (
      barrier.intentTxId !== input.postIntent!.txId
      || barrier.signedBytesSha256 !== input.postIntent!.signedBytesSha256
      || !barrier.intentPersistedAt
    ) {
      throw new Error('Intent barrier does not match the durable post-intent txid, signed bytes, and timestamp.');
    }
    chronology.push(withinWindow(input, barrier.intentPersistedAt, 'Intent stage'));
  }
  if (input.killpoint === 'after-intent-persist') {
    forbidLaterStageEvidence(barrier, ['networkAcceptance', 'phase4Persisted']);
  }

  if (input.killpoint === 'after-broadcast-before-submit' || input.killpoint === 'after-submit-persist') {
    const acceptance = barrier.networkAcceptance;
    if (!acceptance) throw new Error('Post-broadcast kill requires node network acceptance evidence.');
    if (!acceptance.nodeId?.trim() || (acceptance.state !== 'mempool' && acceptance.state !== 'confirmed')) {
      throw new Error('Network acceptance must identify the observing node and state.');
    }
    if (acceptance.txId !== input.postIntent!.txId) {
      throw new Error('Network acceptance does not match the exact post-intent txid.');
    }
    if (acceptance.rawTxSha256 !== input.postIntent!.signedBytesSha256) {
      throw new Error('Network acceptance does not prove the exact signed bytes returned by the node.');
    }
    chronology.push(withinWindow(input, acceptance.observedAt, 'Network acceptance stage'));
  }
  if (input.killpoint === 'after-broadcast-before-submit') {
    forbidLaterStageEvidence(barrier, ['phase4Persisted']);
  }

  if (input.killpoint === 'after-submit-persist') {
    const persisted = barrier.phase4Persisted;
    if (!persisted) throw new Error('Post-submit kill requires Phase-4 persistence evidence.');
    if (
      persisted.batchId !== expected.batchId
      || persisted.txId !== input.postIntent!.txId
      || persisted.rowCount !== drainedClaims(input).length
    ) {
      throw new Error('Phase-4 persistence does not match the batch, txid, and drained row count.');
    }
    chronology.push(withinWindow(input, persisted.persistedAt, 'Phase-4 persistence stage'));
  }

  chronology.push(withinWindow(input, barrier.reachedAt, 'Crash barrier'));
  if (chronology.some((value, index) => index > 0 && value < chronology[index - 1]!)) {
    throw new Error('Crash barrier stage chronology is not monotonic before termination.');
  }
}

function validateObservation(
  input: CrashCaseInput,
  barrier: CrashBarrier,
  replacementWorkerId: string,
  observation: CrashObservation,
): { summary: DrainPassEvidenceSummary; txIds: string[] } {
  if (observation.runId !== input.runId) throw new Error('Crash observation runId does not match the case.');
  if (observation.finalWorkerId !== replacementWorkerId) {
    throw new Error('Crash observation was not produced by the replacement worker.');
  }
  const summary = assertDrainPassObservation(input.expectation, observation.drain);
  if (summary.transactionIds.length !== 1) throw new Error('A crash case must resolve to exactly one derived transaction.');

  const actualTransaction = observation.drain.transactions[0]!;
  if (input.postIntent && (
    actualTransaction.txId !== input.postIntent.txId
    || actualTransaction.signedBytesSha256 !== input.postIntent.signedBytesSha256
  )) {
    throw new Error('Actual recovered transaction does not match the declared post-intent identity.');
  }
  if (observation.broadcastAttempts.length === 0) {
    throw new Error('Crash recovery requires at least one correlated broadcast attempt.');
  }
  for (const attempt of observation.broadcastAttempts) {
    if (
      attempt.batchId !== input.expectation.batchId
      || attempt.schedulerExecutionId !== input.expectation.schedulerExecutionId
      || attempt.txId !== actualTransaction.txId
      || attempt.signedBytesSha256 !== actualTransaction.signedBytesSha256
    ) {
      throw new Error('Broadcast attempt is unrelated or does not reuse the exact derived signed transaction.');
    }
  }
  return { summary, txIds: [actualTransaction.txId] };
}

export async function orchestrateCrashCase(
  input: CrashCaseInput,
  port: CrashControlPort,
): Promise<CrashCaseEvidence> {
  validateInput(input);
  let disarmRequired = false;
  let hasPrimaryError = false;
  let primaryError: unknown;
  try {
    disarmRequired = true;
    await port.arm(input);
    await port.start(input);
    const barrier = await port.waitForKillpoint(input);
    validateBarrier(input, barrier);

    await port.terminate({ ...input, workerId: barrier.workerId });
    const replacement = await port.waitForRestart({ ...input, previousWorkerId: barrier.workerId });
    if (!replacement.workerId?.trim() || replacement.workerId === barrier.workerId) {
      throw new Error('Crash worker did not restart with a distinct worker id.');
    }
    await port.recover(input);
    const observation = await port.inspect(input);
    const { summary, txIds } = validateObservation(input, barrier, replacement.workerId, observation);
    return {
      ...summary,
      runId: input.runId,
      killpoint: input.killpoint,
      verdict: 'pass',
      uniqueNetworkTxIds: txIds,
      broadcastAttempts: observation.broadcastAttempts.length,
      restartedFrom: barrier.workerId,
      restartedTo: replacement.workerId,
    };
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    throw error;
  } finally {
    if (disarmRequired) {
      try {
        await port.disarm(input);
      } catch (disarmError) {
        if (hasPrimaryError) throw new CrashDisarmAggregateError(primaryError, disarmError);
        throw disarmError;
      }
    }
  }
}
