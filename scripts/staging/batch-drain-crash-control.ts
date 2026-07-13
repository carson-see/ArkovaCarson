/**
 * Port-driven crash-matrix orchestration for the batch-drain harness.
 *
 * This module owns the safety ordering and evidence invariants but performs no
 * process, network, database, or rig operation itself. A supervised rig adapter
 * must implement CrashControlPort; unit tests use an in-memory fake.
 */

export const CRASH_KILLPOINTS = [
  'after-claim',
  'after-merkle-tree',
  'after-intent-persist',
  'after-broadcast-before-submit',
] as const;

export type CrashKillpoint = typeof CRASH_KILLPOINTS[number];

export interface CrashCaseInput {
  runId: string;
  killpoint: CrashKillpoint;
  expectedLeaves: number;
}

export interface CrashBarrier {
  runId: string;
  killpoint: CrashKillpoint;
  workerId: string;
  intentTxId?: string;
  signedBytesSha256?: string;
}

export interface CrashStatuses {
  pending: number;
  broadcasting: number;
  submitted: number;
  secured: number;
}

export interface CrashBroadcastAttempt {
  txId: string;
  signedBytesSha256: string;
}

export interface CrashObservation {
  runId: string;
  finalWorkerId: string;
  statuses: CrashStatuses;
  networkTxIds: string[];
  broadcastAttempts: CrashBroadcastAttempt[];
}

export interface CrashControlPort {
  /** Enable one named deterministic barrier for this run. */
  arm(input: CrashCaseInput): Promise<void>;
  /** Start the drain case under a supervisor; must not return a completion verdict. */
  start(input: CrashCaseInput): Promise<void>;
  /** Resolve only when the named boundary is durably observable. */
  waitForKillpoint(input: CrashCaseInput): Promise<CrashBarrier>;
  /** Terminate exactly the worker reported by the barrier. */
  terminate(input: CrashCaseInput & { workerId: string }): Promise<void>;
  /** Resolve only after the supervisor reports a replacement worker. */
  waitForRestart(input: CrashCaseInput & { previousWorkerId: string }): Promise<{ workerId: string }>;
  /** Invoke the trigger-specific recovery path after replacement is proven. */
  recover(input: CrashCaseInput): Promise<void>;
  /** Return terminal row state and externally observed broadcast evidence. */
  inspect(input: CrashCaseInput): Promise<CrashObservation>;
  /** Disable the barrier in both pass and failure paths. */
  disarm(input: CrashCaseInput): Promise<void>;
}

