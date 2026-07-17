/**
 * Production clock/start adapter for the one S3.3 RIG-R release soak.
 *
 * The CTO-signed provision envelope is the existing authority boundary. This
 * module adds no key or ceremony: it re-verifies that envelope, re-observes the
 * exact admitted live identity, creates a generation-zero locked start receipt,
 * supervises the fixed T3 clock, and only then delegates the existing release
 * driver. It never provisions a resource or detaches a background process.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { runAiSoakHarness, type AiSoakHarnessRunOptions } from './ai-soak-harness';
import { buildTemplatePayload } from './ai-eval/harness-core';
import { allGoldenEntries, gateGoldenEntries } from './ai-eval/golden';
import { parseDocVariants } from './ai-eval/corpus';
import {
  callAiEndpoint,
  randomForwardedFor,
  type WorkerIdentity,
} from './ai-eval/ai-client';
import {
  buildEvalRecord,
  buildExtractPayload,
  certifyRound,
  fieldsFromExtractResponse,
  LIVE_PROVIDERS,
  providerFromBody,
  saltForRound,
  scoreEntry,
} from './ai-eval/eval-core';
import {
  newReliabilityStats,
  recordReliability,
  reliabilityReport,
} from './ai-eval/reliability';
import { pickIdentity } from './ai-eval/rate';
import type { EntryEvalResult } from './ai-eval/scoring';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import {
  createProductionRigRProvisionApprovalVerifier,
  type RigRProvisionExpectedBinding,
} from './s33-rig-r-provision-approval.mjs';
import {
  runS33RigRReleaseDriver,
  validateS33RigRProvisionBinding,
  type S33RigRProvisionBinding,
} from './s33-rig-r-release-driver';
import { composeS33RigRReleaseEvidence } from './s33-rig-r-release-evidence';

export const RIG_R_WORKER_UPTIME_MIN = 2880;
export const RIG_R_WALL_MIN = 2910;
export const RIG_R_HEARTBEAT_INTERVAL_MIN = 5;
export const RIG_R_SESSION_REFRESH_INTERVAL_MIN = 45;
export const RIG_R_SESSION_REFRESH_START_MIN = 30;
export const RIG_R_TEARDOWN_RESERVE_MIN = 360;

const PROJECT_ID = 'arkova1';
const REGION = 'us-central1';
const RECEIPT_BUCKET = 'arkova1-s33-immutable-authority-ledger';
const RECEIPT_PREFIX = 's33/rig-r/release-start-receipts';
// CTO-authorized recovery namespace. The first immutable receipt is retained as
// superseded/non-merge-grade; this exact suffix prevents replaying or
// overwriting either its receipt or its partial local evidence paths.
const START_ATTEMPT_ID = 'real-provider-recovery-7';
const LEASE_URI = `gs://${RECEIPT_BUCKET}/s33/rig-leases/RIG-R.singleton.json`;
const SOURCE_IMAGE_REPOSITORY =
  'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker';
const ENDPOINT_ID = '733002';
const ENDPOINT = `projects/${PROJECT_ID}/locations/${REGION}/endpoints/${ENDPOINT_ID}`;
const CANONICAL_ENDPOINT = `projects/270018525501/locations/${REGION}/endpoints/${ENDPOINT_ID}`;
const ENDPOINT_DISPLAY_NAME = 'arkova-s33-rig-r-release-v6';
const MODEL = 'projects/270018525501/locations/us-central1/models/6611494259700793344';
const MODEL_VERSION = `${MODEL}@1`;
const CHECKPOINT_ID = '6';
const DEPLOYED_MODEL_ID = '7330021';
const RUNTIME_SA = 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com';
const SERVICE = 'arkova-worker-s33-r-staging';
const SUPABASE_PROJECT_NAME = 'arkova-soak-s33-r';
const SUPABASE_ORG_ID = 'byhkazrpmivhcsuqjtva';
const GIT_BINARY = '/usr/bin/git';
const GCLOUD_BINARY = '/opt/homebrew/bin/gcloud';
const DOCKER_BINARY = '/usr/local/bin/docker';
const BASH_BINARY = '/bin/bash';
const GCLOUD_PYTHON = '/opt/homebrew/bin/python3';
const COMMAND_TIMEOUT_MS = 120_000;
const LONG_COMMAND_TIMEOUT_MS = 4 * 60 * 60_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_IAM_POLICY_BYTES = 256 * 1024;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const PRECLOCK_NETWORK_TIMEOUT_MS = 2 * 60_000;
const SESSION_REFRESH_ATTEMPT_TIMEOUT_MS = 45_000;
const SESSION_REFRESH_RETRY_DELAYS_MS = [5_000, 15_000] as const;
const SESSION_REFRESH_RETRY_BUDGET_MS = 3 * SESSION_REFRESH_ATTEMPT_TIMEOUT_MS
  + SESSION_REFRESH_RETRY_DELAYS_MS[0]
  + SESSION_REFRESH_RETRY_DELAYS_MS[1];
const SESSION_CLEANUP_NETWORK_TIMEOUT_MS = 4 * 60_000;
const SUPERVISOR_POLL_MAX_MS = 4 * 60_000;
const HEARTBEAT_NETWORK_TIMEOUT_MS = 45_000;
const SESSION_POOL_SIZE = 4;
const LOAD_RATE_PER_HOUR = 5_200;
const MIN_ACHIEVED_REQUESTS_PER_HOUR = 5_000;
const LIVE_EVAL_ROUNDS = 96;
const LIVE_EVAL_ENTRIES_PER_ROUND = 48;
const LIVE_EVAL_WINDOW_MS = 30 * 60_000;
const LIVE_EVAL_REQUEST_INTERVAL_MS = LIVE_EVAL_WINDOW_MS / LIVE_EVAL_ENTRIES_PER_ROUND;
const LIVE_EVAL_REQUEST_TIMEOUT_MS = 30_000;
const TEMPLATE_ROUTE = '/api/v1/ai/template';

const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const timestamp = z.string().datetime({ offset: true });
const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);
const projectRef = z.string().regex(/^[a-z]{20}$/u);
const numericId = z.string().regex(/^[1-9][0-9]*$/u);

const immutableLedgerSchema = z.object({
  backend: z.literal('gcs-if-generation-match-0-locked-retention'),
  bucket: z.literal(RECEIPT_BUCKET),
  projectId: z.literal(PROJECT_ID),
  requiresPerObjectRetention: z.literal(true),
}).strict();

const secretReferencesSchema = z.object({
  supabaseUrl: z.literal('supabase-url-s33-r-staging@1'),
  supabaseServiceRoleKey: z.literal('supabase-service-role-key-s33-r-staging@1'),
  stripeSecretKey: z.literal('stripe-secret-key-staging@1'),
  stripeWebhookSecret: z.literal('stripe-webhook-secret-staging@1'),
  apiKeyHmacSecret: z.literal('api-key-hmac-secret-staging@1'),
  cronSecret: z.literal('cron-secret@1'),
  geminiApiKey: z.literal('gemini-api-key@2'),
}).strict();

const approvalCandidateSchema = z.object({
  sourceHeadSha: gitSha,
  sourceTreeSha: gitSha,
  sourceHeadImageRef: z.string().min(1),
  imageDigest: sha256,
  provisionArtifactSha256: sha256,
  rigName: z.literal('s33-r'),
  rigProfile: z.literal('gemini-release'),
  soakId: boundedId,
  leaseId: boundedId,
  requiredWallMin: z.number().int().min(RIG_R_WALL_MIN).safe(),
  vertexEndpointId: z.literal(ENDPOINT_ID),
  vertexEndpoint: z.literal(ENDPOINT),
  vertexEndpointDisplayName: z.literal(ENDPOINT_DISPLAY_NAME),
  vertexModel: z.literal(MODEL),
  vertexModelVersion: z.literal(MODEL_VERSION),
  checkpointId: z.literal(CHECKPOINT_ID),
  deployedModelId: z.literal(DEPLOYED_MODEL_ID),
  deployedModelDisplayName: z.literal(ENDPOINT_DISPLAY_NAME),
  deploymentResourcesMode: z.literal('TUNED_GEMINI_AUTOMATIC_RESOURCES'),
  minReplicaCount: z.literal(1),
  maxReplicaCount: z.literal(1),
  endpointIamRole: z.literal('roles/aiplatform.endpointUser'),
  endpointIamMember: z.literal(`serviceAccount:${RUNTIME_SA}`),
  provisionStartedAt: timestamp,
  expiresAt: timestamp,
  teardownScriptSha256: sha256,
  secretReferences: secretReferencesSchema,
  immutableLedger: immutableLedgerSchema,
}).strict();

const verifiedApprovalSchema = z.object({
  status: z.literal('VERIFIED'),
  approvalId: boundedId,
  canonicalSha256: sha256,
  approverIdentity: z.literal('arkova.s33.approver.founder-cto.v1'),
  candidate: approvalCandidateSchema,
}).passthrough();

const admissionSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('isolated_rig_admission'),
  generated_at: timestamp,
  rig_name: z.literal('s33-r'),
  rig_id: z.literal('RIG-R'),
  profile: z.literal('gemini-release'),
  soak_id: boundedId,
  lease_id: boundedId,
  gcp_project_id: z.literal(PROJECT_ID),
  supabase_org_id: z.literal(SUPABASE_ORG_ID),
  region: z.literal(REGION),
  cloud_run_service: z.literal(SERVICE),
  tier: z.literal('T3'),
  duration_min: z.literal(RIG_R_WORKER_UPTIME_MIN),
  required_uptime_min: z.literal(RIG_R_WORKER_UPTIME_MIN),
  required_wall_min: z.number().int().min(RIG_R_WALL_MIN).safe(),
  sha: gitSha,
  declared_source_head: gitSha,
  source_head_image_ref: z.string().min(1),
  source_head_image_digest: sha256,
  image_digest: sha256,
  deployed_revision: z.string().regex(/^arkova-worker-s33-r-staging-[a-z0-9-]+$/u),
  deployed_image_ref: z.string().min(1),
  deployed_image_digest: sha256,
  deployed_source_head: gitSha,
  tag_url: z.string().url().refine((value) => value.startsWith('https://')),
  supabase_project_ref: projectRef,
  preflight_result: z.literal('environment_type=clean_mirror'),
  clean_mirror_attestation_id: sha256,
  critical_config: z.object({
    gemini_tuned_model: z.literal(ENDPOINT),
    gemini_v6_prompt: z.literal('true'),
    gemini_tuned_response_schema: z.literal('<unset>'),
  }).passthrough(),
  scheduler: z.object({
    applicable: z.literal(false),
    jobs: z.tuple([]),
    activation_mode: z.literal('PAUSED'),
  }).passthrough(),
  rig_r: z.object({
    candidate_head_sha: gitSha,
    candidate_tree_sha: gitSha,
    provision_artifact_sha256: sha256,
    tier: z.literal('T3'),
    required_worker_uptime_min: z.literal(RIG_R_WORKER_UPTIME_MIN),
    required_wall_min: z.number().int().min(RIG_R_WALL_MIN).safe(),
    provision_started_at: timestamp,
    hard_stop_expires_at: timestamp,
    cto_provision_authority_status: z.literal('VERIFIED'),
    provision_approval: verifiedApprovalSchema,
    project: z.literal(PROJECT_ID),
    region: z.literal(REGION),
    supabase_project_name: z.literal(SUPABASE_PROJECT_NAME),
    supabase_project_ref: projectRef,
    cloud_run_service: z.literal(SERVICE),
    runtime_service_account: z.literal(RUNTIME_SA),
    vertex_endpoint: z.literal(ENDPOINT),
    vertex_model: z.literal(MODEL),
    deployed_model_id: z.literal(DEPLOYED_MODEL_ID),
    chain_mode: z.literal('mocked'),
    contained_database_queues: z.tuple([z.literal('ai-rollback'), z.literal('chain-fault')]),
    scheduler_jobs: z.tuple([]),
    managed_queues: z.tuple([]),
    oidc_identities: z.tuple([]),
    lease: z.object({
      cardinality: z.literal(1),
      lease_id: boundedId,
      object_uri: z.literal(LEASE_URI),
      object_name_is_code_fixed: z.literal(true),
      acquisition: z.literal('gcs-singleton-if-generation-match-0'),
      release: z.literal('ownership-verified-generation-bound-delete'),
    }).strict(),
  }).passthrough(),
}).passthrough().superRefine((value, context) => {
  const candidate = value.rig_r.provision_approval.candidate;
  const expectedFullImage = `${SOURCE_IMAGE_REPOSITORY}:${value.declared_source_head}@${value.image_digest}`;
  const heads = [
    value.sha,
    value.declared_source_head,
    value.deployed_source_head,
    value.rig_r.candidate_head_sha,
    candidate.sourceHeadSha,
  ];
  const digests = [
    value.source_head_image_digest,
    value.image_digest,
    value.deployed_image_digest,
    candidate.imageDigest,
  ];
  if (new Set(heads).size !== 1) {
    context.addIssue({ code: 'custom', path: ['declared_source_head'], message: 'RIG-R HEAD bindings differ.' });
  }
  if (new Set(digests).size !== 1) {
    context.addIssue({ code: 'custom', path: ['image_digest'], message: 'RIG-R image digest bindings differ.' });
  }
  if (value.rig_r.candidate_tree_sha !== candidate.sourceTreeSha
    || value.source_head_image_ref !== `${SOURCE_IMAGE_REPOSITORY}:${value.declared_source_head}`
    || candidate.sourceHeadImageRef !== expectedFullImage
    || value.deployed_image_ref !== `${SOURCE_IMAGE_REPOSITORY}@${value.image_digest}`
    || value.rig_r.provision_artifact_sha256 !== candidate.provisionArtifactSha256
    || value.rig_r.provision_approval.canonicalSha256 !== candidate.provisionArtifactSha256
    || value.soak_id !== candidate.soakId
    || value.lease_id !== candidate.leaseId
    || value.lease_id !== value.rig_r.lease.lease_id
    || value.required_wall_min !== value.rig_r.required_wall_min
    || value.required_wall_min !== candidate.requiredWallMin
    || value.rig_r.provision_started_at !== candidate.provisionStartedAt
    || value.rig_r.hard_stop_expires_at !== candidate.expiresAt
    || value.supabase_project_ref !== value.rig_r.supabase_project_ref) {
    context.addIssue({ code: 'custom', path: ['rig_r'], message: 'RIG-R exact provision/admission binding differs.' });
  }
});

export type S33RigRReleaseAdmission = z.infer<typeof admissionSchema>;

const liveObservationSchema = z.object({
  candidateHeadSha: gitSha,
  candidateTreeSha: gitSha,
  fullShaImageRef: z.string().min(1),
  imageDigest: sha256,
  imagePlatform: z.literal('linux/amd64'),
  revision: z.string().min(1),
  serviceUrl: z.string().url(),
  runtimeServiceAccount: z.literal(RUNTIME_SA),
  runtimeServiceAccountUniqueId: numericId,
  supabaseProjectRef: projectRef,
  vertexEndpoint: z.literal(ENDPOINT),
  vertexModel: z.literal(MODEL),
  deployedModelId: z.literal(DEPLOYED_MODEL_ID),
  leaseId: boundedId,
  leaseGeneration: numericId,
  schedulerJobCount: z.literal(0),
  managedQueueCount: z.literal(0),
  oidcIdentityCount: z.literal(0),
  inProcessJobsDisabled: z.literal(true),
  observedAt: timestamp,
}).strict();

export type S33RigRLiveObservation = z.infer<typeof liveObservationSchema>;

const preclockSchema = z.object({
  status: z.literal('PRECLOCK_AUTH_READY'),
  verifiedAt: timestamp,
  sessionIdentityCount: z.number().int().min(4).max(29),
  sessionRefreshVerifiedCount: z.number().int().min(4).max(29),
  cloudRunBoundary: z.object({
    missingIngressTokenStatus: z.literal(401),
    missingAppTokenStatus: z.literal(401),
    invalidAppTokenStatus: z.literal(401),
    validExactUserStatus: z.literal(200),
  }).strict(),
  vertexCapabilityProbe: z.object({
    status: z.literal('PASSED_PRECLOCK_NO_CUSTOMER_DATA'),
    endpoint: z.literal(ENDPOINT),
    runtimeServiceAccount: z.literal(RUNTIME_SA),
  }).strict(),
}).strict();

export type S33RigRPreclockReadiness = z.infer<typeof preclockSchema>;

export interface S33RigRStartReceipt {
  readonly schemaVersion: 'arkova.s33.rig-r.release-start-receipt/v1';
  readonly receiptId: string;
  readonly approvalId: string;
  readonly provisionArtifactSha256: string;
  readonly approverIdentity: 'arkova.s33.approver.founder-cto.v1';
  readonly soakId: string;
  readonly leaseId: string;
  readonly candidateHeadSha: string;
  readonly candidateTreeSha: string;
  readonly fullShaImageRef: string;
  readonly imageDigest: string;
  readonly imagePlatform: 'linux/amd64';
  readonly gcpProjectId: 'arkova1';
  readonly cloudRunService: typeof SERVICE;
  readonly revision: string;
  readonly serviceUrl: string;
  readonly runtimeServiceAccount: typeof RUNTIME_SA;
  readonly runtimeServiceAccountUniqueId: string;
  readonly supabaseProjectRef: string;
  readonly vertexEndpoint: typeof ENDPOINT;
  readonly vertexModel: typeof MODEL;
  readonly deployedModelId: typeof DEPLOYED_MODEL_ID;
  readonly leaseGeneration: string;
  readonly workerUptimeMin: 2880;
  readonly wallMin: number;
  readonly heartbeatIntervalMin: 5;
  readonly sessionRefreshIntervalMin: 45;
  readonly backgroundExecution: 'DISABLED';
  readonly startedAt: string;
  readonly authorityExpiresAt: string;
  readonly preclockReadiness: S33RigRPreclockReadiness;
}

export interface S33RigRHarnessRequest {
  readonly receipt: S33RigRStartReceipt;
  readonly workerUptimeMin: 2880;
  readonly wallMin: number;
  readonly heartbeatIntervalMin: 5;
  readonly sessionRefreshIntervalMin: 45;
}

export interface S33RigRHarnessOutcome {
  readonly configuredWorkerUptimeMin: number;
  readonly configuredWallMin: number;
  readonly workerUptimeMs: number;
  readonly wallElapsedMs: number;
  readonly maximumHeartbeatGapMs: number;
  readonly sessionRefreshIntervalMs: number;
  readonly harnessDurationSec: number;
  readonly liveEvalRounds: 96;
  readonly liveEvalMeritedRounds: 96;
  readonly liveEvalEvidencePath: string;
  readonly liveEvalEvidenceSha256: string;
  readonly completedAt: string;
}

export interface S33RigRReleaseProductionPort {
  now(): Date;
  verifyProvisionApproval(
    rawEnvelope: string,
    expected: RigRProvisionExpectedBinding,
    now: Date,
  ): unknown | Promise<unknown>;
  observeExactIdentity(admission: S33RigRReleaseAdmission): Promise<unknown>;
  preparePreclock(
    admission: S33RigRReleaseAdmission,
    observation: S33RigRLiveObservation,
  ): Promise<unknown>;
  loadStartReceipt(receiptId: string): Promise<unknown | null>;
  persistStartReceipt(receipt: S33RigRStartReceipt): Promise<void>;
  runSupervisedHarness(request: S33RigRHarnessRequest): Promise<S33RigRHarnessOutcome>;
  runReleaseDriver(
    binding: S33RigRProvisionBinding,
    context: Readonly<{ receipt: S33RigRStartReceipt; harness: S33RigRHarnessOutcome }>,
  ): Promise<unknown>;
  cleanupPreparation(): Promise<void>;
  teardown(
    binding: S33RigRProvisionBinding,
    reason: 'driver-failure' | 'authority-expiry' | 'evidence-complete',
    admission?: S33RigRReleaseAdmission,
  ): Promise<void>;
}

export interface S33RigRReleaseProductionResult {
  readonly status: 'RIG_R_RELEASE_EVIDENCE_BOUND';
  readonly receipt: S33RigRStartReceipt;
  readonly harness: S33RigRHarnessOutcome;
  readonly release: unknown;
}

class S33RigRReplayError extends Error {}
class S33RigRAuthorityExpiryError extends Error {}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactNow(port: Pick<S33RigRReleaseProductionPort, 'now'>): Date {
  const value = port.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('RIG-R production adapter observed an invalid current time.');
  }
  return value;
}

async function beforeAuthorityExpiry<T>(
  port: Pick<S33RigRReleaseProductionPort, 'now'>,
  expiresAt: string,
  operation: () => Promise<T>,
): Promise<T> {
  const remainingMs = Date.parse(expiresAt) - exactNow(port).getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new S33RigRAuthorityExpiryError('RIG-R CTO authority expired before post-harness evidence completed.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new S33RigRAuthorityExpiryError(
      'RIG-R CTO authority expired during post-harness evidence.',
    )), remainingMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), hardStop]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function validateS33RigRReleaseAdmission(value: unknown): S33RigRReleaseAdmission {
  let snapshot: unknown;
  try { snapshot = structuredClone(value); } catch (error) {
    throw new TypeError('RIG-R release admission must be immutable JSON data.', { cause: error });
  }
  const parsed = admissionSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error(`RIG-R release admission rejected: ${z.prettifyError(parsed.error)}`);
  }
  return deepFreeze(parsed.data);
}

function expectedApproval(admission: S33RigRReleaseAdmission): RigRProvisionExpectedBinding {
  return { ...admission.rig_r.provision_approval.candidate };
}

function provisionBinding(admission: S33RigRReleaseAdmission): S33RigRProvisionBinding {
  return validateS33RigRProvisionBinding({
    schemaVersion: 'arkova.s33.rig-r.provision-binding/v1',
    rigId: 'RIG-R',
    rigName: admission.rig_name,
    profile: admission.profile,
    tier: admission.tier,
    candidateHeadSha: admission.declared_source_head,
    candidateTreeSha: admission.rig_r.candidate_tree_sha,
    imageDigest: admission.image_digest,
    provisionArtifactSha256: admission.rig_r.provision_artifact_sha256,
    gcpProjectId: admission.gcp_project_id,
    supabaseProjectName: admission.rig_r.supabase_project_name,
    cloudRunService: admission.cloud_run_service,
    runtimeServiceAccount: admission.rig_r.runtime_service_account,
    vertexEndpoint: admission.rig_r.vertex_endpoint,
    vertexModel: admission.rig_r.vertex_model,
    deployedModelId: admission.rig_r.deployed_model_id,
    containedDatabaseQueues: admission.rig_r.contained_database_queues,
    managedSchedulerJobs: admission.rig_r.scheduler_jobs,
    managedQueues: admission.rig_r.managed_queues,
    oidcIdentities: admission.rig_r.oidc_identities,
    leaseId: admission.lease_id,
    requiredWorkerUptimeMin: admission.required_uptime_min,
    requiredWallMin: admission.required_wall_min,
    provisionStartedAt: admission.rig_r.provision_started_at,
    expiresAt: admission.rig_r.hard_stop_expires_at,
  });
}

function assertApprovalExact(
  admission: S33RigRReleaseAdmission,
  rawVerified: unknown,
): z.infer<typeof verifiedApprovalSchema> {
  const verified = verifiedApprovalSchema.parse(rawVerified);
  const embedded = admission.rig_r.provision_approval;
  if (verified.approvalId !== embedded.approvalId
    || verified.canonicalSha256 !== admission.rig_r.provision_artifact_sha256
    || verified.approverIdentity !== embedded.approverIdentity
    || !isDeepStrictEqual(verified.candidate, embedded.candidate)) {
    throw new Error('RIG-R re-verified CTO provision artifact differs from the exact admission.');
  }
  return verified;
}

function assertObservationExact(
  admission: S33RigRReleaseAdmission,
  raw: unknown,
  authorizationTime: Date,
): S33RigRLiveObservation {
  const observed = liveObservationSchema.parse(raw);
  const candidate = admission.rig_r.provision_approval.candidate;
  if (observed.candidateHeadSha !== admission.declared_source_head
    || observed.candidateTreeSha !== admission.rig_r.candidate_tree_sha
    || observed.fullShaImageRef !== candidate.sourceHeadImageRef
    || observed.imageDigest !== admission.image_digest
    || observed.revision !== admission.deployed_revision
    || observed.serviceUrl !== admission.tag_url
    || observed.runtimeServiceAccount !== admission.rig_r.runtime_service_account
    || observed.supabaseProjectRef !== admission.supabase_project_ref
    || observed.vertexEndpoint !== admission.rig_r.vertex_endpoint
    || observed.vertexModel !== admission.rig_r.vertex_model
    || observed.deployedModelId !== admission.rig_r.deployed_model_id
    || observed.leaseId !== admission.lease_id) {
    throw new Error('RIG-R live identity differs from the exact admitted HEAD/tree/image/revision/topology/lease.');
  }
  const observedAt = Date.parse(observed.observedAt);
  if (observedAt < authorizationTime.getTime()
    || observedAt >= Date.parse(admission.rig_r.hard_stop_expires_at)) {
    throw new Error('RIG-R exact live identity observation falls outside active CTO authority.');
  }
  return deepFreeze(observed);
}

function assertPreclockExact(
  raw: unknown,
  authorizationTime: Date,
  expiresAt: string,
): S33RigRPreclockReadiness {
  const readiness = preclockSchema.parse(raw);
  const verifiedAt = Date.parse(readiness.verifiedAt);
  if (readiness.sessionIdentityCount !== readiness.sessionRefreshVerifiedCount
    || verifiedAt < authorizationTime.getTime()
    || verifiedAt >= Date.parse(expiresAt)) {
    throw new Error('RIG-R pre-clock authenticated probe/session pool is stale or incomplete.');
  }
  return deepFreeze(readiness);
}

function assertHarnessExact(
  outcome: S33RigRHarnessOutcome,
  request: S33RigRHarnessRequest,
  expiresAt: string,
): S33RigRHarnessOutcome {
  if (outcome.configuredWorkerUptimeMin !== RIG_R_WORKER_UPTIME_MIN
    || outcome.configuredWallMin !== request.wallMin
    || outcome.workerUptimeMs !== RIG_R_WORKER_UPTIME_MIN * 60_000
    || outcome.wallElapsedMs < request.wallMin * 60_000
    || outcome.maximumHeartbeatGapMs > RIG_R_HEARTBEAT_INTERVAL_MIN * 60_000
    || outcome.sessionRefreshIntervalMs > RIG_R_SESSION_REFRESH_INTERVAL_MIN * 60_000
    || outcome.harnessDurationSec < RIG_R_WORKER_UPTIME_MIN * 60
    || outcome.harnessDurationSec >= (RIG_R_WORKER_UPTIME_MIN + 1) * 60
    || outcome.liveEvalRounds !== LIVE_EVAL_ROUNDS
    || outcome.liveEvalMeritedRounds !== LIVE_EVAL_ROUNDS
    || !sha256.safeParse(outcome.liveEvalEvidenceSha256).success
    || outcome.liveEvalEvidencePath.length === 0
    || !Number.isFinite(Date.parse(outcome.completedAt))
    || Date.parse(outcome.completedAt) >= Date.parse(expiresAt)) {
    throw new Error('RIG-R harness exited early or failed the exact 2880 worker-up / >=2910 wall / bounded-heartbeat contract.');
  }
  return deepFreeze(outcome);
}

async function containFailure(
  port: S33RigRReleaseProductionPort,
  binding: S33RigRProvisionBinding,
  admission: S33RigRReleaseAdmission,
  cause: unknown,
): Promise<never> {
  const teardownReason = cause instanceof S33RigRAuthorityExpiryError
    ? 'authority-expiry'
    : 'driver-failure';
  const failures: unknown[] = [];
  try {
    await port.cleanupPreparation();
  } catch (error) {
    failures.push(error);
  }
  try {
    await port.teardown(binding, teardownReason, admission);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [cause, ...failures],
      'RIG-R release failed and one or more ordered compensation steps failed.',
    );
  }
  throw cause;
}

export async function runS33RigRReleaseProduction(
  rawAdmission: unknown,
  rawProvisionApprovalEnvelope: string,
  ctoConfirmation: string,
  port: S33RigRReleaseProductionPort,
): Promise<S33RigRReleaseProductionResult> {
  const admission = validateS33RigRReleaseAdmission(rawAdmission);
  const binding = provisionBinding(admission);
  const authorizationTime = exactNow(port);
  const verified = await port.verifyProvisionApproval(
    rawProvisionApprovalEnvelope,
    expectedApproval(admission),
    authorizationTime,
  );
  const approval = assertApprovalExact(admission, verified);
  const requiredConfirmation = `START_RIG_R:${approval.approvalId}:${admission.soak_id}:${admission.lease_id}:${START_ATTEMPT_ID}`;
  if (ctoConfirmation !== requiredConfirmation) {
    throw new Error(`RIG-R release requires exact CTO confirmation '${requiredConfirmation}'.`);
  }
  const receiptId = `rig-r-release-start:${approval.approvalId}:${admission.soak_id}:${admission.lease_id}:${START_ATTEMPT_ID}`;
  if (await port.loadStartReceipt(receiptId) !== null) {
    throw new S33RigRReplayError('RIG-R release start receipt already exists; replay is forbidden.');
  }

  // Observation is read-only and must succeed before any compensation can use
  // the post-provision project ref (which did not exist when CTO signed).
  const observation = assertObservationExact(
    admission,
    await port.observeExactIdentity(admission),
    authorizationTime,
  );
  const expiry = Date.parse(admission.rig_r.hard_stop_expires_at);
  const minimumSafeExpiry = authorizationTime.getTime()
    + (admission.required_wall_min + RIG_R_TEARDOWN_RESERVE_MIN) * 60_000;
  if (expiry < minimumSafeExpiry) {
    return containFailure(port, binding, admission, new Error(
      'RIG-R CTO authority expiry cannot cover the wall clock plus teardown reserve.',
    ));
  }

  try {
    const preclock = assertPreclockExact(
      await port.preparePreclock(admission, observation),
      authorizationTime,
      admission.rig_r.hard_stop_expires_at,
    );
    const startedAt = exactNow(port);
    if (startedAt.getTime() < Date.parse(preclock.verifiedAt)
      || startedAt.getTime() + (admission.required_wall_min + RIG_R_TEARDOWN_RESERVE_MIN) * 60_000 > expiry) {
      throw new Error('RIG-R start timestamp falls outside the active CTO authority/reserve window.');
    }
    const receipt = deepFreeze<S33RigRStartReceipt>({
      schemaVersion: 'arkova.s33.rig-r.release-start-receipt/v1',
      receiptId,
      approvalId: approval.approvalId,
      provisionArtifactSha256: approval.canonicalSha256,
      approverIdentity: approval.approverIdentity,
      soakId: admission.soak_id,
      leaseId: admission.lease_id,
      candidateHeadSha: observation.candidateHeadSha,
      candidateTreeSha: observation.candidateTreeSha,
      fullShaImageRef: observation.fullShaImageRef,
      imageDigest: observation.imageDigest,
      imagePlatform: observation.imagePlatform,
      gcpProjectId: PROJECT_ID,
      cloudRunService: SERVICE,
      revision: observation.revision,
      serviceUrl: observation.serviceUrl,
      runtimeServiceAccount: observation.runtimeServiceAccount,
      runtimeServiceAccountUniqueId: observation.runtimeServiceAccountUniqueId,
      supabaseProjectRef: observation.supabaseProjectRef,
      vertexEndpoint: observation.vertexEndpoint,
      vertexModel: observation.vertexModel,
      deployedModelId: observation.deployedModelId,
      leaseGeneration: observation.leaseGeneration,
      workerUptimeMin: RIG_R_WORKER_UPTIME_MIN,
      wallMin: admission.required_wall_min,
      heartbeatIntervalMin: RIG_R_HEARTBEAT_INTERVAL_MIN,
      sessionRefreshIntervalMin: RIG_R_SESSION_REFRESH_INTERVAL_MIN,
      backgroundExecution: 'DISABLED',
      startedAt: startedAt.toISOString(),
      authorityExpiresAt: admission.rig_r.hard_stop_expires_at,
      preclockReadiness: preclock,
    });
    await port.persistStartReceipt(receipt);
    const reloaded = await port.loadStartReceipt(receiptId);
    if (!isDeepStrictEqual(reloaded, receipt)) {
      throw new Error('RIG-R generation-zero locked start receipt did not reload exactly.');
    }

    const harnessRequest: S33RigRHarnessRequest = {
      receipt,
      workerUptimeMin: RIG_R_WORKER_UPTIME_MIN,
      wallMin: admission.required_wall_min,
      heartbeatIntervalMin: RIG_R_HEARTBEAT_INTERVAL_MIN,
      sessionRefreshIntervalMin: RIG_R_SESSION_REFRESH_INTERVAL_MIN,
    };
    const harness = assertHarnessExact(
      await port.runSupervisedHarness(harnessRequest),
      harnessRequest,
      admission.rig_r.hard_stop_expires_at,
    );
    const release = await beforeAuthorityExpiry(
      port,
      admission.rig_r.hard_stop_expires_at,
      async () => {
        await port.cleanupPreparation();
        return port.runReleaseDriver(binding, { receipt, harness });
      },
    );
    if (!release || typeof release !== 'object'
      || (release as { status?: unknown }).status !== 'SOAK_EVIDENCE_BOUND') {
      throw new Error('RIG-R release driver returned no exact bound release evidence.');
    }
    await port.teardown(binding, 'evidence-complete', admission);
    return deepFreeze({
      status: 'RIG_R_RELEASE_EVIDENCE_BOUND' as const,
      receipt,
      harness,
      release,
    });
  } catch (error) {
    return containFailure(port, binding, admission, error);
  }
}

export interface S33RigRCommandResult {
  readonly status: 'ok' | 'not-found' | 'error';
  readonly stdout: string;
}

export interface S33RigRCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface S33RigRCommandRunner {
  run(
    binary: string,
    args: readonly string[],
    options?: S33RigRCommandOptions,
  ): Promise<S33RigRCommandResult>;
}

export interface S33RigRProductionDependencies {
  readonly command: S33RigRCommandRunner;
  readonly fetch: typeof fetch;
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly now: () => Date;
  readonly randomId: () => string;
  readonly randomSecret: () => string;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly runHarness: (options: AiSoakHarnessRunOptions) => Promise<unknown>;
}

const projectsSchema = z.array(z.object({
  id: projectRef,
  name: z.string().min(1),
  region: z.string().min(1).optional(),
}).passthrough());

const serviceSchema = z.object({
  metadata: z.object({ name: z.string().min(1) }).passthrough(),
  status: z.object({
    latestReadyRevisionName: z.string().min(1),
    url: z.string().url(),
    traffic: z.array(z.object({
      revisionName: z.string().min(1).optional(),
      percent: z.number().int().min(0).max(100).optional(),
      latestRevision: z.boolean().optional(),
    }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

const revisionSchema = z.object({
  metadata: z.object({
    name: z.string().min(1).optional(),
    labels: z.record(z.string(), z.string()),
  }).passthrough(),
  spec: z.object({
    serviceAccountName: z.string().email(),
    containers: z.array(z.object({
      image: z.string().min(1),
      env: z.array(z.object({
        name: z.string().min(1),
        value: z.string().optional(),
      }).passthrough()),
    }).passthrough()).length(1),
  }).passthrough(),
  status: z.object({ imageDigest: z.string().min(1) }).passthrough(),
}).passthrough();

const serviceAccountSchema = z.object({
  email: z.string().email(),
  uniqueId: numericId,
  disabled: z.boolean().optional(),
}).passthrough();

const endpointSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  deployedModels: z.array(z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    model: z.string().min(1),
    modelVersionId: z.string().min(1),
    checkpointId: z.string().min(1),
    automaticResources: z.object({
      minReplicaCount: z.union([z.number(), z.string()]).transform(Number),
      maxReplicaCount: z.union([z.number(), z.string()]).transform(Number),
    }).strict(),
  }).passthrough()).length(1),
  trafficSplit: z.record(z.string(), z.union([z.number(), z.string()]).transform(Number)),
}).passthrough();

const iamPolicySchema = z.object({
  bindings: z.array(z.object({
    role: z.string().min(1),
    members: z.array(z.string()),
  }).passthrough()),
}).passthrough();

const leaseMetadataSchema = z.object({
  bucket: z.literal(RECEIPT_BUCKET),
  name: z.literal('s33/rig-leases/RIG-R.singleton.json'),
  generation: z.union([z.string(), z.number()]).transform(String).pipe(numericId),
}).passthrough();

const leaseSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-r.exclusive-lease/v1'),
  leaseId: boundedId,
  rigId: z.literal('RIG-R'),
  rigName: z.literal('s33-r'),
  profile: z.literal('gemini-release'),
  candidateHeadSha: gitSha,
  candidateTreeSha: gitSha,
  imageDigest: sha256,
  vertexEndpoint: z.literal(ENDPOINT),
  vertexModel: z.literal(MODEL),
  deployedModelId: z.literal(DEPLOYED_MODEL_ID),
  provisionArtifactSha256: sha256,
  provisionStartedAt: timestamp,
  expiresAt: timestamp,
}).strict();

const imagePlatformSchema = z.union([
  z.object({ architecture: z.literal('amd64'), os: z.literal('linux') }).passthrough(),
  z.object({ config: z.object({ architecture: z.literal('amd64'), os: z.literal('linux') }).passthrough() }).passthrough(),
]);

const apiKeysSchema = z.array(z.object({
  name: z.string().min(1),
  api_key: z.string().min(1),
}).passthrough());

const adminUserSchema = z.union([
  z.object({ id: z.string().uuid() }).passthrough(),
  z.object({ user: z.object({ id: z.string().uuid() }).passthrough() }).passthrough(),
]);

const sessionSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  user: z.object({ id: z.string().uuid() }).passthrough(),
}).passthrough();

const jwtSchema = z.object({
  sub: z.string().min(1),
  exp: z.number().int().positive(),
  iss: z.string().url().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
}).passthrough();

const receiptMetadataSchema = z.object({
  bucket: z.literal(RECEIPT_BUCKET),
  name: z.string().min(1),
  generation: z.union([z.string(), z.number()]).transform(String).pipe(numericId),
  retention: z.object({
    mode: z.literal('Locked'),
    retainUntilTime: timestamp,
  }).passthrough(),
}).passthrough();

const harnessSummarySchema = z.object({
  durationSec: z.number().finite().min(RIG_R_WORKER_UPTIME_MIN * 60),
  totalRequests: z.number().int().min(MIN_ACHIEVED_REQUESTS_PER_HOUR * 48),
  achievedRequestsPerHour: z.number().finite().min(MIN_ACHIEVED_REQUESTS_PER_HOUR),
}).passthrough();

interface PreparedIdentity {
  readonly userId: string;
  readonly label: string;
  refreshToken: string;
  readonly workerIdentity: WorkerIdentity;
}

interface PreparedState {
  readonly admission: S33RigRReleaseAdmission;
  readonly observation: S33RigRLiveObservation;
  readonly supabaseUrl: string;
  readonly publicKey: string;
  readonly serviceRoleKey: string;
  readonly identities: PreparedIdentity[];
  ingressToken: string;
}

function parseStrict<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  const result = schema.safeParse(parseJsonRejectingDuplicateKeys(raw, label));
  if (!result.success) throw new Error(`${label} did not match its strict production schema.`);
  return result.data;
}

function requireOk(result: S33RigRCommandResult, label: string): string {
  if (result.status !== 'ok') throw new Error(`${label} failed.`);
  return result.stdout;
}

async function boundedResponseText(
  response: Response,
  label: string,
  maximumBytes = MAX_IAM_POLICY_BYTES,
): Promise<string> {
  const advertisedLength = response.headers.get('content-length');
  if (advertisedLength !== null
    && (!/^[0-9]+$/u.test(advertisedLength) || Number(advertisedLength) > maximumBytes)) {
    throw new Error(`${label} exceeded the bounded response size.`);
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeded the bounded response size.`);
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function digestFromImageReference(value: string): string {
  const marker = value.lastIndexOf('@sha256:');
  const digest = marker >= 0 ? value.slice(marker + 1) : value;
  if (!sha256.safeParse(digest).success) throw new Error('Observed image reference has no immutable SHA-256 digest.');
  return digest;
}

function sha256Raw(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function exactEvalArtifactPath(
  stdout: string,
  prefix: 'Eval raw' | 'Analysis saved to',
  fileName: RegExp,
): { path: string; absolutePath: string } {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const matches = [...stdout.matchAll(new RegExp(`^${escaped}:\\s+([^\\r\\n]+)$`, 'gmu'))];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error(`RIG-R supplemental eval emitted no unique ${prefix} artifact path.`);
  }
  const base = resolve(process.cwd(), 'services/worker/docs/eval');
  const absolutePath = resolve(process.cwd(), 'services/worker', matches[0][1].trim());
  const path = relative(base, absolutePath);
  if (path === '..' || path.startsWith(`..${sep}`) || !fileName.test(path)) {
    throw new Error(`RIG-R supplemental eval ${prefix} path escaped its exact evidence directory.`);
  }
  return { path: `services/worker/docs/eval/${path}`, absolutePath };
}

function envValue(revision: z.infer<typeof revisionSchema>, name: string): string | undefined {
  const matches = revision.spec.containers[0].env.filter((entry) => entry.name === name);
  if (matches.length > 1) throw new Error(`Cloud Run revision contains duplicate ${name} environment bindings.`);
  return matches[0]?.value;
}

function decodeJwt(token: string, label: string): z.infer<typeof jwtSchema> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) throw new Error(`${label} is not a JWT.`);
  try {
    return jwtSchema.parse(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  } catch {
    throw new Error(`${label} has invalid claims.`);
  }
}

function userId(value: z.infer<typeof adminUserSchema>): string {
  if ('id' in value && typeof value.id === 'string') return value.id;
  if ('user' in value && value.user !== null && typeof value.user === 'object'
    && 'id' in value.user && typeof value.user.id === 'string') return value.user.id;
  throw new Error('RIG-R Supabase admin response has no exact user ID.');
}

function receiptObject(receiptId: string): { uri: string; name: string } {
  const digest = createHash('sha256').update(receiptId, 'utf8').digest('hex');
  const name = `${RECEIPT_PREFIX}/${digest}.json`;
  return { name, uri: `gs://${RECEIPT_BUCKET}/${name}` };
}

function commandEnvironment(binary: string, ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return binary === GCLOUD_BINARY ? { ...ambient, CLOUDSDK_PYTHON: GCLOUD_PYTHON } : ambient;
}

class NodeCommandRunner implements S33RigRCommandRunner {
  async run(
    binary: string,
    args: readonly string[],
    options: S33RigRCommandOptions = {},
  ): Promise<S33RigRCommandResult> {
    return new Promise((resolveResult) => {
      execFile(binary, [...args], {
        encoding: 'utf8',
        shell: false,
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: options.env ?? commandEnvironment(binary),
      }, (error, stdout, stderr) => {
        if (!error) return resolveResult({ status: 'ok', stdout });
        const missing = /(?:not found|no urls matched|urls matched no objects|404)/iu.test(stderr);
        return resolveResult({ status: missing ? 'not-found' : 'error', stdout: '' });
      });
    });
  }
}

function exactDependencyNow(dependencies: S33RigRProductionDependencies): Date {
  const now = dependencies.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('RIG-R production dependencies returned invalid time.');
  }
  return now;
}

export interface S33RigRRefreshOperation {
  readonly label: string;
  readonly run: () => Promise<void>;
}

async function runBoundedRefreshBatch(
  operations: readonly S33RigRRefreshOperation[],
  sleep: S33RigRProductionDependencies['sleep'],
  signal: AbortSignal,
): Promise<void> {
  let pending = [...operations];
  let lastFailures: Error[] = [];
  for (let attempt = 1; attempt <= SESSION_REFRESH_RETRY_DELAYS_MS.length + 1; attempt += 1) {
    if (signal.aborted) throw new Error('RIG-R session refresh retry was aborted.');
    const current = pending;
    const settled = await Promise.allSettled(current.map(({ run }) => run()));
    pending = [];
    lastFailures = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') return;
      const operation = current[index]!;
      pending.push(operation);
      lastFailures.push(new Error(
        `RIG-R ${operation.label} failed on bounded refresh attempt ${attempt}.`,
        { cause: result.reason },
      ));
    });
    if (pending.length === 0) return;
    if (attempt > SESSION_REFRESH_RETRY_DELAYS_MS.length) {
      throw new AggregateError(lastFailures, 'RIG-R bounded session/ingress refresh retries exhausted.');
    }
    await sleep(SESSION_REFRESH_RETRY_DELAYS_MS[attempt - 1]!, signal);
  }
}

/** Test-only seam for the exact retry policy used by the live supervisor. */
export async function runS33RigRBoundedRefreshBatchForTest(
  operations: readonly S33RigRRefreshOperation[],
  sleep: S33RigRProductionDependencies['sleep'],
  signal: AbortSignal,
): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Injected RIG-R refresh operations are test-only.');
  }
  return runBoundedRefreshBatch(operations, sleep, signal);
}

