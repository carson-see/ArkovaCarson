/**
 * S3.3 RIG-G1 paired-start controller.
 *
 * Provisioning deliberately leaves both physical G1 arms paused. This module
 * is the single transition from admitted infrastructure to counted soak time.
 * It performs no cloud mutation itself: adapters supply read-only observation,
 * arm start/stop, and durable receipt persistence. A result is returned only
 * after the signed approval, exact admission, both live identities, start skew,
 * and the reloaded durable receipt all agree.
 */

import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import {
  createProductionG1SpendApprovalVerifier,
  type G1ExpectedCandidate,
  type VerifiedG1SpendApproval,
} from './s33-g1-spend-approval.mjs';

export const G1_PAIRED_START_CONTRACT = Object.freeze({
  schemaVersion: 'arkova.s33.g1.paired-start-receipt/v1',
  rigName: 's33-g1',
  soakTier: 'T2',
  maxStartSkewMin: 30,
  ctoIdentity: 'arkova.s33.approver.founder-cto.v1',
  gcpProjectId: 'arkova1',
  control: Object.freeze({
    rigId: 'RIG-G1-A',
    projectName: 'arkova-soak-s33-g1-a',
    service: 'arkova-worker-s33-g1-a-staging',
    runtimeServiceAccount: 's33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com',
  }),
  tuned: Object.freeze({
    rigId: 'RIG-G1-B',
    projectName: 'arkova-soak-s33-g1-b',
    service: 'arkova-worker-s33-g1-b-staging',
    runtimeServiceAccount: 's33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com',
    endpoint: 'projects/arkova1/locations/us-central1/endpoints/733001',
    modelVersion: 'projects/270018525501/locations/us-central1/models/6611494259700793344@1',
    checkpointId: '6',
    deployedModelId: '7330011',
  }),
} as const);

const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);
const projectRef = z.string().regex(/^[a-z]{20}$/u);
const numericIdentity = z.string().regex(/^[1-9][0-9]*$/u);
const httpsUrl = z.string().url().refine((value) => value.startsWith('https://'), {
  message: 'G1 arm URL must use HTTPS.',
});
const timestamp = z.string().datetime({ offset: true });

const signedScopeSchema = z.object({
  rigClass: z.literal('RIG-G1'),
  rigName: z.literal(G1_PAIRED_START_CONTRACT.rigName),
  rigProfile: z.literal('gemini'),
  soakId: boundedId,
  rigId: z.literal('RIG-G1'),
  leaseId: boundedId,
  corpusDigest: sha256,
  endpointId: z.literal('733001'),
  endpointResource: z.literal(G1_PAIRED_START_CONTRACT.tuned.endpoint),
  endpointDisplayName: z.literal('arkova-s33-rig-g1-b-tuned-v6'),
  vertexModelResource: z.literal(G1_PAIRED_START_CONTRACT.tuned.modelVersion),
  checkpointId: z.literal(G1_PAIRED_START_CONTRACT.tuned.checkpointId),
  deployedModelId: z.literal(G1_PAIRED_START_CONTRACT.tuned.deployedModelId),
  deployedModelDisplayName: z.literal('arkova-s33-rig-g1-b-tuned-v6'),
  deploymentResourcesMode: z.literal('TUNED_GEMINI_AUTOMATIC_RESOURCES'),
  minReplicaCount: z.literal(1),
  maxReplicaCount: z.literal(1),
  controlRuntimeServiceAccount: z.literal(G1_PAIRED_START_CONTRACT.control.runtimeServiceAccount),
  tunedRuntimeServiceAccount: z.literal(G1_PAIRED_START_CONTRACT.tuned.runtimeServiceAccount),
  controlService: z.literal(G1_PAIRED_START_CONTRACT.control.service),
  tunedService: z.literal(G1_PAIRED_START_CONTRACT.tuned.service),
  controlProjectName: z.literal(G1_PAIRED_START_CONTRACT.control.projectName),
  tunedProjectName: z.literal(G1_PAIRED_START_CONTRACT.tuned.projectName),
  controlSupabaseUrlSecret: z.literal('supabase-url-s33-g1-a-staging@1'),
  controlSupabaseServiceRoleSecret: z.literal('supabase-service-role-key-s33-g1-a-staging@1'),
  tunedSupabaseUrlSecret: z.literal('supabase-url-s33-g1-b-staging@1'),
  tunedSupabaseServiceRoleSecret: z.literal('supabase-service-role-key-s33-g1-b-staging@1'),
  controlRunId: boundedId,
  tunedRunId: boundedId,
  controlQueue: boundedId,
  tunedQueue: boundedId,
  pairedCadenceMaxMin: z.literal(G1_PAIRED_START_CONTRACT.maxStartSkewMin),
  secretReferences: z.object({
    stripeSecretKey: z.literal('stripe-secret-key-staging@1'),
    stripeWebhookSecret: z.literal('stripe-webhook-secret-staging@1'),
    apiKeyHmacSecret: z.literal('api-key-hmac-secret-staging@1'),
    cronSecret: z.literal('cron-secret@1'),
    geminiApiKey: z.literal('gemini-api-key@2'),
  }).strict(),
  immutableLedger: z.object({
    backend: z.literal('gcs-if-generation-match-0-locked-retention'),
    bucket: z.literal('arkova1-s33-immutable-authority-ledger'),
    projectId: z.literal('arkova1'),
    requiresPerObjectRetention: z.literal(true),
  }).strict(),
}).strict();

