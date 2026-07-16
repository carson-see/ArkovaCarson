/**
 * The only counted-start transition for the S3.3 RIG-B1 soak.
 *
 * Provisioning owns preparation and leaves every Scheduler job PAUSED. This
 * controller validates the frozen candidate, admission, pre-clock evidence,
 * signed B1 authority and immutable ownership before it resumes anything. Once
 * Scheduler observation begins, every failure is contained by pausing and then
 * separately re-observing all six jobs as PAUSED.
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import {
  projectAdmissionV2ToPreClockIdentity,
  requirePreClockAdmissionIdentity,
} from './batch-drain-admission-adapter';
import {
  assertRigB1PreClockReadiness,
  buildRigB1ReadinessPlan,
} from './batch-drain-chain-readiness';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import {
  planTreasuryPresplit,
  type TreasuryPresplitPlanInput,
} from './batch-drain-utxo-fanout';
import {
  createProductionB1StartAuthorityVerifier,
  type VerifiedB1StartAuthority,
} from './s33-b1-start-approval';

const JOBS = [
  { suffix: 'batch-anchors', path: '/jobs/batch-anchors', timeZone: 'Etc/UTC', attemptDeadline: '120s' },
  { suffix: 'batch-anchors-forced-flush', path: '/jobs/batch-anchors?force=true', timeZone: 'America/New_York', attemptDeadline: '600s' },
  { suffix: 'check-confirmations', path: '/jobs/check-confirmations', timeZone: 'Etc/UTC', attemptDeadline: '300s' },
  { suffix: 'org-queue-scheduler', path: '/jobs/org-queue-scheduler', timeZone: 'Etc/UTC', attemptDeadline: '600s' },
  { suffix: 'populate-confirmation-proofs', path: '/jobs/populate-confirmation-proofs', timeZone: 'Etc/UTC', attemptDeadline: '300s' },
  { suffix: 'recover-broadcasts', path: '/jobs/recover-broadcasts', timeZone: 'Etc/UTC', attemptDeadline: '120s' },
] as const;

export const B1_SCHEDULER_START_CONTRACT = Object.freeze({
  schemaVersion: 'arkova.s33.rig-b1.scheduler-start-receipt/v1',
  keyId: 'arkova.s33.b1-evidence.ed25519.v1',
  verifierIdentity: 'arkova.s33.verifier.public-ed25519.v1',
  authorityPurpose: 'START_B1',
  rigId: 'RIG-B1',
  rigName: 's33-rig-b1',
  gcpProjectId: 'arkova1',
  gcpRegion: 'us-central1',
  workerService: 'arkova-worker-s33-rig-b1-staging',
  workerRuntimeServiceAccount: 's33-rig-b1-runtime@arkova1.iam.gserviceaccount.com',
  schedulerOidcServiceAccount: 's33-rig-b1-cron@arkova1.iam.gserviceaccount.com',
  workerImageRepository: 'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker',
  ledgerBaseUri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1',
  cadence: '*/5 * * * *',
  requiredWorkerUptimeMin: 2_880,
  requiredWallMin: 2_910,
  retry: Object.freeze({ minBackoff: '5s', maxBackoff: '3600s', maxDoublings: 5 }),
  jobs: Object.freeze(JOBS.map((job) => Object.freeze({ ...job }))),
} as const);

type JobSpec = typeof B1_SCHEDULER_START_CONTRACT.jobs[number];

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);
const timestamp = z.string().datetime({ offset: true });
const numericGeneration = z.string().regex(/^[1-9][0-9]*$/u);
const projectRef = z.string().regex(/^[a-z]{20}$/u);
const pinnedWorkerImage = z.string().regex(
  /^us-central1-docker[.]pkg[.]dev\/arkova1\/arkova-worker-images\/arkova-worker@sha256:[0-9a-f]{64}$/u,
);

export interface B1SchedulerStartAdmission {
  readonly admissionSha256: string;
  readonly generatedAt: string;
  readonly cleanMirrorVerifiedAt: string;
  readonly rigName: string;
  readonly soakId: string;
  readonly leaseId: string;
  readonly sourceHeadSha: string;
  readonly workerImage: string;
  readonly workerImageDigest: string;
  readonly gcpProjectId: string;
  readonly gcpRegion: string;
  readonly supabaseProjectRef: string;
  readonly workerService: string;
  readonly workerRevision: string;
  readonly schedulerOidcServiceAccount: string;
  readonly cleanMirrorAttestationId: string;
  readonly requiredWorkerUptimeMin: number;
  readonly requiredWallMin: number;
  readonly approvalId: string;
  readonly approvalEnvelopeSha256: string;
  readonly signedPayloadSha256: string;
  readonly approvalClaimUri: string;
  readonly approvalClaimGeneration: string;
  readonly nodeReadinessSha256: string;
  readonly cronSecretName: string;
  readonly cronSecretVersion: string;
  readonly cronSecretResource: string;
}

export interface B1SchedulerStartPreclock {
  readonly status: 'PRE_CLOCK_READY';
  readonly preclockSha256: string;
  readonly admissionSha256: string;
  readonly sourceHeadSha: string;
  readonly workerImageDigest: string;
  readonly cleanMirrorAttestationId: string;
  readonly nodeReadinessSha256: string;
  readonly observedAt: string;
  readonly schedulerJobsPaused: 6;
  readonly schedulerCadence: string;
}

export interface VerifiedB1StartApproval {
  readonly status: 'VERIFIED';
  readonly keyId: string;
  readonly verifierIdentity: string;
  readonly envelopeSha256: string;
  readonly signedPayloadSha256: string;
  readonly startId: string;
  readonly purpose: string;
  readonly sourceHeadSha: string;
  readonly sourceTreeSha: string;
  readonly workerImage: string;
  readonly workerImageDigest: string;
  readonly corpusDigest: string;
  readonly releaseCandidateId: string;
  readonly rigName: string;
  readonly soakId: string;
  readonly leaseId: string;
  readonly workerService: string;
  readonly workerRuntimeServiceAccount: string;
  readonly schedulerOidcServiceAccount: string;
  readonly schedulerJobNames: readonly string[];
  readonly provisionApprovalId: string;
  readonly provisionApprovalEnvelopeSha256: string;
  readonly provisionSignedPayloadSha256: string;
  readonly provisionAdmissionSha256: string;
  readonly approvalClaim: Readonly<{ objectUri: string; generation: string; sha256: string }>;
  readonly topologyOwnership: Readonly<{ objectUri: string; generation: string; sha256: string }>;
  readonly preparationId: string;
  readonly preparationApprovalEnvelopeSha256: string;
  readonly preparationSignedPayloadSha256: string;
  readonly preparationIntent: Readonly<{ objectUri: string; generation: string; sha256: string }>;
  readonly preparationOutcome: Readonly<{ objectUri: string; generation: string; sha256: string }>;
  readonly preclockArtifactSha256: string;
  readonly actionExpiresAt: string;
  readonly runHardStopAt: string;
}

