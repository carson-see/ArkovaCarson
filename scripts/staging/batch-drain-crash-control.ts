/**
 * Supervised crash-matrix orchestration contract. The port is implemented by
 * a rig adapter; this module validates durable barriers, signet identity, and
 * Cloud Run lifecycle evidence without performing live actions itself.
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
import { parseUtcTimestamp } from './batch-drain-time';

export const CRASH_KILLPOINTS = [
  'after-claim',
  'after-merkle-tree',
  'after-intent-persist',
  'after-broadcast-before-submit',
  'after-submit-persist',
] as const;

export type CrashKillpoint = typeof CRASH_KILLPOINTS[number];

export interface RuntimeBinding {
  headSha: string;
  imageDigest: string;
}

export interface PostIntentIdentity {
  txId: string;
  signedBytesSha256: string;
}

export interface CrashCaseInput {
  runId: string;
  killpoint: CrashKillpoint;
  expectation: DrainPassExpectation;
  runtime: RuntimeBinding;
}

export interface CrashClaimIdentity {
  fingerprint: string;
  orgId: string;
  claimOrder: number;
}

export interface NetworkAcceptanceEvidence {
  txId: string;
  rawTxSha256: string;
  nodeId: string;
  network: 'signet';
  state: 'mempool' | 'confirmed';
  observedAt: string;
}

export interface Phase4PersistenceEvidence {
  batchId: string;
  txId: string;
  rowCount: number;
  persistedAt: string;
}

export interface CrashBarrier extends RuntimeBinding {
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

export interface ProcessUptimeEvidence extends RuntimeBinding {
  workerId: string;
  source: 'cloud-run-audit-log';
  startedAt: string;
  observedUntil: string;
  uptimeMs: number;
  lifecycleAudit: ProcessLifecycleAuditEntry[];
}

export interface ProcessLifecycleAuditEntry {
  workerId: string;
  event: 'started' | 'terminated' | 'restarted' | 'observed';
  logEntryId: string;
  occurredAt: string;
}

export interface CrashObservation {
  runId: string;
  finalWorkerId: string;
  observedAt: string;
  drain: DrainPassObservation;
  broadcastAttempts: CrashBroadcastAttempt[];
  processUptime: ProcessUptimeEvidence[];
}

export interface TerminationEvidence extends RuntimeBinding {
  workerId: string;
  source: 'cloud-run-audit-log';
  logEntryId: string;
  signal: 'SIGKILL' | 'SIGTERM';
  requestedAt: string;
  exitedAt: string;
}

export interface RestartEvidence extends RuntimeBinding {
  previousWorkerId: string;
  workerId: string;
  source: 'cloud-run-audit-log';
  logEntryId: string;
  startedAt: string;
}

export interface RecoveryEvidence {
  recoverySchedulerExecutionId: string;
  correlatedDrainExecutionId: string;
  faultWindowId: string;
  source: 'cloud-scheduler';
  endpointPath: '/jobs/recover-broadcasts';
  httpStatus: 200;
  startedAt: string;
  completedAt: string;
}

export interface CrashControlPort {
  readonly evidenceMode: 'offline-replay' | 'live-rig';
  arm(input: CrashCaseInput): Promise<void>;
  start(input: CrashCaseInput): Promise<void>;
  waitForKillpoint(input: CrashCaseInput): Promise<CrashBarrier>;
  terminate(input: CrashCaseInput & { workerId: string }): Promise<TerminationEvidence>;
  waitForRestart(input: CrashCaseInput & { previousWorkerId: string }): Promise<RestartEvidence>;
  recover(input: CrashCaseInput): Promise<RecoveryEvidence>;
  inspect(input: CrashCaseInput): Promise<CrashObservation>;
  disarm(input: CrashCaseInput): Promise<void>;
}

export interface CrashCaseEvidence extends DrainPassEvidenceSummary {
  evidenceMode: 'offline-replay' | 'live-rig';
  runId: string;
  killpoint: CrashKillpoint;
  verdict: 'pass';
  uniqueNetworkTxIds: string[];
  broadcastAttempts: number;
  restartedFrom: string;
  restartedTo: string;
  postIntent: PostIntentIdentity | null;
  terminatedAt: string;
  restartedAt: string;
  recoveredAt: string;
  initialWorkerUptimeMs: number;
  replacementWorkerUptimeMs: number;
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
const HEAD_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const POST_INTENT = new Set<CrashKillpoint>([
  'after-intent-persist',
  'after-broadcast-before-submit',
  'after-submit-persist',
]);

function timestamp(value: string, name: string): number {
  return parseUtcTimestamp(value, name);
}

function withinWindow(input: CrashCaseInput, value: string, name: string): number {
  const startMs = timestamp(input.expectation.faultWindow.startsAt, 'faultWindow.startsAt');
  const endMs = timestamp(input.expectation.faultWindow.endsAt, 'faultWindow.endsAt');
  const actualMs = timestamp(value, name);
  if (actualMs < startMs || actualMs > endMs) throw new Error(`${name} is outside the declared fault window.`);
  return actualMs;
}

function assertRuntime(expected: RuntimeBinding, actual: RuntimeBinding, name: string): void {
  if (actual.headSha !== expected.headSha || actual.imageDigest !== expected.imageDigest) {
    throw new Error(`${name} does not match the exact tested head and image digest.`);
  }
}

function validateInput(input: CrashCaseInput): void {
  if (!input.runId?.trim()) throw new Error('Crash case runId is required.');
  if (!(CRASH_KILLPOINTS as readonly string[]).includes(input.killpoint)) {
    throw new Error(`Unsupported crash killpoint: ${input.killpoint}.`);
  }
  if (!HEAD_SHA.test(input.runtime.headSha) || !IMAGE_DIGEST.test(input.runtime.imageDigest)) {
    throw new Error('Crash case requires exact lowercase head SHA and sha256 image digest.');
  }
  if ('postIntent' in input) {
    throw new Error('postIntent is captured only after the durable intent barrier and must not be predeclared.');
  }
  validateDrainPassExpectation(input.expectation);
  const orgs = new Set(input.expectation.claims.map((claim) => claim.orgId));
  if (input.expectation.armedTrigger === 'org-scheduler' && orgs.size !== 1) {
    throw new Error('A crash case represents one org-scheduler batch and therefore exactly one org.');
  }
  if (input.expectation.armedTrigger !== 'org-scheduler' && orgs.size < 2) {
    throw new Error('A global crash case requires the mixed-org R3 invariant.');
  }
  if (input.expectation.claims.length > 10_000) throw new Error('A crash case transaction may contain at most 10000 leaves.');
}

function sameOrderedClaims(expected: DrainPassExpectation['claims'], actual: CrashClaimIdentity[]): boolean {
  return expected.length === actual.length && actual.every((claim, index) => (
    claim.claimOrder === index + 1
    && claim.fingerprint === expected[index]!.fingerprint
    && claim.orgId === expected[index]!.orgId
  ));
}

function forbidLaterStageEvidence(barrier: CrashBarrier, fields: Array<keyof CrashBarrier>): void {
  if (fields.some((field) => barrier[field] !== undefined)) {
    throw new Error(`${barrier.killpoint} barrier contains later-stage evidence and cannot prove an exact kill boundary.`);
  }
}

function postIntentFromBarrier(input: CrashCaseInput, barrier: CrashBarrier): PostIntentIdentity | null {
  if (!POST_INTENT.has(input.killpoint)) return null;
  if (
    !barrier.intentTxId
    || !barrier.signedBytesSha256
    || !SHA256_HEX.test(barrier.intentTxId)
    || !SHA256_HEX.test(barrier.signedBytesSha256)
    || !barrier.intentPersistedAt
  ) {
    throw new Error('Durable intent barrier did not expose a valid postIntent identity and timestamp.');
  }
  return { txId: barrier.intentTxId, signedBytesSha256: barrier.signedBytesSha256 };
}

function validateBarrier(input: CrashCaseInput, barrier: CrashBarrier): PostIntentIdentity | null {
  const expected = input.expectation;
  if (barrier.runId !== input.runId || barrier.killpoint !== input.killpoint) {
    throw new Error('Crash barrier does not match the armed runId and killpoint.');
  }
  if (!barrier.workerId?.trim()) throw new Error('Crash barrier must identify the worker to terminate.');
  assertRuntime(input.runtime, barrier, 'Crash barrier runtime');
  if (
    barrier.batchId !== expected.batchId
    || barrier.armedTrigger !== expected.armedTrigger
    || barrier.schedulerExecutionId !== expected.schedulerExecutionId
    || barrier.faultWindowId !== expected.faultWindow.id
  ) {
    throw new Error('Crash barrier is unrelated to the declared batch, trigger, execution, or fault window.');
  }
  if (!sameOrderedClaims(expected.claims, barrier.claimedLeaves)) {
    throw new Error('Crash barrier does not preserve the exact durable claim order and identity.');
  }

  const chronology: number[] = [withinWindow(input, barrier.claimedAt, 'Claim stage')];
  const root = computeMerkleRootFromFingerprints(expected.claims.map((claim) => claim.fingerprint));
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

  const postIntent = postIntentFromBarrier(input, barrier);
  if (postIntent && barrier.intentPersistedAt) {
    chronology.push(withinWindow(input, barrier.intentPersistedAt, 'Intent stage'));
  }
  if (input.killpoint === 'after-intent-persist') forbidLaterStageEvidence(barrier, ['networkAcceptance', 'phase4Persisted']);

  if (input.killpoint === 'after-broadcast-before-submit' || input.killpoint === 'after-submit-persist') {
    const acceptance = barrier.networkAcceptance;
    if (!acceptance) throw new Error('Post-broadcast kill requires node network acceptance evidence.');
    if (
      acceptance.network !== 'signet'
      || !acceptance.nodeId?.trim()
      || (acceptance.state !== 'mempool' && acceptance.state !== 'confirmed')
      || acceptance.txId !== postIntent!.txId
      || acceptance.rawTxSha256 !== postIntent!.signedBytesSha256
    ) {
      throw new Error('Network acceptance does not prove the exact durable signed transaction on signet.');
    }
    chronology.push(withinWindow(input, acceptance.observedAt, 'Network acceptance stage'));
  }
  if (input.killpoint === 'after-broadcast-before-submit') forbidLaterStageEvidence(barrier, ['phase4Persisted']);

  if (input.killpoint === 'after-submit-persist') {
    const persisted = barrier.phase4Persisted;
    if (!persisted) throw new Error('Post-submit kill requires Phase-4 persistence evidence.');
    if (
      persisted.batchId !== expected.batchId
      || persisted.txId !== postIntent!.txId
      || persisted.rowCount !== expected.claims.length
    ) {
      throw new Error('Phase-4 persistence does not match the batch, txid, and ordered row count.');
    }
    chronology.push(withinWindow(input, persisted.persistedAt, 'Phase-4 persistence stage'));
  }

  chronology.push(withinWindow(input, barrier.reachedAt, 'Crash barrier'));
  if (chronology.some((value, index) => index > 0 && value < chronology[index - 1]!)) {
    throw new Error('Crash barrier stage chronology is not monotonic before termination.');
  }
  return postIntent;
}

function validateLifecycle(
  input: CrashCaseInput,
  barrier: CrashBarrier,
  termination: TerminationEvidence,
  restart: RestartEvidence,
  recovery: RecoveryEvidence,
  observation: CrashObservation,
): { initialUptimeMs: number; replacementUptimeMs: number } {
  assertRuntime(input.runtime, termination, 'Termination runtime');
  assertRuntime(input.runtime, restart, 'Restart runtime');
  if (
    termination.workerId !== barrier.workerId
    || termination.source !== 'cloud-run-audit-log'
    || !termination.logEntryId?.trim()
  ) {
    throw new Error('Termination evidence is not a correlated Cloud Run lifecycle event.');
  }
  if (
    restart.previousWorkerId !== barrier.workerId
    || !restart.workerId?.trim()
    || restart.workerId === barrier.workerId
    || restart.source !== 'cloud-run-audit-log'
    || !restart.logEntryId?.trim()
  ) {
    throw new Error('Restart evidence is not a distinct correlated Cloud Run replacement.');
  }
  if (
    !recovery.recoverySchedulerExecutionId?.trim()
    || recovery.recoverySchedulerExecutionId === input.expectation.schedulerExecutionId
    || recovery.correlatedDrainExecutionId !== input.expectation.schedulerExecutionId
    || recovery.faultWindowId !== input.expectation.faultWindow.id
    || recovery.source !== 'cloud-scheduler'
    || recovery.endpointPath !== '/jobs/recover-broadcasts'
    || recovery.httpStatus !== 200
  ) {
    throw new Error('Recovery evidence must be a distinct Cloud-Scheduler 200 correlated to the exact drain execution and fault window.');
  }
  if (observation.runId !== input.runId || observation.finalWorkerId !== restart.workerId) {
    throw new Error('Crash observation was not produced by the correlated replacement worker.');
  }

  if (termination.logEntryId === restart.logEntryId) {
    throw new Error('Termination and restart require distinct Cloud Run audit-log identities.');
  }

  const drainCompletedMs = withinWindow(input, observation.drain.execution.completedAt, 'Correlated drain completion');
  const recoveryStartedMs = withinWindow(input, recovery.startedAt, 'Recovery start');
  if (
    observation.drain.execution.schedulerExecutionId !== recovery.correlatedDrainExecutionId
    || recoveryStartedMs <= drainCompletedMs
  ) {
    throw new Error('Recovery must start strictly after the exact correlated drain completion.');
  }
  const chronology = [
    withinWindow(input, barrier.reachedAt, 'Crash barrier'),
    withinWindow(input, termination.requestedAt, 'Termination request'),
    withinWindow(input, termination.exitedAt, 'Worker exit'),
    withinWindow(input, restart.startedAt, 'Worker restart'),
    drainCompletedMs,
    recoveryStartedMs,
    withinWindow(input, recovery.completedAt, 'Recovery completion'),
    withinWindow(input, observation.observedAt, 'Post-recovery inspection'),
  ];
  if (chronology.some((value, index) => index > 0 && value < chronology[index - 1]!)) {
    throw new Error('Termination, restart, recovery, and inspection chronology is not monotonic.');
  }

  if (observation.processUptime.length !== 2) {
    throw new Error('Process lifecycle requires exactly two uptime records: initial and replacement.');
  }
  const byWorker = new Map(observation.processUptime.map((item) => [item.workerId, item]));
  const initial = byWorker.get(barrier.workerId);
  const replacement = byWorker.get(restart.workerId);
  if (!initial || !replacement || byWorker.size !== 2) {
    throw new Error('Process lifecycle requires exact initial and replacement worker uptime evidence.');
  }
  for (const item of [initial, replacement]) {
    assertRuntime(input.runtime, item, 'Worker uptime runtime');
    if (item.source !== 'cloud-run-audit-log' || item.lifecycleAudit.length !== 2) {
      throw new Error('Worker uptime requires exactly two typed lifecycle audit entries.');
    }
    const computed = timestamp(item.observedUntil, 'uptime observedUntil') - timestamp(item.startedAt, 'uptime startedAt');
    if (computed < 0 || computed !== item.uptimeMs) throw new Error('Worker uptime milliseconds do not match lifecycle timestamps.');
  }
  const [initialStart, initialTermination] = initial.lifecycleAudit;
  const [replacementStart, replacementObserved] = replacement.lifecycleAudit;
  const lifecycleLogIds = observation.processUptime.flatMap((item) => item.lifecycleAudit.map((entry) => entry.logEntryId));
  if (
    lifecycleLogIds.some((logEntryId) => !logEntryId.trim())
    || new Set(lifecycleLogIds).size !== lifecycleLogIds.length
    || [initialStart, initialTermination].some((entry) => entry?.workerId !== barrier.workerId)
    || [replacementStart, replacementObserved].some((entry) => entry?.workerId !== restart.workerId)
    || initialStart?.event !== 'started'
    || initialStart.occurredAt !== initial.startedAt
    || initialTermination?.event !== 'terminated'
    || initialTermination.logEntryId !== termination.logEntryId
    || initialTermination.occurredAt !== termination.exitedAt
    || replacementStart?.event !== 'restarted'
    || replacementStart.logEntryId !== restart.logEntryId
    || replacementStart.occurredAt !== restart.startedAt
    || replacementObserved?.event !== 'observed'
    || replacementObserved.occurredAt !== observation.observedAt
  ) {
    throw new Error('Cloud Run lifecycle audit bijection rejects duplicate, extra, or cross-worker identities.');
  }
  if (
    initial.observedUntil !== termination.exitedAt
    || timestamp(initial.startedAt, 'initial worker start') > timestamp(barrier.claimedAt, 'claim time')
    || replacement.startedAt !== restart.startedAt
    || replacement.observedUntil !== observation.observedAt
  ) {
    throw new Error('Worker uptime intervals do not join the claim, termination, restart, and inspection facts.');
  }
  return { initialUptimeMs: initial.uptimeMs, replacementUptimeMs: replacement.uptimeMs };
}

function validateObservation(
  input: CrashCaseInput,
  postIntent: PostIntentIdentity | null,
  observation: CrashObservation,
): { summary: DrainPassEvidenceSummary; txIds: string[] } {
  const summary = assertDrainPassObservation(input.expectation, observation.drain);
  if (summary.transactionIds.length !== 1) throw new Error('A crash case must resolve to exactly one derived transaction.');
  const actualTransaction = observation.drain.transactions[0]!;
  if (postIntent && (
    actualTransaction.txId !== postIntent.txId
    || actualTransaction.signedBytesSha256 !== postIntent.signedBytesSha256
  )) {
    throw new Error('Recovered transaction does not match postIntent captured at the durable barrier.');
  }
  if (observation.broadcastAttempts.length === 0) throw new Error('Crash recovery requires a correlated broadcast attempt.');
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
  let result: CrashCaseEvidence | undefined;
  let primaryError: unknown;

  try {
    disarmRequired = true;
    await port.arm(input);
    await port.start(input);
    const barrier = await port.waitForKillpoint(input);
    const postIntent = validateBarrier(input, barrier);
    const termination = await port.terminate({ ...input, workerId: barrier.workerId });
    const restart = await port.waitForRestart({ ...input, previousWorkerId: barrier.workerId });
    const recovery = await port.recover(input);
    const observation = await port.inspect(input);
    const uptime = validateLifecycle(input, barrier, termination, restart, recovery, observation);
    const { summary, txIds } = validateObservation(input, postIntent, observation);
    result = {
      ...summary,
      evidenceMode: port.evidenceMode,
      runId: input.runId,
      killpoint: input.killpoint,
      verdict: 'pass',
      uniqueNetworkTxIds: txIds,
      broadcastAttempts: observation.broadcastAttempts.length,
      restartedFrom: barrier.workerId,
      restartedTo: restart.workerId,
      postIntent,
      terminatedAt: termination.exitedAt,
      restartedAt: restart.startedAt,
      recoveredAt: recovery.completedAt,
      initialWorkerUptimeMs: uptime.initialUptimeMs,
      replacementWorkerUptimeMs: uptime.replacementUptimeMs,
    };
  } catch (error) {
    primaryError = error;
  }

  let disarmError: unknown;
  if (disarmRequired) {
    try {
      await port.disarm(input);
    } catch (error) {
      disarmError = error;
    }
  }
  if (primaryError !== undefined && disarmError !== undefined) {
    throw new CrashDisarmAggregateError(primaryError, disarmError);
  }
  if (primaryError !== undefined) throw primaryError;
  if (disarmError !== undefined) throw disarmError;
  if (!result) throw new Error('Crash orchestration completed without evidence.');
  return result;
}