class S33RigRProductionAdapter implements S33RigRReleaseProductionPort {
  private prepared: PreparedState | undefined;
  private activeAdmission: S33RigRReleaseAdmission | undefined;
  private readonly receiptGenerations = new Map<string, string>();
  private teardownPromise: Promise<void> | undefined;
  private cleanupPromise: Promise<void> | undefined;
  private approvalExpiresAt: string | undefined;

  constructor(private readonly dependencies: S33RigRProductionDependencies) {}

  now(): Date { return exactDependencyNow(this.dependencies); }

  private async withNetworkDeadline<T>(
    maximumMs: number,
    label: string,
    operation: (signal: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    const expiresAt = this.approvalExpiresAt;
    if (expiresAt === undefined) {
      throw new Error(`${label} requires active exact CTO authority.`);
    }
    const remainingAuthorityMs = Date.parse(expiresAt) - this.now().getTime();
    if (!Number.isFinite(remainingAuthorityMs) || remainingAuthorityMs <= 0) {
      throw new S33RigRAuthorityExpiryError(`RIG-R CTO authority expired during ${label}.`);
    }
    const timeoutMs = Math.max(1, Math.min(maximumMs, remainingAuthorityMs));
    const authorityLimited = remainingAuthorityMs <= maximumMs;
    const controller = new AbortController();
    let parentAborted = false;
    const abortFromParent = (): void => {
      parentAborted = true;
      controller.abort();
    };
    if (parentSignal?.aborted === true) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      if (authorityLimited && !parentAborted) {
        throw new S33RigRAuthorityExpiryError(`RIG-R CTO authority expired during ${label}.`);
      }
      throw new Error(`${label} exceeded its bounded network deadline.`, { cause: error });
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }

  async verifyProvisionApproval(
    rawEnvelope: string,
    expected: RigRProvisionExpectedBinding,
    now: Date,
  ): Promise<unknown> {
    const teardownBytes = await this.dependencies.readFile(
      resolve(process.cwd(), 'scripts/staging/teardown-isolated-rig.sh'),
    );
    const checkoutDigest = `sha256:${createHash('sha256').update(teardownBytes).digest('hex')}`;
    if (checkoutDigest !== expected.teardownScriptSha256) {
      throw new Error('RIG-R checked-out canonical teardown bytes differ from CTO provision authority.');
    }
    this.approvalExpiresAt = expected.expiresAt;
    return createProductionRigRProvisionApprovalVerifier().verify(rawEnvelope, expected, now);
  }

  private async observeEmptyList(args: readonly string[], label: string): Promise<number> {
    const parsed = parseStrict(z.array(z.unknown()), requireOk(
      await this.dependencies.command.run(GCLOUD_BINARY, args), label,
    ), label);
    return parsed.length;
  }

  async observeExactIdentity(admission: S33RigRReleaseAdmission): Promise<S33RigRLiveObservation> {
    this.activeAdmission = admission;
    const candidate = admission.rig_r.provision_approval.candidate;
    const checkoutHead = requireOk(await this.dependencies.command.run(
      GIT_BINARY,
      ['rev-parse', 'HEAD'],
    ), 'Checked-out candidate HEAD observation').trim();
    const dirty = requireOk(await this.dependencies.command.run(
      GIT_BINARY,
      ['status', '--porcelain', '--untracked-files=no'],
    ), 'Checked-out candidate cleanliness observation').trim();
    if (checkoutHead !== admission.declared_source_head || dirty.length !== 0) {
      throw new Error('RIG-R must execute from the clean exact admitted candidate HEAD.');
    }
    const observedTree = requireOk(await this.dependencies.command.run(
      GIT_BINARY,
      ['rev-parse', `${admission.declared_source_head}^{tree}`],
    ), 'Candidate tree observation').trim();

    const artifactDigestRef = requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['artifacts', 'docker', 'images', 'describe', admission.source_head_image_ref,
        '--project', PROJECT_ID, '--format=value(image_summary.fully_qualified_digest)'],
    ), 'Full-SHA Artifact Registry observation').trim();
    if (artifactDigestRef !== `${SOURCE_IMAGE_REPOSITORY}@${admission.image_digest}`) {
      throw new Error('Artifact Registry full-SHA tag does not resolve to the admitted digest.');
    }
    const platform = parseStrict(imagePlatformSchema, requireOk(await this.dependencies.command.run(
      DOCKER_BINARY,
      ['buildx', 'imagetools', 'inspect', candidate.sourceHeadImageRef, '--format={{json .Image}}'],
    ), 'OCI image platform observation'), 'OCI image platform observation') as
      | { architecture: 'amd64'; os: 'linux' }
      | { config: { architecture: 'amd64'; os: 'linux' } };
    const normalizedPlatform: { architecture: string; os: string } = 'architecture' in platform ? platform : platform.config;
    const nestedImageConfig = (platform as { config?: { User?: unknown; Env?: unknown } }).config;
    if (normalizedPlatform.architecture !== 'amd64' || normalizedPlatform.os !== 'linux'
      || nestedImageConfig?.User !== 'appuser' || !Array.isArray(nestedImageConfig.Env)
      || !nestedImageConfig.Env.includes(`BUILD_SHA=${admission.declared_source_head}`)) {
      throw new Error('RIG-R image is not the exact linux/amd64 artifact.');
    }