export interface B1LockedObject {
  readonly uri: string;
  readonly generation: string;
  readonly retainUntilTime: string;
  readonly raw: string;
}

export interface B1SchedulerJobObservation {
  readonly name: string;
  readonly resourceName: string;
  readonly state: 'PAUSED' | 'ENABLED';
  readonly path: string;
  readonly uri: string;
  readonly schedule: string;
  readonly timeZone: string;
  readonly attemptDeadline: string;
  readonly retry: Readonly<{ minBackoff: string; maxBackoff: string; maxDoublings: number }>;
  readonly httpMethod: 'POST';
  readonly oidcServiceAccountEmail: string;
  readonly oidcAudience: string;
  readonly cronHeaderPresent: boolean;
  readonly cronHeaderSha256: string;
  readonly observedAt: string;
}

export interface B1ActivationObservation {
  readonly observedAt: string;
  readonly workerRevision: string;
  readonly sourceHeadSha: string;
  readonly imageDigest: string;
  readonly runtimeServiceAccount: string;
  readonly serviceUrl: string;
  readonly healthStatusCode: 200;
  readonly healthStatus: 'healthy';
  readonly healthGitSha: string;
}

export interface B1SchedulerStartReceipt {
  readonly [field: string]: unknown;
  readonly schemaVersion: typeof B1_SCHEDULER_START_CONTRACT.schemaVersion;
  readonly status: 'COUNTED_START';
  readonly scheduler: Readonly<{
    projectId: string;
    location: string;
    serviceUrl: string;
    cadence: string;
    jobs: readonly B1SchedulerJobObservation[];
  }>;
}

export interface B1SchedulerStartPort {
  now(): Date;
  projectAdmission?(raw: string): B1SchedulerStartAdmission;
  verifyPreclock?(raw: string, admission: B1SchedulerStartAdmission): B1SchedulerStartPreclock;
  verifySignedApproval?(raw: string, now: Date): VerifiedB1StartApproval;
  hasStartReceipt(uri: string): Promise<boolean>;
  readLockedObject(uri: string, generation?: string): Promise<B1LockedObject>;
  observeJob(spec: JobSpec): Promise<B1SchedulerJobObservation>;
  observeActivation(expected: Readonly<{
    workerRevision: string;
    sourceHeadSha: string;
    imageDigest: string;
    runtimeServiceAccount: string;
    serviceUrl: string;
  }>): Promise<B1ActivationObservation>;
  readSecretSha256(secretName: string, version: string): Promise<string>;
  installInvocationLease(input: Readonly<{
    approvalId: string;
    expiresAt: string;
    authorityExpiresAt: string;
  }>): Promise<void>;
  removeInvocationLease(approvalId: string): Promise<void>;
  resumeJob(name: string): Promise<void>;
  pauseJob(name: string): Promise<void>;
  persistStartReceipt(uri: string, raw: string, retainUntilTime: string): Promise<void>;
}

const admissionExtractSchema = z.object({
  generated_at: timestamp,
  rig_name: z.literal(B1_SCHEDULER_START_CONTRACT.rigName),
  soak_id: boundedId,
  lease_id: boundedId,
  sha: gitSha,
  image: pinnedWorkerImage,
  image_digest: sha256,
  gcp_project_id: z.literal(B1_SCHEDULER_START_CONTRACT.gcpProjectId),
  region: z.literal(B1_SCHEDULER_START_CONTRACT.gcpRegion),
  supabase_project_ref: projectRef,
  cloud_run_service: z.literal(B1_SCHEDULER_START_CONTRACT.workerService),
  deployed_revision: z.string().min(1),
  clean_mirror_attestation_id: sha256,
  clean_mirror: z.object({ verified_at: timestamp }).passthrough(),
  required_uptime_min: z.literal(B1_SCHEDULER_START_CONTRACT.requiredWorkerUptimeMin),
  required_wall_min: z.number().int().min(B1_SCHEDULER_START_CONTRACT.requiredWallMin),
  infrastructure: z.object({
    nodeReadiness: z.unknown(),
    secretReferences: z.array(z.object({
      env: z.string(),
      secretName: z.string(),
      version: z.string().regex(/^[1-9][0-9]*$/u),
      resource: z.string(),
    }).strict()).length(9),
    authority: z.object({
      approvalId: boundedId,
      approvalEnvelopeSha256: sha256,
      signedPayloadSha256: sha256,
      claim: z.object({ objectUri: z.string(), generation: numericGeneration }).passthrough(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const preclockIdentityShape = {
  status: z.literal('PRE_CLOCK_READY'),
  admissionSha256: sha256,
  sourceHeadSha: gitSha,
  workerImageDigest: sha256,
  cleanMirrorAttestationId: sha256,
  nodeReadinessSha256: sha256,
  observedAt: timestamp,
  schedulerJobsPaused: z.literal(6),
  schedulerCadence: z.literal(B1_SCHEDULER_START_CONTRACT.cadence),
} as const;

const treasuryPlanInputSchema = z.object({
  planId: boundedId,
  network: z.literal('signet'),
  treasuryAddress: z.string().regex(/^tb1[a-z0-9]{20,87}$/u),
  inputs: z.array(z.object({
    txId: z.string().regex(/^[0-9a-f]{64}$/u),
    vout: z.number().int().nonnegative().safe(),
    valueSats: z.number().int().positive().safe(),
    confirmations: z.number().int().positive().safe(),
  }).strict()).min(1),
  outputCount: z.literal(32),
  feeSats: z.number().int().nonnegative().safe(),
  minOutputSats: z.number().int().positive().safe(),
}).strict();

const preclockArtifactSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.scheduler-start-preclock/v1'),
  ...preclockIdentityShape,
  sourceEvidence: z.object({
    treasuryPlanInput: treasuryPlanInputSchema,
    readinessObservation: z.unknown(),
  }).strict(),
}).strict();

const claimSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.node-approval-claim/v1'),
  approvalId: boundedId,
  envelopeSha256: sha256,
  signedPayloadSha256: sha256,
  sourceHeadSha: gitSha,
  sourceTreeSha: gitSha,
  corpusDigest: sha256,
  releaseCandidateId: boundedId,
  soakId: boundedId,
  leaseId: boundedId,
  spendCapUsd: z.number().int().min(1).max(200),
  claimedAt: timestamp,
}).strict();

const topologySchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.topology-ownership/v1'),
  approvalId: boundedId,
  envelopeSha256: sha256,
  signedPayloadSha256: sha256,
  sourceHeadSha: gitSha,
  sourceTreeSha: gitSha,
  corpusDigest: sha256,
  releaseCandidateId: boundedId,
  rigId: z.literal(B1_SCHEDULER_START_CONTRACT.rigId),
  rigName: z.literal(B1_SCHEDULER_START_CONTRACT.rigName),
  soakId: boundedId,
  leaseId: boundedId,
  gcpProjectId: z.literal(B1_SCHEDULER_START_CONTRACT.gcpProjectId),
  gcpRegion: z.literal(B1_SCHEDULER_START_CONTRACT.gcpRegion),
  supabaseProjectRef: projectRef,
  supabaseProjectName: z.literal('arkova-soak-s33-rig-b1'),
  workerService: z.literal(B1_SCHEDULER_START_CONTRACT.workerService),
  workerRuntimeServiceAccount: z.literal(B1_SCHEDULER_START_CONTRACT.workerRuntimeServiceAccount),
  schedulerOidcServiceAccount: z.literal(B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount),
  cloudRunServiceUrl: z.string().url(),
  schedulerJobNames: z.array(z.string()).length(6),
  nodeReadinessSha256: sha256.optional(),
  nodeReadiness: z.unknown().optional(),
  approvalClaim: z.object({ objectUri: z.string(), generation: numericGeneration }).strict(),
}).passthrough();

const preparationIntentStartSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.preparation-intent/v1'),
  status: z.literal('PREPARE_INTENT_LOCKED'),
  preparationId: boundedId,
  authorityEnvelopeSha256: sha256,
  authoritySignedPayloadSha256: sha256,
  provisionApprovalEnvelopeSha256: sha256,
  provisionSignedPayloadSha256: sha256,
  admissionSha256: sha256,
  sourceHeadSha: gitSha,
  sourceTreeSha: gitSha,
  workerImageDigest: sha256,
  corpusDigest: sha256,
  releaseCandidateId: boundedId,
  soakId: boundedId,
  leaseId: boundedId,
  maxFundedBroadcasts: z.literal(1),
  invocationLeaseMaxSeconds: z.literal(600),
  authorityExpiresAt: timestamp,
}).passthrough();

const preparationOutcomeStartSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.preparation-outcome/v1'),
  status: z.literal('PRE_CLOCK_READY'),
  preparationId: boundedId,
  intentSha256: sha256,
  admissionSha256: sha256,
  preclockArtifactSha256: sha256,
  preclockArtifactRaw: z.string().min(1),
  completedAt: timestamp,
}).passthrough();

function digestRaw(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function digestJson(value: unknown): string {
  return digestRaw(JSON.stringify(value));
}

function parseStrict(raw: string, label: string): unknown {
  return parseJsonRejectingDuplicateKeys(raw, label);
}

export function projectB1SchedulerStartAdmission(raw: string): B1SchedulerStartAdmission {
  const handle = projectAdmissionV2ToPreClockIdentity(raw);
  const identity = requirePreClockAdmissionIdentity(handle);
  const value = admissionExtractSchema.parse(parseStrict(raw, 'RIG-B1 admission'));
  if (identity.gitHeadSha !== value.sha || identity.imageDigest !== value.image_digest) {
    throw new Error('RIG-B1 admission projection identity is contradictory.');
  }
  const cron = value.infrastructure.secretReferences.find(({ env }) => env === 'CRON_SECRET');
  if (cron === undefined
    || cron.resource !== `projects/${B1_SCHEDULER_START_CONTRACT.gcpProjectId}/secrets/${cron.secretName}/versions/${cron.version}`) {
    throw new Error('RIG-B1 admission lacks the exact numeric CRON_SECRET binding.');
  }
  return {
    admissionSha256: `sha256:${handle.admissionSha256}`,
    generatedAt: value.generated_at,
    cleanMirrorVerifiedAt: value.clean_mirror.verified_at,
    rigName: value.rig_name,
    soakId: value.soak_id,
    leaseId: value.lease_id,
    sourceHeadSha: value.sha,
    workerImage: value.image,
    workerImageDigest: value.image_digest,
    gcpProjectId: value.gcp_project_id,
    gcpRegion: value.region,
    supabaseProjectRef: value.supabase_project_ref,
    workerService: value.cloud_run_service,
    workerRevision: value.deployed_revision,
    schedulerOidcServiceAccount: B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount,
    cleanMirrorAttestationId: value.clean_mirror_attestation_id,
    requiredWorkerUptimeMin: value.required_uptime_min,
    requiredWallMin: value.required_wall_min,
    approvalId: value.infrastructure.authority.approvalId,
    approvalEnvelopeSha256: value.infrastructure.authority.approvalEnvelopeSha256,
    signedPayloadSha256: value.infrastructure.authority.signedPayloadSha256,
    approvalClaimUri: value.infrastructure.authority.claim.objectUri,
    approvalClaimGeneration: value.infrastructure.authority.claim.generation,
    nodeReadinessSha256: digestJson(value.infrastructure.nodeReadiness),
    cronSecretName: cron.secretName,
    cronSecretVersion: cron.version,
    cronSecretResource: cron.resource,
  };
}

function computePreclockIdentity(
  admissionRaw: string,
  admission: B1SchedulerStartAdmission,
  treasuryPlanInput: TreasuryPresplitPlanInput,
  readinessObservation: unknown,
): Omit<B1SchedulerStartPreclock, 'preclockSha256'> {
  const handle = projectAdmissionV2ToPreClockIdentity(admissionRaw);
  const plan = buildRigB1ReadinessPlan(handle, {
    treasurySplitPlan: planTreasuryPresplit(treasuryPlanInput),
  });
  const summary = assertRigB1PreClockReadiness(plan, readinessObservation);
  const schedulerPolicy = z.object({ observedAt: timestamp }).passthrough().parse(
    z.object({ schedulerPolicy: z.unknown() }).passthrough().parse(readinessObservation)
      .schedulerPolicy,
  );
  return {
    status: summary.status,
    admissionSha256: admission.admissionSha256,
    sourceHeadSha: admission.sourceHeadSha,
    workerImageDigest: admission.workerImageDigest,
    cleanMirrorAttestationId: admission.cleanMirrorAttestationId,
    nodeReadinessSha256: admission.nodeReadinessSha256,
    observedAt: schedulerPolicy.observedAt,
    schedulerJobsPaused: summary.schedulerJobsPaused,
    schedulerCadence: summary.schedulerCadence,
  };
}

/**
 * Produce the only start-consumable pre-clock artifact from strict raw
 * admission, deterministic treasury input, and the full supervised readiness
 * observation. The start driver reruns the same validation; this artifact is
 * evidence transport, not a new trust root.
 */
export function buildB1SchedulerStartPreclockArtifact(
  admissionRaw: string,
  treasuryPlanInputRaw: string,
  readinessObservationRaw: string,
): string {
  const admission = projectB1SchedulerStartAdmission(admissionRaw);
  const treasuryPlanInput = treasuryPlanInputSchema.parse(
    parseStrict(treasuryPlanInputRaw, 'RIG-B1 treasury pre-split plan input'),
  );
  const readinessObservation = parseStrict(
    readinessObservationRaw,
    'RIG-B1 supervised readiness observation',
  );
  const identity = computePreclockIdentity(
    admissionRaw,
    admission,
    treasuryPlanInput,
    readinessObservation,
  );
  return JSON.stringify({
    schemaVersion: 'arkova.s33.rig-b1.scheduler-start-preclock/v1',
    ...identity,
    sourceEvidence: { treasuryPlanInput, readinessObservation },
  });
}

function defaultVerifyPreclock(
  raw: string,
  admissionRaw: string,
  admission: B1SchedulerStartAdmission,
): B1SchedulerStartPreclock {
  const artifact = preclockArtifactSchema.parse(parseStrict(raw, 'RIG-B1 pre-clock artifact'));
  const computed = computePreclockIdentity(
    admissionRaw,
    admission,
    artifact.sourceEvidence.treasuryPlanInput,
    artifact.sourceEvidence.readinessObservation,
  );
  const advertised = {
    status: artifact.status,
    admissionSha256: artifact.admissionSha256,
    sourceHeadSha: artifact.sourceHeadSha,
    workerImageDigest: artifact.workerImageDigest,
    cleanMirrorAttestationId: artifact.cleanMirrorAttestationId,
    nodeReadinessSha256: artifact.nodeReadinessSha256,
    observedAt: artifact.observedAt,
    schedulerJobsPaused: artifact.schedulerJobsPaused,
    schedulerCadence: artifact.schedulerCadence,
  };
  if (!isDeepStrictEqual(advertised, computed)) {
    throw new Error('RIG-B1 augmented pre-clock artifact differs from its full source evidence.');
  }
  return { ...computed, preclockSha256: digestRaw(raw) };
}

export function verifyB1SchedulerStartApproval(raw: string, now: Date): VerifiedB1StartApproval {
  const verified: VerifiedB1StartAuthority = createProductionB1StartAuthorityVerifier().verify(raw, now);
  return {
    status: 'VERIFIED',
    keyId: verified.authority.keyId,
    verifierIdentity: verified.verifierIdentity,
    envelopeSha256: verified.envelopeSha256,
    signedPayloadSha256: verified.signedPayloadSha256,
    startId: verified.startId,
    purpose: verified.authority.purpose,
    sourceHeadSha: verified.candidate.sourceHeadSha,
    sourceTreeSha: verified.candidate.sourceTreeSha,
    workerImage: verified.candidate.workerImage,
    workerImageDigest: verified.candidate.workerImageDigest,
    corpusDigest: verified.candidate.corpusDigest,
    releaseCandidateId: verified.candidate.releaseCandidateId,
    rigName: verified.run.rigName,
    soakId: verified.run.soakId,
    leaseId: verified.run.leaseId,
    workerService: verified.run.workerService,
    workerRuntimeServiceAccount: verified.run.workerRuntimeServiceAccount,
    schedulerOidcServiceAccount: verified.run.schedulerOidcServiceAccount,
    schedulerJobNames: verified.run.schedulerJobResources.map((resource) => resource.split('/').at(-1)!),
    provisionApprovalId: verified.prerequisites.provision.approvalId,
    provisionApprovalEnvelopeSha256: verified.prerequisites.provision.approvalEnvelopeSha256,
    provisionSignedPayloadSha256: verified.prerequisites.provision.signedPayloadSha256,
    provisionAdmissionSha256: verified.prerequisites.provision.admissionSha256,
    approvalClaim: verified.prerequisites.provision.approvalClaim,
    topologyOwnership: verified.prerequisites.provision.topologyOwnership,
    preparationId: verified.prerequisites.preparation.preparationId,
    preparationApprovalEnvelopeSha256: verified.prerequisites.preparation.approvalEnvelopeSha256,
    preparationSignedPayloadSha256: verified.prerequisites.preparation.signedPayloadSha256,
    preparationIntent: verified.prerequisites.preparation.intent,
    preparationOutcome: verified.prerequisites.preparation.outcome,
    preclockArtifactSha256: verified.prerequisites.preparation.preclockArtifactSha256,
    actionExpiresAt: verified.expiresAt,
    runHardStopAt: verified.run.runHardStopAt,
  };
}

export function expectedB1SchedulerStartConfirmation(input: Readonly<{
  startId: string;
  soakId: string;
  leaseId: string;
  admissionSha256: string;
  preclockSha256: string;
}>): string {
  return `START_B1:${input.startId}:${input.soakId}:${input.leaseId}:${input.admissionSha256}:${input.preclockSha256}`;
}

function jobName(spec: JobSpec): string {
  return `${B1_SCHEDULER_START_CONTRACT.workerService}-${spec.suffix}`;
}

function exactJobNames(): readonly string[] {
  return B1_SCHEDULER_START_CONTRACT.jobs.map(jobName);
}

function assertCommonBindings(
  admission: B1SchedulerStartAdmission,
  preclock: B1SchedulerStartPreclock,
  approval: VerifiedB1StartApproval,
): void {
  const contract = B1_SCHEDULER_START_CONTRACT;
  const expectedImage = `${contract.workerImageRepository}@${admission.workerImageDigest}`;
  if (admission.admissionSha256 !== preclock.admissionSha256
    || admission.sourceHeadSha !== preclock.sourceHeadSha
    || admission.workerImageDigest !== preclock.workerImageDigest
    || admission.cleanMirrorAttestationId !== preclock.cleanMirrorAttestationId
    || admission.nodeReadinessSha256 !== preclock.nodeReadinessSha256) {
    throw new Error('RIG-B1 admission/pre-clock bindings differ.');
  }
  if (admission.rigName !== contract.rigName
    || admission.gcpProjectId !== contract.gcpProjectId
    || admission.gcpRegion !== contract.gcpRegion
    || admission.workerService !== contract.workerService
    || admission.schedulerOidcServiceAccount !== contract.schedulerOidcServiceAccount
    || admission.requiredWorkerUptimeMin !== contract.requiredWorkerUptimeMin
    || admission.requiredWallMin < contract.requiredWallMin
    || admission.workerImage !== expectedImage) {
    throw new Error('RIG-B1 admission differs from the frozen start contract.');
  }
  if (approval.keyId !== contract.keyId
    || approval.verifierIdentity !== contract.verifierIdentity
    || approval.purpose !== contract.authorityPurpose
    || approval.provisionApprovalId !== admission.approvalId
    || approval.provisionApprovalEnvelopeSha256 !== admission.approvalEnvelopeSha256
    || approval.provisionSignedPayloadSha256 !== admission.signedPayloadSha256
    || approval.provisionAdmissionSha256 !== admission.admissionSha256
    || approval.preclockArtifactSha256 !== preclock.preclockSha256
    || approval.sourceHeadSha !== admission.sourceHeadSha
    || approval.workerImage !== admission.workerImage
    || approval.workerImageDigest !== admission.workerImageDigest
    || approval.rigName !== contract.rigName
    || approval.soakId !== admission.soakId
    || approval.leaseId !== admission.leaseId
    || approval.workerService !== contract.workerService
    || approval.workerRuntimeServiceAccount !== contract.workerRuntimeServiceAccount
    || approval.schedulerOidcServiceAccount !== contract.schedulerOidcServiceAccount
    || !isDeepStrictEqual(approval.schedulerJobNames, exactJobNames())) {
    throw new Error('RIG-B1 signed START authority differs from the exact candidate/admission/PREPARE topology.');
  }
  if (preclock.status !== 'PRE_CLOCK_READY'
    || preclock.schedulerJobsPaused !== 6
    || preclock.schedulerCadence !== contract.cadence) {
    throw new Error('RIG-B1 pre-clock Scheduler admission is incomplete.');
  }
}

function assertRetention(object: B1LockedObject, uri: string, expiresAt: string): void {
  if (object.uri !== uri || !numericGeneration.safeParse(object.generation).success
    || !Number.isFinite(Date.parse(object.retainUntilTime))
    || Date.parse(object.retainUntilTime) < Date.parse(expiresAt)) {
    throw new Error(`RIG-B1 locked object ${uri} does not retain the exact authority window.`);
  }
}

function assertOwnership(
  claimObject: B1LockedObject,
  topologyObject: B1LockedObject,
  admission: B1SchedulerStartAdmission,
  approval: VerifiedB1StartApproval,
): string {
  assertRetention(claimObject, approval.approvalClaim.objectUri, approval.runHardStopAt);
  if (claimObject.generation !== admission.approvalClaimGeneration
    || claimObject.generation !== approval.approvalClaim.generation
    || claimObject.uri !== admission.approvalClaimUri
    || digestRaw(claimObject.raw) !== approval.approvalClaim.sha256) {
    throw new Error('RIG-B1 approval claim generation differs from admission.');
  }
  const claim = claimSchema.parse(parseStrict(claimObject.raw, 'RIG-B1 approval claim'));
  const topology = topologySchema.parse(parseStrict(topologyObject.raw, 'RIG-B1 topology ownership'));
  const commonExpected = {
    approvalId: approval.provisionApprovalId,
    envelopeSha256: approval.provisionApprovalEnvelopeSha256,
    signedPayloadSha256: approval.provisionSignedPayloadSha256,
    sourceHeadSha: approval.sourceHeadSha,
    sourceTreeSha: approval.sourceTreeSha,
    corpusDigest: approval.corpusDigest,
    releaseCandidateId: approval.releaseCandidateId,
    soakId: approval.soakId,
    leaseId: approval.leaseId,
  };
  for (const [field, expected] of Object.entries(commonExpected)) {
    if (claim[field as keyof typeof claim] !== expected || topology[field as keyof typeof topology] !== expected) {
      throw new Error(`RIG-B1 immutable ownership ${field} binding differs.`);
    }
  }
  if (topology.supabaseProjectRef !== admission.supabaseProjectRef
    || topology.workerService !== admission.workerService
    || topology.schedulerOidcServiceAccount !== admission.schedulerOidcServiceAccount
    || !isDeepStrictEqual(topology.schedulerJobNames, exactJobNames())
    || topology.approvalClaim.objectUri !== admission.approvalClaimUri
    || topology.approvalClaim.generation !== admission.approvalClaimGeneration
    || topologyObject.uri !== approval.topologyOwnership.objectUri
    || topologyObject.generation !== approval.topologyOwnership.generation
    || digestRaw(topologyObject.raw) !== approval.topologyOwnership.sha256) {
    throw new Error('RIG-B1 immutable topology binding differs from admission.');
  }
  const topologyReadiness = topology.nodeReadinessSha256
    ?? (topology.nodeReadiness === undefined ? undefined : digestJson(topology.nodeReadiness));
  if (topologyReadiness !== admission.nodeReadinessSha256) {
    throw new Error('RIG-B1 immutable node-readiness binding differs from admission.');
  }
  assertRetention(topologyObject, approval.topologyOwnership.objectUri, approval.runHardStopAt);
  return topology.cloudRunServiceUrl;
}

function assertPreparationOwnership(
  intentObject: B1LockedObject,
  outcomeObject: B1LockedObject,
  approval: VerifiedB1StartApproval,
  admission: B1SchedulerStartAdmission,
  preclock: B1SchedulerStartPreclock,
  preclockRaw: string,
): void {
  assertRetention(intentObject, approval.preparationIntent.objectUri, approval.runHardStopAt);
  assertRetention(outcomeObject, approval.preparationOutcome.objectUri, approval.runHardStopAt);
  if (intentObject.generation !== approval.preparationIntent.generation
    || outcomeObject.generation !== approval.preparationOutcome.generation
    || digestRaw(intentObject.raw) !== approval.preparationIntent.sha256
    || digestRaw(outcomeObject.raw) !== approval.preparationOutcome.sha256) {
    throw new Error('RIG-B1 START preparation Locked object identity/digest differs.');
  }
  const intent = preparationIntentStartSchema.parse(
    parseStrict(intentObject.raw, 'RIG-B1 START preparation intent'),
  );
  const outcome = preparationOutcomeStartSchema.parse(
    parseStrict(outcomeObject.raw, 'RIG-B1 START preparation outcome'),
  );
  if (intent.preparationId !== approval.preparationId
    || intent.authorityEnvelopeSha256 !== approval.preparationApprovalEnvelopeSha256
    || intent.authoritySignedPayloadSha256 !== approval.preparationSignedPayloadSha256
    || intent.provisionApprovalEnvelopeSha256 !== approval.provisionApprovalEnvelopeSha256
    || intent.provisionSignedPayloadSha256 !== approval.provisionSignedPayloadSha256
    || intent.admissionSha256 !== admission.admissionSha256
    || intent.sourceHeadSha !== approval.sourceHeadSha
    || intent.sourceTreeSha !== approval.sourceTreeSha
    || intent.workerImageDigest !== approval.workerImageDigest
    || intent.corpusDigest !== approval.corpusDigest
    || intent.releaseCandidateId !== approval.releaseCandidateId
    || intent.soakId !== approval.soakId
    || intent.leaseId !== approval.leaseId
    || outcome.preparationId !== approval.preparationId
    || outcome.intentSha256 !== digestRaw(intentObject.raw)
    || outcome.admissionSha256 !== admission.admissionSha256
    || outcome.preclockArtifactSha256 !== preclock.preclockSha256
    || outcome.preclockArtifactRaw !== preclockRaw) {
    throw new Error('RIG-B1 START preparation intent/outcome differs from signed prerequisites.');
  }
}

function assertJobBinding(
  observed: B1SchedulerJobObservation,
  spec: JobSpec,
  expectedState: 'PAUSED' | 'ENABLED',
  serviceUrl: string,
  expectedCronHeaderSha256: string,
): void {
  const name = jobName(spec);
  const expectedResource = `projects/${B1_SCHEDULER_START_CONTRACT.gcpProjectId}/locations/${B1_SCHEDULER_START_CONTRACT.gcpRegion}/jobs/${name}`;
  if (observed.name !== name || observed.resourceName !== expectedResource
    || observed.state !== expectedState || observed.path !== spec.path
    || observed.uri !== `${serviceUrl}${spec.path}`
    || observed.schedule !== B1_SCHEDULER_START_CONTRACT.cadence
    || observed.timeZone !== spec.timeZone
    || observed.attemptDeadline !== spec.attemptDeadline
    || !isDeepStrictEqual(observed.retry, B1_SCHEDULER_START_CONTRACT.retry)
    || observed.httpMethod !== 'POST'
    || observed.oidcServiceAccountEmail !== B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount
    || observed.oidcAudience !== serviceUrl
    || observed.cronHeaderPresent !== true
    || observed.cronHeaderSha256 !== expectedCronHeaderSha256
    || !Number.isFinite(Date.parse(observed.observedAt))) {
    throw new Error(`RIG-B1 Scheduler binding/state mismatch for ${name}; expected ${expectedState}.`);
  }
}

async function containPaused(
  port: B1SchedulerStartPort,
  serviceUrl: string,
  expectedCronHeaderSha256: string,
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const spec of B1_SCHEDULER_START_CONTRACT.jobs) {
    try { await port.pauseJob(jobName(spec)); } catch (error) {
      failures.push(new Error(`pause ${jobName(spec)} failed: ${error instanceof Error ? error.message : 'unknown error'}`));
    }
  }
  for (const spec of B1_SCHEDULER_START_CONTRACT.jobs) {
    try {
      assertJobBinding(
        await port.observeJob(spec),
        spec,
        'PAUSED',
        serviceUrl,
        expectedCronHeaderSha256,
      );
    } catch (error) {
      failures.push(new Error(`PAUSED verification ${jobName(spec)} failed: ${error instanceof Error ? error.message : 'unknown error'}`));
    }
  }
  return failures;
}