const embeddedApprovalSchema = z.object({
  status: z.literal('VERIFIED'),
  approvalId: boundedId,
  canonicalSha256: sha256,
  approverIdentity: z.literal(G1_PAIRED_START_CONTRACT.ctoIdentity),
  approverRole: z.enum(['founder', 'cto']),
  candidateSourceHeadSha: gitSha,
  candidateImageDigest: sha256,
  expiresAt: timestamp,
  scope: signedScopeSchema,
}).passthrough();

const cleanMirrorSchema = z.object({
  artifact: z.string().min(1),
  attestation_id: sha256,
  verified_at: timestamp,
}).strict();

const refreshVerifiedIdentitySchema = z.object({
  userId: z.string().uuid(),
  label: boundedId,
  initialSessionEstablishedAt: timestamp,
  refreshRotationVerifiedAt: timestamp,
}).strict();

const preclockReadinessSchema = z.object({
  status: z.literal('PRECLOCK_AUTH_READY'),
  rigId: z.enum(['RIG-G1-A', 'RIG-G1-B']),
  supabaseProjectRef: projectRef,
  service: z.string().min(1),
  revision: z.string().min(1),
  url: httpsUrl,
  imageDigest: sha256,
  sourceHeadSha: gitSha,
  runtimeServiceAccount: z.string().email(),
  appBoundary: z.object({
    route: z.literal('/api/v1/ai/template'),
    cloudRunIngress: z.literal('ALLOW_UNAUTHENTICATED_APP_AUTH_REQUIRED'),
    unauthenticatedHttpStatus: z.literal(401),
    invalidBearerHttpStatus: z.literal(401),
    validExactUserHttpStatus: z.literal(200),
    validExactUserId: z.string().uuid(),
  }).strict(),
  sessionPool: z.object({
    minimumRequired: z.literal(4),
    secretPersistence: z.literal('NONE'),
    refreshRotationCount: z.number().int().min(4).max(29),
    identities: z.array(refreshVerifiedIdentitySchema).min(4).max(29),
  }).strict(),
  verifiedAt: timestamp,
}).strict();

const armSchema = z.object({
  rig_id: z.enum(['RIG-G1-A', 'RIG-G1-B']),
  arm: z.enum(['public_control', 'tuned_v6']),
  supabase_project_name: z.string().min(1),
  supabase_project_ref: projectRef,
  service: z.string().min(1),
  runtime_service_account: z.string().email(),
  runtime_service_account_unique_id: numericIdentity,
  revision: z.string().min(1),
  url: httpsUrl,
  run_id: boundedId,
  queue: boundedId,
  queue_binding: z.literal('external_harness'),
  clean_mirror: cleanMirrorSchema,
  vertex_endpoint: z.unknown(),
  authenticated_capability_probe: z.object({ status: z.string().min(1) }).passthrough(),
}).passthrough();

