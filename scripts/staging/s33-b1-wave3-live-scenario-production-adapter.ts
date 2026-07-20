/** Production PostgREST adapter for the bounded S3.3 RIG-B1 live scenarios. */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { z } from 'zod';

import { resolveRigTarget } from './batch-drain-harness-lib';
import {
  CapturedFileRawSourceCollector,
  DEFAULT_EVIDENCE_CAPTURE_ROOT,
  runDeclarationSchema,
  type KnownSourceKind,
  type KnownSourceTransport,
  type RawCaptureFileArguments,
  type RawCaptureTextSet,
  type RunDeclaration,
} from './batch-drain-live-evidence';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import {
  type S33B1LiveExecutionObservation,
  type S33B1ScenarioCompletionObservation,
  type S33B1ScenarioControlObservation,
  type S33B1ScenarioLeaseObservation,
  type S33B1ScenarioSeedObservation,
  type S33B1Wave3LiveScenario,
  type S33B1Wave3LiveScenarioPlan,
  type S33B1Wave3LiveScenarioPort,
} from './s33-b1-wave3-live-scenario-executor';

const POLL_INTERVAL_MS = 1_000;
const MAX_RPC_BYTES = 64 * 1024 * 1024;
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const captureId = sha256;
const declarationSha256 = z.string().regex(/^[0-9a-f]{64}$/u);

const controlSchema = z.object({
  generation: z.number().int().nonnegative().safe(),
  activeLeaseId: z.string().uuid().nullable(),
  phase: z.string().nullable(),
  expiresAt: timestamp.nullable(),
}).strict();
const leaseSchema = z.object({
  captureId,
  scenarioLeaseId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  phase: z.enum(['PREPARING', 'ARMED', 'RUNNING', 'COMPLETED']),
  expiresAt: timestamp,
}).strict();
const seedSchema = z.object({
  captureId,
  scenarioLeaseId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  scenarioId: z.string().min(3).max(128),
  namespaceId: z.string().min(3).max(128),
  seedManifestSha256: sha256,
  pending: z.number().int().nonnegative().safe(),
  oldestPendingAgeSeconds: z.number().int().nonnegative().safe().nullable(),
  isolation: z.literal('repeatable-read'),
  observedAt: timestamp,
}).strict();
const completionSchema = z.object({
  captureId,
  scenarioLeaseId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  phase: z.enum(['PREPARING', 'COMPLETED']),
  expiresAt: timestamp.optional(),
}).strict();
const liveSchema = z.object({
  captureId,
  scenarioLeaseId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  scenarioId: z.string().min(3).max(128),
  namespaceId: z.string().min(3).max(128),
  faultWindowId: z.string().min(3).max(128),
  targetJobResource: z.string().min(3).max(512),
  schedulerJobResource: z.string().min(3).max(512),
  schedulerScheduleTime: timestamp,
  schedulerExecutionId: sha256,
  routePath: z.string().min(1).max(256),
  workerRevision: z.string().min(3).max(128),
  pendingBefore: z.number().int().nonnegative().safe(),
  drainedLeaves: z.number().int().nonnegative().safe(),
  pendingAfter: z.number().int().nonnegative().safe(),
  poisonPending: z.number().int().nonnegative().safe(),
  startedAt: timestamp,
  completedAt: timestamp,
  evidenceArtifactRaw: z.string().min(2).max(MAX_RPC_BYTES),
  evidenceArtifactSha256: sha256,
}).strict();
const executionArtifactSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.execution-capture/v1'),
  captureId,
  scenarioId: z.string().min(3).max(128),
  schedulerExecutionId: sha256,
  faultWindowId: z.string().min(3).max(128),
  declarationWindow: runDeclarationSchema.shape.windows.element,
  recoveries: z.array(runDeclarationSchema.shape.recoveries.element),
}).passthrough();
const abortSchema = z.object({
  captureId,
  scenarioLeaseId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  phase: z.literal('FAILED'),
}).strict();
const cleanupSchema = z.object({
  scenarioLeaseId: z.string().uuid(),
  preservedCaptureIds: z.array(captureId),
  deletedRows: z.number().int().nonnegative().safe(),
}).strict();

export type S33B1ScenarioRpcName =
  | 'get_s33_rig_b1_scenario_control'
  | 'acquire_s33_rig_b1_scenario_lease'
  | 'prepare_s33_rig_b1_scenario_seed'
  | 'arm_s33_rig_b1_scenario_lease'
  | 'observe_s33_rig_b1_scenario_outcome'
  | 'complete_s33_rig_b1_scenario_execution'
  | 'abort_s33_rig_b1_scenario_lease'
  | 'cleanup_s33_rig_b1_scenario_run';