function rethrowWithContainment(original: unknown, failures: readonly Error[]): never {
  const originalError = original instanceof Error ? original : new Error('RIG-B1 Scheduler start failed.');
  if (failures.length === 0) throw originalError;
  throw new AggregateError([originalError, ...failures], `${originalError.message}; PAUSED containment also failed.`);
}

function assertStartActionCurrent(now: Date, actionExpiresAt: string): void {
  const nowMs = now.getTime();
  const expiry = Date.parse(actionExpiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiry) || nowMs >= expiry) {
    throw new Error('RIG-B1 START action authority expired before activation completed.');
  }
}

function assertRunHardStopCapacity(
  now: Date,
  runHardStopAt: string,
  requiredWallMin: number,
): void {
  const nowMs = now.getTime();
  const hardStop = Date.parse(runHardStopAt);
  const minimumHardStop = nowMs + requiredWallMin * 60_000;
  if (!Number.isFinite(nowMs) || !Number.isFinite(hardStop) || hardStop < minimumHardStop) {
    throw new Error('RIG-B1 signed run hard stop cannot cover the complete required wall from counted start.');
  }
}

function assertActivationObservation(
  observed: B1ActivationObservation,
  expected: Readonly<{
    workerRevision: string;
    sourceHeadSha: string;
    imageDigest: string;
    runtimeServiceAccount: string;
    serviceUrl: string;
  }>,
): void {
  if (observed.workerRevision !== expected.workerRevision
    || observed.sourceHeadSha !== expected.sourceHeadSha
    || observed.imageDigest !== expected.imageDigest
    || observed.runtimeServiceAccount !== expected.runtimeServiceAccount
    || observed.serviceUrl !== expected.serviceUrl
    || observed.healthStatusCode !== 200
    || observed.healthStatus !== 'healthy'
    || observed.healthGitSha !== expected.sourceHeadSha
    || !Number.isFinite(Date.parse(observed.observedAt))) {
    throw new Error('RIG-B1 activation observation differs from the exact admitted worker revision/health.');
  }
}