export interface CrashCaseEvidence {
  runId: string;
  killpoint: CrashKillpoint;
  verdict: 'pass';
  uniqueNetworkTxIds: string[];
  broadcastAttempts: number;
  restartedFrom: string;
  restartedTo: string;
  statuses: CrashStatuses;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const POST_INTENT_KILLPOINTS = new Set<CrashKillpoint>([
  'after-intent-persist',
  'after-broadcast-before-submit',
]);

function validateInput(input: CrashCaseInput): void {
  if (!input.runId?.trim()) throw new Error('Crash case runId is required.');
  if (!(CRASH_KILLPOINTS as readonly string[]).includes(input.killpoint)) {
    throw new Error(`Unsupported crash killpoint: ${input.killpoint}.`);
  }
  if (!Number.isInteger(input.expectedLeaves) || input.expectedLeaves <= 0) {
    throw new Error(`expectedLeaves must be a positive integer; received ${input.expectedLeaves}.`);
  }
}

function validateBarrier(input: CrashCaseInput, barrier: CrashBarrier): void {
  if (barrier.runId !== input.runId || barrier.killpoint !== input.killpoint) {
    throw new Error('Crash barrier does not match the armed runId and killpoint.');
  }
  if (!barrier.workerId?.trim()) throw new Error('Crash barrier must identify the worker to terminate.');

  if (POST_INTENT_KILLPOINTS.has(input.killpoint)) {
    if (!SHA256_HEX.test(barrier.intentTxId ?? '') || !SHA256_HEX.test(barrier.signedBytesSha256 ?? '')) {
      throw new Error('Post-intent barrier requires 64-hex intentTxId and signedBytesSha256 evidence.');
    }
  }
}

function validateStatuses(statuses: CrashStatuses, expectedLeaves: number): void {
  const entries = Object.entries(statuses) as Array<[keyof CrashStatuses, number]>;
  for (const [status, count] of entries) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Crash observation status ${status} must be a non-negative integer.`);
    }
  }
  if (statuses.pending !== 0 || statuses.broadcasting !== 0) {
    throw new Error('Crash recovery left non-terminal PENDING or BROADCASTING rows.');
  }
  if (statuses.submitted + statuses.secured !== expectedLeaves) {
    throw new Error(
      `Crash recovery terminal leaf count ${statuses.submitted + statuses.secured} does not match expectedLeaves ${expectedLeaves}.`,
    );
  }
}

function validateObservation(
  input: CrashCaseInput,
  barrier: CrashBarrier,
  replacementWorkerId: string,
  observation: CrashObservation,
): string[] {
  if (observation.runId !== input.runId) {
    throw new Error('Crash observation runId does not match the case.');
  }
  if (observation.finalWorkerId !== replacementWorkerId) {
    throw new Error('Crash observation was not produced by the replacement worker.');
  }
  validateStatuses(observation.statuses, input.expectedLeaves);

  const networkTxIds = [...new Set(observation.networkTxIds)];
  if (networkTxIds.length !== 1 || !SHA256_HEX.test(networkTxIds[0] ?? '')) {
    throw new Error('Crash recovery must produce exactly one network txid.');
  }
  if (observation.broadcastAttempts.length === 0) {
    throw new Error('Crash recovery requires at least one broadcast-attempt record.');
  }

  const signedHashes = new Set<string>();
  for (const attempt of observation.broadcastAttempts) {
    if (!SHA256_HEX.test(attempt.txId) || !SHA256_HEX.test(attempt.signedBytesSha256)) {
      throw new Error('Every broadcast attempt requires 64-hex txId and signedBytesSha256 evidence.');
    }
    if (attempt.txId !== networkTxIds[0]) {
      throw new Error('Broadcast attempts do not converge on exactly one network txid.');
    }
    signedHashes.add(attempt.signedBytesSha256);
  }
  if (signedHashes.size !== 1) {
    throw new Error('Repeated broadcast attempts must use identical signed bytes.');
  }

  if (POST_INTENT_KILLPOINTS.has(input.killpoint)) {
    if (networkTxIds[0] !== barrier.intentTxId || [...signedHashes][0] !== barrier.signedBytesSha256) {
      throw new Error('Recovered broadcast evidence does not match the durable intent txid and signed bytes.');
    }
  }

  return networkTxIds;
}

/**
 * Drive one deterministic crash case through a supplied supervisor adapter.
 * The ordering is deliberately strict: no termination before a named barrier,
 * and no recovery before a distinct replacement worker is observed.
 */
export async function orchestrateCrashCase(
  input: CrashCaseInput,
  port: CrashControlPort,
): Promise<CrashCaseEvidence> {
  validateInput(input);
  let armed = false;
  try {
    await port.arm(input);
    armed = true;
    await port.start(input);
    const barrier = await port.waitForKillpoint(input);
    validateBarrier(input, barrier);

    await port.terminate({ ...input, workerId: barrier.workerId });
    const replacement = await port.waitForRestart({
      ...input,
      previousWorkerId: barrier.workerId,
    });
    if (!replacement.workerId?.trim() || replacement.workerId === barrier.workerId) {
      throw new Error('Crash worker did not restart with a distinct worker id.');
    }

    await port.recover(input);
    const observation = await port.inspect(input);
    const uniqueNetworkTxIds = validateObservation(
      input,
      barrier,
      replacement.workerId,
      observation,
    );

    return {
      runId: input.runId,
      killpoint: input.killpoint,
      verdict: 'pass',
      uniqueNetworkTxIds,
      broadcastAttempts: observation.broadcastAttempts.length,
      restartedFrom: barrier.workerId,
      restartedTo: replacement.workerId,
      statuses: observation.statuses,
    };
  } finally {
    if (armed) await port.disarm(input);
  }
}
