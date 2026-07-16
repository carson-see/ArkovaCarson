/**
 * Bounded operator-side executor for the five live S3.3 Wave-3 RIG-B1 cases.
 *
 * The plan contains logical execution slots, never invented Scheduler execution
 * ids. A live id is accepted only when it re-derives from the exact Cloud
 * Scheduler job resource and canonical schedule time observed by the worker.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import {
  deriveS33RigB1SchedulerExecutionIdentity,
  S33_RIG_B1_SCENARIO_JOB_ROUTES,
  S33_RIG_B1_WORKER_SERVICE,
} from '../../services/worker/src/jobs/s33-rig-b1-scenario';

const PROJECT = 'arkova1';
const REGION = 'us-central1';
const JOB_PREFIX = `projects/${PROJECT}/locations/${REGION}/jobs/${S33_RIG_B1_WORKER_SERVICE}-`;
const NORMAL_JOB = `${JOB_PREFIX}batch-anchors`;
const FORCED_JOB = `${JOB_PREFIX}batch-anchors-forced-flush`;
const ORG_JOB = `${JOB_PREFIX}org-queue-scheduler`;
const ACTIVE_TTL_SECONDS = 240;
const CLEANUP_TIMEOUT_MS = 5 * 60_000;

export const S33_B1_WAVE3_EXECUTION_SLOTS = Object.freeze([
  'trigger-a-size:1',
  'trigger-a-size:2',
  'trigger-b-age:1',
  'trigger-d-force:1',
  'org-scheduler:1',
] as const);

export type S33B1Wave3ExecutionSlot = typeof S33_B1_WAVE3_EXECUTION_SLOTS[number];
export type S33B1Wave3Trigger =
  | 'trigger-a-size'
  | 'trigger-b-age'
  | 'trigger-d-force'
  | 'org-scheduler';

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);
const timestamp = z.string().datetime({ offset: true });
const exactJobResource = z.enum([NORMAL_JOB, FORCED_JOB, ORG_JOB]);
const routePath = z.enum([
  '/jobs/batch-anchors',
  '/jobs/batch-anchors?force=true',
  '/jobs/org-queue-scheduler',
]);

const seedSchema = z.object({
  operation: z.enum([
    'INSERT_ZIPF_30',
    'ADD_ZIPF_30',
    'CARRY_AND_AGE',
    'RESET_FORCED_CONTROL',
    'RESET_ORG_POISON_ZIPF_30',
  ]),
  insertCount: z.number().int().nonnegative().safe(),
  expectedPending: z.number().int().nonnegative().safe(),
  minimumOldestAgeSeconds: z.number().int().nonnegative().safe().nullable(),
  distribution: z.enum(['zipf-30-global', 'carry-forward', 'forced-control', 'zipf-30-org-poison']),
}).strict();

const expectedSchema = z.object({
  pendingBefore: z.number().int().nonnegative().safe(),
  drainedLeaves: z.number().int().nonnegative().safe(),
  pendingAfter: z.number().int().nonnegative().safe(),
  poisonPending: z.number().int().nonnegative().safe(),
  trigger: z.enum(['global-policy', 'global-flush', 'org-scheduler']),
  force: z.boolean(),
}).strict();

const scenarioSchema = z.object({
  executionSlot: z.enum(S33_B1_WAVE3_EXECUTION_SLOTS),
  executionOrdinal: z.number().int().positive().safe(),
  scenarioId: boundedId,
  namespaceId: boundedId,
  faultWindowId: boundedId,
  captureId: sha256,
  targetJobResource: exactJobResource,
  routePath,
  ttlSeconds: z.literal(ACTIVE_TTL_SECONDS),
  seed: seedSchema,
  expected: expectedSchema,
}).strict();

const planBodySchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.wave3-live-scenario-plan/v1'),
  planId: boundedId,
  runId: boundedId,
  startApprovalId: boundedId,
  admissionSha256: sha256,
  receiptSha256: sha256,
  gitHeadSha: gitSha,
  imageDigest: sha256,
  soakId: boundedId,
  runLeaseId: boundedId,
  workerRevision: boundedId,
  serviceAudience: z.string().url(),
  authorityExpiresAt: timestamp,
  runHardStopAt: timestamp,
  scenarios: z.tuple([
    scenarioSchema,
    scenarioSchema,
    scenarioSchema,
    scenarioSchema,
    scenarioSchema,
  ]),
}).strict();

const planArtifactSchema = planBodySchema.extend({ planSha256: sha256 }).strict();

export type S33B1Wave3LiveScenario = z.infer<typeof scenarioSchema>;
export type S33B1Wave3LiveScenarioPlan = z.infer<typeof planArtifactSchema>;

export interface S33B1Wave3PlanInput {
  readonly planId: string;
  readonly runId: string;
  readonly startApprovalId: string;
  readonly admissionSha256: string;
  readonly receiptSha256: string;
  readonly gitHeadSha: string;
  readonly imageDigest: string;
  readonly soakId: string;
  readonly runLeaseId: string;
  readonly workerRevision: string;
  readonly serviceAudience: string;
  readonly authorityExpiresAt: string;
  readonly runHardStopAt: string;
}

export interface S33B1ScenarioControlObservation {
  readonly generation: number;
  readonly activeLeaseId: string | null;
  readonly phase: string | null;
  readonly expiresAt: string | null;
}

export interface S33B1ScenarioLeaseObservation {
  readonly captureId: string;
  readonly scenarioLeaseId: string;
  readonly generation: number;
  readonly phase: 'PREPARING' | 'ARMED' | 'RUNNING' | 'COMPLETED';
  readonly expiresAt: string;
}

export interface S33B1ScenarioSeedObservation {
  readonly captureId: string;
  readonly scenarioLeaseId: string;
  readonly generation: number;
  readonly scenarioId: string;
  readonly namespaceId: string;
  readonly seedManifestSha256: string;
  readonly pending: number;
  readonly oldestPendingAgeSeconds: number | null;
  readonly isolation: 'repeatable-read';
  readonly observedAt: string;
}

export interface S33B1LiveExecutionObservation {
  readonly captureId: string;
  readonly scenarioLeaseId: string;
  readonly generation: number;
  readonly scenarioId: string;
  readonly namespaceId: string;
  readonly faultWindowId: string;
  readonly targetJobResource: string;
  readonly schedulerJobResource: string;
  readonly schedulerScheduleTime: string;
  readonly schedulerExecutionId: string;
  readonly routePath: string;
  readonly workerRevision: string;
  readonly pendingBefore: number;
  readonly drainedLeaves: number;
  readonly pendingAfter: number;
  readonly poisonPending: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly evidenceArtifactRaw: string;
  readonly evidenceArtifactSha256: string;
}

export interface S33B1ScenarioCompletionObservation {
  readonly captureId: string;
  readonly scenarioLeaseId: string;
  readonly generation: number;
  readonly phase: 'PREPARING' | 'COMPLETED';
  readonly expiresAt?: string;
}

export interface S33B1Wave3LiveScenarioPort {
  now(): Date;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  observeControl(signal: AbortSignal): Promise<S33B1ScenarioControlObservation>;
  acquirePreparing(input: Readonly<{
    expectedGeneration: number;
    scenario: S33B1Wave3LiveScenario;
    plan: S33B1Wave3LiveScenarioPlan;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioLeaseObservation>;
  prepareSeed(input: Readonly<{
    scenarioLeaseId: string;
    generation: number;
    scenario: S33B1Wave3LiveScenario;
    plan: S33B1Wave3LiveScenarioPlan;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioSeedObservation>;
  arm(input: Readonly<{
    scenarioLeaseId: string;
    expectedGeneration: number;
    seed: S33B1ScenarioSeedObservation;
    scenario: S33B1Wave3LiveScenario;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioLeaseObservation>;
  awaitLiveExecution(input: Readonly<{
    scenarioLeaseId: string;
    generation: number;
    scenario: S33B1Wave3LiveScenario;
    plan: S33B1Wave3LiveScenarioPlan;
    signal: AbortSignal;
  }>): Promise<S33B1LiveExecutionObservation>;
  complete(input: Readonly<{
    scenarioLeaseId: string;
    expectedGeneration: number;
    schedulerExecutionId: string;
    resultDigest: string;
    captureId: string;
    nextScenario: S33B1Wave3LiveScenario | null;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioCompletionObservation>;
  /** Must cancel/kill in-flight mutation and resolve only after the port proves idle. */
  abortAndAwaitIdle(input: Readonly<{
    reason: string;
    deadline: string;
    signal: AbortSignal;
  }>): Promise<void>;
  /** Must mark/release PREPARING, ARMED, or RUNNING state without executing a target. */
  abortScenarioLease(input: Readonly<{
    scenarioLeaseId: string | null;
    reason: string;
    deadline: string;
    signal: AbortSignal;
  }>): Promise<void>;
  /** May delete seeded rows only after preserving immutable capture artifacts. */
  cleanupScenarioRun(input: Readonly<{
    planId: string;
    runId: string;
    scenarioLeaseId: string | null;
    preserveCaptureIds: readonly string[];
    deadline: string;
    signal: AbortSignal;
  }>): Promise<void>;
}

