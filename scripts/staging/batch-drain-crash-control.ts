/**
 * Port-driven crash-matrix orchestration for the batch-drain harness.
 *
 * This module defines strict ordering/correlation contracts but performs no
 * process, network, database, broadcast, or rig operation. A supervised rig
 * adapter must implement CrashControlPort; offline tests use an in-memory fake.
 */

import {
  assertDrainPassObservation,
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

export interface CrashCaseInput {
  runId: string;
  killpoint: CrashKillpoint;
  expectation: DrainPassExpectation;
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
  reachedAt: string;
  workerId: string;
  claimedLeaves: CrashClaimIdentity[];
  merkleRoot?: string;
  intentTxId?: string;
  signedBytesSha256?: string;
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
  /** Enable exactly one named deterministic barrier for this case. */
  arm(input: CrashCaseInput): Promise<void>;
  /** Start the declared scheduler case under a supervisor. */
  start(input: CrashCaseInput): Promise<void>;
  /** Return complete, boundary-specific, batch-correlated barrier evidence. */
  waitForKillpoint(input: CrashCaseInput): Promise<CrashBarrier>;
  /** Terminate exactly the worker proved by the validated barrier. */
  terminate(input: CrashCaseInput & { workerId: string }): Promise<void>;
  /** Resolve only after the supervisor reports a distinct replacement. */
  waitForRestart(input: CrashCaseInput & { previousWorkerId: string }): Promise<{ workerId: string }>;
  /** Invoke the trigger-specific recovery path after replacement is proven. */
  recover(input: CrashCaseInput): Promise<void>;
  /** Return the complete actual pass observation; sparse evidence must fail. */
  inspect(input: CrashCaseInput): Promise<CrashObservation>;
  /** Disable the named barrier in pass and failure paths. */
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

/** Retains both failures when cleanup itself fails after a primary failure. */
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
const POST_MERKLE_KILLPOINTS = new Set<CrashKillpoint>([
  'after-merkle-tree',
  'after-intent-persist',
  'after-broadcast-before-submit',
  'after-submit-persist',
]);
const POST_INTENT_KILLPOINTS = new Set<CrashKillpoint>([
  'after-intent-persist',
  'after-broadcast-before-submit',
  'after-submit-persist',
]);
const POST_NETWORK_KILLPOINTS = new Set<CrashKillpoint>([
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
  if (endMs <= startMs || actualMs < startMs || actualMs > endMs) {
    throw new Error(`${name} is outside the declared fault window.`);
  }
  return actualMs;
}

function validateInput(input: CrashCaseInput): void {
  if (!input.runId?.trim()) throw new Error('Crash case runId is required.');
  if (!(CRASH_KILLPOINTS as readonly string[]).includes(input.killpoint)) {
    throw new Error(`Unsupported crash killpoint: ${input.killpoint}.`);
  }
  if (input.expectation.transactions.length !== 1) {
    throw new Error('A crash case must declare exactly one transaction for one correlated batch.');
  }
  if (input.expectation.claims.length === 0) throw new Error('A crash case requires claimed leaves.');
  validateDrainPassExpectation(input.expectation);
}

function sameClaims(expected: CrashClaimIdentity[], actual: CrashClaimIdentity[]): boolean {
  if (expected.length !== actual.length) return false;
  const expectedByFingerprint = new Map(expected.map((claim) => [claim.fingerprint, claim.orgId]));
  return actual.every((claim) => expectedByFingerprint.get(claim.fingerprint) === claim.orgId)
    && new Set(actual.map((claim) => claim.fingerprint)).size === actual.length;
}

function validateBarrier(input: CrashCaseInput, barrier: CrashBarrier): void {
  const expected = input.expectation;
  const transaction = expected.transactions[0]!;
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
    throw new Error('Crash barrier is not correlated to the declared batch, armed trigger, scheduler execution, and fault window.');
  }
  const reachedAtMs = withinWindow(input, barrier.reachedAt, 'Crash barrier');
  if (!sameClaims(expected.claims, barrier.claimedLeaves)) {
    throw new Error('Crash barrier claimed leaves/orgs do not exactly match the declared claims.');
  }

  if (POST_MERKLE_KILLPOINTS.has(input.killpoint) && barrier.merkleRoot !== transaction.merkleRoot) {
    throw new Error('Crash barrier merkle root does not match the claimed batch root.');
  }
  if (POST_INTENT_KILLPOINTS.has(input.killpoint)) {
    if (
      !SHA256_HEX.test(barrier.intentTxId ?? '')
      || !SHA256_HEX.test(barrier.signedBytesSha256 ?? '')
      || barrier.intentTxId !== transaction.txId
      || barrier.signedBytesSha256 !== transaction.signedBytesSha256
    ) {
      throw new Error('Post-intent barrier txid/signed bytes do not match the declared batch transaction.');
    }
  }

  if (POST_NETWORK_KILLPOINTS.has(input.killpoint)) {
    const acceptance = barrier.networkAcceptance;
    if (!acceptance) {
      throw new Error('Post-broadcast kill requires node network acceptance evidence before termination.');
    }
    if (!acceptance.nodeId?.trim() || (acceptance.state !== 'mempool' && acceptance.state !== 'confirmed')) {
      throw new Error('Network acceptance evidence must identify the observing node and accepted state.');
    }
    if (acceptance.txId !== transaction.txId || acceptance.txId !== barrier.intentTxId) {
      throw new Error('Network acceptance evidence does not match the exact intended txid.');
    }
    if (
      !SHA256_HEX.test(acceptance.rawTxSha256)
      || acceptance.rawTxSha256 !== transaction.signedBytesSha256
      || acceptance.rawTxSha256 !== barrier.signedBytesSha256
    ) {
      throw new Error('Network acceptance evidence does not prove the exact signed bytes returned by the node.');
    }
    const acceptedAtMs = withinWindow(input, acceptance.observedAt, 'Network acceptance');
    if (acceptedAtMs > reachedAtMs) {
      throw new Error('Network acceptance must be observed before the crash barrier is released.');
    }
  }

  if (input.killpoint === 'after-submit-persist') {
    const persisted = barrier.phase4Persisted;
    const drainedLeaves = expected.claims.filter((claim) => claim.outcome === 'drained').length;
    if (!persisted) throw new Error('Post-submit kill requires Phase-4 persistence evidence before termination.');
    if (
      persisted.batchId !== expected.batchId
      || persisted.txId !== transaction.txId
      || persisted.rowCount !== drainedLeaves
    ) {
      throw new Error('Phase-4 persistence evidence does not match the declared batch, txid, and row count.');
    }
    const persistedAtMs = withinWindow(input, persisted.persistedAt, 'Phase-4 persistence');
    const acceptedAtMs = timestamp(barrier.networkAcceptance!.observedAt, 'Network acceptance');
    if (persistedAtMs < acceptedAtMs || persistedAtMs > reachedAtMs) {
      throw new Error('Phase-4 persistence must follow network acceptance and precede barrier release.');
    }
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
  const transaction = input.expectation.transactions[0]!;
  if (observation.broadcastAttempts.length === 0) {
    throw new Error('Crash recovery requires at least one correlated broadcast-attempt record.');
  }
  for (const attempt of observation.broadcastAttempts) {
    if (
      attempt.batchId !== input.expectation.batchId
      || attempt.schedulerExecutionId !== input.expectation.schedulerExecutionId
      || attempt.txId !== transaction.txId
      || attempt.signedBytesSha256 !== transaction.signedBytesSha256
    ) {
      throw new Error('Broadcast attempt is unrelated or does not reuse the exact declared signed transaction.');
    }
  }

  const txIds = [...new Set(observation.broadcastAttempts.map((attempt) => attempt.txId))];
  const signedHashes = new Set(observation.broadcastAttempts.map((attempt) => attempt.signedBytesSha256));
  if (txIds.length !== 1 || signedHashes.size !== 1) {
    throw new Error('Crash recovery must converge on exactly one txid and one signed-byte hash.');
  }
  if (
    POST_INTENT_KILLPOINTS.has(input.killpoint)
    && (txIds[0] !== barrier.intentTxId || [...signedHashes][0] !== barrier.signedBytesSha256)
  ) {
    throw new Error('Recovered broadcast does not match the durable intent txid and signed bytes.');
  }

  return { summary, txIds };
}

/**
 * Drive one deterministic crash case through a supplied supervisor adapter.
 * Termination is impossible until the complete boundary evidence validates.
 */
export async function orchestrateCrashCase(
  input: CrashCaseInput,
  port: CrashControlPort,
): Promise<CrashCaseEvidence> {
  validateInput(input);
  let disarmRequired = false;
  let hasPrimaryError = false;
  let primaryError: unknown;
  try {
    // An adapter can arm its barrier and then fail while reporting success.
    // From this point onward cleanup is mandatory even when arm() rejects.
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