async function containStart(
  port: B1SchedulerStartPort,
  serviceUrl: string,
  cronHeaderSha256: string,
  approvalId: string,
): Promise<Error[]> {
  const failures = await containPaused(port, serviceUrl, cronHeaderSha256);
  try { await port.removeInvocationLease(approvalId); } catch (error) {
    failures.push(new Error(`conditional Run Invoker removal failed: ${error instanceof Error ? error.message : 'unknown error'}`));
  }
  return failures;
}

export async function runS33B1SchedulerStartDriver(
  admissionRaw: string,
  preclockRaw: string,
  startAuthorityRaw: string,
  ctoConfirmation: string,
  port: B1SchedulerStartPort,
): Promise<Readonly<{ status: 'RIG_B1_SOAK_STARTED'; receipt: B1SchedulerStartReceipt }>> {
  const now = port.now();
  const admission = (port.projectAdmission ?? projectB1SchedulerStartAdmission)(admissionRaw);
  const preclock = port.verifyPreclock === undefined
    ? defaultVerifyPreclock(preclockRaw, admissionRaw, admission)
    : port.verifyPreclock(preclockRaw, admission);
  const approval = (port.verifySignedApproval ?? verifyB1SchedulerStartApproval)(startAuthorityRaw, now);
  assertCommonBindings(admission, preclock, approval);

  const expectedConfirmation = expectedB1SchedulerStartConfirmation({
    startId: approval.startId,
    soakId: approval.soakId,
    leaseId: approval.leaseId,
    admissionSha256: admission.admissionSha256,
    preclockSha256: preclock.preclockSha256,
  });
  if (ctoConfirmation !== expectedConfirmation) {
    throw new Error(`RIG-B1 start requires exact CTO confirmation ${expectedConfirmation}.`);
  }
  assertStartActionCurrent(now, approval.actionExpiresAt);
  assertRunHardStopCapacity(now, approval.runHardStopAt, admission.requiredWallMin);

  const receiptUri = `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/scheduler-start-receipts/${approval.startId}.json`;
  if (await port.hasStartReceipt(receiptUri)) {
    throw new Error('RIG-B1 Scheduler start receipt already exists; replay is forbidden.');
  }
  const claimObject = await port.readLockedObject(
    approval.approvalClaim.objectUri,
    approval.approvalClaim.generation,
  );
  const topologyObject = await port.readLockedObject(
    approval.topologyOwnership.objectUri,
    approval.topologyOwnership.generation,
  );
  const serviceUrl = assertOwnership(claimObject, topologyObject, admission, approval);
  const preparationIntentObject = await port.readLockedObject(
    approval.preparationIntent.objectUri,
    approval.preparationIntent.generation,
  );
  const preparationOutcomeObject = await port.readLockedObject(
    approval.preparationOutcome.objectUri,
    approval.preparationOutcome.generation,
  );
  assertPreparationOwnership(
    preparationIntentObject,
    preparationOutcomeObject,
    approval,
    admission,
    preclock,
    preclockRaw,
  );
  const cronHeaderSha256 = await port.readSecretSha256(
    admission.cronSecretName,
    admission.cronSecretVersion,
  );
  if (!sha256.safeParse(cronHeaderSha256).success) {
    throw new Error('RIG-B1 exact numeric CRON_SECRET read did not produce a SHA-256 identity.');
  }
  const activationUri = `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/scheduler-activation-intents/${approval.startId}.json`;
  if (await port.hasStartReceipt(activationUri)) {
    rethrowWithContainment(
      new Error('RIG-B1 generation-zero activation intent already exists; replay requires containment.'),
      await containStart(port, serviceUrl, cronHeaderSha256, approval.startId),
    );
  }

  try {
    const paused: B1SchedulerJobObservation[] = [];
    for (const spec of B1_SCHEDULER_START_CONTRACT.jobs) {
      const observed = await port.observeJob(spec);
      assertJobBinding(observed, spec, 'PAUSED', serviceUrl, cronHeaderSha256);
      paused.push(observed);
    }
    // Recheck both independent signed clocks immediately before recording the
    // one-shot activation intent. The short action authorizes activation; the
    // hard stop authorizes the complete foreground soak.
    const activationAt = port.now();
    assertStartActionCurrent(activationAt, approval.actionExpiresAt);
    assertRunHardStopCapacity(activationAt, approval.runHardStopAt, admission.requiredWallMin);
    const invocationLeaseExpiresAt = new Date(Math.min(
      activationAt.getTime() + 10 * 60_000,
      Date.parse(approval.actionExpiresAt),
    )).toISOString();
    const activationIntent = {
      schemaVersion: 'arkova.s33.rig-b1.scheduler-activation-intent/v1',
      status: 'PAUSED_ACTIVATION_INTENT',
      activationId: approval.startId,
      startAuthorityEnvelopeSha256: approval.envelopeSha256,
      startAuthoritySignedPayloadSha256: approval.signedPayloadSha256,
      admissionSha256: admission.admissionSha256,
      preclockSha256: preclock.preclockSha256,
      provisionApprovalId: approval.provisionApprovalId,
      provisionApprovalEnvelopeSha256: approval.provisionApprovalEnvelopeSha256,
      provisionSignedPayloadSha256: approval.provisionSignedPayloadSha256,
      preparationId: approval.preparationId,
      preparationApprovalEnvelopeSha256: approval.preparationApprovalEnvelopeSha256,
      preparationSignedPayloadSha256: approval.preparationSignedPayloadSha256,
      preparationIntent: {
        objectUri: preparationIntentObject.uri,
        generation: preparationIntentObject.generation,
        sha256: digestRaw(preparationIntentObject.raw),
      },
      preparationOutcome: {
        objectUri: preparationOutcomeObject.uri,
        generation: preparationOutcomeObject.generation,
        sha256: digestRaw(preparationOutcomeObject.raw),
      },
      sourceHeadSha: approval.sourceHeadSha,
      workerImageDigest: approval.workerImageDigest,
      workerRevision: admission.workerRevision,
      serviceUrl,
      cronHeaderSha256,
      schedulerJobs: paused.map((job) => ({ ...job })),
      invocationLeaseExpiresAt,
      actionExpiresAt: approval.actionExpiresAt,
      runHardStopAt: approval.runHardStopAt,
      recordedAt: activationAt.toISOString(),
    };
    const activationRaw = JSON.stringify(activationIntent);
    await port.persistStartReceipt(activationUri, activationRaw, approval.runHardStopAt);
    const activationReloaded = await port.readLockedObject(activationUri);
    assertRetention(activationReloaded, activationUri, approval.runHardStopAt);
    if (activationReloaded.raw !== activationRaw) {
      throw new Error('RIG-B1 Locked activation-intent readback differs before Scheduler resume.');
    }
    await port.installInvocationLease({
      approvalId: approval.startId,
      expiresAt: invocationLeaseExpiresAt,
      authorityExpiresAt: approval.actionExpiresAt,
    });
    const activationObservation = await port.observeActivation({
      workerRevision: admission.workerRevision,
      sourceHeadSha: approval.sourceHeadSha,
      imageDigest: approval.workerImageDigest,
      runtimeServiceAccount: approval.workerRuntimeServiceAccount,
      serviceUrl,
    });
    assertActivationObservation(activationObservation, {
      workerRevision: admission.workerRevision,
      sourceHeadSha: approval.sourceHeadSha,
      imageDigest: approval.workerImageDigest,
      runtimeServiceAccount: approval.workerRuntimeServiceAccount,
      serviceUrl,
    });
    for (const spec of B1_SCHEDULER_START_CONTRACT.jobs) {
      assertJobBinding(
        await port.observeJob(spec),
        spec,
        'PAUSED',
        serviceUrl,
        cronHeaderSha256,
      );
    }
    assertStartActionCurrent(port.now(), approval.actionExpiresAt);
    assertRunHardStopCapacity(port.now(), approval.runHardStopAt, admission.requiredWallMin);
    for (const spec of B1_SCHEDULER_START_CONTRACT.jobs) await port.resumeJob(jobName(spec));
    const enabled: B1SchedulerJobObservation[] = [];
    for (const spec of B1_SCHEDULER_START_CONTRACT.jobs) {
      const observed = await port.observeJob(spec);
      assertJobBinding(observed, spec, 'ENABLED', serviceUrl, cronHeaderSha256);
      enabled.push(observed);
    }
    const startedAtTime = port.now();
    assertStartActionCurrent(startedAtTime, approval.actionExpiresAt);
    assertRunHardStopCapacity(startedAtTime, approval.runHardStopAt, admission.requiredWallMin);
    const startedAt = startedAtTime.toISOString();
    const receipt: B1SchedulerStartReceipt = {
      schemaVersion: B1_SCHEDULER_START_CONTRACT.schemaVersion,
      status: 'COUNTED_START',
      activationId: approval.startId,
      authority: {
        keyId: approval.keyId,
        verifierIdentity: approval.verifierIdentity,
        purpose: approval.purpose,
        envelopeSha256: approval.envelopeSha256,
        signedPayloadSha256: approval.signedPayloadSha256,
        actionExpiresAt: approval.actionExpiresAt,
        runHardStopAt: approval.runHardStopAt,
      },
      candidate: {
        sourceHeadSha: approval.sourceHeadSha,
        sourceTreeSha: approval.sourceTreeSha,
        workerImage: approval.workerImage,
        workerImageDigest: approval.workerImageDigest,
        corpusDigest: approval.corpusDigest,
        releaseCandidateId: approval.releaseCandidateId,
      },
      run: {
        rigId: B1_SCHEDULER_START_CONTRACT.rigId,
        rigName: approval.rigName,
        soakId: approval.soakId,
        leaseId: approval.leaseId,
        requiredWorkerUptimeMin: admission.requiredWorkerUptimeMin,
        requiredWallMin: admission.requiredWallMin,
        startedAt,
      },
      evidence: {
        admissionSha256: admission.admissionSha256,
        preclockSha256: preclock.preclockSha256,
        cleanMirrorAttestationId: admission.cleanMirrorAttestationId,
        nodeReadinessSha256: admission.nodeReadinessSha256,
        provision: {
          approvalId: approval.provisionApprovalId,
          approvalEnvelopeSha256: approval.provisionApprovalEnvelopeSha256,
          signedPayloadSha256: approval.provisionSignedPayloadSha256,
          approvalClaim: {
            objectUri: claimObject.uri,
            generation: claimObject.generation,
            sha256: digestRaw(claimObject.raw),
          },
          topologyOwnership: {
            objectUri: topologyObject.uri,
            generation: topologyObject.generation,
            sha256: digestRaw(topologyObject.raw),
          },
        },
        preparation: {
          preparationId: approval.preparationId,
          approvalEnvelopeSha256: approval.preparationApprovalEnvelopeSha256,
          signedPayloadSha256: approval.preparationSignedPayloadSha256,
          intent: {
            objectUri: preparationIntentObject.uri,
            generation: preparationIntentObject.generation,
            sha256: digestRaw(preparationIntentObject.raw),
          },
          outcome: {
            objectUri: preparationOutcomeObject.uri,
            generation: preparationOutcomeObject.generation,
            sha256: digestRaw(preparationOutcomeObject.raw),
          },
        },
        activationIntentUri: activationReloaded.uri,
        activationIntentGeneration: activationReloaded.generation,
        activationIntentSha256: digestRaw(activationReloaded.raw),
      },
      scheduler: {
        projectId: B1_SCHEDULER_START_CONTRACT.gcpProjectId,
        location: B1_SCHEDULER_START_CONTRACT.gcpRegion,
        serviceUrl,
        cadence: B1_SCHEDULER_START_CONTRACT.cadence,
        jobs: enabled.map((job) => ({ ...job })),
      },
      ctoConfirmation,
    };
    const receiptRaw = JSON.stringify(receipt);
    // The start is not counted until the exact receipt is Locked while the
    // signed activation action is still current.
    assertStartActionCurrent(port.now(), approval.actionExpiresAt);
    assertRunHardStopCapacity(port.now(), approval.runHardStopAt, admission.requiredWallMin);
    await port.persistStartReceipt(receiptUri, receiptRaw, approval.runHardStopAt);
    const reloaded = await port.readLockedObject(receiptUri);
    assertRetention(reloaded, receiptUri, approval.runHardStopAt);
    if (reloaded.raw !== receiptRaw) throw new Error('RIG-B1 locked start receipt readback differs from the counted start.');
    assertStartActionCurrent(port.now(), approval.actionExpiresAt);
    assertRunHardStopCapacity(port.now(), approval.runHardStopAt, admission.requiredWallMin);
    return Object.freeze({ status: 'RIG_B1_SOAK_STARTED', receipt });
  } catch (error) {
    rethrowWithContainment(
      error,
      await containStart(port, serviceUrl, cronHeaderSha256, approval.startId),
    );
  }
}