const controlSchema = z.object({
  generation: z.number().int().nonnegative().safe(),
  activeLeaseId: z.string().uuid().nullable(),
  phase: z.string().nullable(),
  expiresAt: timestamp.nullable(),
}).strict();
const leaseSchema = z.object({
  captureId: sha256,
  scenarioLeaseId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  phase: z.enum(['PREPARING', 'ARMED', 'RUNNING', 'COMPLETED']),
  expiresAt: timestamp,
}).strict();
const seedObservationSchema = z.object({
  captureId: sha256,
  scenarioLeaseId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  scenarioId: boundedId,
  namespaceId: boundedId,
  seedManifestSha256: sha256,
  pending: z.number().int().nonnegative().safe(),
  oldestPendingAgeSeconds: z.number().int().nonnegative().safe().nullable(),
  isolation: z.literal('repeatable-read'),
  observedAt: timestamp,
}).strict();
const liveObservationSchema = z.object({
  captureId: sha256,
  scenarioLeaseId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  scenarioId: boundedId,
  namespaceId: boundedId,
  faultWindowId: boundedId,
  targetJobResource: exactJobResource,
  schedulerJobResource: exactJobResource,
  schedulerScheduleTime: timestamp,
  schedulerExecutionId: sha256,
  routePath,
  workerRevision: boundedId,
  pendingBefore: z.number().int().nonnegative().safe(),
  drainedLeaves: z.number().int().nonnegative().safe(),
  pendingAfter: z.number().int().nonnegative().safe(),
  poisonPending: z.number().int().nonnegative().safe(),
  startedAt: timestamp,
  completedAt: timestamp,
  evidenceArtifactRaw: z.string().min(2).max(64 * 1024 * 1024),
  evidenceArtifactSha256: sha256,
}).strict();
const completionSchema = z.object({
  captureId: sha256,
  scenarioLeaseId: z.string().uuid(),
  generation: z.number().int().positive().safe(),
  phase: z.enum(['PREPARING', 'COMPLETED']),
  expiresAt: timestamp.optional(),
}).strict();

