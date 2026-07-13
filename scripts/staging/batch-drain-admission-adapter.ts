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
  runDeclarationSchema,
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
const projectRef = z.string().regex(/^[a-z]{20}$/);
const runIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
const gcpProjectId = z.string().regex(/^[a-z][a-z\d-]{4,28}[a-z\d]$/);
const gcpRegion = z.string().regex(/^[a-z]+-[a-z]+\d$/);
const cloudRunName = z.string().regex(/^[a-z](?:[a-z\d-]{0,61}[a-z\d])?$/);
const isoTimestamp = strictUtcTimestampSchema;
const TEAM2_RIG_B1_CREATION_GUARD =
  'non-firing hold schedule; create then immediate pause + PAUSED verification';
const TEAM2_RIG_B1_SCHEDULER_SPECS = [
  ['batch-anchors', '/jobs/batch-anchors'],
  ['check-confirmations', '/jobs/check-confirmations'],
  ['populate-confirmation-proofs', '/jobs/populate-confirmation-proofs'],
  ['org-queue-scheduler', '/jobs/org-queue-scheduler'],
  ['batch-anchors-forced-flush', '/jobs/batch-anchors?force=true'],
  ['recover-broadcasts', '/jobs/recover-broadcasts'],
] as const;
const TEAM2_RIG_B1_LIVE_CHAIN_CRITICAL_CONFIG = {
  node_env: 'production',
  enable_ai_fraud: 'false',
  enable_ai_reports: 'false',
  frontend_url: 'https://app.arkova.ai',
  use_mocks: 'false',
  enable_prod_network_anchoring: 'true',
  bitcoin_network: 'signet',
  bitcoin_utxo_provider: 'getblock',
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
}).strict();

const schedulerSchema = z.object({
  applicable: z.literal(true),
  jobs: z.array(schedulerJobSchema).min(3),
  creation_guard: z.literal(TEAM2_RIG_B1_CREATION_GUARD),
  paused_through_clean_mirror: z.literal(true),
  state: z.literal('resumed_after_clean_mirror'),
}).strict();

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
  driver_path: nonEmpty,
  driver_sha256: sha256Hex,
  changed_behavior: nonEmpty,
  harness_version: nonEmpty,
  tool_version: nonEmpty,
  owner: nonEmpty,
  stop_conditions: z.array(nonEmpty).min(3),
}).strict();

const ceremonySchema = runDeclarationSchema.pick({
  declarationId: true,
  soakStartedAt: true,
  soakEndedAt: true,
  recoveries: true,
  windows: true,
}).strict();

type AdmissionV2 = z.infer<typeof admissionV2Schema>;
type DeclarationCeremony = z.infer<typeof ceremonySchema>;

export interface AdmissionBoundRunDeclaration {
  readonly admissionSha256: string;
}

const DECLARATION_BY_ADMISSION_HANDLE = new WeakMap<AdmissionBoundRunDeclaration, RunDeclaration>();

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

function assertAdmissionInvariants(admission: AdmissionV2): void {
  if (
    admission.sha !== admission.declared_source_head
    || admission.sha !== admission.deployed_source_head
    || admission.sha === admission.base_sha
  ) throw new Error('Admission v2 contains contradictory head/base identity bindings.');

  if (!admission.deployed_revision.startsWith(`${admission.cloud_run_service}-`)) {
    throw new Error('Admission v2 deployed revision must bind to the exact Cloud Run service identity.');
  }

  const expectedImageSuffix = `@${admission.deployed_image_digest}`;
  const imageRepository = admission.image.slice(0, -expectedImageSuffix.length);
  const expectedSourceHeadImageRef = `${imageRepository}:${admission.declared_source_head}`;
  if (
    admission.image_digest !== admission.deployed_image_digest
    || admission.source_head_image_digest !== admission.deployed_image_digest
    || admission.source_head_image_ref !== expectedSourceHeadImageRef
    || !admission.image.endsWith(expectedImageSuffix)
    || !admission.deployed_image_ref.endsWith(expectedImageSuffix)
  ) throw new Error('Admission v2 contains contradictory source-head/deployed image digest identity.');

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
  const expectedSchedulerJobs = new Map<string, string>(TEAM2_RIG_B1_SCHEDULER_SPECS.map(([suffix, path]) => (
    [`${admission.cloud_run_service}-${suffix}`, path] as const
  )));
  if (
    admission.scheduler.jobs.length !== expectedSchedulerJobs.size
    || admission.scheduler.jobs.some((job) => expectedSchedulerJobs.get(job.name) !== job.path)
  ) {
    throw new Error('Admission v2 must match the complete exact Team2 RIG-B1 Scheduler service-derived contract.');
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

export function requireAdmissionBoundRunDeclaration(candidate: unknown): RunDeclaration {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('Run declaration requires an admission-adapter provenance handle.');
  }
  const declaration = DECLARATION_BY_ADMISSION_HANDLE.get(candidate as AdmissionBoundRunDeclaration);
  if (!declaration) throw new Error('Run declaration requires an admission-adapter provenance handle.');
  return declaration;
}