const admissionSchema = z.object({
  schema_version: z.literal(2),
  kind: z.literal('isolated_rig_admission'),
  generated_at: timestamp,
  rig_name: z.literal(G1_PAIRED_START_CONTRACT.rigName),
  rig_id: z.literal('RIG-G1'),
  profile: z.literal('gemini'),
  soak_id: boundedId,
  lease_id: boundedId,
  gcp_project_id: z.literal(G1_PAIRED_START_CONTRACT.gcpProjectId),
  tier: z.literal(G1_PAIRED_START_CONTRACT.soakTier),
  required_uptime_min: z.literal(720),
  required_wall_min: z.number().int().min(750).safe(),
  sha: gitSha,
  declared_source_head: gitSha,
  source_head_image_digest: sha256,
  image_digest: sha256,
  deployed_image_digest: sha256,
  deployed_source_head: gitSha,
  preflight_result: z.literal('environment_type=clean_mirror_pair'),
  g1: z.object({
    corpus_digest: sha256,
    tier: z.literal(G1_PAIRED_START_CONTRACT.soakTier),
    paired_cadence_max_min: z.literal(G1_PAIRED_START_CONTRACT.maxStartSkewMin),
    execution_state: z.literal('PAUSED'),
    background_execution: z.literal('disabled'),
    actual_soak_clock: z.object({
      status: z.literal('DEFERRED_CTO_AUTHORITY'),
      deployment_timestamps_are_soak_clocks: z.literal(false),
    }).passthrough(),
    spend_approval: embeddedApprovalSchema,
    shared_inputs: z.object({ image: z.string().min(1), corpus_digest: sha256 }).strict(),
    arms: z.array(armSchema).length(2),
  }).passthrough(),
}).passthrough().superRefine((value, context) => {
  const approval = value.g1.spend_approval;
  const digests = [
    value.source_head_image_digest,
    value.image_digest,
    value.deployed_image_digest,
    approval.candidateImageDigest,
  ];
  if (new Set(digests).size !== 1) {
    context.addIssue({ code: 'custom', path: ['image_digest'], message: 'All admitted image digests must be exact.' });
  }
  const heads = [value.sha, value.declared_source_head, value.deployed_source_head, approval.candidateSourceHeadSha];
  if (new Set(heads).size !== 1) {
    context.addIssue({ code: 'custom', path: ['declared_source_head'], message: 'All admitted source SHAs must be exact.' });
  }
  if (value.g1.corpus_digest !== approval.scope.corpusDigest
    || value.g1.shared_inputs.corpus_digest !== approval.scope.corpusDigest) {
    context.addIssue({ code: 'custom', path: ['g1', 'corpus_digest'], message: 'Admission and signed corpus digests differ.' });
  }
  if (value.soak_id !== approval.scope.soakId || value.lease_id !== approval.scope.leaseId) {
    context.addIssue({ code: 'custom', path: ['g1', 'spend_approval', 'scope'], message: 'Admission and signed run identities differ.' });
  }
  if (value.required_wall_min < value.required_uptime_min) {
    context.addIssue({ code: 'custom', path: ['required_wall_min'], message: 'Required wall time cannot be below worker uptime.' });
  }

  const control = value.g1.arms.find((arm) => arm.rig_id === 'RIG-G1-A');
  const tuned = value.g1.arms.find((arm) => arm.rig_id === 'RIG-G1-B');
  if (control === undefined || tuned === undefined) {
    context.addIssue({ code: 'custom', path: ['g1', 'arms'], message: 'Exactly one physical G1-A and G1-B arm are required.' });
    return;
  }
  const expected = [
    [control, G1_PAIRED_START_CONTRACT.control, approval.scope.controlRunId, approval.scope.controlQueue],
    [tuned, G1_PAIRED_START_CONTRACT.tuned, approval.scope.tunedRunId, approval.scope.tunedQueue],
  ] as const;
  for (const [arm, fixed, runId, queue] of expected) {
    if (arm.supabase_project_name !== fixed.projectName
      || arm.service !== fixed.service
      || arm.runtime_service_account !== fixed.runtimeServiceAccount
      || arm.run_id !== runId
      || arm.queue !== queue) {
      context.addIssue({ code: 'custom', path: ['g1', 'arms'], message: `${arm.rig_id} physical identity differs from signed scope.` });
    }
  }
  if (control.arm !== 'public_control' || control.vertex_endpoint !== null
    || control.authenticated_capability_probe.status !== 'NOT_APPLICABLE') {
    context.addIssue({ code: 'custom', path: ['g1', 'arms'], message: 'G1-A must remain the endpoint-free public control.' });
  }
  const tunedEndpoint = tuned.vertex_endpoint as Record<string, unknown> | null;
  if (tuned.arm !== 'tuned_v6'
    || tunedEndpoint === null
    || tunedEndpoint.resource !== G1_PAIRED_START_CONTRACT.tuned.endpoint
    || tunedEndpoint.model_version_resource !== G1_PAIRED_START_CONTRACT.tuned.modelVersion
    || tunedEndpoint.checkpoint_id !== G1_PAIRED_START_CONTRACT.tuned.checkpointId
    || tunedEndpoint.deployed_model_id !== G1_PAIRED_START_CONTRACT.tuned.deployedModelId
    || tuned.authenticated_capability_probe.status !== 'PASSED_PRECLOCK_NO_CUSTOMER_DATA') {
    context.addIssue({ code: 'custom', path: ['g1', 'arms'], message: 'G1-B tuned endpoint or pre-clock capability evidence differs.' });
  }
  for (const field of [
    [control.supabase_project_ref, tuned.supabase_project_ref],
    [control.service, tuned.service],
    [control.runtime_service_account, tuned.runtime_service_account],
    [control.run_id, tuned.run_id],
    [control.queue, tuned.queue],
    [control.url, tuned.url],
    [control.clean_mirror.attestation_id, tuned.clean_mirror.attestation_id],
  ]) {
    if (field[0] === field[1]) {
      context.addIssue({ code: 'custom', path: ['g1', 'arms'], message: 'G1-A and G1-B physical/run identities must be distinct.' });
    }
  }
});