export interface S33B1Wave3ScenarioCaptureHandle {
  readonly captureId: string;
  readonly executionSlot: S33B1Wave3ExecutionSlot;
}

export type S33B1Wave3ScenarioCaptureHandles = readonly [
  S33B1Wave3ScenarioCaptureHandle,
  S33B1Wave3ScenarioCaptureHandle,
  S33B1Wave3ScenarioCaptureHandle,
  S33B1Wave3ScenarioCaptureHandle,
  S33B1Wave3ScenarioCaptureHandle,
];

export interface S33B1Wave3LiveScenarioMaterial {
  readonly status: 'S33_B1_WAVE3_LIVE_SCENARIOS_COMPLETE';
  readonly planSha256: string;
  readonly admissionSha256: string;
  readonly receiptSha256: string;
  readonly gitHeadSha: string;
  readonly imageDigest: string;
  readonly soakId: string;
  readonly runLeaseId: string;
  readonly scenarioLeaseId: string;
  readonly captures: S33B1Wave3ScenarioCaptureHandles;
}

const PLAN_PROVENANCE = new WeakSet<S33B1Wave3LiveScenarioPlan>();
const CAPTURE_PROVENANCE = new WeakMap<
  S33B1Wave3ScenarioCaptureHandle,
  Readonly<{ scenario: S33B1Wave3LiveScenario; observation: S33B1LiveExecutionObservation }>
>();
const MATERIAL_PROVENANCE = new WeakMap<
  S33B1Wave3LiveScenarioMaterial,
  S33B1Wave3LiveScenarioPlan
>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  const raw = JSON.stringify(value);
  if (raw === undefined) throw new Error('RIG-B1 Wave-3 plan cannot digest undefined.');
  return raw;
}