export interface S33B1ScenarioRpcTransport {
  invoke(
    name: S33B1ScenarioRpcName,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface S33B1Wave3ScenarioProductionDependencies {
  readonly rpc: S33B1ScenarioRpcTransport;
  readonly now: () => Date;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface ActiveLeaseState {
  leaseId: string;
  generation: number;
  captureId: string;
  phase: 'PREPARING' | 'ARMED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
}

function exactNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('RIG-B1 scenario production adapter observed invalid current time.');
  }
  return value;
}

function abortError(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted.`);
}

function nodeWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return Promise.reject(new Error('RIG-B1 wait duration is invalid.'));
  }
  if (signal.aborted) return Promise.reject(abortError(signal, 'RIG-B1 wait'));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal, 'RIG-B1 wait'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class ProductionPostgrestTransport implements S33B1ScenarioRpcTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async invoke(
    name: S33B1ScenarioRpcName,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    // These two RPCs take row locks that can legitimately queue behind the
    // target Scheduler transaction. Their callers already bound the operation
    // with an AbortSignal deadline, so retry only transient gateway responses
    // until that deadline rather than converting brief lock contention into a
    // destructive soak failure.
    const lockBoundRpc = name === 'observe_s33_rig_b1_scenario_outcome'
      || name === 'abort_s33_rig_b1_scenario_lease';
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: {
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(args),
        redirect: 'error',
        signal,
      });
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RPC_BYTES) {
        throw new Error(`RIG-B1 ${name} response exceeds the bounded capture size.`);
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw, 'utf8') > MAX_RPC_BYTES) {
        throw new Error(`RIG-B1 ${name} response exceeds the bounded capture size.`);
      }
      if (response.ok) {
        if (raw.length === 0) return null;
        return parseJsonRejectingDuplicateKeys(raw, `RIG-B1 ${name} response`);
      }
      const retryableGateway = [502, 503, 504].includes(response.status);
      if (retryableGateway && (lockBoundRpc || attempt < 3)) {
        await nodeWait(1_000, signal);
        continue;
      }
      throw new Error(`RIG-B1 ${name} failed with HTTP ${response.status}.`);
    }
  }
}

class ProductionS33B1Wave3ScenarioPort implements S33B1Wave3LiveScenarioPort {
  private readonly inFlight = new Set<Promise<unknown>>();
  private active: ActiveLeaseState | null = null;

  constructor(private readonly dependencies: S33B1Wave3ScenarioProductionDependencies) {}

  now(): Date { return exactNow(this.dependencies.now); }

  wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    return this.dependencies.wait(milliseconds, signal);
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => { this.inFlight.delete(tracked); });
    this.inFlight.add(tracked);
    return tracked;
  }

  private invoke<T>(
    name: S33B1ScenarioRpcName,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return this.track(this.dependencies.rpc.invoke(name, args, signal).then((value) => schema.parse(value)));
  }

  observeControl(signal: AbortSignal): Promise<S33B1ScenarioControlObservation> {
    return this.invoke('get_s33_rig_b1_scenario_control', {}, signal, controlSchema);
  }

  async acquirePreparing(input: Readonly<{
    expectedGeneration: number;
    scenario: S33B1Wave3LiveScenario;
    plan: S33B1Wave3LiveScenarioPlan;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioLeaseObservation> {
    const observed = await this.invoke('acquire_s33_rig_b1_scenario_lease', {
      p_expected_generation: input.expectedGeneration,
      p_capture_id: input.scenario.captureId,
      p_plan_id: input.plan.planId,
      p_run_id: input.plan.runId,
      p_admission_sha256: input.plan.admissionSha256,
      p_receipt_sha256: input.plan.receiptSha256,
      p_git_head_sha: input.plan.gitHeadSha,
      p_image_digest: input.plan.imageDigest,
      p_approval_id: input.plan.startApprovalId,
      p_soak_id: input.plan.soakId,
      p_run_lease_id: input.plan.runLeaseId,
      p_scenario_id: input.scenario.scenarioId,
      p_namespace_id: input.scenario.namespaceId,
      p_fault_window_id: input.scenario.faultWindowId,
      p_target_job_resource: input.scenario.targetJobResource,
      p_service_audience: input.plan.serviceAudience,
      p_worker_revision: input.plan.workerRevision,
      p_authority_expires_at: input.plan.authorityExpiresAt,
      p_ttl_seconds: input.scenario.ttlSeconds,
    }, input.signal, leaseSchema);
    this.active = {
      leaseId: observed.scenarioLeaseId,
      generation: observed.generation,
      captureId: observed.captureId,
      phase: observed.phase,
    };
    return observed;
  }

  prepareSeed(input: Readonly<{
    scenarioLeaseId: string;
    generation: number;
    scenario: S33B1Wave3LiveScenario;
    plan: S33B1Wave3LiveScenarioPlan;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioSeedObservation> {
    return this.invoke('prepare_s33_rig_b1_scenario_seed', {
      p_scenario_lease_id: input.scenarioLeaseId,
      p_expected_generation: input.generation,
      p_capture_id: input.scenario.captureId,
      p_scenario_id: input.scenario.scenarioId,
      p_namespace_id: input.scenario.namespaceId,
      p_operation: input.scenario.seed.operation,
      p_insert_count: input.scenario.seed.insertCount,
      p_expected_pending: input.scenario.seed.expectedPending,
      p_minimum_oldest_age_seconds: input.scenario.seed.minimumOldestAgeSeconds,
      p_distribution: input.scenario.seed.distribution,
    }, input.signal, seedSchema);
  }

  async arm(input: Readonly<{
    scenarioLeaseId: string;
    expectedGeneration: number;
    seed: S33B1ScenarioSeedObservation;
    scenario: S33B1Wave3LiveScenario;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioLeaseObservation> {
    const observed = await this.invoke('arm_s33_rig_b1_scenario_lease', {
      p_scenario_lease_id: input.scenarioLeaseId,
      p_expected_generation: input.expectedGeneration,
      p_capture_id: input.scenario.captureId,
      p_seed_manifest_sha256: input.seed.seedManifestSha256,
      p_expected_pending: input.scenario.seed.expectedPending,
      p_ttl_seconds: input.scenario.ttlSeconds,
    }, input.signal, leaseSchema);
    this.active = {
      leaseId: observed.scenarioLeaseId,
      generation: observed.generation,
      captureId: observed.captureId,
      phase: observed.phase,
    };
    return observed;
  }

  async awaitLiveExecution(input: Readonly<{
    scenarioLeaseId: string;
    generation: number;
    scenario: S33B1Wave3LiveScenario;
    plan: S33B1Wave3LiveScenarioPlan;
    signal: AbortSignal;
  }>): Promise<S33B1LiveExecutionObservation> {
    while (true) {
      if (input.signal.aborted) throw abortError(input.signal, 'RIG-B1 outcome poll');
      const raw = await this.track(this.dependencies.rpc.invoke(
        'observe_s33_rig_b1_scenario_outcome',
        {
          p_scenario_lease_id: input.scenarioLeaseId,
          p_expected_generation: input.generation,
          p_capture_id: input.scenario.captureId,
          p_scenario_id: input.scenario.scenarioId,
          p_namespace_id: input.scenario.namespaceId,
          p_fault_window_id: input.scenario.faultWindowId,
          p_target_job_resource: input.scenario.targetJobResource,
          p_worker_revision: input.plan.workerRevision,
        },
        input.signal,
      ));
      if (raw !== null) {
        const observed = liveSchema.parse(raw);
        const artifact = executionArtifactSchema.parse(parseJsonRejectingDuplicateKeys(
          observed.evidenceArtifactRaw,
          `RIG-B1 persisted execution artifact ${input.scenario.executionSlot}`,
        ));
        const passes = artifact.declarationWindow.passes;
        const passIdentities = passes.map((pass) => {
          const record = pass as unknown as Record<string, unknown>;
          if (typeof record.batchId === 'string') return `broadcast:${record.batchId}`;
          if (typeof record.outcomeId === 'string') return `no-broadcast:${record.outcomeId}`;
          return '';
        });
        if (artifact.captureId !== observed.captureId
          || artifact.scenarioId !== observed.scenarioId
          || artifact.schedulerExecutionId !== observed.schedulerExecutionId
          || artifact.faultWindowId !== observed.faultWindowId
          || artifact.declarationWindow.scenarioId !== observed.scenarioId
          || passes.some((pass) => (
            pass.schedulerExecutionId !== observed.schedulerExecutionId
            || pass.faultWindow.id !== observed.faultWindowId
          ))
          || passIdentities.some((identity) => identity.length === 0)
          || new Set(passIdentities).size !== passes.length) {
          throw new Error('RIG-B1 persisted execution artifact is aggregate, duplicated, or cross-execution.');
        }
        this.active = {
          leaseId: observed.scenarioLeaseId,
          generation: observed.generation,
          captureId: observed.captureId,
          phase: 'RUNNING',
        };
        return observed;
      }
      await this.wait(POLL_INTERVAL_MS, input.signal);
    }
  }

  async complete(input: Readonly<{
    scenarioLeaseId: string;
    expectedGeneration: number;
    schedulerExecutionId: string;
    resultDigest: string;
    captureId: string;
    nextScenario: S33B1Wave3LiveScenario | null;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioCompletionObservation> {
    const observed = await this.invoke('complete_s33_rig_b1_scenario_execution', {
      p_scenario_lease_id: input.scenarioLeaseId,
      p_expected_generation: input.expectedGeneration,
      p_capture_id: input.captureId,
      p_scheduler_execution_id: input.schedulerExecutionId,
      p_result_digest: input.resultDigest,
      p_next_scenario: input.nextScenario === null ? null : {
        captureId: input.nextScenario.captureId,
        scenarioId: input.nextScenario.scenarioId,
        namespaceId: input.nextScenario.namespaceId,
        faultWindowId: input.nextScenario.faultWindowId,
        targetJobResource: input.nextScenario.targetJobResource,
        ttlSeconds: input.nextScenario.ttlSeconds,
      },
    }, input.signal, completionSchema);
    this.active = {
      leaseId: observed.scenarioLeaseId,
      generation: observed.generation,
      captureId: input.nextScenario?.captureId ?? observed.captureId,
      phase: observed.phase,
    };
    return observed;
  }

  async abortAndAwaitIdle(input: Readonly<{
    reason: string;
    deadline: string;
    signal: AbortSignal;
  }>): Promise<void> {
    void input.reason;
    const deadlineMs = Date.parse(input.deadline);
    while (this.inFlight.size > 0) {
      if (input.signal.aborted) throw abortError(input.signal, 'RIG-B1 idle proof');
      if (this.now().getTime() >= deadlineMs) throw new Error('RIG-B1 idle proof exceeded its deadline.');
      const snapshot = [...this.inFlight];
      await Promise.race([
        Promise.allSettled(snapshot).then(() => undefined),
        this.wait(Math.min(25, deadlineMs - this.now().getTime()), input.signal),
      ]);
    }
  }

  async abortScenarioLease(input: Readonly<{
    scenarioLeaseId: string | null;
    reason: string;
    deadline: string;
    signal: AbortSignal;
  }>): Promise<void> {
    if (input.scenarioLeaseId === null) return;
    if (this.active === null || this.active.leaseId !== input.scenarioLeaseId) {
      throw new Error('RIG-B1 production adapter lacks exact active lease state for abort.');
    }
    if (this.active.phase === 'COMPLETED' || this.active.phase === 'FAILED') return;
    const observed = await this.invoke('abort_s33_rig_b1_scenario_lease', {
      p_scenario_lease_id: this.active.leaseId,
      p_expected_generation: this.active.generation,
      p_capture_id: this.active.captureId,
      p_reason: input.reason,
    }, input.signal, abortSchema);
    this.active = {
      leaseId: observed.scenarioLeaseId,
      generation: observed.generation,
      captureId: observed.captureId,
      phase: observed.phase,
    };
  }

  async cleanupScenarioRun(input: Readonly<{
    planId: string;
    runId: string;
    scenarioLeaseId: string | null;
    preserveCaptureIds: readonly string[];
    deadline: string;
    signal: AbortSignal;
  }>): Promise<void> {
    if (input.scenarioLeaseId === null) return;
    const observed = await this.invoke('cleanup_s33_rig_b1_scenario_run', {
      p_scenario_lease_id: input.scenarioLeaseId,
      p_plan_id: input.planId,
      p_run_id: input.runId,
      p_preserve_capture_ids: input.preserveCaptureIds,
    }, input.signal, cleanupSchema);
    if (observed.scenarioLeaseId !== input.scenarioLeaseId
      || observed.preservedCaptureIds.length !== input.preserveCaptureIds.length
      || observed.preservedCaptureIds.some((id, index) => id !== input.preserveCaptureIds[index])) {
      throw new Error('RIG-B1 cleanup did not preserve the exact ordered capture set.');
    }
  }
}

const SOURCE_SUFFIXES = Object.freeze({
  scheduler: 'scheduler',
  workerLogs: 'worker-logs',
  database: 'database',
  signet: 'signet',
  cloudRun: 'cloud-run',
  supervisor: 'supervisor',
} satisfies Readonly<Record<KnownSourceKind, string>>);

const SOURCE_NAMES = Object.freeze({
  scheduler: 'cloud-scheduler',
  workerLogs: 'cloud-logging',
  database: 'db-query-export',
  signet: 'signet-rpc',
  cloudRun: 'cloud-run-lifecycle',
  supervisor: 'supervisor-records',
} satisfies Readonly<Record<KnownSourceKind, string>>);

export function s33B1Wave3RawCaptureFilePaths(
  soakId: string,
  declarationDigest: string,
): RawCaptureFileArguments {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u.test(soakId)
    || !/^[0-9a-f]{64}$/u.test(declarationDigest)) {
    throw new Error('RIG-B1 raw capture paths require exact soak and declaration identities.');
  }
  const prefix = createHash('sha256')
    .update(`arkova:s33:rig-b1:raw-captures\0${soakId}\0${declarationDigest}`)
    .digest('hex')
    .slice(0, 32);
  const path = (source: KnownSourceKind) => join(
    DEFAULT_EVIDENCE_CAPTURE_ROOT,
    `s33-b1-${prefix}-${SOURCE_SUFFIXES[source]}.json`,
  );
  return {
    schedulerFile: path('scheduler'),
    workerLogsFile: path('workerLogs'),
    databaseFile: path('database'),
    signetFile: path('signet'),
    cloudRunFile: path('cloudRun'),
    supervisorFile: path('supervisor'),
  };
}

function rawForSource(raw: RawCaptureTextSet, source: KnownSourceKind): string {
  return raw[source];
}

class S33B1Wave3CapturedSourceTransport implements KnownSourceTransport {
  private readonly captures = new Map<string, Promise<RawCaptureTextSet>>();

  async collect(request: Readonly<{
    source: KnownSourceKind;
    declaration: RunDeclaration;
    declarationSha256: string;
  }>): Promise<string> {
    const digest = declarationSha256.parse(request.declarationSha256);
    const key = `${request.declaration.soakId}:${digest}`;
    let captured = this.captures.get(key);
    if (captured === undefined) {
      captured = new CapturedFileRawSourceCollector(s33B1Wave3RawCaptureFilePaths(
        request.declaration.soakId,
        digest,
      )).collect();
      this.captures.set(key, captured);
    }
    const raw = rawForSource(await captured, request.source);
    const common = z.object({
      schemaVersion: z.literal(1),
      declarationSha256: z.literal(digest),
      rigId: z.literal('RIG-B1'),
      soakId: z.literal(request.declaration.soakId),
      gitHeadSha: z.literal(request.declaration.gitHeadSha),
      imageDigest: z.literal(request.declaration.imageDigest),
      source: z.literal(SOURCE_NAMES[request.source]),
    }).passthrough().parse(parseJsonRejectingDuplicateKeys(
      raw,
      `RIG-B1 independently captured ${request.source} export`,
    ));
    void common;
    return raw;
  }
}

function productionDependencies(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): S33B1Wave3ScenarioProductionDependencies {
  const target = resolveRigTarget(env.STAGING_SUPABASE_URL, env.ALLOWED_STAGING_PROJECT_REFS);
  const url = new URL(target.url);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('RIG-B1 production PostgREST target must be one exact HTTPS Supabase origin.');
  }
  const serviceRoleKey = env.STAGING_SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (serviceRoleKey === undefined || serviceRoleKey.length < 32) {
    throw new Error('STAGING_SUPABASE_SERVICE_ROLE_KEY is required for the RIG-B1 production port.');
  }
  return {
    rpc: new ProductionPostgrestTransport(url.origin, serviceRoleKey, fetchImpl),
    now: () => new Date(),
    wait: nodeWait,
  };
}

export function createS33B1Wave3LiveScenarioProductionPort(): S33B1Wave3LiveScenarioPort {
  return new ProductionS33B1Wave3ScenarioPort(productionDependencies());
}

/** Reads six independently produced, O_NOFOLLOW, fixed-root raw source exports. */
export function createS33B1Wave3KnownSourceTransport(): KnownSourceTransport {
  return new S33B1Wave3CapturedSourceTransport();
}

/** Test-only dependency seam; production callers always use the guarded PostgREST transport. */
export function createS33B1Wave3LiveScenarioProductionPortForTest(
  dependencies: S33B1Wave3ScenarioProductionDependencies,
): S33B1Wave3LiveScenarioPort {
  if (process.env.NODE_ENV !== 'test') throw new Error('Injected RIG-B1 scenario dependencies are test-only.');
  return new ProductionS33B1Wave3ScenarioPort(dependencies);
}
