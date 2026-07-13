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

const nonEmpty = z.string().min(1);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const headSha = z.string().regex(/^[0-9a-f]{40}$/);
const imageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const pinnedImage = z.string().regex(/^[^\s@]+@sha256:[0-9a-f]{64}$/);
const projectRef = z.string().regex(/^[a-z]{20}$/);
const runIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
const gcpProjectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
const gcpRegion = z.string().regex(/^[a-z]+-[a-z]+[0-9]$/);
const cloudRunName = z.string().regex(/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const isoTimestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'invalid timestamp');

const criticalConfigSchema = z.object({
  node_env: z.string(),
  enable_ai_fraud: z.string(),
  enable_ai_reports: z.string(),
  frontend_url: z.string(),
  use_mocks: z.string(),
  enable_prod_network_anchoring: z.string(),
  bitcoin_network: z.literal('signet'),
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
  creation_guard: nonEmpty,
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
const REQUIRED_SCHEDULER_PATHS = [
  '/jobs/batch-anchors?force=true',
  '/jobs/recover-broadcasts',
  '/jobs/org-queue-scheduler',
] as const;

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
  if (
    admission.image_digest !== admission.deployed_image_digest
    || !admission.image.endsWith(expectedImageSuffix)
    || !admission.deployed_image_ref.endsWith(expectedImageSuffix)
  ) throw new Error('Admission v2 contains contradictory deployed image digest identity.');

  if (
    admission.clean_mirror.attestation_id !== admission.clean_mirror_attestation_id
    || admission.clean_mirror.result !== admission.preflight_result
    || Date.parse(admission.clean_mirror.verified_at) > Date.parse(admission.generated_at)
  ) throw new Error('Admission v2 clean_mirror attestation identity is contradictory.');

  const names = admission.scheduler.jobs.map((job) => job.name);
  const paths = admission.scheduler.jobs.map((job) => job.path);
  if (new Set(names).size !== names.length || new Set(paths).size !== paths.length) {
    throw new Error('Admission v2 Scheduler specs contain duplicate names or paths.');
  }
  if (names.some((name) => !name.startsWith(`${admission.cloud_run_service}-`))) {
    throw new Error('Admission v2 Scheduler job names must bind to the exact Cloud Run service.');
  }
  for (const path of REQUIRED_SCHEDULER_PATHS) {
    if (!paths.includes(path)) throw new Error(`Admission v2 omits required Scheduler path ${path}.`);
  }
  if (!/PAUSED/.test(admission.scheduler.creation_guard)) {
    throw new Error('Admission v2 Scheduler creation guard lacks PAUSED-through-clean-mirror proof.');
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
  const wallMinutes = (Date.parse(result.data.soakEndedAt) - Date.parse(result.data.soakStartedAt)) / 60_000;
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