function digestStable(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function digestRaw(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function derivedId(prefix: string, runId: string, slot: string): string {
  return `${prefix}-${createHash('sha256').update(`${runId}\0${slot}`).digest('hex').slice(0, 24)}`;
}

function captureId(runId: string, slot: S33B1Wave3ExecutionSlot): string {
  return digestStable({ purpose: 'S33_B1_WAVE3_LIVE_CAPTURE', runId, executionSlot: slot });
}

function scenario(
  runId: string,
  executionSlot: S33B1Wave3ExecutionSlot,
  executionOrdinal: number,
  namespaceSlot: string,
  targetJobResource: typeof NORMAL_JOB | typeof FORCED_JOB | typeof ORG_JOB,
  route: z.infer<typeof routePath>,
  seed: z.infer<typeof seedSchema>,
  expected: z.infer<typeof expectedSchema>,
): S33B1Wave3LiveScenario {
  return scenarioSchema.parse({
    executionSlot,
    executionOrdinal,
    scenarioId: derivedId('b1w3-scenario', runId, executionSlot),
    namespaceId: derivedId('b1w3-namespace', runId, namespaceSlot),
    faultWindowId: derivedId('b1w3-fault', runId, executionSlot),
    captureId: captureId(runId, executionSlot),
    targetJobResource,
    routePath: route,
    ttlSeconds: ACTIVE_TTL_SECONDS,
    seed,
    expected,
  });
}

function canonicalPlanBody(input: S33B1Wave3PlanInput): z.infer<typeof planBodySchema> {
  const base = planBodySchema.omit({ scenarios: true }).parse({
    schemaVersion: 'arkova.s33.rig-b1.wave3-live-scenario-plan/v1',
    ...input,
  });
  if (input.authorityExpiresAt !== input.runHardStopAt) {
    throw new Error('RIG-B1 scenario authority expiry must equal the signed START run hard stop.');
  }
  const authorityExpiry = Date.parse(input.authorityExpiresAt);
  if (!Number.isFinite(authorityExpiry)) throw new Error('RIG-B1 scenario authority expiry is invalid.');
  const backlogNamespace = 'backlog-carry-forward';
  const scenarios = [
    scenario(
      input.runId, 'trigger-a-size:1', 1, backlogNamespace, NORMAL_JOB,
      '/jobs/batch-anchors',
      {
        operation: 'INSERT_ZIPF_30', insertCount: 12_500, expectedPending: 12_500,
        minimumOldestAgeSeconds: null, distribution: 'zipf-30-global',
      },
      {
        pendingBefore: 12_500, drainedLeaves: 10_000, pendingAfter: 2_500,
        poisonPending: 0, trigger: 'global-policy', force: false,
      },
    ),
    scenario(
      input.runId, 'trigger-a-size:2', 2, backlogNamespace, NORMAL_JOB,
      '/jobs/batch-anchors',
      {
        operation: 'ADD_ZIPF_30', insertCount: 12_500, expectedPending: 15_000,
        minimumOldestAgeSeconds: null, distribution: 'zipf-30-global',
      },
      {
        pendingBefore: 15_000, drainedLeaves: 10_000, pendingAfter: 5_000,
        poisonPending: 0, trigger: 'global-policy', force: false,
      },
    ),
    scenario(
      input.runId, 'trigger-b-age:1', 1, backlogNamespace, NORMAL_JOB,
      '/jobs/batch-anchors',
      {
        operation: 'CARRY_AND_AGE', insertCount: 0, expectedPending: 5_000,
        minimumOldestAgeSeconds: 10_800, distribution: 'carry-forward',
      },
      {
        pendingBefore: 5_000, drainedLeaves: 5_000, pendingAfter: 0,
        poisonPending: 0, trigger: 'global-policy', force: false,
      },
    ),
    scenario(
      input.runId, 'trigger-d-force:1', 1, 'forced-control', FORCED_JOB,
      '/jobs/batch-anchors?force=true',
      {
        operation: 'RESET_FORCED_CONTROL', insertCount: 2_500, expectedPending: 2_500,
        minimumOldestAgeSeconds: 0, distribution: 'forced-control',
      },
      {
        pendingBefore: 2_500, drainedLeaves: 2_500, pendingAfter: 0,
        poisonPending: 0, trigger: 'global-flush', force: true,
      },
    ),
    scenario(
      input.runId, 'org-scheduler:1', 1, 'org-poison-control', ORG_JOB,
      '/jobs/org-queue-scheduler',
      {
        operation: 'RESET_ORG_POISON_ZIPF_30', insertCount: 12_500, expectedPending: 12_500,
        minimumOldestAgeSeconds: null, distribution: 'zipf-30-org-poison',
      },
      {
        pendingBefore: 12_500, drainedLeaves: 12_303, pendingAfter: 197,
        poisonPending: 197, trigger: 'org-scheduler', force: false,
      },
    ),
  ] as const;
  return planBodySchema.parse({ ...base, scenarios });
}

function brandPlan(body: z.infer<typeof planBodySchema>): S33B1Wave3LiveScenarioPlan {
  const plan = deepFreeze(planArtifactSchema.parse({
    ...body,
    planSha256: digestStable(body),
  }));
  PLAN_PROVENANCE.add(plan);
  return plan;
}

export function buildS33B1Wave3LiveScenarioPlan(
  input: S33B1Wave3PlanInput,
): S33B1Wave3LiveScenarioPlan {
  return brandPlan(canonicalPlanBody(input));
}

export function serializeS33B1Wave3LiveScenarioPlan(plan: S33B1Wave3LiveScenarioPlan): string {
  requirePlan(plan);
  return JSON.stringify(plan);
}

export function loadS33B1Wave3LiveScenarioPlan(raw: string): S33B1Wave3LiveScenarioPlan {
  const parsed = planArtifactSchema.parse(parseJsonRejectingDuplicateKeys(
    raw,
    'RIG-B1 Wave-3 live scenario plan',
  ));
  const { planSha256, ...body } = parsed;
  if (planSha256 !== digestStable(body)) throw new Error('RIG-B1 Wave-3 plan digest is invalid.');
  const rebuilt = canonicalPlanBody({
    planId: body.planId,
    runId: body.runId,
    startApprovalId: body.startApprovalId,
    admissionSha256: body.admissionSha256,
    receiptSha256: body.receiptSha256,
    gitHeadSha: body.gitHeadSha,
    imageDigest: body.imageDigest,
    soakId: body.soakId,
    runLeaseId: body.runLeaseId,
    workerRevision: body.workerRevision,
    serviceAudience: body.serviceAudience,
    authorityExpiresAt: body.authorityExpiresAt,
    runHardStopAt: body.runHardStopAt,
  });
  if (stableJson(body) !== stableJson(rebuilt)) {
    throw new Error('RIG-B1 Wave-3 plan differs from the exact five execution-slot topology.');
  }
  return brandPlan(rebuilt);
}

function requirePlan(plan: S33B1Wave3LiveScenarioPlan): void {
  if (!PLAN_PROVENANCE.has(plan)) {
    throw new Error('RIG-B1 Wave-3 execution requires an immutable branded plan handle.');
  }
}

function assertBeforeDeadline(port: S33B1Wave3LiveScenarioPort, deadlineMs: number, label: string): void {
  const now = port.now().getTime();
  if (!Number.isFinite(now) || now >= deadlineMs) {
    throw new Error(`${label} reached the signed RIG-B1 run hard stop.`);
  }
}

function abortFailure(signal: AbortSignal, label: string): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(`${label} was aborted.`);
}

async function boundedOperation<T>(
  label: string,
  deadlineMs: number,
  port: S33B1Wave3LiveScenarioPort,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  assertBeforeDeadline(port, deadlineMs, label);
  if (signal.aborted) throw abortFailure(signal, label);
  const remaining = deadlineMs - port.now().getTime();
  const timerController = new AbortController();
  let removeAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const listener = () => reject(abortFailure(signal, label));
    signal.addEventListener('abort', listener, { once: true });
    removeAbort = () => signal.removeEventListener('abort', listener);
  });
  const expired = port.wait(remaining, timerController.signal).then(() => {
    throw new Error(`${label} exceeded the signed RIG-B1 run hard stop.`);
  });
  try {
    return await Promise.race([operation(), expired, aborted]);
  } finally {
    timerController.abort();
    removeAbort();
  }
}

