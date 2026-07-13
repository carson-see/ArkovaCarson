#!/usr/bin/env -S npx tsx
/**
 * Executable consumer for a captured RIG-B1 evidence bundle. Live collection
 * is an injected adapter operation and is disabled unless two operator gates
 * are present. The bundled JSON adapter only reads a local capture: this file
 * never embeds credentials or makes a network, DB, Scheduler, process, or
 * broadcast call by itself.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  assertDrainWindowObservation,
  type DrainPassObservation,
  type DrainWindowEvidenceSummary,
  type DrainWindowExpectation,
  type DrainTrigger,
} from './batch-drain-observation';

export const LIVE_EVIDENCE_ENABLE_VALUE = 'ARKOVA_S33_VALIDATE_CAPTURED_RIG_EVIDENCE';

export interface LiveEvidenceRequest {
  rigId: 'RIG-B1';
  projectRef: string;
  soakId: string;
  headSha: string;
  imageDigest: string;
  workerService: string;
  workerRevision: string;
  region: string;
  cleanMirrorAttestationId: string;
  leaseId: string;
  requiredFloorMinutes: number;
  windows: DrainWindowExpectation[];
}

export interface LiveRigIdentity {
  rigId: string;
  projectRef: string;
  soakId: string;
  headSha: string;
  imageDigest: string;
  workerService: string;
  workerRevision: string;
  region: string;
}

export interface CleanMirrorEvidence {
  attestationId: string;
  result: 'pass';
  projectRef: string;
  headSha: string;
  observedAt: string;
}

export interface LeaseEvidence {
  leaseId: string;
  rigId: string;
  projectRef: string;
  soakId: string;
  state: 'active';
  holder: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface SchedulerHttpEvidence {
  schedulerExecutionId: string;
  source: 'cloud-scheduler';
  projectRef: string;
  soakId: string;
  path: string;
  trigger: DrainTrigger;
  statusCode: 200;
  firedAt: string;
  completedAt: string;
}

export interface SupervisedRunnerEvidence {
  runnerId: string;
  supervisor: string;
  mode: 'log-and-continue';
  startedAt: string;
  stoppedAt: string;
  heartbeatAt: string[];
  runnerDeathEvents: string[];
}

export interface WorkerUptimeInterval {
  workerId: string;
  source: 'cloud-run-audit-log';
  headSha: string;
  imageDigest: string;
  startedAt: string;
  endedAt: string;
  uptimeMs: number;
  logEntryIds: string[];
}

export interface LiveDrainWindowObservation {
  scenarioId: string;
  observations: DrainPassObservation[];
}

export interface LiveEvidenceSources {
  schedulerExportId: string;
  databaseQueryExportId: string;
  signetNodeExportId: string;
  cloudRunAuditExportId: string;
  supervisorLogExportId: string;
}

export interface LiveEvidenceBundle {
  identity: LiveRigIdentity;
  cleanMirror: CleanMirrorEvidence;
  lease: LeaseEvidence;
  preclockSchedulerProbe: SchedulerHttpEvidence;
  schedulerFirings: SchedulerHttpEvidence[];
  soak: {
    startedAt: string;
    endedAt: string;
    supervisedRunner: SupervisedRunnerEvidence;
    workerUptime: WorkerUptimeInterval[];
    crashLoopEvents: string[];
    endpointEvictionEvents: string[];
  };
  windows: LiveDrainWindowObservation[];
  sources: LiveEvidenceSources;
  capturedAt: string;
}

export interface LiveEvidenceAdapter {
  collect(request: LiveEvidenceRequest): Promise<LiveEvidenceBundle>;
}

export interface LiveEvidenceExecutionEnv {
  ARKOVA_LIVE_EVIDENCE_EXECUTION?: string;
  ARKOVA_LIVE_EVIDENCE_SOAK_ID?: string;
}

export interface LiveEvidenceSummary {
  mode: 'validated';
  rigId: 'RIG-B1';
  projectRef: string;
  soakId: string;
  headSha: string;
  imageDigest: string;
  schedulerFirings: number;
  workerUptimeMs: number;
  requiredUptimeMs: number;
  windows: DrainWindowEvidenceSummary[];
  sourceIds: string[];
}

export type LiveEvidenceExecutionResult = LiveEvidenceSummary | {
  mode: 'disabled';
  reason: 'live evidence execution was not explicitly enabled';
};

interface LiveEvidenceEnvelope {
  request: LiveEvidenceRequest;
  bundle: LiveEvidenceBundle;
}

const HEAD_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const PROJECT_REF = /^[a-z]{20}$/;
const JOB_PATH = /^\/jobs\/[a-z0-9-]+(?:\?[A-Za-z0-9_=&%-]+)?$/;

function requireId(value: string, name: string): void {
  if (!value?.trim()) throw new Error(`${name} is required.`);
}

function timestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid timestamp.`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelope(raw: string): LiveEvidenceEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Live evidence file must contain valid JSON.');
  }
  if (!isRecord(parsed) || !isRecord(parsed.request) || !isRecord(parsed.bundle)) {
    throw new Error('Live evidence file must contain request and bundle objects.');
  }
  return parsed as unknown as LiveEvidenceEnvelope;
}

function expectedPath(trigger: DrainTrigger): string {
  return trigger === 'org-scheduler'
    ? '/jobs/org-queue-scheduler'
    : '/jobs/batch-anchors?force=true';
}

function assertIdentity(request: LiveEvidenceRequest, actual: LiveRigIdentity): void {
  if (request.rigId !== 'RIG-B1') throw new Error('This acceptance consumer is hard-bound to RIG-B1.');
  if (!PROJECT_REF.test(request.projectRef)) throw new Error('projectRef must be a 20-lowercase-letter Supabase ref.');
  if (!HEAD_SHA.test(request.headSha) || !IMAGE_DIGEST.test(request.imageDigest)) {
    throw new Error('Request requires an exact lowercase head SHA and sha256 image digest.');
  }
  const fields: Array<keyof LiveRigIdentity> = [
    'rigId', 'projectRef', 'soakId', 'headSha', 'imageDigest',
    'workerService', 'workerRevision', 'region',
  ];
  for (const field of fields) {
    if (actual[field] !== request[field]) throw new Error(`Captured rig identity mismatches requested ${field}.`);
  }
}

function assertSchedulerEvidence(
  request: LiveEvidenceRequest,
  evidence: SchedulerHttpEvidence,
  expectedTrigger?: DrainTrigger,
): void {
  requireId(evidence.schedulerExecutionId, 'schedulerExecutionId');
  if (
    evidence.source !== 'cloud-scheduler'
    || evidence.projectRef !== request.projectRef
    || evidence.soakId !== request.soakId
    || evidence.statusCode !== 200
    || !JOB_PATH.test(evidence.path)
  ) {
    throw new Error('Scheduler evidence must be a correlated Cloud-Scheduler /jobs/* HTTP 200.');
  }
  if (expectedTrigger && (evidence.trigger !== expectedTrigger || evidence.path !== expectedPath(expectedTrigger))) {
    throw new Error('Scheduler evidence path does not match the armed trigger.');
  }
  const firedAt = timestamp(evidence.firedAt, 'Scheduler firedAt');
  const completedAt = timestamp(evidence.completedAt, 'Scheduler completedAt');
  if (completedAt < firedAt) throw new Error('Scheduler HTTP completion predates its firing.');
}

function assertPreflight(request: LiveEvidenceRequest, bundle: LiveEvidenceBundle): { startMs: number; endMs: number } {
  const startMs = timestamp(bundle.soak.startedAt, 'soak.startedAt');
  const endMs = timestamp(bundle.soak.endedAt, 'soak.endedAt');
  if (endMs <= startMs) throw new Error('Soak end must follow soak start.');
  const cleanMirrorMs = timestamp(bundle.cleanMirror.observedAt, 'clean_mirror observedAt');
  if (
    bundle.cleanMirror.attestationId !== request.cleanMirrorAttestationId
    || bundle.cleanMirror.result !== 'pass'
    || bundle.cleanMirror.projectRef !== request.projectRef
    || bundle.cleanMirror.headSha !== request.headSha
    || cleanMirrorMs > startMs
  ) {
    throw new Error('clean_mirror attestation is missing, late, or unrelated to the exact rig/head.');
  }

  const acquiredMs = timestamp(bundle.lease.acquiredAt, 'lease.acquiredAt');
  const expiresMs = timestamp(bundle.lease.expiresAt, 'lease.expiresAt');
  if (
    bundle.lease.leaseId !== request.leaseId
    || bundle.lease.rigId !== request.rigId
    || bundle.lease.projectRef !== request.projectRef
    || bundle.lease.soakId !== request.soakId
    || bundle.lease.state !== 'active'
    || !bundle.lease.holder?.trim()
    || acquiredMs > cleanMirrorMs
    || expiresMs < endMs
  ) {
    throw new Error('Rig lease does not exclusively cover clean_mirror through soak completion.');
  }

  assertSchedulerEvidence(request, bundle.preclockSchedulerProbe);
  if (timestamp(bundle.preclockSchedulerProbe.completedAt, 'pre-clock Scheduler completion') > startMs) {
    throw new Error('A Scheduler-fired /jobs/* 200 must be observed before the soak clock starts.');
  }
  return { startMs, endMs };
}

function assertSoakV2(
  request: LiveEvidenceRequest,
  bundle: LiveEvidenceBundle,
  startMs: number,
  endMs: number,
): { workerUptimeMs: number; requiredUptimeMs: number } {
  if (!Number.isInteger(request.requiredFloorMinutes) || request.requiredFloorMinutes <= 0) {
    throw new Error('requiredFloorMinutes must be a positive integer.');
  }
  const runner = bundle.soak.supervisedRunner;
  requireId(runner.runnerId, 'supervised runnerId');
  requireId(runner.supervisor, 'supervisor');
  if (
    runner.mode !== 'log-and-continue'
    || timestamp(runner.startedAt, 'runner.startedAt') > startMs
    || timestamp(runner.stoppedAt, 'runner.stoppedAt') < endMs
    || runner.heartbeatAt.length < 2
    || runner.runnerDeathEvents.length !== 0
  ) {
    throw new Error('Soak v2 requires a live supervised log-and-continue runner with heartbeats and no death.');
  }
  for (const heartbeat of runner.heartbeatAt) {
    const heartbeatMs = timestamp(heartbeat, 'runner heartbeat');
    if (heartbeatMs < startMs || heartbeatMs > endMs) throw new Error('Runner heartbeat is outside the soak window.');
  }
  if (bundle.soak.crashLoopEvents.length !== 0 || bundle.soak.endpointEvictionEvents.length !== 0) {
    throw new Error('Crash-loop or endpoint eviction voids the soak clock.');
  }

  const intervals = [...bundle.soak.workerUptime].sort((left, right) => (
    timestamp(left.startedAt, 'worker uptime start') - timestamp(right.startedAt, 'worker uptime start')
  ));
  if (intervals.length === 0) throw new Error('Cloud Run worker uptime evidence is required.');
  let workerUptimeMs = 0;
  let previousEnd = -Infinity;
  for (const interval of intervals) {
    if (
      interval.source !== 'cloud-run-audit-log'
      || interval.headSha !== request.headSha
      || interval.imageDigest !== request.imageDigest
      || !interval.workerId?.trim()
      || interval.logEntryIds.length === 0
      || interval.logEntryIds.some((id) => !id.trim())
    ) {
      throw new Error('Worker uptime must be exact-head/image Cloud Run audit evidence.');
    }
    const intervalStart = timestamp(interval.startedAt, 'worker uptime startedAt');
    const intervalEnd = timestamp(interval.endedAt, 'worker uptime endedAt');
    if (intervalStart < startMs || intervalEnd > endMs || intervalEnd < intervalStart || intervalStart < previousEnd) {
      throw new Error('Worker uptime intervals must be non-overlapping and contained by the soak window.');
    }
    const derivedUptime = intervalEnd - intervalStart;
    if (interval.uptimeMs !== derivedUptime) throw new Error('Worker uptime does not match its audit timestamps.');
    workerUptimeMs += interval.uptimeMs;
    previousEnd = intervalEnd;
  }
  const requiredUptimeMs = (request.requiredFloorMinutes + 30) * 60_000;
  if (workerUptimeMs < requiredUptimeMs) {
    throw new Error('Soak v2 worker-uptime clock did not overshoot its floor by at least 30 minutes.');
  }
  return { workerUptimeMs, requiredUptimeMs };
}

function assertSources(sources: LiveEvidenceSources): string[] {
  const sourceIds = [
    sources.schedulerExportId,
    sources.databaseQueryExportId,
    sources.signetNodeExportId,
    sources.cloudRunAuditExportId,
    sources.supervisorLogExportId,
  ];
  if (sourceIds.some((value) => !value?.trim()) || new Set(sourceIds).size !== sourceIds.length) {
    throw new Error('Scheduler, DB, signet, Cloud Run, and supervisor evidence require distinct source IDs.');
  }
  return sourceIds;
}

export function assertLiveEvidenceBundle(
  request: LiveEvidenceRequest,
  bundle: LiveEvidenceBundle,
): LiveEvidenceSummary {
  assertIdentity(request, bundle.identity);
  const { startMs, endMs } = assertPreflight(request, bundle);
  const soak = assertSoakV2(request, bundle, startMs, endMs);
  const sourceIds = assertSources(bundle.sources);
  if (timestamp(bundle.capturedAt, 'capturedAt') < endMs) throw new Error('Evidence bundle was captured before soak completion.');
  if (request.windows.length === 0 || bundle.windows.length !== request.windows.length) {
    throw new Error('Evidence bundle must cover exactly every requested drain window.');
  }

  const actualWindows = new Map(bundle.windows.map((window) => [window.scenarioId, window]));
  if (actualWindows.size !== bundle.windows.length) throw new Error('Duplicate drain-window scenario ID in evidence.');
  const windowSummaries = request.windows.map((window) => {
    const actual = actualWindows.get(window.scenarioId);
    if (!actual) throw new Error(`Missing live drain-window evidence for ${window.scenarioId}.`);
    return assertDrainWindowObservation(window, actual.observations);
  });

  const schedulerByExecution = new Map(bundle.schedulerFirings.map((firing) => [firing.schedulerExecutionId, firing]));
  if (schedulerByExecution.size !== bundle.schedulerFirings.length) throw new Error('Duplicate Scheduler firing execution ID.');
  const observedPassByExecution = new Map(bundle.windows.flatMap((window) => (
    window.observations.map((observation) => [observation.execution.schedulerExecutionId, observation] as const)
  )));
  const expectedExecutions = request.windows.flatMap((window) => window.passes.map((pass) => ({
    executionId: pass.schedulerExecutionId,
    trigger: pass.armedTrigger,
  })));
  if (bundle.schedulerFirings.length !== expectedExecutions.length) {
    throw new Error('Scheduler evidence must cover exactly every observed drain pass.');
  }
  for (const expected of expectedExecutions) {
    const firing = schedulerByExecution.get(expected.executionId);
    const observedPass = observedPassByExecution.get(expected.executionId);
    if (!firing) throw new Error(`Missing Scheduler HTTP evidence for ${expected.executionId}.`);
    if (!observedPass) throw new Error(`Missing DB/chain pass evidence for ${expected.executionId}.`);
    assertSchedulerEvidence(request, firing, expected.trigger);
    if (timestamp(firing.firedAt, 'Scheduler firedAt') < startMs || timestamp(firing.completedAt, 'Scheduler completedAt') > endMs) {
      throw new Error('Drain Scheduler firing is outside the named soak window.');
    }
    if (
      timestamp(firing.firedAt, 'Scheduler firedAt') > timestamp(observedPass.execution.startedAt, 'pass execution startedAt')
      || timestamp(firing.completedAt, 'Scheduler completedAt') < timestamp(observedPass.execution.completedAt, 'pass execution completedAt')
    ) {
      throw new Error('Scheduler HTTP evidence does not enclose the correlated DB/chain pass execution.');
    }
  }

  return {
    mode: 'validated',
    rigId: 'RIG-B1',
    projectRef: request.projectRef,
    soakId: request.soakId,
    headSha: request.headSha,
    imageDigest: request.imageDigest,
    schedulerFirings: bundle.schedulerFirings.length,
    workerUptimeMs: soak.workerUptimeMs,
    requiredUptimeMs: soak.requiredUptimeMs,
    windows: windowSummaries,
    sourceIds,
  };
}

export async function executeLiveEvidenceConsumer(
  request: LiveEvidenceRequest,
  adapter: LiveEvidenceAdapter,
  env: LiveEvidenceExecutionEnv,
): Promise<LiveEvidenceExecutionResult> {
  if (
    env.ARKOVA_LIVE_EVIDENCE_EXECUTION !== LIVE_EVIDENCE_ENABLE_VALUE
    || env.ARKOVA_LIVE_EVIDENCE_SOAK_ID !== request.soakId
  ) {
    return { mode: 'disabled', reason: 'live evidence execution was not explicitly enabled' };
  }
  const bundle = await adapter.collect(request);
  return assertLiveEvidenceBundle(request, bundle);
}

/** Concrete local-capture adapter. It reads no secrets and performs no live calls. */
export class JsonFileLiveEvidenceAdapter implements LiveEvidenceAdapter {
  constructor(private readonly evidenceFile: string) {}

  async collect(): Promise<LiveEvidenceBundle> {
    const envelope = parseEnvelope(await readFile(this.evidenceFile, 'utf8'));
    return envelope.bundle;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'evidence-file': { type: 'string' } } });
  const evidenceFile = values['evidence-file']?.trim();
  if (!evidenceFile) throw new Error('--evidence-file is required.');
  const envelope = parseEnvelope(await readFile(evidenceFile, 'utf8'));
  const result = await executeLiveEvidenceConsumer(
    envelope.request,
    new JsonFileLiveEvidenceAdapter(evidenceFile),
    process.env,
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.mode !== 'validated') process.exitCode = 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`batch-drain-live-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
