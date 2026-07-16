/**
 * Fail-closed Team2 admission-v2 -> Team1 run-declaration identity adapter.
 *
 * This module projects only admission-authored rig identities. Ceremony input
 * is a separate strict JSON primitive and can provide only declaration/run
 * fields. Signing and the production Ed25519 trust root remain separate.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  assertRunDeclarationInvariants,
  rigB1InfrastructureSchema,
  runDeclarationSchema,
  type RigB1Infrastructure,
  type RunDeclaration,
} from './batch-drain-live-evidence';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import { parseUtcTimestamp, strictUtcTimestampSchema } from './batch-drain-time';

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const headSha = z.string().regex(/^[0-9a-f]{40}$/);
const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const pinnedImage = z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/);
const sourceHeadImageRef = z.string().regex(/^[^\s@]+:[0-9a-f]{40}$/);
const APPROVED_IMAGE_REPOSITORY =
  'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker';
const APPROVED_SUPABASE_ORG_ID = 'byhkazrpmivhcsuqjtva';
const projectRef = z.string().regex(/^[a-z]{20}$/);
const runIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
const gcpProjectId = z.string().regex(/^[a-z][a-z\d-]{4,28}[a-z\d]$/);
const gcpRegion = z.string().regex(/^[a-z]+-[a-z]+\d$/);
const cloudRunName = z.string().regex(/^[a-z](?:[a-z\d-]{0,61}[a-z\d])?$/);
const isoTimestamp = strictUtcTimestampSchema;
const TEAM2_RIG_B1_CREATION_GUARD =
  'non-firing hold schedule; create then immediate pause + PAUSED verification';
const TEAM2_RIG_B1_SCHEDULER_SPECS = [
  ['batch-anchors', '/jobs/batch-anchors', '*/30 * * * *', 'Etc/UTC', '120s'],
  ['check-confirmations', '/jobs/check-confirmations', '*/30 * * * *', 'Etc/UTC', '300s'],
  ['populate-confirmation-proofs', '/jobs/populate-confirmation-proofs', '*/15 * * * *', 'Etc/UTC', '300s'],
  ['org-queue-scheduler', '/jobs/org-queue-scheduler', '0 * * * *', 'Etc/UTC', '600s'],
  ['batch-anchors-forced-flush', '/jobs/batch-anchors?force=true', '0 3 * * *', 'America/New_York', '600s'],
  ['recover-broadcasts', '/jobs/recover-broadcasts', '*/15 * * * *', 'Etc/UTC', '120s'],
] as const;
const TEAM2_RIG_B1_ACCELERATED_SCHEDULE = '*/5 * * * *';
const TEAM2_RIG_B1_RETRY = {
  min_backoff: '5s',
  max_backoff: '3600s',
  max_doublings: 5,
} as const;
const TEAM2_RIG_B1_LIVE_CHAIN_CRITICAL_CONFIG = {
  node_env: 'production',
  enable_ai_fraud: 'false',
  enable_ai_reports: 'false',
  frontend_url: 'https://app.arkova.ai',
  use_mocks: 'false',
  enable_prod_network_anchoring: 'true',
  bitcoin_network: 'signet',
  bitcoin_utxo_provider: 'rpc',
  kms_provider: 'gcp',
  gemini_tuned_model: '',
  gemini_v6_prompt: '',
  gemini_tuned_response_schema: '<unset>',
} as const;

const criticalConfigSchema = z.object({
  node_env: z.string(),
  enable_ai_fraud: z.string(),
  enable_ai_reports: z.string(),
  frontend_url: z.string(),
  use_mocks: z.string(),
  enable_prod_network_anchoring: z.string(),
  bitcoin_network: z.string(),
  bitcoin_utxo_provider: z.string(),
  kms_provider: z.string(),
  gemini_tuned_model: z.string(),
  gemini_v6_prompt: z.string(),
  gemini_tuned_response_schema: z.string(),
}).strict();