function assertCaptureIdentity(
  scenarioPlan: S33B1Wave3LiveScenario,
  value: Readonly<{ captureId: string; scenarioLeaseId: string; generation: number }>,
  expectedLeaseId: string,
  expectedGeneration: number,
  label: string,
): void {
  if (value.captureId !== scenarioPlan.captureId
    || value.scenarioLeaseId !== expectedLeaseId
    || value.generation !== expectedGeneration) {
    throw new Error(`${label} capture, lease, or generation identity differs from the execution slot.`);
  }
}

function assertSeed(
  scenarioPlan: S33B1Wave3LiveScenario,
  value: S33B1ScenarioSeedObservation,
  leaseId: string,
  generation: number,
): void {
  assertCaptureIdentity(scenarioPlan, value, leaseId, generation, 'RIG-B1 seed');
  if (value.scenarioId !== scenarioPlan.scenarioId
    || value.namespaceId !== scenarioPlan.namespaceId
    || value.pending !== scenarioPlan.seed.expectedPending
    || value.isolation !== 'repeatable-read'
    || (scenarioPlan.seed.minimumOldestAgeSeconds !== null
      && (value.oldestPendingAgeSeconds ?? -1) < scenarioPlan.seed.minimumOldestAgeSeconds)) {
    throw new Error('RIG-B1 repeatable-read seed capture differs from the immutable scenario precondition.');
  }
}