    const projects = parseStrict(projectsSchema, requireOk(await this.dependencies.command.run(
      process.execPath,
      [fileURLToPath(new URL('../../node_modules/supabase/dist/supabase.js', import.meta.url)),
        'projects', 'list', '--output', 'json'],
    ), 'Supabase project observation'), 'Supabase project observation');
    if (projects.filter((project) => project.id === admission.supabase_project_ref
      && project.name === SUPABASE_PROJECT_NAME).length !== 1) {
      throw new Error('Exact RIG-R Supabase project binding was not observed once.');
    }

    const service = parseStrict(serviceSchema, requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['run', 'services', 'describe', SERVICE, '--project', PROJECT_ID, '--region', REGION, '--format=json'],
    ), 'Cloud Run service observation'), 'Cloud Run service observation');
    const exactTraffic = service.status.traffic.filter((entry) =>
      (entry.revisionName === admission.deployed_revision || entry.latestRevision === true)
      && entry.percent === 100);
    if (service.metadata.name !== SERVICE
      || service.status.latestReadyRevisionName !== admission.deployed_revision
      || service.status.url !== admission.tag_url
      || exactTraffic.length !== 1) {
      throw new Error('Cloud Run service/revision/URL/traffic differs from RIG-R admission.');
    }
    const runPolicy = parseStrict(iamPolicySchema, requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['run', 'services', 'get-iam-policy', SERVICE,
        '--project', PROJECT_ID, '--region', REGION, '--format=json'],
    ), 'Cloud Run service IAM observation'), 'Cloud Run service IAM observation');
    const runInvokers = runPolicy.bindings
      .filter(({ role }) => role === 'roles/run.invoker')
      .flatMap(({ members }) => members).sort();
    if (!isDeepStrictEqual(runInvokers, [`serviceAccount:${RUNTIME_SA}`])) {
      throw new Error('RIG-R Cloud Run Invoker IAM differs from its exact authority-bound runtime identity.');
    }

    const revision = parseStrict(revisionSchema, requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['run', 'revisions', 'describe', admission.deployed_revision,
        '--project', PROJECT_ID, '--region', REGION, '--format=json'],
    ), 'Cloud Run revision observation'), 'Cloud Run revision observation');
    if (revision.metadata.labels['arkova-source-head'] !== admission.declared_source_head
      || revision.metadata.labels['arkova-source-tree'] !== admission.rig_r.candidate_tree_sha
      || revision.metadata.labels['arkova-rig-id'] !== 'rig-r'
      || revision.spec.serviceAccountName !== RUNTIME_SA
      || revision.spec.containers[0].image !== admission.deployed_image_ref
      || digestFromImageReference(revision.status.imageDigest) !== admission.image_digest
      || envValue(revision, 'DISABLE_ALL_IN_PROCESS_CRON') !== 'true'
      || envValue(revision, 'GEMINI_TUNED_MODEL') !== ENDPOINT
      || envValue(revision, 'GEMINI_V6_PROMPT') !== 'true'
      || envValue(revision, 'GEMINI_TUNED_RESPONSE_SCHEMA') !== undefined) {
      throw new Error('Cloud Run revision provenance/runtime/background bindings differ from admission.');
    }

    const runtime = parseStrict(serviceAccountSchema, requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['iam', 'service-accounts', 'describe', RUNTIME_SA, '--project', PROJECT_ID, '--format=json'],
    ), 'Runtime service-account observation'), 'Runtime service-account observation');
    if (runtime.email !== RUNTIME_SA || runtime.disabled === true) {
      throw new Error('RIG-R runtime service account is missing, replaced, or disabled.');
    }

    const endpoint = parseStrict(endpointSchema, requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['ai', 'endpoints', 'describe', ENDPOINT_ID, '--project', PROJECT_ID, '--region', REGION, '--format=json'],
    ), 'Vertex endpoint observation'), 'Vertex endpoint observation');
    const deployed = endpoint.deployedModels[0];
    if (endpoint.name !== CANONICAL_ENDPOINT || endpoint.displayName !== ENDPOINT_DISPLAY_NAME
      || deployed.id !== DEPLOYED_MODEL_ID || deployed.displayName !== ENDPOINT_DISPLAY_NAME
      || deployed.model !== MODEL || deployed.modelVersionId !== '1'
      || deployed.checkpointId !== CHECKPOINT_ID
      || deployed.automaticResources.minReplicaCount !== 1
      || deployed.automaticResources.maxReplicaCount !== 1
      || !isDeepStrictEqual(endpoint.trafficSplit, { [DEPLOYED_MODEL_ID]: 100 })) {
      throw new Error('RIG-R temporary endpoint/model/checkpoint/traffic identity differs from CTO scope.');
    }
    const operatorAccessToken = requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['auth', 'print-access-token'],
    ), 'Vertex endpoint IAM operator token').trim();
    if (operatorAccessToken.length < 20 || operatorAccessToken.length > 8192
      || /\s/u.test(operatorAccessToken)) {
      throw new Error('Vertex endpoint IAM operator token was empty or malformed.');
    }
    const { response: policyResponse, raw: policyRaw } = await this.withNetworkDeadline(
      PRECLOCK_NETWORK_TIMEOUT_MS,
      'Vertex endpoint IAM observation',
      async (signal) => {
        const response = await this.dependencies.fetch(
          `https://${REGION}-aiplatform.googleapis.com/v1beta1/${CANONICAL_ENDPOINT}:getIamPolicy`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${operatorAccessToken}`,
              'Content-Type': 'application/json',
            },
            body: '{}',
            signal,
          },
        );
        return {
          response,
          raw: await boundedResponseText(response, 'Vertex endpoint IAM observation'),
        };
      },
    );
    if (policyResponse.status !== 200) {
      throw new Error(`Vertex endpoint IAM observation returned HTTP ${policyResponse.status}.`);
    }
    const policy = parseStrict(iamPolicySchema, policyRaw, 'Vertex endpoint IAM observation');
    const endpointUsers = policy.bindings
      .filter(({ role }) => role === 'roles/aiplatform.endpointUser')
      .flatMap(({ members }) => members).sort();
    if (!isDeepStrictEqual(endpointUsers, [`serviceAccount:${RUNTIME_SA}`])) {
      throw new Error('RIG-R endpoint predictor IAM differs from its exact runtime identity.');
    }

    const leaseMetadata = parseStrict(leaseMetadataSchema, requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['storage', 'objects', 'describe', LEASE_URI, '--project', PROJECT_ID, '--raw', '--format=json'],
    ), 'RIG-R singleton lease metadata'), 'RIG-R singleton lease metadata');
    const lease = parseStrict(leaseSchema, requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['storage', 'cat', `${LEASE_URI}#${leaseMetadata.generation}`, '--project', PROJECT_ID],
    ), 'RIG-R singleton lease payload'), 'RIG-R singleton lease payload');
    const expectedLease = {
      leaseId: admission.lease_id,
      candidateHeadSha: admission.declared_source_head,
      candidateTreeSha: admission.rig_r.candidate_tree_sha,
      imageDigest: admission.image_digest,
      provisionArtifactSha256: admission.rig_r.provision_artifact_sha256,
      provisionStartedAt: admission.rig_r.provision_started_at,
      expiresAt: admission.rig_r.hard_stop_expires_at,
    };
    if (Object.entries(expectedLease).some(([key, value]) =>
      lease[key as keyof typeof lease] !== value)) {
      throw new Error('RIG-R singleton lease payload differs from the exact admission.');
    }

    const schedulerJobCount = await this.observeEmptyList(
      ['scheduler', 'jobs', 'list', '--project', PROJECT_ID, '--location', REGION,
        `--filter=name:${SERVICE}`, '--format=json'],
      'RIG-R Scheduler absence observation',
    );
    const managedQueueCount = await this.observeEmptyList(
      ['tasks', 'queues', 'list', '--project', PROJECT_ID, '--location', REGION,
        '--filter=name:s33-r', '--format=json'],
      'RIG-R managed-queue absence observation',
    );
    const oidcIdentityCount = await this.observeEmptyList(
      ['iam', 'service-accounts', 'list', '--project', PROJECT_ID,
        '--filter=email:s33-rig-r-cron', '--format=json'],
      'RIG-R OIDC identity absence observation',
    );
    if (schedulerJobCount !== 0 || managedQueueCount !== 0 || oidcIdentityCount !== 0) {
      throw new Error('RIG-R observed forbidden Scheduler, managed-queue, or OIDC background topology.');
    }

    return deepFreeze({
      candidateHeadSha: admission.declared_source_head,
      candidateTreeSha: observedTree,
      fullShaImageRef: candidate.sourceHeadImageRef,
      imageDigest: admission.image_digest,
      imagePlatform: 'linux/amd64' as const,
      revision: service.status.latestReadyRevisionName,
      serviceUrl: service.status.url,
      runtimeServiceAccount: runtime.email,
      runtimeServiceAccountUniqueId: runtime.uniqueId,
      supabaseProjectRef: admission.supabase_project_ref,
      vertexEndpoint: ENDPOINT,
      vertexModel: MODEL,
      deployedModelId: DEPLOYED_MODEL_ID,
      leaseId: lease.leaseId,
      leaseGeneration: leaseMetadata.generation,
      schedulerJobCount: 0 as const,
      managedQueueCount: 0 as const,
      oidcIdentityCount: 0 as const,
      inProcessJobsDisabled: true as const,
      observedAt: this.now().toISOString(),
    });
  }

  private async jsonFetch<T>(
    schema: z.ZodType<T>,
    url: string,
    init: RequestInit,
    expectedStatus: number,
    label: string,
    timeoutMs = PRECLOCK_NETWORK_TIMEOUT_MS,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    return this.withNetworkDeadline(timeoutMs, label, async (signal) => {
      const response = await this.dependencies.fetch(url, { ...init, signal });
      const raw = await boundedResponseText(response, label, MAX_JSON_RESPONSE_BYTES);
      if (response.status !== expectedStatus) throw new Error(`${label} returned HTTP ${response.status}.`);
      return parseStrict(schema, raw, label);
    }, parentSignal);
  }

  private async createIdentity(state: PreparedState, index: number): Promise<PreparedIdentity> {
    const label = `rig-r-user-${index + 1}`;
    const email = `arkova-s33-r-${this.dependencies.randomId()}@example.invalid`;
    const password = this.dependencies.randomSecret();
    const adminHeaders = {
      'Content-Type': 'application/json',
      apikey: state.serviceRoleKey,
      Authorization: `Bearer ${state.serviceRoleKey}`,
    };
    const created = await this.jsonFetch(
      adminUserSchema,
      `${state.supabaseUrl}/auth/v1/admin/users`,
      { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email, password, email_confirm: true }) },
      200,
      'RIG-R ephemeral-user creation',
    );
    const exactUserId = userId(created);
    try {
      const initial = await this.jsonFetch(
        sessionSchema,
        `${state.supabaseUrl}/auth/v1/token?grant_type=password`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: state.publicKey }, body: JSON.stringify({ email, password }) },
        200,
        'RIG-R initial session',
      );
      if (initial.user.id !== exactUserId) throw new Error('RIG-R initial session changed exact user identity.');
      const refreshed = await this.refreshSession(state, exactUserId, initial.refresh_token);
      return {
        userId: exactUserId,
        label,
        refreshToken: refreshed.refreshToken,
        workerIdentity: { label, jwt: refreshed.accessToken },
      };
    } catch (error) {
      const cleanup = await this.withNetworkDeadline(
        PRECLOCK_NETWORK_TIMEOUT_MS,
        'RIG-R partial-user cleanup',
        (signal) => this.dependencies.fetch(`${state.supabaseUrl}/auth/v1/admin/users/${exactUserId}`, {
          method: 'DELETE', headers: adminHeaders, signal,
        }),
      );
      if (![200, 204, 404].includes(cleanup.status)) {
        throw new AggregateError([error, new Error('RIG-R partial-user cleanup failed.')]);
      }
      throw error;
    }
  }

  private async refreshSession(
    state: PreparedState,
    expectedUserId: string,
    refreshToken: string,
    timeoutMs = PRECLOCK_NETWORK_TIMEOUT_MS,
    parentSignal?: AbortSignal,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const refreshed = await this.jsonFetch(
      sessionSchema,
      `${state.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: state.publicKey }, body: JSON.stringify({ refresh_token: refreshToken }) },
      200,
      'RIG-R session refresh',
      timeoutMs,
      parentSignal,
    );
    const now = this.now();
    const claims = decodeJwt(refreshed.access_token, 'RIG-R Supabase access token');
    if (refreshed.user.id !== expectedUserId || claims.sub !== expectedUserId
      || claims.exp * 1000 <= now.getTime()) {
      throw new Error('RIG-R refreshed session is stale or changed exact user identity.');
    }
    return { accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token };
  }

  private async ingressToken(
    state: PreparedState,
    timeoutMs?: number,
  ): Promise<string> {
    const token = requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['auth', 'print-identity-token', `--impersonate-service-account=${RUNTIME_SA}`,
        `--audiences=${state.observation.serviceUrl}`],
      timeoutMs === undefined ? undefined : { timeoutMs },
    ), 'RIG-R Cloud Run ingress token').trim();
    const claims = decodeJwt(token, 'RIG-R Cloud Run ingress token');
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(state.observation.serviceUrl)
      || claims.exp * 1000 <= this.now().getTime()) {
      throw new Error('RIG-R Cloud Run ingress token has wrong audience or is expired.');
    }
    return token;
  }

  private async appProbe(
    state: PreparedState,
    appAuthorization?: string,
    includeIngress = true,
  ): Promise<number> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (includeIngress) headers['X-Serverless-Authorization'] = `Bearer ${state.ingressToken}`;
    if (appAuthorization !== undefined) headers.Authorization = appAuthorization;
    return this.withNetworkDeadline(PRECLOCK_NETWORK_TIMEOUT_MS, 'RIG-R app-boundary probe', async (signal) => {
      const response = await this.dependencies.fetch(`${state.observation.serviceUrl}${TEMPLATE_ROUTE}`, {
        method: 'POST', headers, body: JSON.stringify(buildTemplatePayload(allGoldenEntries()[0]!)), signal,
      });
      await response.arrayBuffer();
      return response.status;
    });
  }

  async preparePreclock(
    admission: S33RigRReleaseAdmission,
    observation: S33RigRLiveObservation,
  ): Promise<S33RigRPreclockReadiness> {
    if (this.prepared !== undefined) throw new Error('RIG-R pre-clock session preparation is not replayable.');
    const supabaseUrl = requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['secrets', 'versions', 'access', '1', '--secret=supabase-url-s33-r-staging', '--project', PROJECT_ID],
    ), 'RIG-R Supabase URL secret access').trim();
    if (supabaseUrl !== `https://${admission.supabase_project_ref}.supabase.co`) {
      throw new Error('RIG-R Supabase URL secret differs from its exact admitted project.');
    }
    const serviceRoleKey = requireOk(await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['secrets', 'versions', 'access', '1', '--secret=supabase-service-role-key-s33-r-staging', '--project', PROJECT_ID],
    ), 'RIG-R service-role secret access').trim();
    const apiKeys = parseStrict(apiKeysSchema, requireOk(await this.dependencies.command.run(
      process.execPath,
      [fileURLToPath(new URL('../../node_modules/supabase/dist/supabase.js', import.meta.url)),
        'projects', 'api-keys', '--project-ref', admission.supabase_project_ref, '--output', 'json'],
    ), 'RIG-R public-key observation'), 'RIG-R public-key observation');
    const publicKey = apiKeys.find(({ name }) => name === 'anon' || name === 'publishable')?.api_key;
    if (publicKey === undefined || publicKey === serviceRoleKey || serviceRoleKey.length === 0) {
      throw new Error('RIG-R exact project did not return distinct public and service-role keys.');
    }
    const state: PreparedState = {
      admission, observation, supabaseUrl, publicKey, serviceRoleKey, identities: [], ingressToken: '',
    };
    this.prepared = state;
    try {
      for (let index = 0; index < SESSION_POOL_SIZE; index += 1) {
        state.identities.push(await this.createIdentity(state, index));
      }
      state.ingressToken = await this.ingressToken(state);
      const valid = state.identities[0]!;
      const [missingIngressTokenStatus, missingAppTokenStatus, invalidAppTokenStatus, validExactUserStatus] =
        await Promise.all([
          this.appProbe(state, `Bearer ${valid.workerIdentity.jwt}`, false),
          this.appProbe(state),
          this.appProbe(state, 'Bearer arkova-invalid-rig-r-preclock-token'),
          this.appProbe(state, `Bearer ${valid.workerIdentity.jwt}`),
        ]);
      if (missingIngressTokenStatus !== 401 || missingAppTokenStatus !== 401
        || invalidAppTokenStatus !== 401 || validExactUserStatus !== 200) {
        throw new Error('RIG-R pre-clock Cloud Run/app authentication boundary is not exact 401/401/401/200.');
      }

      const vertexToken = requireOk(await this.dependencies.command.run(
        GCLOUD_BINARY,
        ['auth', 'print-access-token', `--impersonate-service-account=${RUNTIME_SA}`],
      ), 'RIG-R Vertex capability token').trim();
      const { response: vertexResponse, raw: vertexRaw } = await this.withNetworkDeadline(
        PRECLOCK_NETWORK_TIMEOUT_MS,
        'RIG-R Vertex capability probe',
        async (signal) => {
          const response = await this.dependencies.fetch(
            `https://${REGION}-aiplatform.googleapis.com/v1beta1/projects/270018525501/locations/${REGION}/endpoints/${ENDPOINT_ID}:generateContent`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${vertexToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: 'Synthetic Arkova S3.3 capability probe; no customer data. Return one short JSON object.' }] }],
                generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 64 },
              }),
              signal,
            },
          );
          return {
            response,
            raw: await boundedResponseText(response, 'RIG-R Vertex capability probe', MAX_JSON_RESPONSE_BYTES),
          };
        },
      );
      if (vertexResponse.status !== 200) throw new Error(`RIG-R Vertex capability probe returned HTTP ${vertexResponse.status}.`);
      const vertexPayload = parseJsonRejectingDuplicateKeys(vertexRaw, 'RIG-R Vertex capability probe') as { candidates?: unknown[] };
      if (!Array.isArray(vertexPayload.candidates) || vertexPayload.candidates.length === 0) {
        throw new Error('RIG-R Vertex capability probe returned no candidate.');
      }
      return deepFreeze({
        status: 'PRECLOCK_AUTH_READY' as const,
        verifiedAt: this.now().toISOString(),
        sessionIdentityCount: state.identities.length,
        sessionRefreshVerifiedCount: state.identities.length,
        cloudRunBoundary: {
          missingIngressTokenStatus: 401 as const,
          missingAppTokenStatus: 401 as const,
          invalidAppTokenStatus: 401 as const,
          validExactUserStatus: 200 as const,
        },
        vertexCapabilityProbe: {
          status: 'PASSED_PRECLOCK_NO_CUSTOMER_DATA' as const,
          endpoint: ENDPOINT,
          runtimeServiceAccount: RUNTIME_SA,
        },
      });
    } catch (error) {
      try { await this.cleanupPreparation(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'RIG-R pre-clock preparation and cleanup both failed.');
      }
      throw error;
    }
  }

  async loadStartReceipt(receiptId: string): Promise<unknown | null> {
    const { uri } = receiptObject(receiptId);
    const generation = this.receiptGenerations.get(receiptId);
    const result = await this.dependencies.command.run(
      GCLOUD_BINARY,
      ['storage', 'cat', generation === undefined ? uri : `${uri}#${generation}`, '--project', PROJECT_ID],
    );
    if (result.status === 'not-found') return null;
    return parseJsonRejectingDuplicateKeys(requireOk(result, 'RIG-R immutable start receipt load'), 'RIG-R immutable start receipt');
  }

  async persistStartReceipt(receipt: S33RigRStartReceipt): Promise<void> {
    const expiresAt = this.approvalExpiresAt;
    if (expiresAt === undefined || expiresAt !== receipt.authorityExpiresAt
      || Date.parse(expiresAt) <= this.now().getTime()) {
      throw new Error('RIG-R cannot persist a start receipt without active exact CTO retention authority.');
    }
    const { uri, name } = receiptObject(receipt.receiptId);
    const directory = await mkdtemp(join(tmpdir(), 'arkova-rig-r-start-'));
    const path = join(directory, 'receipt.json');
    try {
      await writeFile(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      requireOk(await this.dependencies.command.run(GCLOUD_BINARY, [
        'storage', 'cp', path, uri,
        '--project', PROJECT_ID,
        '--if-generation-match=0',
        '--content-type=application/json',
        `--retain-until=${expiresAt}`,
        '--retention-mode=Locked',
        '--quiet',
      ]), 'RIG-R generation-zero start receipt create');
      const metadata = parseStrict(receiptMetadataSchema, requireOk(await this.dependencies.command.run(
        GCLOUD_BINARY,
        ['storage', 'objects', 'describe', uri, '--project', PROJECT_ID, '--raw', '--format=json'],
      ), 'RIG-R start receipt metadata'), 'RIG-R start receipt metadata');
      if (metadata.name !== name || Date.parse(metadata.retention.retainUntilTime) < Date.parse(expiresAt)) {
        throw new Error('RIG-R start receipt retention/provenance did not re-observe exactly.');
      }
      this.receiptGenerations.set(receipt.receiptId, metadata.generation);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private harnessFetch(state: PreparedState): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set('X-Serverless-Authorization', `Bearer ${state.ingressToken}`);
      return this.dependencies.fetch(input, { ...init, headers });
    }) as typeof fetch;
  }

  private async runLiveEvalWindows(
    state: PreparedState,
    receipt: S33RigRStartReceipt,
    clockOpenedAt: number,
    signal: AbortSignal,
  ): Promise<Readonly<{
    rounds: 96;
    meritedRounds: 96;
    evidencePath: string;
    evidenceSha256: string;
  }>> {
    const entries = gateGoldenEntries();
    if (entries.length !== LIVE_EVAL_ENTRIES_PER_ROUND || state.identities.length < SESSION_POOL_SIZE) {
      throw new Error('RIG-R live eval requires exactly 48 gate entries and at least four refreshed identities.');
    }
    const evidencePath = `docs/staging/s33-rig-r/${receipt.soakId}-${START_ATTEMPT_ID}-live-eval.jsonl`;
    const absoluteEvidencePath = resolve(process.cwd(), evidencePath);
    await mkdir(dirname(absoluteEvidencePath), { recursive: true });
    await writeFile(absoluteEvidencePath, '', { encoding: 'utf8', flag: 'wx' });
    const fetchImpl = this.harnessFetch(state);
    let meritedRounds = 0;

    for (let round = 1; round <= LIVE_EVAL_ROUNDS; round += 1) {
      const windowStartedAt = clockOpenedAt + (round - 1) * LIVE_EVAL_WINDOW_MS;
      const windowEndsAt = windowStartedAt + LIVE_EVAL_WINDOW_MS;
      const scored: EntryEvalResult[] = [];
      const providersSeen = new Set<string>();
      const reliability = newReliabilityStats();

      for (let index = 0; index < entries.length; index += 1) {
        if (signal.aborted) throw new Error('RIG-R live eval was aborted before all 96 windows completed.');
        const scheduledAt = windowStartedAt + index * LIVE_EVAL_REQUEST_INTERVAL_MS;
        const delayMs = scheduledAt - this.now().getTime();
        if (delayMs > 0) await this.dependencies.sleep(delayMs, signal);
        const dispatchedAt = this.now().getTime();
        if (signal.aborted) throw new Error('RIG-R live eval was aborted before a scheduled request.');
        if (dispatchedAt >= Date.parse(receipt.authorityExpiresAt)) {
          throw new S33RigRAuthorityExpiryError('RIG-R CTO authority expired during the live eval gate.');
        }
        if (dispatchedAt > scheduledAt + LIVE_EVAL_REQUEST_TIMEOUT_MS) {
          throw new Error(`RIG-R live eval missed absolute 30-minute window ${round} pacing.`);
        }
        const entry = entries[index]!;
        const identity = pickIdentity(
          state.identities.map(({ workerIdentity }) => workerIdentity),
          index + (round - 1) * entries.length,
        );
        const outcome = await callAiEndpoint(
          state.observation.serviceUrl,
          'extract',
          buildExtractPayload(entry, saltForRound(receipt.receiptId, round)),
          identity,
          fetchImpl,
          { timeoutMs: LIVE_EVAL_REQUEST_TIMEOUT_MS, forwardedFor: randomForwardedFor() },
        );
        providersSeen.add(providerFromBody(outcome.body));
        const reliabilityClass = recordReliability(reliability, outcome);
        if (outcome.ok && reliabilityClass !== 'false_reading') {
          scored.push(scoreEntry(entry, fieldsFromExtractResponse(outcome.body)));
        } else if (reliabilityClass === 'false_reading') {
          scored.push(scoreEntry(
            entry,
            fieldsFromExtractResponse(outcome.body),
            'false_reading (degraded/fast-fallback)',
            true,
          ));
        } else {
          scored.push(scoreEntry(entry, {}, outcome.transportError ?? `HTTP ${outcome.status}`));
        }
      }

      const record = buildEvalRecord({
        sampledAt: this.now().toISOString(),
        apiBase: state.observation.serviceUrl,
        provider: [...providersSeen].find((provider) => LIVE_PROVIDERS.has(provider))
          ?? [...providersSeen].sort()[0]
          ?? 'unknown',
        scored,
        reliability: reliabilityReport(reliability),
      });
      const certification = certifyRound(record, providersSeen, true);
      const evidence = {
        schemaVersion: 'arkova.s33.rig-r.live-eval-window/v1' as const,
        receiptId: receipt.receiptId,
        approvalId: receipt.approvalId,
        soakId: receipt.soakId,
        leaseId: receipt.leaseId,
        candidateHeadSha: receipt.candidateHeadSha,
        candidateTreeSha: receipt.candidateTreeSha,
        imageDigest: receipt.imageDigest,
        round,
        windowStartedAt: new Date(windowStartedAt).toISOString(),
        windowEndsAt: new Date(windowEndsAt).toISOString(),
        entries: entries.length,
        requestIntervalMs: LIVE_EVAL_REQUEST_INTERVAL_MS,
        providersSeen: [...providersSeen].sort(),
        merited: certification.merited,
        notes: certification.notes,
        record,
      };
      const evidenceRaw = JSON.stringify(evidence);
      await appendFile(absoluteEvidencePath, `${JSON.stringify({
        ...evidence,
        recordSha256: sha256Raw(evidenceRaw),
      })}\n`, 'utf8');
      if (!certification.merited || !record.gate.passed) {
        throw new Error(`RIG-R live eval window ${round} was unmerited or failed its exact gate.`);
      }
      meritedRounds += 1;
    }

    if (meritedRounds !== LIVE_EVAL_ROUNDS) {
      throw new Error('RIG-R live eval did not complete all 96 merited windows.');
    }
    const evidenceBytes = await this.dependencies.readFile(absoluteEvidencePath);
    return Object.freeze({
      rounds: LIVE_EVAL_ROUNDS,
      meritedRounds: LIVE_EVAL_ROUNDS,
      evidencePath,
      evidenceSha256: sha256Raw(evidenceBytes),
    });
  }

  private async refreshPreparedState(
    state: PreparedState,
    parentSignal: AbortSignal,
  ): Promise<void> {
    const operations: S33RigRRefreshOperation[] = state.identities.map((identity) => ({
      label: `session refresh for ${identity.label}`,
      run: async () => {
        const refreshed = await this.refreshSession(
          state,
          identity.userId,
          identity.refreshToken,
          SESSION_REFRESH_ATTEMPT_TIMEOUT_MS,
          parentSignal,
        );
        identity.refreshToken = refreshed.refreshToken;
        identity.workerIdentity.jwt = refreshed.accessToken;
      },
    }));
    operations.push({
      label: 'Cloud Run ingress-token refresh',
      run: async () => {
        state.ingressToken = await this.ingressToken(state, SESSION_REFRESH_ATTEMPT_TIMEOUT_MS);
      },
    });
    await runBoundedRefreshBatch(operations, this.dependencies.sleep, parentSignal);
  }

  private async heartbeat(state: PreparedState, parentSignal: AbortSignal): Promise<void> {
    await this.withNetworkDeadline(
      HEARTBEAT_NETWORK_TIMEOUT_MS,
      'RIG-R worker heartbeat',
      async (signal) => {
        const response = await this.harnessFetch(state)(`${state.observation.serviceUrl}${TEMPLATE_ROUTE}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${state.identities[0]!.workerIdentity.jwt}`,
          },
          body: JSON.stringify(buildTemplatePayload(allGoldenEntries()[0]!)),
          signal,
        });
        await response.arrayBuffer();
        if (response.status !== 200) throw new Error(`RIG-R worker heartbeat returned HTTP ${response.status}.`);
      },
      parentSignal,
    );
  }

  async runSupervisedHarness(request: S33RigRHarnessRequest): Promise<S33RigRHarnessOutcome> {
    const state = this.prepared;
    if (state === undefined) throw new Error('RIG-R has no exact prepared in-memory session pool.');
    if (request.workerUptimeMin !== RIG_R_WORKER_UPTIME_MIN
      || request.wallMin < RIG_R_WALL_MIN
      || request.heartbeatIntervalMin !== RIG_R_HEARTBEAT_INTERVAL_MIN
      || request.sessionRefreshIntervalMin !== RIG_R_SESSION_REFRESH_INTERVAL_MIN) {
      throw new Error('RIG-R harness request differs from the fixed T3 supervisor contract.');
    }
    if (RIG_R_SESSION_REFRESH_START_MIN * 60_000
        + SUPERVISOR_POLL_MAX_MS
        + SESSION_REFRESH_RETRY_BUDGET_MS
        > RIG_R_SESSION_REFRESH_INTERVAL_MIN * 60_000
      || SESSION_REFRESH_RETRY_BUDGET_MS >= RIG_R_HEARTBEAT_INTERVAL_MIN * 60_000) {
      throw new Error('RIG-R session refresh retry policy cannot satisfy its signed heartbeat/refresh bounds.');
    }
    const controller = new AbortController();
    let readyAt: number | undefined;
    let settled = false;
    let harnessValue: unknown;
    let harnessError: unknown;
    const harness = this.dependencies.runHarness({
      apiBase: state.observation.serviceUrl,
      identities: state.identities.map(({ workerIdentity }) => workerIdentity),
      durationMin: RIG_R_WORKER_UPTIME_MIN,
      ratePerHour: LOAD_RATE_PER_HOUR,
      endpoints: ['extract', 'template', 'tags'],
      variants: parseDocVariants(undefined),
      timeoutMs: 30_000,
      rotateIp: true,
      fingerprintNamespace: START_ATTEMPT_ID,
      evidencePath: `docs/staging/s33-rig-r/${state.admission.soak_id}-${START_ATTEMPT_ID}-ai-soak.json`,
      signal: controller.signal,
      fetchImpl: this.harnessFetch(state),
      onReady: () => { readyAt = this.now().getTime(); },
    }).then((value) => {
      settled = true;
      harnessValue = value;
    }).catch((error) => {
      settled = true;
      harnessError = error;
    });
    await Promise.resolve();
    if (readyAt === undefined) {
      controller.abort();
      await harness;
      throw new Error('RIG-R AI harness did not synchronously open its worker clock.');
    }
    let liveEvalValue: Awaited<ReturnType<S33RigRProductionAdapter['runLiveEvalWindows']>> | undefined;
    let liveEvalError: unknown;
    const liveEval = this.runLiveEvalWindows(state, request.receipt, readyAt, controller.signal)
      .then((value) => { liveEvalValue = value; })
      .catch((error) => {
        liveEvalError = error;
        controller.abort();
      });

    const receiptStart = Date.parse(request.receipt.startedAt);
    const workerEnd = readyAt + RIG_R_WORKER_UPTIME_MIN * 60_000;
    const wallEnd = receiptStart + request.wallMin * 60_000;
    const completeAt = Math.max(workerEnd, wallEnd);
    let lastHeartbeatAt = readyAt;
    let maximumHeartbeatGapMs = 0;
    let lastRefreshAt = readyAt;
    let maximumRefreshGapMs = 0;
    const recordHeartbeat = async (): Promise<number> => {
      await this.heartbeat(state, controller.signal);
      const heartbeatAt = this.now().getTime();
      const heartbeatGap = heartbeatAt - lastHeartbeatAt;
      maximumHeartbeatGapMs = Math.max(maximumHeartbeatGapMs, heartbeatGap);
      if (heartbeatGap > RIG_R_HEARTBEAT_INTERVAL_MIN * 60_000) {
        throw new Error('RIG-R worker heartbeat gap exceeded five minutes.');
      }
      lastHeartbeatAt = heartbeatAt;
      return heartbeatAt;
    };
    try {
      while (this.now().getTime() < completeAt) {
        const observedAt = this.now().getTime();
        if (observedAt >= Date.parse(request.receipt.authorityExpiresAt)) {
          throw new Error('RIG-R CTO authority expired during the supervised clock.');
        }
        if (liveEvalError !== undefined) throw liveEvalError;
        if (harnessError !== undefined) throw harnessError;
        if (settled && observedAt < workerEnd) {
          throw new Error('RIG-R AI harness exited before exactly 2880 worker-up minutes.');
        }
        if (observedAt - lastRefreshAt >= RIG_R_SESSION_REFRESH_START_MIN * 60_000) {
          // Open a fresh five-minute heartbeat budget before a bounded retry
          // batch. The full retry policy is shorter than that budget.
          await recordHeartbeat();
          await this.refreshPreparedState(state, controller.signal);
          const refreshedAt = this.now().getTime();
          const gap = refreshedAt - lastRefreshAt;
          maximumRefreshGapMs = Math.max(maximumRefreshGapMs, gap);
          if (gap > RIG_R_SESSION_REFRESH_INTERVAL_MIN * 60_000) {
            throw new Error('RIG-R session/ingress refresh exceeded the bounded 45-minute interval.');
          }
          lastRefreshAt = refreshedAt;
        }
        const heartbeatAt = await recordHeartbeat();
        const remaining = completeAt - heartbeatAt;
        if (remaining <= 0) break;
        await this.dependencies.sleep(
          Math.min(SUPERVISOR_POLL_MAX_MS, remaining),
          controller.signal,
        );
      }
      if (!settled) {
        const timeoutController = new AbortController();
        const timeout = this.dependencies.sleep(RIG_R_HEARTBEAT_INTERVAL_MIN * 60_000, timeoutController.signal)
          .then(() => 'timeout' as const);
        const completion = harness.then(() => 'harness' as const);
        if (await Promise.race([timeout, completion]) === 'timeout') {
          controller.abort();
          throw new Error('RIG-R harness did not finish within one bounded heartbeat after its exact duration.');
        }
        timeoutController.abort();
      }
      await harness;
      if (harnessError !== undefined) throw harnessError;
      await liveEval;
      if (liveEvalError !== undefined) throw liveEvalError;
      if (liveEvalValue === undefined) throw new Error('RIG-R live eval returned no exact 96-window evidence.');
      const summary = harnessSummarySchema.parse(harnessValue);
      const completedAt = this.now();
      const wallElapsedMs = completedAt.getTime() - receiptStart;
      if (wallElapsedMs < request.wallMin * 60_000) {
        throw new Error('RIG-R supervisor ended before the required wall floor.');
      }
      return deepFreeze({
        configuredWorkerUptimeMin: RIG_R_WORKER_UPTIME_MIN,
        configuredWallMin: request.wallMin,
        workerUptimeMs: RIG_R_WORKER_UPTIME_MIN * 60_000,
        wallElapsedMs,
        maximumHeartbeatGapMs,
        sessionRefreshIntervalMs: maximumRefreshGapMs === 0
          ? RIG_R_SESSION_REFRESH_INTERVAL_MIN * 60_000
          : maximumRefreshGapMs,
        harnessDurationSec: summary.durationSec,
        liveEvalRounds: liveEvalValue.rounds,
        liveEvalMeritedRounds: liveEvalValue.meritedRounds,
        liveEvalEvidencePath: liveEvalValue.evidencePath,
        liveEvalEvidenceSha256: liveEvalValue.evidenceSha256,
        completedAt: completedAt.toISOString(),
      });
    } catch (error) {
      controller.abort();
      await Promise.allSettled([harness, liveEval]);
      throw error;
    } finally {
      controller.abort();
    }
  }

  async cleanupPreparation(): Promise<void> {
    if (this.cleanupPromise !== undefined) return this.cleanupPromise;
    const state = this.prepared;
    if (state === undefined) return;
    this.cleanupPromise = (async () => {
      const results = await Promise.allSettled(state.identities.map(async ({ userId: exactUserId }) => {
        const response = await this.withNetworkDeadline(
          SESSION_CLEANUP_NETWORK_TIMEOUT_MS,
          'RIG-R ephemeral-user cleanup',
          (signal) => this.dependencies.fetch(`${state.supabaseUrl}/auth/v1/admin/users/${exactUserId}`, {
            method: 'DELETE',
            headers: { apikey: state.serviceRoleKey, Authorization: `Bearer ${state.serviceRoleKey}` },
            signal,
          }),
        );
        if (![200, 204, 404].includes(response.status)) {
          throw new Error(`RIG-R ephemeral-user cleanup returned HTTP ${response.status}.`);
        }
      }));
      this.prepared = undefined;
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) throw new Error('RIG-R could not delete every ephemeral soak user.');
    })();
    return this.cleanupPromise;
  }

  private authorityBoundCommandTimeout(binding: S33RigRProvisionBinding): number {
    const remainingMs = Date.parse(binding.expiresAt) - this.now().getTime();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      throw new S33RigRAuthorityExpiryError('RIG-R CTO authority expired during post-harness evidence.');
    }
    return Math.max(1, Math.min(LONG_COMMAND_TIMEOUT_MS, remainingMs));
  }

  async runReleaseDriver(
    binding: S33RigRProvisionBinding,
    context: Readonly<{ receipt: S33RigRStartReceipt; harness: S33RigRHarnessOutcome }>,
  ): Promise<unknown> {
    const tsxCli = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const smokePath = resolve(process.cwd(), 'services/worker/scripts/smoke-test-gemini-golden-v6.ts');
    const evalPath = resolve(process.cwd(), 'services/worker/scripts/eval-and-analyze-v6.sh');
    const soakEvidencePath = `docs/staging/s33-rig-r/${context.receipt.soakId}-${START_ATTEMPT_ID}-ai-soak.json`;
    const absoluteSoakEvidencePath = resolve(process.cwd(), soakEvidencePath);
    const absoluteLiveEvalPath = resolve(process.cwd(), context.harness.liveEvalEvidencePath);
    const expectedLiveEvalPath = `docs/staging/s33-rig-r/${context.receipt.soakId}-${START_ATTEMPT_ID}-live-eval.jsonl`;
    if (context.harness.liveEvalEvidencePath !== expectedLiveEvalPath
      || absoluteLiveEvalPath !== resolve(process.cwd(), expectedLiveEvalPath)) {
      throw new Error('RIG-R live-eval evidence path differs from its exact soak-bound location.');
    }
    const releaseEnvironment = {
      ...process.env,
      GEMINI_TUNED_MODEL: binding.vertexEndpoint,
      GEMINI_V6_PROMPT: 'true',
    };
    let smokeStdout = '';
    let evalStdout = '';
    return runS33RigRReleaseDriver(binding, {
      now: () => this.now(),
      runV6Smoke: async () => {
        smokeStdout = requireOk(await this.dependencies.command.run(
          process.execPath,
          [tsxCli, smokePath],
          { env: releaseEnvironment, timeoutMs: this.authorityBoundCommandTimeout(binding) },
        ), 'RIG-R v6 smoke');
      },
      runV6Eval: async () => {
        evalStdout = requireOk(await this.dependencies.command.run(
          BASH_BINARY,
          [evalPath, binding.vertexEndpoint],
          { env: releaseEnvironment, timeoutMs: this.authorityBoundCommandTimeout(binding) },
        ), 'RIG-R v6 eval');
      },
      loadReleaseEvidence: async () => {
        const evalJson = exactEvalArtifactPath(
          evalStdout,
          'Eval raw',
          /^eval-gemini-[0-9TZ-]+[.]json$/u,
        );
        const analysis = exactEvalArtifactPath(
          evalStdout,
          'Analysis saved to',
          /^eval-gemini-golden-v6-[0-9TZ-]+[.]md$/u,
        );
        const [soakEvidence, liveEvalEvidence, evalJsonRaw, analysisRaw] = await Promise.all([
          this.dependencies.readFile(absoluteSoakEvidencePath),
          this.dependencies.readFile(absoluteLiveEvalPath),
          this.dependencies.readFile(evalJson.absolutePath),
          this.dependencies.readFile(analysis.absolutePath),
        ]);
        return composeS33RigRReleaseEvidence({
          receipt: context.receipt,
          harness: context.harness,
          soakEvidencePath,
          soakEvidenceRaw: soakEvidence.toString('utf8'),
          liveEvalEvidenceRaw: liveEvalEvidence.toString('utf8'),
          smokeStdout,
          evalStdout,
          evalJsonPath: evalJson.path,
          evalJsonRaw: evalJsonRaw.toString('utf8'),
          analysisPath: analysis.path,
          analysisRaw: analysisRaw.toString('utf8'),
          composedAt: this.now().toISOString(),
        });
      },
      teardown: async (_exactBinding, reason) => this.teardown(binding, reason),
    });
  }

  async teardown(
    binding: S33RigRProvisionBinding,
    reason: 'driver-failure' | 'authority-expiry' | 'evidence-complete',
    admission?: S33RigRReleaseAdmission,
  ): Promise<void> {
    void reason;
    if (this.teardownPromise !== undefined) return this.teardownPromise;
    this.teardownPromise = (async () => {
      const exactAdmission = admission ?? this.activeAdmission ?? this.prepared?.admission;
      const project = exactAdmission?.supabase_project_ref;
      if (project === undefined) {
        throw new Error('RIG-R canonical teardown requires the exact admitted Supabase project ref.');
      }
      requireOk(await this.dependencies.command.run(
        BASH_BINARY,
        [resolve(process.cwd(), 'scripts/staging/teardown-isolated-rig.sh'),
          '--project-ref', project,
          '--rig-name', 's33-r',
          '--rig-id', 'RIG-R',
          '--service', SERVICE,
          '--vertex-endpoint', binding.vertexEndpoint,
          '--vertex-model', binding.vertexModel,
          '--deployed-model-id', binding.deployedModelId,
          '--runtime-sa', binding.runtimeServiceAccount,
          '--lease-id', binding.leaseId,
          '--apply'],
        {
          timeoutMs: LONG_COMMAND_TIMEOUT_MS,
          env: { ...process.env, CONFIRM_TEARDOWN: project },
        },
      ), 'RIG-R canonical teardown');
    })();
    return this.teardownPromise;
  }
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((complete) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      complete();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function productionDependencies(): S33RigRProductionDependencies {
  const command = new NodeCommandRunner();
  return {
    command,
    fetch,
    readFile,
    now: () => new Date(),
    randomId: randomUUID,
    randomSecret: () => randomBytes(32).toString('base64url'),
    sleep: abortableSleep,
    runHarness: runAiSoakHarness,
  };
}

export function createS33RigRReleaseProductionAdapter(): S33RigRReleaseProductionPort {
  return new S33RigRProductionAdapter(productionDependencies());
}

/** Test-only production seam. It cannot be reached by the live CLI. */
export function createS33RigRReleaseProductionAdapterForTest(
  dependencies: S33RigRProductionDependencies,
): S33RigRReleaseProductionPort {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Injected RIG-R production dependencies are test-only.');
  }
  return new S33RigRProductionAdapter(dependencies);
}