const schedulerJobSchema = z.object({
  name: nonEmpty,
  path: z.string().regex(/^\/jobs\/[a-z0-9-]+(?:\?[A-Za-z0-9_=&%-]+)?$/),
  schedule: nonEmpty,
  time_zone: z.enum(['Etc/UTC', 'America/New_York']),
  attempt_deadline: z.string().regex(/^[1-9]\d*s$/),
  retry: z.object({
    min_backoff: z.string().regex(/^[1-9]\d*s$/),
    max_backoff: z.string().regex(/^[1-9]\d*s$/),
    max_doublings: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const schedulerSharedShape = {
  applicable: z.literal(true),
  jobs: z.array(schedulerJobSchema).min(3),
  creation_guard: z.literal(TEAM2_RIG_B1_CREATION_GUARD),
  paused_through_clean_mirror: z.literal(true),
} as const;

const pausedSchedulerSchema = z.object({
  ...schedulerSharedShape,
  activation_mode: z.literal('PAUSED'),
  state: z.literal('paused_after_clean_mirror'),
}).strict();

const schedulerSchema = z.discriminatedUnion('activation_mode', [
  pausedSchedulerSchema,
  z.object({
    ...schedulerSharedShape,
    activation_mode: z.literal('FORCE_ACCELERATED_RIG_ONLY'),
    state: z.literal('accelerated_rig_only_enabled'),
  }).strict(),
]);

const preClockSchedulerSchema = pausedSchedulerSchema;

const cleanMirrorSchema = z.object({
  result: z.literal('environment_type=clean_mirror'),
  artifact: nonEmpty,
  verified_at: isoTimestamp,
  attestation_id: sha256,
}).strict();

const admissionV2Schema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('isolated_rig_admission'),
  generated_at: isoTimestamp,
  rig_name: nonEmpty,
  rig_id: z.literal('RIG-B1'),
  profile: z.literal('chain'),
  soak_id: runIdentity,
  cloud_run_service: cloudRunName,
  gcp_project_id: gcpProjectId,
  supabase_org_id: z.literal(APPROVED_SUPABASE_ORG_ID),
  region: gcpRegion,
  lease_id: runIdentity,
  clean_mirror_attestation_id: sha256,
  tier: z.literal('T3'),
  duration_min: z.literal(2_880),
  required_uptime_min: z.literal(2_880),
  required_wall_min: z.number().int().min(2_910),
  sha: headSha,
  declared_source_head: headSha,
  source_head_image_ref: sourceHeadImageRef,
  source_head_image_digest: imageDigest,
  base_sha: headSha,
  image: pinnedImage,
  image_digest: imageDigest,
  deployed_revision: cloudRunName,
  deployed_image_ref: pinnedImage,
  deployed_image_digest: imageDigest,
  deployed_source_head: headSha,
  tag_url: nonEmpty,
  supabase_project_ref: projectRef,
  preflight_result: z.literal('environment_type=clean_mirror'),
  clean_mirror: cleanMirrorSchema,
  critical_config: criticalConfigSchema,
  scheduler: schedulerSchema,
  infrastructure: rigB1InfrastructureSchema,
  driver_path: nonEmpty,
  driver_sha256: sha256Hex,
  changed_behavior: nonEmpty,
  harness_version: nonEmpty,
  tool_version: nonEmpty,
  owner: nonEmpty,
  stop_conditions: z.array(nonEmpty).min(3),
}).strict();

/** A separate pre-clock packet cannot claim that Scheduler already resumed. */
const preClockAdmissionV2Schema = admissionV2Schema.extend({
  scheduler: preClockSchedulerSchema,
});

const ceremonySchema = runDeclarationSchema.pick({
  declarationId: true,
  soakStartedAt: true,
  soakEndedAt: true,
  recoveries: true,
  windows: true,
}).strict();

type AdmissionV2 = z.infer<typeof admissionV2Schema>;
type PreClockAdmissionV2 = z.infer<typeof preClockAdmissionV2Schema>;
type DeclarationCeremony = z.infer<typeof ceremonySchema>;

export interface AdmissionBoundRunDeclaration {
  readonly admissionSha256: string;
}

export interface PreClockAdmissionBoundIdentity {
  readonly admissionSha256: string;
}

export interface PreClockAdmissionIdentity {
  readonly gitHeadSha: string;
  readonly imageDigest: string;
  readonly gcpProjectId: string;
  readonly workerService: string;
  readonly cleanMirrorAttestationId: string;
  readonly infrastructure: RigB1Infrastructure;
}

const DECLARATION_BY_ADMISSION_HANDLE = new WeakMap<AdmissionBoundRunDeclaration, RunDeclaration>();
const IDENTITY_BY_PRE_CLOCK_HANDLE = new WeakMap<
  PreClockAdmissionBoundIdentity,
  PreClockAdmissionIdentity
>();

function parseStrict<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const result = schema.safeParse(parseJsonRejectingDuplicateKeys(raw, label));
  if (!result.success) throw new Error(`${label} schema rejected: ${z.prettifyError(result.error)}`);
  return result.data;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertAdmissionInvariants(admission: AdmissionV2 | PreClockAdmissionV2): void {
  if (
    admission.sha !== admission.declared_source_head
    || admission.sha !== admission.deployed_source_head
    || admission.sha === admission.base_sha
  ) throw new Error('Admission v2 contains contradictory head/base identity bindings.');

  if (!admission.deployed_revision.startsWith(`${admission.cloud_run_service}-`)) {
    throw new Error('Admission v2 deployed revision must bind to the exact Cloud Run service identity.');
  }

  const expectedPinnedImageRef = `${APPROVED_IMAGE_REPOSITORY}@${admission.deployed_image_digest}`;
  const expectedSourceHeadImageRef = `${APPROVED_IMAGE_REPOSITORY}:${admission.declared_source_head}`;
  if (
    admission.image_digest !== admission.deployed_image_digest
    || admission.source_head_image_digest !== admission.image_digest
    || admission.source_head_image_digest !== admission.deployed_image_digest
    || admission.source_head_image_ref !== expectedSourceHeadImageRef
    || admission.image !== expectedPinnedImageRef
    || admission.deployed_image_ref !== expectedPinnedImageRef
  ) throw new Error('Admission v2 contains contradictory source-head or deployed image digest identity.');

  if (
    admission.clean_mirror.attestation_id !== admission.clean_mirror_attestation_id
    || admission.clean_mirror.result !== admission.preflight_result
    || parseUtcTimestamp(admission.clean_mirror.verified_at, 'clean_mirror.verified_at')
      > parseUtcTimestamp(admission.generated_at, 'generated_at')
  ) throw new Error('Admission v2 clean_mirror attestation identity is contradictory.');

  const names = admission.scheduler.jobs.map((job) => job.name);
  const paths = admission.scheduler.jobs.map((job) => job.path);
  if (new Set(names).size !== names.length || new Set(paths).size !== paths.length) {
    throw new Error('Admission v2 Scheduler specs contain duplicate names or paths.');
  }
  const expectedSchedulerJobs: ReadonlyMap<string, Readonly<{
    path: string;
    schedule: string;
    timeZone: string;
    attemptDeadline: string;
  }>> = new Map(TEAM2_RIG_B1_SCHEDULER_SPECS.map(([
    suffix, path, schedule, timeZone, attemptDeadline,
  ]) => (
    [`${admission.cloud_run_service}-${suffix}`, {
      path, schedule, timeZone, attemptDeadline,
    }] as const
  )));
  if (
    admission.scheduler.jobs.length !== expectedSchedulerJobs.size
    || admission.scheduler.jobs.some((job) => {
      const expected = expectedSchedulerJobs.get(job.name);
      const expectedSchedule = admission.scheduler.activation_mode === 'FORCE_ACCELERATED_RIG_ONLY'
        ? TEAM2_RIG_B1_ACCELERATED_SCHEDULE
        : expected?.schedule;
      return !expected
        || job.path !== expected.path
        || job.schedule !== expectedSchedule
        || job.time_zone !== expected.timeZone
        || job.attempt_deadline !== expected.attemptDeadline
        || job.retry.min_backoff !== TEAM2_RIG_B1_RETRY.min_backoff
        || job.retry.max_backoff !== TEAM2_RIG_B1_RETRY.max_backoff
        || job.retry.max_doublings !== TEAM2_RIG_B1_RETRY.max_doublings;
    })
  ) {
    throw new Error(
      'Admission v2 must match the complete exact Team2 RIG-B1 Scheduler service-derived binding contract.',
    );
  }

  for (const [field, expected] of Object.entries(TEAM2_RIG_B1_LIVE_CHAIN_CRITICAL_CONFIG)) {
    const actual = admission.critical_config[field as keyof typeof admission.critical_config];
    if (actual !== expected) {
      throw new Error(
        `Admission v2 critical_config.${field} contradicts the exact RIG-B1 live-chain contract; expected ${JSON.stringify(expected)}.`,
      );
    }
  }
}

function buildRunDeclaration(admission: AdmissionV2, ceremony: DeclarationCeremony): RunDeclaration {
  const candidate = {
    schemaVersion: 1 as const,
    declarationId: ceremony.declarationId,
    gitBaseSha: admission.base_sha,
    gitHeadSha: admission.sha,
    imageDigest: admission.deployed_image_digest,
    rigId: admission.rig_id,
    gcpProjectId: admission.gcp_project_id,
    projectRef: admission.supabase_project_ref,
    soakId: admission.soak_id,
    leaseId: admission.lease_id,
    cleanMirrorAttestationId: admission.clean_mirror_attestation_id,
    workerService: admission.cloud_run_service,
    workerRevision: admission.deployed_revision,
    region: admission.region,
    infrastructure: admission.infrastructure,
    soakStartedAt: ceremony.soakStartedAt,
    soakEndedAt: ceremony.soakEndedAt,
    recoveries: ceremony.recoveries,
    windows: ceremony.windows,
  };
  const result = runDeclarationSchema.safeParse(candidate);
  if (!result.success) throw new Error(`Projected run declaration schema rejected: ${z.prettifyError(result.error)}`);
  const wallMinutes = (
    parseUtcTimestamp(result.data.soakEndedAt, 'soakEndedAt')
    - parseUtcTimestamp(result.data.soakStartedAt, 'soakStartedAt')
  ) / 60_000;
  if (wallMinutes < admission.required_wall_min) {
    throw new Error('Projected run declaration does not meet the admission required wall minutes.');
  }
  assertRunDeclarationInvariants(result.data);
  return deepFreeze(result.data);
}

export function projectAdmissionV2ToRunDeclaration(
  admissionRaw: unknown,
  ceremonyRaw: unknown,
): AdmissionBoundRunDeclaration {
  const admission = parseStrict(admissionV2Schema, admissionRaw, 'Admission v2');
  assertAdmissionInvariants(admission);
  const ceremony = parseStrict(ceremonySchema, ceremonyRaw, 'Declaration ceremony');
  const declaration = buildRunDeclaration(admission, ceremony);
  const handle = deepFreeze<AdmissionBoundRunDeclaration>({
    admissionSha256: createHash('sha256').update(admissionRaw as string).digest('hex'),
  });
  DECLARATION_BY_ADMISSION_HANDLE.set(handle, declaration);
  return handle;
}

/**
 * Project strict, clean-mirror-complete admission into a pre-clock identity.
 * No soak ceremony is accepted here, and Scheduler must still be paused.
 */
export function projectAdmissionV2ToPreClockIdentity(
  admissionRaw: unknown,
): PreClockAdmissionBoundIdentity {
  const admission = parseStrict(
    preClockAdmissionV2Schema,
    admissionRaw,
    'Pre-clock admission v2',
  );
  assertAdmissionInvariants(admission);
  const identity = deepFreeze<PreClockAdmissionIdentity>({
    gitHeadSha: admission.sha,
    imageDigest: admission.deployed_image_digest,
    gcpProjectId: admission.gcp_project_id,
    workerService: admission.cloud_run_service,
    cleanMirrorAttestationId: admission.clean_mirror_attestation_id,
    infrastructure: admission.infrastructure,
  });
  const handle = deepFreeze<PreClockAdmissionBoundIdentity>({
    admissionSha256: createHash('sha256').update(admissionRaw as string).digest('hex'),
  });
  IDENTITY_BY_PRE_CLOCK_HANDLE.set(handle, identity);
  return handle;
}

export function requireAdmissionBoundRunDeclaration(candidate: unknown): RunDeclaration {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Run declaration requires an admission-adapter provenance handle.');
  }
  const declaration = DECLARATION_BY_ADMISSION_HANDLE.get(candidate as AdmissionBoundRunDeclaration);
  if (!declaration) throw new Error('Run declaration requires an admission-adapter provenance handle.');
  return declaration;
}

export function requirePreClockAdmissionIdentity(candidate: unknown): PreClockAdmissionIdentity {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Pre-clock readiness requires a paused admission provenance handle.');
  }
  const identity = IDENTITY_BY_PRE_CLOCK_HANDLE.get(candidate as PreClockAdmissionBoundIdentity);
  if (!identity) throw new Error('Pre-clock readiness requires a paused admission provenance handle.');
  return identity;
}