function assertLiveObservation(
  scenarioPlan: S33B1Wave3LiveScenario,
  plan: S33B1Wave3LiveScenarioPlan,
  value: S33B1LiveExecutionObservation,
  leaseId: string,
  generation: number,
): void {
  assertCaptureIdentity(scenarioPlan, value, leaseId, generation, 'RIG-B1 live execution');
  const identity = deriveS33RigB1SchedulerExecutionIdentity(
    value.schedulerJobResource,
    value.schedulerScheduleTime,
  );
  const expectedSuffix = value.schedulerJobResource.slice(JOB_PREFIX.length) as keyof typeof S33_RIG_B1_SCENARIO_JOB_ROUTES;
  if (value.schedulerExecutionId !== identity.executionId
    || value.schedulerScheduleTime !== identity.scheduleTime
    || value.schedulerJobResource !== scenarioPlan.targetJobResource
    || value.targetJobResource !== scenarioPlan.targetJobResource
    || S33_RIG_B1_SCENARIO_JOB_ROUTES[expectedSuffix] !== scenarioPlan.routePath
    || value.routePath !== scenarioPlan.routePath
    || value.scenarioId !== scenarioPlan.scenarioId
    || value.namespaceId !== scenarioPlan.namespaceId
    || value.faultWindowId !== scenarioPlan.faultWindowId
    || value.workerRevision !== plan.workerRevision
    || value.pendingBefore !== scenarioPlan.expected.pendingBefore
    || value.drainedLeaves !== scenarioPlan.expected.drainedLeaves
    || value.pendingAfter !== scenarioPlan.expected.pendingAfter
    || value.poisonPending !== scenarioPlan.expected.poisonPending
    || value.pendingAfter !== value.pendingBefore - value.drainedLeaves
    || digestRaw(value.evidenceArtifactRaw) !== value.evidenceArtifactSha256
    || Date.parse(value.startedAt) > Date.parse(value.completedAt)) {
    throw new Error('RIG-B1 live capture differs from exact resource, server-derived identity, route, remainder, or evidence bytes.');
  }
  parseJsonRejectingDuplicateKeys(value.evidenceArtifactRaw, 'RIG-B1 live scenario capture artifact');
}

function createCaptureHandle(
  scenarioPlan: S33B1Wave3LiveScenario,
  observation: S33B1LiveExecutionObservation,
): S33B1Wave3ScenarioCaptureHandle {
  const handle = Object.freeze({
    captureId: scenarioPlan.captureId,
    executionSlot: scenarioPlan.executionSlot,
  });
  CAPTURE_PROVENANCE.set(handle, deepFreeze({ scenario: scenarioPlan, observation }));
  return handle;
}

async function cleanup(
  port: S33B1Wave3LiveScenarioPort,
  controller: AbortController,
  plan: S33B1Wave3LiveScenarioPlan,
  leaseId: string | null,
  captureIds: readonly string[],
  reason: string,
): Promise<void> {
  controller.abort(new Error(reason));
  const deadlineMs = port.now().getTime() + CLEANUP_TIMEOUT_MS;
  const deadline = new Date(deadlineMs).toISOString();
  const runStep = async (label: string, operation: (signal: AbortSignal) => Promise<void>) => {
    const remaining = deadlineMs - port.now().getTime();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new Error(`${label} exceeded the bounded RIG-B1 cleanup deadline.`);
    }
    const operationController = new AbortController();
    const timerController = new AbortController();
    const expired = port.wait(remaining, timerController.signal).then(() => {
      operationController.abort(new Error(`${label} exceeded the bounded RIG-B1 cleanup deadline.`));
      throw new Error(`${label} exceeded the bounded RIG-B1 cleanup deadline.`);
    });
    try {
      await Promise.race([operation(operationController.signal), expired]);
    } finally {
      timerController.abort();
    }
  };

  // Fail closed: never release the six-job lease until all in-flight mutation
  // has settled, and never delete seeded state until lease release succeeds.
  await runStep('RIG-B1 in-flight mutation idle proof', (signal) => (
    port.abortAndAwaitIdle({ reason, deadline, signal })
  ));
  await runStep('RIG-B1 scenario lease abort/release', (signal) => (
    port.abortScenarioLease({ scenarioLeaseId: leaseId, reason, deadline, signal })
  ));
  await runStep('RIG-B1 seeded-state cleanup', (signal) => port.cleanupScenarioRun({
    planId: plan.planId,
    runId: plan.runId,
    scenarioLeaseId: leaseId,
    preserveCaptureIds: captureIds,
    deadline,
    signal,
  }));
}