export type S33G1PairedStartAdmission = z.infer<typeof admissionSchema>;
export type S33G1AdmissionArm = S33G1PairedStartAdmission['g1']['arms'][number];
export type S33G1PreclockReadiness = z.infer<typeof preclockReadinessSchema>;

export interface S33G1ObservedArm {
  readonly rigId: 'RIG-G1-A' | 'RIG-G1-B';
  readonly supabaseProjectName: string;
  readonly supabaseProjectRef: string;
  readonly service: string;
  readonly runtimeServiceAccount: string;
  readonly runtimeServiceAccountUniqueId: string;
  readonly revision: string;
  readonly url: string;
  readonly imageDigest: string;
  readonly sourceHeadSha: string;
  readonly cleanMirrorAttestationId: string;
  readonly runId: string;
  readonly queue: string;
}

export interface S33G1ArmStartObservation {
  readonly rigId: 'RIG-G1-A' | 'RIG-G1-B';
  readonly runId: string;
  readonly queue: string;
  readonly sessionIdentity: string;
  readonly startedAt: string;
  readonly evidencePath: string;
  readonly logPath: string;
}

export interface S33G1ArmStartRequest {
  readonly admission: S33G1PairedStartAdmission;
  readonly arm: S33G1AdmissionArm;
  readonly observed: S33G1ObservedArm;
  readonly candidateTreeSha: string;
  readonly preclockReadiness: S33G1PreclockReadiness;
}

export type S33G1ArmPreparationRequest = Omit<S33G1ArmStartRequest, 'preclockReadiness'>;

