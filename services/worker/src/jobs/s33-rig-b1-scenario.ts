/**
 * RIG-B1-only Cloud Scheduler scenario admission.
 *
 * A short database lease makes one of the six continuously enabled Scheduler
 * jobs the target. Cloud Scheduler's immutable job-resource and schedule-time
 * headers are the sole execution-identity input. The database derives the same
 * identity, records every non-target controlled skip, and returns the target's
 * namespace/fault binding. No request may provide an execution id.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

export const S33_RIG_B1_CRON_SERVICE_ACCOUNT =
  's33-rig-b1-cron@arkova1.iam.gserviceaccount.com' as const;
export const S33_RIG_B1_WORKER_SERVICE =
  'arkova-worker-s33-rig-b1-staging' as const;
export const S33_RIG_B1_SCENARIO_EXECUTION_VERSION =
  'arkova.s33.rig-b1.scheduler-execution/v1' as const;

const JOB_PREFIX =
  `projects/arkova1/locations/us-central1/jobs/${S33_RIG_B1_WORKER_SERVICE}-`;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const S33_RIG_B1_SCENARIO_JOB_ROUTES = Object.freeze({
  'batch-anchors': '/jobs/batch-anchors',
  'batch-anchors-forced-flush': '/jobs/batch-anchors?force=true',
  'check-confirmations': '/jobs/check-confirmations',
  'org-queue-scheduler': '/jobs/org-queue-scheduler',
  'populate-confirmation-proofs': '/jobs/populate-confirmation-proofs',
  'recover-broadcasts': '/jobs/recover-broadcasts',
} as const);

export type S33RigB1ScenarioJobSuffix = keyof typeof S33_RIG_B1_SCENARIO_JOB_ROUTES;

const exactJobResourceSchema = z.string().refine((value) => {
  if (!value.startsWith(JOB_PREFIX)) return false;
  const suffix = value.slice(JOB_PREFIX.length);
  return Object.hasOwn(S33_RIG_B1_SCENARIO_JOB_ROUTES, suffix);
}, 'Cloud Scheduler job resource is outside the exact RIG-B1 six-job set.');

const timestampSchema = z.string().datetime({ offset: true });
const boundedIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);
const activeGateSchema = z.object({
  mode: z.enum(['TARGET_EXECUTE', 'CONTROLLED_SKIP', 'PREPARING_SKIP', 'TARGET_REPLAY']),
  generation: z.number().int().positive().safe(),
  scenarioLeaseId: z.string().regex(UUID),
  scenarioId: boundedIdSchema,
  targetJobResource: exactJobResourceSchema,
  namespaceId: boundedIdSchema,
  expectedPending: z.number().int().nonnegative().safe().nullable(),
  faultWindowId: boundedIdSchema,
  soakId: boundedIdSchema,
  runLeaseId: boundedIdSchema,
  workerRevision: z.string().regex(/^arkova-worker-s33-rig-b1-staging-[a-z0-9-]+$/u),
  executionId: z.string().regex(SHA256),
  scheduleTime: timestampSchema,
  expiresAt: timestampSchema,
}).strict();
const gateResultSchema = z.union([
  z.object({ mode: z.literal('NORMAL') }).strict(),
  activeGateSchema,
]);

export interface S33RigB1CronAuthContext {
  readonly accepted: boolean;
  readonly method: 'development' | 'cron-secret' | 'platform-admin' | 'google-oidc' | 'combined';
  readonly cronSecretValid: boolean;
  readonly oidcPrincipal: string | null;
  readonly oidcEmailVerified: boolean;
  readonly oidcAudience: string | null;
}

export interface S33RigB1ScenarioDb {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message?: string } | null;
  }>;
}

export interface S33RigB1SchedulerExecutionIdentity {
  readonly jobResource: string;
  readonly scheduleTime: string;
  readonly executionId: string;
}

export interface S33RigB1ScenarioExecutionContext {
  readonly generation: number;
  readonly scenarioLeaseId: string;
  readonly scenarioId: string;
  readonly targetJobResource: string;
  readonly namespaceId: string;
  readonly expectedPending: number | null;
  readonly faultWindowId: string;
  readonly soakId: string;
  readonly runLeaseId: string;
  readonly workerRevision: string;
  readonly schedulerExecutionId: string;
  readonly schedulerJobResource: string;
  readonly schedulerScheduleTime: string;
  readonly expiresAt: string;
}

export type S33RigB1ScenarioGateResult =
  | Readonly<{ mode: 'NORMAL' }>
  | Readonly<{ mode: 'TARGET_EXECUTE'; context: S33RigB1ScenarioExecutionContext }>
  | Readonly<{
      mode: 'CONTROLLED_SKIP';
      statusCode: 200;
      context: S33RigB1ScenarioExecutionContext;
      body: Readonly<{
        controlledSkip: true;
        reason:
          | 's33_rig_b1_non_target_during_active_scenario'
          | 's33_rig_b1_preparing'
          | 's33_rig_b1_target_replay';
        scenarioId: string;
        schedulerExecutionId: string;
        targetJobResource: string;
      }>;
    }>;

export interface S33RigB1ScenarioRequest {
  readonly routePath: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly auth: S33RigB1CronAuthContext;
  readonly serviceName?: string;
  readonly serviceRevision?: string;
  readonly serviceAudience: string;
}

function primitiveHeader(
  headers: S33RigB1ScenarioRequest['headers'],
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    throw new Error(`RIG-B1 Scheduler ${name} header rejects duplicate/array values.`);
  }
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length === 0 || raw !== raw.trim() || raw.includes(',')) {
    throw new Error(`RIG-B1 Scheduler ${name} header must be one exact primitive value.`);
  }
  return raw;
}

function canonicalScheduleTime(raw: string): string {
  const parsed = timestampSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Cloud Scheduler schedule time must be strict RFC3339.');
  const epoch = Date.parse(parsed.data);
  if (!Number.isFinite(epoch)) throw new Error('Cloud Scheduler schedule time is invalid.');
  return new Date(epoch).toISOString();
}

function suffixForJobResource(jobResource: string): S33RigB1ScenarioJobSuffix {
  const parsed = exactJobResourceSchema.parse(jobResource);
  return parsed.slice(JOB_PREFIX.length) as S33RigB1ScenarioJobSuffix;
}

function assertExactPrivateService(request: S33RigB1ScenarioRequest): void {
  if (request.serviceName !== S33_RIG_B1_WORKER_SERVICE) {
    throw new Error('RIG-B1 scenario requires the exact private RIG-B1 K_SERVICE.');
  }
  if (typeof request.serviceRevision !== 'string'
    || request.serviceRevision.length === 0
    || request.serviceRevision !== request.serviceRevision.trim()) {
    throw new Error('RIG-B1 scenario requires the exact nonempty Cloud Run K_REVISION.');
  }
  let url: URL;
  try { url = new URL(request.serviceAudience); } catch {
    throw new Error('RIG-B1 scenario requires the exact normalized private-service OIDC audience.');
  }
  if (url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
    || url.origin !== request.serviceAudience) {
    throw new Error('RIG-B1 scenario requires one exact normalized HTTPS audience origin.');
  }
  if (request.auth.oidcAudience !== request.serviceAudience) {
    throw new Error('Active RIG-B1 scenario OIDC audience differs from the configured private-service audience.');
  }
}

export function deriveS33RigB1SchedulerExecutionIdentity(
  jobResourceRaw: string,
  scheduleTimeRaw: string,
): S33RigB1SchedulerExecutionIdentity {
  const jobResource = exactJobResourceSchema.parse(jobResourceRaw);
  const scheduleTime = canonicalScheduleTime(scheduleTimeRaw);
  const executionId = `sha256:${createHash('sha256')
    .update(`${S33_RIG_B1_SCENARIO_EXECUTION_VERSION}\0${jobResource}\0${scheduleTime}`)
    .digest('hex')}`;
  return Object.freeze({ jobResource, scheduleTime, executionId });
}

function contextFromGate(
  gate: z.infer<typeof activeGateSchema>,
  identity: S33RigB1SchedulerExecutionIdentity,
): S33RigB1ScenarioExecutionContext {
  if (gate.executionId !== identity.executionId
    || gate.scheduleTime !== identity.scheduleTime) {
    throw new Error('RIG-B1 database audit identity differs from the server-derived Scheduler identity.');
  }
  const targetMatches = gate.targetJobResource === identity.jobResource;
  if ((gate.mode === 'TARGET_EXECUTE' || gate.mode === 'TARGET_REPLAY') && !targetMatches) {
    throw new Error('RIG-B1 database gate attempted to execute or replay a non-target Scheduler job.');
  }
  if (gate.mode === 'CONTROLLED_SKIP' && targetMatches) {
    throw new Error('RIG-B1 database gate attempted to skip the armed target as a non-target job.');
  }
  if ((gate.mode === 'TARGET_EXECUTE' || gate.mode === 'TARGET_REPLAY')
    && gate.expectedPending === null) {
    throw new Error('RIG-B1 armed target is missing its durable pending precondition.');
  }
  return Object.freeze({
    generation: gate.generation,
    scenarioLeaseId: gate.scenarioLeaseId,
    scenarioId: gate.scenarioId,
    targetJobResource: gate.targetJobResource,
    namespaceId: gate.namespaceId,
    expectedPending: gate.expectedPending,
    faultWindowId: gate.faultWindowId,
    soakId: gate.soakId,
    runLeaseId: gate.runLeaseId,
    workerRevision: gate.workerRevision,
    schedulerExecutionId: identity.executionId,
    schedulerJobResource: identity.jobResource,
    schedulerScheduleTime: identity.scheduleTime,
    expiresAt: gate.expiresAt,
  });
}

/**
 * Check the durable lease. NORMAL is the only result that preserves ordinary
 * any-method cron behavior. Every active-lease result requires the exact
 * private service, independently verified cron secret and Scheduler OIDC SA.
 */