export async function executeS33B1Wave3LiveScenarios(
  plan: S33B1Wave3LiveScenarioPlan,
  port: S33B1Wave3LiveScenarioPort,
  externalSignal: AbortSignal,
): Promise<S33B1Wave3LiveScenarioMaterial> {
  requirePlan(plan);
  const deadlineMs = Date.parse(plan.runHardStopAt);
  if (!Number.isFinite(deadlineMs)) throw new Error('RIG-B1 Wave-3 run hard stop is invalid.');
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(externalSignal.reason);
  externalSignal.addEventListener('abort', forwardAbort, { once: true });
  if (externalSignal.aborted) forwardAbort();
  let leaseId: string | null = null;
  let generation = -1;
  const handles: S33B1Wave3ScenarioCaptureHandle[] = [];
  let succeeded = false;
  try {
    const control = controlSchema.parse(await boundedOperation(
      'RIG-B1 scenario control observation', deadlineMs, port, controller.signal,
      () => port.observeControl(controller.signal),
    ));
    if (control.activeLeaseId !== null) {
      throw new Error('RIG-B1 Wave-3 executor refuses to replace an active scenario lease.');
    }
    generation = control.generation;
    const first = plan.scenarios[0];
    const acquired = leaseSchema.parse(await boundedOperation(
      'RIG-B1 scenario acquisition', deadlineMs, port, controller.signal,
      () => port.acquirePreparing({
        expectedGeneration: generation,
        scenario: first,
        plan,
        signal: controller.signal,
      }),
    ));
    if (acquired.phase !== 'PREPARING'
      || acquired.captureId !== first.captureId
      || acquired.generation !== generation + 1) {
      throw new Error('RIG-B1 acquisition did not return the first PREPARING execution slot.');
    }
    leaseId = acquired.scenarioLeaseId;
    generation = acquired.generation;

    for (let index = 0; index < plan.scenarios.length; index += 1) {
      const planned = plan.scenarios[index]!;
      const seed = seedObservationSchema.parse(await boundedOperation(
        `RIG-B1 ${planned.executionSlot} PREPARING seed`, deadlineMs, port, controller.signal,
        () => port.prepareSeed({
          scenarioLeaseId: leaseId!, generation, scenario: planned, plan,
          signal: controller.signal,
        }),
      ));
      assertSeed(planned, seed, leaseId, generation);
      const armed = leaseSchema.parse(await boundedOperation(
        `RIG-B1 ${planned.executionSlot} arm`, deadlineMs, port, controller.signal,
        () => port.arm({
          scenarioLeaseId: leaseId!, expectedGeneration: generation,
          seed, scenario: planned, signal: controller.signal,
        }),
      ));
      assertCaptureIdentity(planned, armed, leaseId, generation + 1, 'RIG-B1 arm');
      if (armed.phase !== 'ARMED') throw new Error('RIG-B1 scenario did not enter ARMED.');
      generation = armed.generation;
      const live = liveObservationSchema.parse(await boundedOperation(
        `RIG-B1 ${planned.executionSlot} live execution`, deadlineMs, port, controller.signal,
        () => port.awaitLiveExecution({
          scenarioLeaseId: leaseId!, generation, scenario: planned, plan,
          signal: controller.signal,
        }),
      ));
      assertLiveObservation(planned, plan, live, leaseId, generation);
      const handle = createCaptureHandle(planned, live);
      handles.push(handle);
      const nextScenario = plan.scenarios[index + 1] ?? null;
      const resultDigest = digestStable({
        captureId: planned.captureId,
        executionSlot: planned.executionSlot,
        evidenceArtifactSha256: live.evidenceArtifactSha256,
        schedulerExecutionId: live.schedulerExecutionId,
        pendingAfter: live.pendingAfter,
      });
      const completed = completionSchema.parse(await boundedOperation(
        `RIG-B1 ${planned.executionSlot} completion`, deadlineMs, port, controller.signal,
        () => port.complete({
          scenarioLeaseId: leaseId!, expectedGeneration: generation,
          schedulerExecutionId: live.schedulerExecutionId, resultDigest,
          captureId: planned.captureId, nextScenario, signal: controller.signal,
        }),
      ));
      assertCaptureIdentity(planned, completed, leaseId, generation + 1, 'RIG-B1 completion');
      const expectedPhase = nextScenario === null ? 'COMPLETED' : 'PREPARING';
      if (completed.phase !== expectedPhase) {
        throw new Error(`RIG-B1 ${planned.executionSlot} did not enter ${expectedPhase}.`);
      }
      generation = completed.generation;
    }
    if (handles.length !== 5) throw new Error('RIG-B1 Wave-3 executor did not capture exact five slots.');
    const captureTuple = handles as unknown as S33B1Wave3ScenarioCaptureHandles;
    const material = deepFreeze<S33B1Wave3LiveScenarioMaterial>({
      status: 'S33_B1_WAVE3_LIVE_SCENARIOS_COMPLETE',
      planSha256: plan.planSha256,
      admissionSha256: plan.admissionSha256,
      receiptSha256: plan.receiptSha256,
      gitHeadSha: plan.gitHeadSha,
      imageDigest: plan.imageDigest,
      soakId: plan.soakId,
      runLeaseId: plan.runLeaseId,
      scenarioLeaseId: leaseId,
      captures: captureTuple,
    });
    MATERIAL_PROVENANCE.set(material, plan);
    succeeded = true;
    return material;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'RIG-B1 Wave-3 executor failed.';
    try {
      await cleanup(port, controller, plan, leaseId, handles.map(({ captureId: id }) => id), reason);
    } catch (cleanupError) {
      const failures = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
      throw new AggregateError([error, ...failures], `${reason}; hard-stop cleanup also failed.`);
    }
    throw error;
  } finally {
    externalSignal.removeEventListener('abort', forwardAbort);
    if (succeeded) {
      await cleanup(
        port,
        controller,
        plan,
        leaseId,
        handles.map(({ captureId: id }) => id),
        'RIG-B1 Wave-3 scenarios completed; preserve captures and remove seeded state.',
      );
    }
  }
}