export interface S33G1PairedStartReceipt {
  readonly schemaVersion: typeof G1_PAIRED_START_CONTRACT.schemaVersion;
  readonly receiptId: string;
  readonly approvalId: string;
  readonly approvalCanonicalSha256: string;
  readonly ctoIdentity: typeof G1_PAIRED_START_CONTRACT.ctoIdentity;
  readonly ctoConfirmation: string;
  readonly soakId: string;
  readonly leaseId: string;
  readonly candidateHeadSha: string;
  readonly candidateTreeSha: string;
  readonly imageDigest: string;
  readonly corpusDigest: string;
  readonly earliestStartedAt: string;
  readonly latestStartedAt: string;
  readonly startSkewMs: number;
  readonly maxStartSkewMs: number;
  readonly preclockReadiness: readonly [S33G1PreclockReadiness, S33G1PreclockReadiness];
  readonly arms: readonly [S33G1ArmStartObservation, S33G1ArmStartObservation];
}

export interface S33G1PairedStartPort {
  now(): Date;
  verifySignedApproval?(
    rawEnvelope: string,
    expected: G1ExpectedCandidate,
    now: Date,
  ): VerifiedG1SpendApproval;
  resolveCandidateTreeSha(headSha: string): Promise<string>;
  observeArm(arm: S33G1AdmissionArm): Promise<S33G1ObservedArm>;
  prepareArm(request: S33G1ArmPreparationRequest): Promise<S33G1PreclockReadiness>;
  startArm(request: S33G1ArmStartRequest): Promise<S33G1ArmStartObservation>;
  stopArm(observation: S33G1ArmStartObservation, reason: 'paired-start-failure'): Promise<void>;
  cleanupArmPreparation(arm: S33G1AdmissionArm, reason: 'paired-start-failure'): Promise<void>;
  loadStartReceipt(receiptId: string): Promise<unknown | null>;
  persistStartReceipt(receipt: S33G1PairedStartReceipt): Promise<void>;
}

