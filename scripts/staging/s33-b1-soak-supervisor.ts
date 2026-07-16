/**
 * Foreground, fail-closed supervisor for the counted RIG-B1 Soak-v2 clock.
 *
 * The counted start CLI must await this driver. There is no detached process
 * and no success return until the complete wall, worker-uptime, heartbeat, raw
 * capture, and post-run declaration-finalization contract has passed.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  MAX_HEARTBEAT_GAP_MINUTES,
  assertRunDeclarationInvariants,
  runDeclarationSchema,
  validateUnsignedLiveEvidenceForSigning,
  type RawCaptureTextSet,
  type RawCaptureDigests,
  type RunDeclaration,
} from './batch-drain-live-evidence';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import {
  B1_SCHEDULER_START_CONTRACT,
  type B1SchedulerJobObservation,
  type B1SchedulerStartReceipt,
} from './s33-b1-scheduler-start-driver';

export const B1_SUPERVISOR_HEARTBEAT_INTERVAL_MINUTES = 4;
const MINUTE_MS = 60_000;
const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);
const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const projectRef = z.string().regex(/^[a-z]{20}$/u);

const receiptJobSchema = z.object({
  name: z.string().min(1),
  resourceName: z.string().min(1),
  state: z.literal('ENABLED'),
  path: z.string().min(1),
  uri: z.string().url(),
  schedule: z.literal(B1_SCHEDULER_START_CONTRACT.cadence),
  timeZone: z.string().min(1),
  attemptDeadline: z.string().min(1),
  retry: z.object({
    minBackoff: z.string().min(1),
    maxBackoff: z.string().min(1),
    maxDoublings: z.number().int().nonnegative(),
  }).strict(),
  httpMethod: z.literal('POST'),
  oidcServiceAccountEmail: z.literal(B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount),
  oidcAudience: z.string().url(),
  cronHeaderPresent: z.literal(true),
  cronHeaderSha256: sha256,
  observedAt: timestamp,
}).passthrough();

const admissionSchema = z.object({
  generated_at: timestamp,
  base_sha: gitSha,
  sha: gitSha,
  image_digest: sha256,
  deployed_revision: z.string().min(1),
  tag_url: z.string().url(),
  gcp_project_id: z.literal(B1_SCHEDULER_START_CONTRACT.gcpProjectId),
  region: z.literal(B1_SCHEDULER_START_CONTRACT.gcpRegion),
  supabase_project_ref: projectRef,
  cloud_run_service: z.literal(B1_SCHEDULER_START_CONTRACT.workerService),
  soak_id: boundedId,
  lease_id: boundedId,
  owner: z.string().min(1),
  clean_mirror_attestation_id: sha256,
  clean_mirror: z.object({ verified_at: timestamp }).passthrough(),
  required_uptime_min: z.literal(B1_SCHEDULER_START_CONTRACT.requiredWorkerUptimeMin),
  required_wall_min: z.number().int().min(B1_SCHEDULER_START_CONTRACT.requiredWallMin),
  infrastructure: z.unknown(),
}).passthrough();

const receiptSchema = z.object({
  schemaVersion: z.literal(B1_SCHEDULER_START_CONTRACT.schemaVersion),
  status: z.literal('COUNTED_START'),
  activationId: boundedId,
  authority: z.object({
    actionExpiresAt: timestamp,
    runHardStopAt: timestamp,
  }).passthrough(),
  candidate: z.object({ sourceHeadSha: gitSha, workerImageDigest: sha256 }).passthrough(),
  run: z.object({
    rigId: z.literal(B1_SCHEDULER_START_CONTRACT.rigId),
    rigName: z.literal(B1_SCHEDULER_START_CONTRACT.rigName),
    soakId: boundedId,
    leaseId: boundedId,
    requiredWorkerUptimeMin: z.literal(B1_SCHEDULER_START_CONTRACT.requiredWorkerUptimeMin),
    requiredWallMin: z.number().int().min(B1_SCHEDULER_START_CONTRACT.requiredWallMin),
    startedAt: timestamp,
  }).passthrough(),
  evidence: z.object({ admissionSha256: sha256 }).passthrough(),
  scheduler: z.object({
    projectId: z.literal(B1_SCHEDULER_START_CONTRACT.gcpProjectId),
    location: z.literal(B1_SCHEDULER_START_CONTRACT.gcpRegion),
    serviceUrl: z.string().url(),
    cadence: z.literal(B1_SCHEDULER_START_CONTRACT.cadence),
    jobs: z.array(receiptJobSchema).length(6),
  }).passthrough(),
}).passthrough();

export interface B1SupervisorContext {
  readonly admissionRaw: string;
  readonly provisionApprovalArtifactPath: string;
  readonly receipt: B1SchedulerStartReceipt;
}

export interface B1SupervisorHeartbeatObservation {
  readonly observedAt: string;
  readonly workerId: string;
  readonly workerRevision: string;
  readonly sourceHeadSha: string;
  readonly imageDigest: string;
  readonly runtimeServiceAccount: string;
  readonly serviceUrl: string;
  readonly healthStatusCode: 200;
  readonly healthStatus: 'healthy';
  readonly healthGitSha: string;
  readonly schedulerJobs: readonly B1SchedulerJobObservation[];
}

export interface B1SupervisorJournalRecord {
  readonly recordId: string;
  readonly event: 'started' | 'heartbeat' | 'stopped';
  readonly occurredAt: string;
  readonly activationId: string;
  readonly admissionSha256: string;
  readonly receiptSha256: string;
  readonly soakId: string;
  readonly leaseId: string;
  readonly sourceHeadSha: string;
  readonly imageDigest: string;
  readonly workerRevision: string;
  readonly workerId: string;
  readonly cloudRunStatusCode: 200;
}

export interface B1FinalizedSoakEvidence {
  readonly declaration: RunDeclaration;
  readonly declarationSha256: string;
  readonly raw: RawCaptureTextSet;
  readonly rawCaptureDigests: RawCaptureDigests;
}

type B1ScenarioOutcome =
  | Readonly<{ status: 'fulfilled'; value: unknown }>
  | Readonly<{ status: 'rejected'; error: unknown }>;

export interface B1SoakSupervisorPort {
  now(): Date;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  createJournal(context: Readonly<{
    admissionSha256: string;
    receiptSha256: string;
    soakId: string;
  }>): Promise<void>;
  appendJournal(record: B1SupervisorJournalRecord): Promise<void>;
  observeHeartbeat(): Promise<B1SupervisorHeartbeatObservation>;
  renewInvocationLease(input: Readonly<{
    activationId: string;
    expiresAt: string;
    runHardStopAt: string;
    heartbeatObservedAt: string;
  }>): Promise<void>;
  removeInvocationLease(activationId: string): Promise<void>;
  executeLiveScenarios(input: Readonly<{
    admissionRaw: string;
    receipt: B1SchedulerStartReceipt;
    signal: AbortSignal;
  }>): Promise<unknown>;
  abortAndAwaitLiveScenarios(input: Readonly<{
    reason: unknown;
    runHardStopAt: string;
  }>): Promise<void>;
  assertGenuineScenarioMaterial(input: Readonly<{
    material: unknown;
    admissionSha256: string;
    receiptSha256: string;
    sourceHeadSha: string;
    imageDigest: string;
    soakId: string;
    leaseId: string;
  }>): void;
  finalizeEvidence(input: Readonly<{
    admissionRaw: string;
    receipt: B1SchedulerStartReceipt;
    heartbeats: readonly B1SupervisorHeartbeatObservation[];
    soakStartedAt: string;
    soakEndedAt: string;
    scenarioMaterial: unknown;
  }>): Promise<B1FinalizedSoakEvidence>;
  pauseAndVerifyAllSix(serviceUrl: string): Promise<void>;
  canonicalTeardown(context: B1SupervisorContext): Promise<void>;
}

function digest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function assertNotExternallyAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('RIG-B1 foreground supervisor received an external termination signal.');
}

function exactJobName(suffix: string): string {
  return `${B1_SCHEDULER_START_CONTRACT.workerService}-${suffix}`;
}

function assertExactEnabledJobs(
  jobs: readonly B1SchedulerJobObservation[],
  serviceUrl: string,
  receiptJobs: readonly z.infer<typeof receiptJobSchema>[],
): void {
  if (jobs.length !== B1_SCHEDULER_START_CONTRACT.jobs.length) {
    throw new Error('RIG-B1 supervisor did not observe all six Scheduler jobs.');
  }
  B1_SCHEDULER_START_CONTRACT.jobs.forEach((spec, index) => {
    const observed = jobs[index];
    const started = receiptJobs[index];
    const expectedName = exactJobName(spec.suffix);
    if (observed === undefined
      || observed.name !== expectedName
      || observed.resourceName !== `projects/${B1_SCHEDULER_START_CONTRACT.gcpProjectId}/locations/${B1_SCHEDULER_START_CONTRACT.gcpRegion}/jobs/${expectedName}`
      || observed.state !== 'ENABLED'
      || observed.path !== spec.path
      || observed.uri !== `${serviceUrl}${spec.path}`
      || observed.schedule !== B1_SCHEDULER_START_CONTRACT.cadence
      || observed.timeZone !== spec.timeZone
      || observed.attemptDeadline !== spec.attemptDeadline
      || observed.retry.minBackoff !== B1_SCHEDULER_START_CONTRACT.retry.minBackoff
      || observed.retry.maxBackoff !== B1_SCHEDULER_START_CONTRACT.retry.maxBackoff
      || observed.retry.maxDoublings !== B1_SCHEDULER_START_CONTRACT.retry.maxDoublings
      || observed.httpMethod !== 'POST'
      || observed.oidcServiceAccountEmail !== B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount
      || observed.oidcAudience !== serviceUrl
      || observed.cronHeaderPresent !== true
      || started === undefined
      || observed.cronHeaderSha256 !== started.cronHeaderSha256) {
      throw new Error(`RIG-B1 supervisor Scheduler drift for ${expectedName}.`);
    }
  });
}

function assertHeartbeat(
  value: B1SupervisorHeartbeatObservation,
  expected: Readonly<{
    revision: string;
    sourceHeadSha: string;
    imageDigest: string;
    serviceUrl: string;
    receiptJobs: readonly z.infer<typeof receiptJobSchema>[];
  }>,
): number {
  const observedAt = Date.parse(value.observedAt);
  if (!Number.isFinite(observedAt)
    || value.workerId !== expected.revision
    || value.workerRevision !== expected.revision
    || value.sourceHeadSha !== expected.sourceHeadSha
    || value.healthGitSha !== expected.sourceHeadSha
    || value.imageDigest !== expected.imageDigest
    || value.runtimeServiceAccount !== B1_SCHEDULER_START_CONTRACT.workerRuntimeServiceAccount
    || value.serviceUrl !== expected.serviceUrl
    || value.healthStatusCode !== 200
    || value.healthStatus !== 'healthy') {
    throw new Error('RIG-B1 supervisor observed Cloud Run revision, image, identity, or authenticated health drift.');
  }
  assertExactEnabledJobs(value.schedulerJobs, expected.serviceUrl, expected.receiptJobs);
  return observedAt;
}

async function pauseRemoveAndTeardown(
  context: B1SupervisorContext,
  serviceUrl: string,
  activationId: string,
  port: B1SoakSupervisorPort,
): Promise<void> {
  const failures: Error[] = [];
  try { await port.pauseAndVerifyAllSix(serviceUrl); } catch (error) {
    failures.push(new Error(`RIG-B1 PAUSED containment failed: ${error instanceof Error ? error.message : 'unknown error'}`));
  }
  try { await port.removeInvocationLease(activationId); } catch (error) {
    failures.push(new Error(`RIG-B1 Run Invoker removal failed: ${error instanceof Error ? error.message : 'unknown error'}`));
  }
  try { await port.canonicalTeardown(context); } catch (error) {
    failures.push(new Error(`RIG-B1 canonical teardown failed: ${error instanceof Error ? error.message : 'unknown error'}`));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'RIG-B1 pause/remove/teardown was incomplete.');
  }
}

async function containAndTeardown(
  original: unknown,
  context: B1SupervisorContext,
  serviceUrl: string,
  activationId: string,
  port: B1SoakSupervisorPort,
): Promise<never> {
  const primary = original instanceof Error ? original : new Error('RIG-B1 foreground supervisor failed.');
  try {
    await pauseRemoveAndTeardown(context, serviceUrl, activationId, port);
  } catch (cleanupError) {
    const cleanupFailures = cleanupError instanceof AggregateError
      ? cleanupError.errors
      : [cleanupError];
    throw new AggregateError(
      [primary, ...cleanupFailures],
      `${primary.message}; containment/teardown also failed.`,
    );
  }
  throw primary;
}

function journalRecord(
  event: B1SupervisorJournalRecord['event'],
  occurredAt: string,
  ordinal: number,
  admissionSha256: string,
  receiptSha256: string,
  receipt: z.infer<typeof receiptSchema>,
  observation: B1SupervisorHeartbeatObservation,
): B1SupervisorJournalRecord {
  return {
    recordId: `${receipt.run.soakId}-${event}-${ordinal}`,
    event,
    occurredAt,
    activationId: receipt.activationId,
    admissionSha256,
    receiptSha256,
    soakId: receipt.run.soakId,
    leaseId: receipt.run.leaseId,
    sourceHeadSha: receipt.candidate.sourceHeadSha,
    imageDigest: receipt.candidate.workerImageDigest,
    workerRevision: observation.workerRevision,
    workerId: observation.workerId,
    cloudRunStatusCode: 200,
  };
}

export async function runS33B1SoakSupervisor(
  context: B1SupervisorContext,
  port: B1SoakSupervisorPort,
  externalSignal: AbortSignal = new AbortController().signal,
): Promise<Readonly<{
  status: 'RIG_B1_SOAK_COMPLETED';
  workerUptimeMin: number;
  wallMin: number;
  evidence: B1FinalizedSoakEvidence;
}>> {
  const admission = admissionSchema.parse(
    parseJsonRejectingDuplicateKeys(context.admissionRaw, 'RIG-B1 supervisor admission'),
  );
  const receiptRaw = JSON.stringify(context.receipt);
  const receipt = receiptSchema.parse(context.receipt);
  const admissionSha256 = digest(context.admissionRaw);
  const receiptSha256 = digest(receiptRaw);
  const activationStartedAtMs = Date.parse(receipt.run.startedAt);
  const runHardStopMs = Date.parse(receipt.authority.runHardStopAt);
  const expected = {
    revision: admission.deployed_revision,
    sourceHeadSha: admission.sha,
    imageDigest: admission.image_digest,
    serviceUrl: admission.tag_url,
    receiptJobs: receipt.scheduler.jobs,
  };
  const heartbeats: B1SupervisorHeartbeatObservation[] = [];
  let previousHeartbeatMs: number | undefined;
  let soakStartedAtMs: number | undefined;
  let wallEndMs: number | undefined;
  let ordinal = 0;
  let scenarioOutcome: B1ScenarioOutcome | undefined;
  let scenarioPromise: Promise<void> | undefined;
  const scenarioAbortController = new AbortController();
  let completed: Readonly<{
    status: 'RIG_B1_SOAK_COMPLETED';
    workerUptimeMin: number;
    wallMin: number;
    evidence: B1FinalizedSoakEvidence;
  }> | undefined;

  try {
    assertNotExternallyAborted(externalSignal);
    if (receipt.evidence.admissionSha256 !== admissionSha256
      || receipt.run.soakId !== admission.soak_id
      || receipt.run.leaseId !== admission.lease_id
      || receipt.candidate.sourceHeadSha !== admission.sha
      || receipt.candidate.workerImageDigest !== admission.image_digest
      || receipt.scheduler.serviceUrl !== admission.tag_url) {
      throw new Error('RIG-B1 supervisor admission and Locked start receipt are contradictory.');
    }
    if (!Number.isFinite(activationStartedAtMs)
      || !Number.isFinite(runHardStopMs)
      || activationStartedAtMs >= runHardStopMs) {
      throw new Error('RIG-B1 activation receipt has an invalid signed run hard stop.');
    }
    await port.createJournal({ admissionSha256, receiptSha256, soakId: receipt.run.soakId });
    assertNotExternallyAborted(externalSignal);
    while (true) {
      assertNotExternallyAborted(externalSignal);
      const now = port.now().getTime();
      if (!Number.isFinite(now) || now >= runHardStopMs) {
        throw new Error('RIG-B1 supervisor clock is invalid or the signed run hard stop was reached.');
      }
      const observation = await port.observeHeartbeat();
      assertNotExternallyAborted(externalSignal);
      const heartbeatMs = assertHeartbeat(observation, expected);
      if (heartbeatMs >= runHardStopMs) {
        throw new Error('RIG-B1 authenticated heartbeat reached or exceeded the signed run hard stop.');
      }
      if (soakStartedAtMs === undefined) {
        if (heartbeatMs < activationStartedAtMs
          || heartbeatMs - activationStartedAtMs > MAX_HEARTBEAT_GAP_MINUTES * MINUTE_MS) {
          throw new Error('RIG-B1 first authenticated heartbeat is outside the five-minute activation boundary.');
        }
        soakStartedAtMs = heartbeatMs;
        wallEndMs = soakStartedAtMs + receipt.run.requiredWallMin * MINUTE_MS;
        if (wallEndMs >= runHardStopMs) {
          throw new Error('RIG-B1 signed run hard stop cannot cover the full counted wall from first heartbeat.');
        }
      }
      if (heartbeatMs > wallEndMs! + MAX_HEARTBEAT_GAP_MINUTES * MINUTE_MS) {
        throw new Error('RIG-B1 final authenticated heartbeat exceeded the five-minute wall boundary.');
      }
      if (previousHeartbeatMs !== undefined && heartbeatMs <= previousHeartbeatMs) {
        throw new Error('RIG-B1 supervisor heartbeat timestamps are not strictly increasing.');
      }
      if (previousHeartbeatMs !== undefined
        && heartbeatMs - previousHeartbeatMs > MAX_HEARTBEAT_GAP_MINUTES * MINUTE_MS) {
        throw new Error('RIG-B1 supervisor heartbeat gap exceeds five minutes.');
      }
      heartbeats.push(observation);
      const wallSatisfied = heartbeatMs >= wallEndMs!;
      const scenarioSatisfied = scenarioOutcome?.status === 'fulfilled';
      const event = ordinal === 0
        ? 'started'
        : wallSatisfied && scenarioSatisfied ? 'stopped' : 'heartbeat';
      await port.appendJournal(journalRecord(
        event,
        observation.observedAt,
        ordinal,
        admissionSha256,
        receiptSha256,
        receipt,
        observation,
      ));
      const invocationExpiresAt = new Date(Math.min(
        heartbeatMs + 10 * MINUTE_MS,
        runHardStopMs,
      )).toISOString();
      await port.renewInvocationLease({
        activationId: receipt.activationId,
        expiresAt: invocationExpiresAt,
        runHardStopAt: receipt.authority.runHardStopAt,
        heartbeatObservedAt: observation.observedAt,
      });
      assertNotExternallyAborted(externalSignal);
      ordinal += 1;
      previousHeartbeatMs = heartbeatMs;
      if (scenarioPromise === undefined) {
        scenarioPromise = port.executeLiveScenarios({
          admissionRaw: context.admissionRaw,
          receipt: context.receipt,
          signal: scenarioAbortController.signal,
        }).then((value) => {
          scenarioOutcome = Object.freeze({ status: 'fulfilled', value });
        }, (error: unknown) => {
          scenarioOutcome = Object.freeze({ status: 'rejected', error });
        });
      }
      if (scenarioOutcome?.status === 'rejected') throw scenarioOutcome.error;
      if (wallSatisfied && scenarioOutcome?.status === 'fulfilled') {
        break;
      }
      const currentTime = port.now().getTime();
      const nextBoundary = wallSatisfied ? runHardStopMs : wallEndMs!;
      const remaining = nextBoundary - currentTime;
      if (remaining <= 0) continue;
      await port.sleep(
        Math.min(B1_SUPERVISOR_HEARTBEAT_INTERVAL_MINUTES * MINUTE_MS, remaining),
        externalSignal,
      );
      assertNotExternallyAborted(externalSignal);
    }

    await Promise.resolve();
    assertNotExternallyAborted(externalSignal);
    if (scenarioPromise === undefined) {
      throw new Error('RIG-B1 genuine live scenarios did not complete within the counted wall.');
    }
    await scenarioPromise;
    const settledScenario = scenarioOutcome as B1ScenarioOutcome | undefined;
    if (settledScenario === undefined) {
      throw new Error('RIG-B1 genuine live scenarios produced no completion material.');
    }
    if (settledScenario.status === 'rejected') throw settledScenario.error;
    port.assertGenuineScenarioMaterial({
      material: settledScenario.value,
      admissionSha256,
      receiptSha256,
      sourceHeadSha: receipt.candidate.sourceHeadSha,
      imageDigest: receipt.candidate.workerImageDigest,
      soakId: receipt.run.soakId,
      leaseId: receipt.run.leaseId,
    });
    const workerUptimeMs = previousHeartbeatMs! - soakStartedAtMs!;
    if (workerUptimeMs < receipt.run.requiredWorkerUptimeMin * MINUTE_MS
      || previousHeartbeatMs! - wallEndMs! > MAX_HEARTBEAT_GAP_MINUTES * MINUTE_MS) {
      throw new Error('RIG-B1 foreground supervisor did not prove 2,880 worker-up minutes.');
    }
    const soakEndedAt = heartbeats.at(-1)!.observedAt;
    const evidence = await port.finalizeEvidence({
      admissionRaw: context.admissionRaw,
      receipt: context.receipt,
      heartbeats,
      soakStartedAt: new Date(soakStartedAtMs!).toISOString(),
      soakEndedAt,
      scenarioMaterial: settledScenario.value,
    });
    assertNotExternallyAborted(externalSignal);
    const declaration = runDeclarationSchema.parse(evidence.declaration);
    assertRunDeclarationInvariants(declaration);
    if (declaration.soakStartedAt !== new Date(soakStartedAtMs!).toISOString()
      || declaration.soakEndedAt !== soakEndedAt) {
      throw new Error('RIG-B1 finalized declaration does not use the actual authenticated soak boundaries.');
    }
    const validated = validateUnsignedLiveEvidenceForSigning(declaration, evidence.raw);
    if (evidence.declarationSha256 !== validated.declarationSha256
      || JSON.stringify(evidence.rawCaptureDigests) !== JSON.stringify(validated.rawCaptureDigests)) {
      throw new Error('RIG-B1 finalized six raw exports do not bind the exact post-run declaration bytes.');
    }
    completed = Object.freeze({
      status: 'RIG_B1_SOAK_COMPLETED',
      workerUptimeMin: workerUptimeMs / MINUTE_MS,
      wallMin: (Date.parse(soakEndedAt) - soakStartedAtMs!) / MINUTE_MS,
      evidence,
    });
  } catch (error) {
    let primaryError: unknown = error;
    if (scenarioPromise !== undefined) {
      scenarioAbortController.abort(error);
      try {
        await port.abortAndAwaitLiveScenarios({
          reason: error,
          runHardStopAt: receipt.authority.runHardStopAt,
        });
        await scenarioPromise;
      } catch (abortError) {
        primaryError = new AggregateError(
          [error, abortError],
          'RIG-B1 supervisor failed and live scenario cancellation was incomplete.',
        );
      }
    }
    return containAndTeardown(
      primaryError,
      context,
      receipt.scheduler.serviceUrl,
      receipt.activationId,
      port,
    );
  }
  if (completed === undefined) throw new Error('RIG-B1 supervisor reached an impossible incomplete state.');
  await pauseRemoveAndTeardown(
    context,
    receipt.scheduler.serviceUrl,
    receipt.activationId,
    port,
  );
  return completed;
}