export function resolveS33B1Wave3ScenarioCapture(
  handle: S33B1Wave3ScenarioCaptureHandle,
): Readonly<{ scenario: S33B1Wave3LiveScenario; observation: S33B1LiveExecutionObservation }> {
  const value = CAPTURE_PROVENANCE.get(handle);
  if (value === undefined) throw new Error('RIG-B1 Wave-3 capture handle is not genuine.');
  return value;
}

export function assertGenuineS33B1Wave3ScenarioMaterial(
  material: unknown,
  expected: Readonly<{
    admissionSha256: string;
    receiptSha256: string;
    sourceHeadSha: string;
    imageDigest: string;
    soakId: string;
    leaseId: string;
  }>,
): asserts material is S33B1Wave3LiveScenarioMaterial {
  if (material === null || typeof material !== 'object') {
    throw new Error('RIG-B1 Wave-3 scenario material is absent.');
  }
  const typed = material as S33B1Wave3LiveScenarioMaterial;
  const plan = MATERIAL_PROVENANCE.get(typed);
  if (plan === undefined
    || typed.status !== 'S33_B1_WAVE3_LIVE_SCENARIOS_COMPLETE'
    || typed.planSha256 !== plan.planSha256
    || typed.admissionSha256 !== expected.admissionSha256
    || typed.receiptSha256 !== expected.receiptSha256
    || typed.gitHeadSha !== expected.sourceHeadSha
    || typed.imageDigest !== expected.imageDigest
    || typed.soakId !== expected.soakId
    || typed.runLeaseId !== expected.leaseId
    || typed.captures.length !== S33_B1_WAVE3_EXECUTION_SLOTS.length) {
    throw new Error('RIG-B1 Wave-3 scenario material differs from the exact supervisor identity.');
  }
  typed.captures.forEach((handle, index) => {
    const captured = CAPTURE_PROVENANCE.get(handle);
    const planned = plan.scenarios[index];
    if (captured === undefined
      || planned === undefined
      || handle.captureId !== planned.captureId
      || handle.executionSlot !== planned.executionSlot
      || captured.scenario !== planned
      || captured.observation.captureId !== planned.captureId) {
      throw new Error('RIG-B1 Wave-3 ordered capture handle is forged, reordered, or cross-plan.');
    }
  });
}