export interface S33G1PairedStartResult {
  readonly status: 'PAIRED_SOAK_STARTED';
  readonly receipt: S33G1PairedStartReceipt;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function exactCtoConfirmation(approval: z.infer<typeof embeddedApprovalSchema>): string {
  return `START_G1:${approval.approvalId}:${approval.scope.soakId}:${approval.scope.leaseId}`;
}

function expectedCandidate(admission: S33G1PairedStartAdmission): G1ExpectedCandidate {
  return {
    sourceHeadSha: admission.declared_source_head,
    imageDigest: admission.image_digest,
    ...admission.g1.spend_approval.scope,
  };
}

function assertVerifiedApprovalMatchesAdmission(
  approval: VerifiedG1SpendApproval,
  admission: S33G1PairedStartAdmission,
): void {
  const embedded = admission.g1.spend_approval;
  if (approval.approverIdentity !== G1_PAIRED_START_CONTRACT.ctoIdentity
    || approval.approverRole !== 'cto') {
    throw new Error('RIG-G1 paired start requires an exact CTO-signed approval.');
  }
  if (approval.status !== 'VERIFIED'
    || approval.approvalId !== embedded.approvalId
    || approval.canonicalSha256 !== embedded.canonicalSha256
    || approval.approverIdentity !== embedded.approverIdentity
    || approval.approverRole !== embedded.approverRole
    || approval.candidateSourceHeadSha !== admission.declared_source_head
    || approval.candidateImageDigest !== admission.image_digest
    || !isDeepStrictEqual(approval.scope, embedded.scope)) {
    throw new Error('RIG-G1 signed approval does not exactly match the admitted topology.');
  }
}

function assertObservedArmExact(
  admission: S33G1PairedStartAdmission,
  arm: S33G1AdmissionArm,
  observed: S33G1ObservedArm,
): void {
  const expected: S33G1ObservedArm = {
    rigId: arm.rig_id,
    supabaseProjectName: arm.supabase_project_name,
    supabaseProjectRef: arm.supabase_project_ref,
    service: arm.service,
    runtimeServiceAccount: arm.runtime_service_account,
    runtimeServiceAccountUniqueId: arm.runtime_service_account_unique_id,
    revision: arm.revision,
    url: arm.url,
    imageDigest: admission.image_digest,
    sourceHeadSha: admission.declared_source_head,
    cleanMirrorAttestationId: arm.clean_mirror.attestation_id,
    runId: arm.run_id,
    queue: arm.queue,
  };
  if (!isDeepStrictEqual(observed, expected)) {
    throw new Error(`${arm.rig_id} live observation differs from the exact admitted physical identity.`);
  }
}

function validatePreclockReadiness(
  request: S33G1ArmPreparationRequest,
  value: unknown,
  authorizationTime: Date,
  observedNow: Date,
  approvalExpiresAt: string,
): S33G1PreclockReadiness {
  const readiness = preclockReadinessSchema.parse(value);
  const expected = {
    rigId: request.arm.rig_id,
    supabaseProjectRef: request.arm.supabase_project_ref,
    service: request.arm.service,
    revision: request.arm.revision,
    url: request.arm.url,
    imageDigest: request.admission.image_digest,
    sourceHeadSha: request.admission.declared_source_head,
    runtimeServiceAccount: request.arm.runtime_service_account,
  };
  if (readiness.rigId !== expected.rigId
    || readiness.supabaseProjectRef !== expected.supabaseProjectRef
    || readiness.service !== expected.service
    || readiness.revision !== expected.revision
    || readiness.url !== expected.url
    || readiness.imageDigest !== expected.imageDigest
    || readiness.sourceHeadSha !== expected.sourceHeadSha
    || readiness.runtimeServiceAccount !== expected.runtimeServiceAccount) {
    throw new Error(`${request.arm.rig_id} pre-clock auth readiness differs from the exact live/admitted physical binding.`);
  }

  const identities = readiness.sessionPool.identities;
  const userIds = identities.map(({ userId }) => userId);
  const labels = identities.map(({ label }) => label);
  if (readiness.sessionPool.refreshRotationCount !== identities.length
    || new Set(userIds).size !== identities.length
    || new Set(labels).size !== identities.length
    || !userIds.includes(readiness.appBoundary.validExactUserId)) {
    throw new Error(`${request.arm.rig_id} pre-clock session pool is not four-or-more distinct refresh-verified exact users.`);
  }

  const authorityStartMs = authorizationTime.getTime();
  const observedNowMs = observedNow.getTime();
  const authorityExpiryMs = Date.parse(approvalExpiresAt);
  const verifiedAtMs = Date.parse(readiness.verifiedAt);
  const sessionTimes = identities.flatMap((identity) => [
    Date.parse(identity.initialSessionEstablishedAt),
    Date.parse(identity.refreshRotationVerifiedAt),
  ]);
  if (!Number.isFinite(verifiedAtMs)
    || verifiedAtMs < authorityStartMs
    || verifiedAtMs > observedNowMs
    || verifiedAtMs >= authorityExpiryMs
    || sessionTimes.some((time) => !Number.isFinite(time)
      || time < authorityStartMs || time > verifiedAtMs || time >= authorityExpiryMs)) {
    throw new Error(`${request.arm.rig_id} refresh/session evidence falls outside the active CTO pre-clock authority window.`);
  }
  for (const identity of identities) {
    if (Date.parse(identity.refreshRotationVerifiedAt) < Date.parse(identity.initialSessionEstablishedAt)) {
      throw new Error(`${request.arm.rig_id} refresh rotation predates its initial session.`);
    }
  }
  return deepFreeze(readiness);
}

async function containPairedStartFailure(
  port: S33G1PairedStartPort,
  arms: readonly [S33G1AdmissionArm, S33G1AdmissionArm],
  observations: readonly S33G1ArmStartObservation[],
  cause: unknown,
): Promise<never> {
  const containment = await Promise.allSettled([
    ...observations.map((observation) => port.stopArm(observation, 'paired-start-failure')),
    ...arms.map((arm) => port.cleanupArmPreparation(arm, 'paired-start-failure')),
  ]);
  const containmentErrors = containment
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (containmentErrors.length > 0) {
    throw new AggregateError(
      [cause, ...containmentErrors],
      'RIG-G1 paired start and mandatory stop/session cleanup both failed.',
    );
  }
  throw cause;
}

export function validateS33G1PairedStartAdmission(value: unknown): S33G1PairedStartAdmission {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch (error) {
    throw new TypeError('RIG-G1 admission must be immutable JSON data.', { cause: error });
  }
  const parsed = admissionSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error(`RIG-G1 paired-start admission rejected: ${z.prettifyError(parsed.error)}`);
  }
  return deepFreeze(parsed.data);
}