export async function gateS33RigB1ScenarioRequest(
  request: S33RigB1ScenarioRequest,
  database: S33RigB1ScenarioDb,
): Promise<S33RigB1ScenarioGateResult> {
  const schedulerMarker = primitiveHeader(request.headers, 'x-cloudscheduler');
  const jobHeader = primitiveHeader(request.headers, 'x-cloudscheduler-jobname');
  const scheduleHeader = primitiveHeader(request.headers, 'x-cloudscheduler-scheduletime');
  const anySchedulerHeader = schedulerMarker !== null || jobHeader !== null || scheduleHeader !== null;
  if (anySchedulerHeader
    && (schedulerMarker !== 'true' || jobHeader === null || scheduleHeader === null)) {
    throw new Error('RIG-B1 Scheduler identity requires all three exact Cloud Scheduler headers.');
  }
  const identity = jobHeader === null || scheduleHeader === null
    ? null
    : deriveS33RigB1SchedulerExecutionIdentity(jobHeader, scheduleHeader);
  if (identity !== null) {
    const suffix = suffixForJobResource(identity.jobResource);
    if (S33_RIG_B1_SCENARIO_JOB_ROUTES[suffix] !== request.routePath) {
      throw new Error('RIG-B1 Scheduler job resource does not match the exact request route.');
    }
  }

  const response = await database.rpc('gate_s33_rig_b1_scenario_execution', {
    p_job_resource: identity?.jobResource ?? null,
    p_schedule_time: identity?.scheduleTime ?? null,
    p_route_path: request.routePath,
    p_worker_id: request.serviceRevision ?? null,
    p_auth_method: request.auth.method,
    p_auth_accepted: request.auth.accepted,
    p_cron_secret_valid: request.auth.cronSecretValid,
    p_oidc_principal: request.auth.oidcPrincipal,
    p_oidc_email_verified: request.auth.oidcEmailVerified,
    p_oidc_audience: request.auth.oidcAudience,
    p_service_name: request.serviceName ?? null,
    p_service_audience: request.serviceAudience,
  });
  if (response.error) {
    throw new Error(`RIG-B1 durable scenario gate failed: ${response.error.message ?? 'unknown database error'}`);
  }
  const gate = gateResultSchema.parse(response.data);
  if (gate.mode === 'NORMAL') return Object.freeze({ mode: 'NORMAL' as const });

  assertExactPrivateService(request);
  if (!request.auth.accepted
    || (request.auth.method !== 'google-oidc' && request.auth.method !== 'combined')) {
    throw new Error('Active RIG-B1 scenario requires independently verified Scheduler OIDC authentication.');
  }
  if (!request.auth.cronSecretValid) {
    throw new Error('Active RIG-B1 scenario requires the exact cron secret in addition to OIDC.');
  }
  if (request.auth.oidcPrincipal !== S33_RIG_B1_CRON_SERVICE_ACCOUNT) {
    throw new Error('Active RIG-B1 scenario OIDC principal is not the exact Scheduler service account.');
  }
  if (!request.auth.oidcEmailVerified) {
    throw new Error('Active RIG-B1 scenario requires the exact verified OIDC email claim.');
  }
  if (identity === null) {
    throw new Error('Active RIG-B1 scenario requires server-observed Cloud Scheduler identity headers.');
  }
  const context = contextFromGate(gate, identity);
  if (context.workerRevision !== request.serviceRevision) {
    throw new Error('RIG-B1 database gate worker revision differs from Cloud Run K_REVISION.');
  }
  if (gate.mode === 'TARGET_EXECUTE') {
    return Object.freeze({ mode: 'TARGET_EXECUTE' as const, context });
  }
  const replay = gate.mode === 'TARGET_REPLAY';
  const preparing = gate.mode === 'PREPARING_SKIP';
  return Object.freeze({
    mode: 'CONTROLLED_SKIP' as const,
    statusCode: 200 as const,
    context,
    body: Object.freeze({
      controlledSkip: true as const,
      reason: replay
        ? 's33_rig_b1_target_replay' as const
        : preparing
          ? 's33_rig_b1_preparing' as const
          : 's33_rig_b1_non_target_during_active_scenario' as const,
      scenarioId: context.scenarioId,
      schedulerExecutionId: context.schedulerExecutionId,
      targetJobResource: context.targetJobResource,
    }),
  });
}