/**
 * Start both physical G1 arms and establish the counted clock atomically from
 * the release controller's perspective. Any post-start mismatch stops every
 * arm that did start; a success is impossible until the durable pair receipt
 * can be loaded back byte-for-byte as equivalent JSON.
 */
export async function runS33G1PairedStartDriver(
  rawAdmission: unknown,
  rawSignedApproval: string,
  ctoConfirmation: string,
  port: S33G1PairedStartPort,
): Promise<S33G1PairedStartResult> {
  const admission = validateS33G1PairedStartAdmission(rawAdmission);
  const authorizationTime = port.now();
  if (!(authorizationTime instanceof Date) || !Number.isFinite(authorizationTime.getTime())) {
    throw new Error('RIG-G1 paired start requires a valid current time.');
  }
  const verifier = port.verifySignedApproval
    ?? ((envelope: string, expected: G1ExpectedCandidate, now: Date) =>
      createProductionG1SpendApprovalVerifier().verify(envelope, expected, now));
  const approval = verifier(rawSignedApproval, expectedCandidate(admission), authorizationTime);
  assertVerifiedApprovalMatchesAdmission(approval, admission);
  const requiredConfirmation = exactCtoConfirmation(admission.g1.spend_approval);
  if (ctoConfirmation !== requiredConfirmation) {
    throw new Error(`RIG-G1 paired start requires exact CTO confirmation '${requiredConfirmation}'.`);
  }
  if (authorizationTime.getTime() >= Date.parse(approval.expiresAt)) {
    throw new Error('RIG-G1 CTO start authority has expired.');
  }

  const candidateTreeSha = await port.resolveCandidateTreeSha(admission.declared_source_head);
  if (!gitSha.safeParse(candidateTreeSha).success) {
    throw new Error('RIG-G1 exact candidate tree could not be resolved from the admitted HEAD.');
  }

  const receiptId = `g1-paired-start:${approval.approvalId}:${admission.soak_id}:${admission.lease_id}`;
  if (await port.loadStartReceipt(receiptId) !== null) {
    throw new Error('RIG-G1 paired-start receipt already exists; replay is forbidden.');
  }

  const [control, tuned] = ['RIG-G1-A', 'RIG-G1-B'].map((rigId) => {
    const arm = admission.g1.arms.find((candidate) => candidate.rig_id === rigId);
    if (arm === undefined) throw new Error(`Missing ${rigId} admission.`);
    return arm;
  });
  const observed = await Promise.all([port.observeArm(control), port.observeArm(tuned)]);
  assertObservedArmExact(admission, control, observed[0]);
  assertObservedArmExact(admission, tuned, observed[1]);

  const preparationRequests: readonly [S33G1ArmPreparationRequest, S33G1ArmPreparationRequest] = [
    { admission, arm: control, observed: observed[0], candidateTreeSha },
    { admission, arm: tuned, observed: observed[1], candidateTreeSha },
  ];
  const arms: readonly [S33G1AdmissionArm, S33G1AdmissionArm] = [control, tuned];
  const preparationSettled = await Promise.allSettled(
    preparationRequests.map((request) => port.prepareArm(request)),
  );
  const preparedValues = preparationSettled
    .filter((result): result is PromiseFulfilledResult<S33G1PreclockReadiness> => result.status === 'fulfilled')
    .map((result) => result.value);
  const preparationRejected = preparationSettled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (preparationRejected !== undefined) {
    return containPairedStartFailure(port, arms, [], preparationRejected.reason);
  }

  let preclockReadiness: [S33G1PreclockReadiness, S33G1PreclockReadiness];
  try {
    const observedNow = port.now();
    if (!(observedNow instanceof Date) || !Number.isFinite(observedNow.getTime())
      || observedNow.getTime() >= Date.parse(approval.expiresAt)) {
      throw new Error('RIG-G1 CTO start authority expired during pre-clock session preparation.');
    }
    preclockReadiness = [
      validatePreclockReadiness(
        preparationRequests[0],
        preparedValues[0],
        authorizationTime,
        observedNow,
        approval.expiresAt,
      ),
      validatePreclockReadiness(
        preparationRequests[1],
        preparedValues[1],
        authorizationTime,
        observedNow,
        approval.expiresAt,
      ),
    ];
  } catch (error) {
    return containPairedStartFailure(port, arms, [], error);
  }

  const requests: readonly [S33G1ArmStartRequest, S33G1ArmStartRequest] = [
    { ...preparationRequests[0], preclockReadiness: preclockReadiness[0] },
    { ...preparationRequests[1], preclockReadiness: preclockReadiness[1] },
  ];
  const settled = await Promise.allSettled(requests.map((request) => port.startArm(request)));
  const started = settled
    .filter((result): result is PromiseFulfilledResult<S33G1ArmStartObservation> => result.status === 'fulfilled')
    .map((result) => result.value);
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected !== undefined) {
    return containPairedStartFailure(port, arms, started, rejected.reason);
  }

  try {
    const starts = started as [S33G1ArmStartObservation, S33G1ArmStartObservation];
    for (let index = 0; index < starts.length; index += 1) {
      const expected = requests[index].arm;
      const start = starts[index];
      if (start.rigId !== expected.rig_id || start.runId !== expected.run_id || start.queue !== expected.queue
        || start.sessionIdentity.length === 0 || start.evidencePath.length === 0 || start.logPath.length === 0
        || !Number.isFinite(Date.parse(start.startedAt))) {
        throw new Error(`${expected.rig_id} start observation differs from its signed run/queue identity.`);
      }
    }
    const sortedTimes = starts.map((start) => Date.parse(start.startedAt)).sort((a, b) => a - b);
    const skewMs = sortedTimes[1] - sortedTimes[0];
    const maxSkewMs = G1_PAIRED_START_CONTRACT.maxStartSkewMin * 60_000;
    if (skewMs > maxSkewMs) {
      throw new Error('RIG-G1 paired starts exceeded the signed 30-minute maximum skew.');
    }
    if (sortedTimes[0] < authorizationTime.getTime() || sortedTimes[1] >= Date.parse(approval.expiresAt)) {
      throw new Error('RIG-G1 start timestamps fall outside the active CTO authority window.');
    }

    const receipt = deepFreeze<S33G1PairedStartReceipt>({
      schemaVersion: G1_PAIRED_START_CONTRACT.schemaVersion,
      receiptId,
      approvalId: approval.approvalId,
      approvalCanonicalSha256: approval.canonicalSha256,
      ctoIdentity: G1_PAIRED_START_CONTRACT.ctoIdentity,
      ctoConfirmation,
      soakId: admission.soak_id,
      leaseId: admission.lease_id,
      candidateHeadSha: admission.declared_source_head,
      candidateTreeSha,
      imageDigest: admission.image_digest,
      corpusDigest: admission.g1.corpus_digest,
      earliestStartedAt: new Date(sortedTimes[0]).toISOString(),
      latestStartedAt: new Date(sortedTimes[1]).toISOString(),
      startSkewMs: skewMs,
      maxStartSkewMs: maxSkewMs,
      preclockReadiness,
      arms: starts,
    });
    await port.persistStartReceipt(receipt);
    const reloaded = await port.loadStartReceipt(receiptId);
    if (!isDeepStrictEqual(reloaded, receipt)) {
      throw new Error('RIG-G1 durable paired-start receipt did not reload exactly.');
    }
    return deepFreeze({ status: 'PAIRED_SOAK_STARTED' as const, receipt });
  } catch (error) {
    return containPairedStartFailure(port, arms, started, error);
  }
}
