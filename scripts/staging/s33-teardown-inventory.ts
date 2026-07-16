/**
 * Strict, side-effect-free S3.3 teardown inventory verifier.
 *
 * The verifier consumes already-captured before/after inventories. It has no
 * cloud client, credential, command execution, or deletion capability.
 */

import { z } from 'zod';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import { digestS33Evidence } from './s33-evidence-integrity';

export const S33_TEARDOWN_SCHEMA_VERSION = 1 as const;
export const S33_TEARDOWN_CAPTURE_SCHEMA_VERSION =
  'arkova.s33.l2.teardown-inventory-capture/v1' as const;
export const S33_TEARDOWN_CAPTURED_VERIFICATION_SCHEMA_VERSION =
  'arkova.s33.l2.teardown-captured-verification/v1' as const;

const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const nonEmpty = z.string().min(1);
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
const capturedAt = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const evidenceActorId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/);
const gcpProjectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
const gcpRegion = z.string().regex(/^[a-z]+-[a-z]+\d$/);
const rigIdSchema = z.enum(['RIG-G1', 'RIG-B1', 'RIG-R']);
const resourceProviderSchema = z.enum(['GCP', 'SUPABASE']);
const serviceAccountEmail = z.string().regex(
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/,
);
const vertexEndpointResourceName = z.string().regex(
  /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z]+-[a-z]+\d\/endpoints\/[1-9]\d*$/,
);
const RIG_G1_CLOUD_RUN_SERVICES = [
  'arkova-worker-s33-g1-public-staging',
  'arkova-worker-s33-g1-tuned-staging',
] as const;
const RIG_G1_SECRET_NAMES = [
  'supabase-service-role-key-s33-g1-staging',
  'supabase-url-s33-g1-staging',
] as const;
const RIG_B1_CLOUD_RUN_SERVICE = 'arkova-worker-s33-rig-b1-staging';
const RIG_R_SUPABASE_PROJECT_NAME = 'arkova-soak-s33-r';
const RIG_R_CLOUD_RUN_SERVICE = 'arkova-worker-s33-r-staging';
const RIG_B1_SCHEDULER_SUFFIXES = [
  'batch-anchors',
  'check-confirmations',
  'populate-confirmation-proofs',
  'org-queue-scheduler',
  'batch-anchors-forced-flush',
  'recover-broadcasts',
] as const;

const scopeSchema = z.object({
  gcpProjectId,
  gcpRegion,
  supabaseOrgId: z.string().regex(/^[a-z]{20}$/),
}).strict();

const targetBindingSchema = z.object({
  authority: z.literal('CTO'),
  decisionArtifactSha256: sha256,
  candidateGitHeadSha: gitSha,
  candidateGitTreeSha: gitSha,
  imageDigestSha256: sha256,
  provisionArtifactSha256: sha256,
  provisionConfigSha256: sha256,
  boundAt: capturedAt,
}).strict();

const dynamicResourceTargetSchema = z.object({
  provider: resourceProviderSchema,
  scopeId: nonEmpty,
  resourceId: nonEmpty,
}).strict();

const serviceAccountIdentitySchema = z.object({
  email: serviceAccountEmail,
  role: z.enum(['RUNTIME', 'OIDC']),
}).strict();

const logicalLeaseTargetSchema = z.object({
  provider: z.literal('SUPABASE'),
  scopeId: z.string().regex(/^[a-z]{20}$/),
  resourceId: nonEmpty,
  role: z.literal('RIG_EXCLUSIVE_LEASE'),
}).strict();

const perRigSecretSchema = z.object({
  name: nonEmpty,
  role: z.enum(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE']),
}).strict();

const rigSchema = z.object({
  rigId: rigIdSchema,
  targetBinding: targetBindingSchema.nullable(),
  supabaseProjectRef: z.string().regex(/^[a-z]{20}$/).nullable(),
  supabaseProjectName: nonEmpty.nullable(),
  cloudRunServiceNames: z.array(nonEmpty),
  schedulerJobNames: z.array(nonEmpty),
  queueTargets: z.array(dynamicResourceTargetSchema),
  containedLogicalQueueIds: z.array(nonEmpty),
  leaseTargets: z.array(logicalLeaseTargetSchema),
  serviceAccountIdentities: z.array(serviceAccountIdentitySchema),
  perRigSecrets: z.array(perRigSecretSchema),
}).strict();

const vertexEndpointTargetSchema = z.object({
  resourceName: vertexEndpointResourceName,
  ownerRigId: rigIdSchema,
  provenance: z.object({
    authority: z.literal('CTO'),
    origin: z.literal('S33_ISOLATED_RIG_RESOURCE'),
    decisionArtifactSha256: sha256,
    candidateGitHeadSha: gitSha,
    candidateGitTreeSha: gitSha,
    imageDigestSha256: sha256,
    provisionArtifactSha256: sha256,
    provisionConfigSha256: sha256,
  }).strict(),
}).strict();

const declarationSchema = z.object({
  schemaVersion: z.literal(S33_TEARDOWN_SCHEMA_VERSION),
  kind: z.literal('s33-teardown-declaration'),
  closeoutId: safeId,
  gitHeadSha: gitSha,
  scope: scopeSchema,
  rigs: z.array(rigSchema).length(3),
  protectedVertexEndpointResourceNames: z.array(vertexEndpointResourceName).min(1),
  vertexEndpointTargets: z.array(vertexEndpointTargetSchema),
  protectedSharedSecretNames: z.array(nonEmpty).min(1),
  protectedNonResourceIdentityIds: z.array(nonEmpty).min(1),
}).strict();

const supabaseProjectSchema = z.object({
  ref: z.string().regex(/^[a-z]{20}$/),
  name: nonEmpty,
  ownerRigId: rigIdSchema.nullable(),
}).strict();

const cloudRunServiceSchema = z.object({
  name: nonEmpty,
  projectId: gcpProjectId,
  region: gcpRegion,
  ownerRigId: rigIdSchema.nullable(),
}).strict();

const schedulerJobSchema = z.object({
  name: nonEmpty,
  projectId: gcpProjectId,
  location: gcpRegion,
  targetService: nonEmpty,
  ownerRigId: rigIdSchema.nullable(),
}).strict();

const vertexEndpointSchema = z.object({
  resourceName: vertexEndpointResourceName,
  displayName: nonEmpty,
  location: nonEmpty,
  deployedModelIds: z.array(nonEmpty),
  ownerRigId: rigIdSchema.nullable(),
  configurationDigestSha256: sha256,
  iamPolicyDigestSha256: sha256,
}).strict();

const dynamicResourceSchema = dynamicResourceTargetSchema.extend({
  ownerRigId: rigIdSchema.nullable(),
}).strict();

const containedLogicalQueueSchema = z.object({
  queueId: nonEmpty,
  supabaseProjectRef: z.string().regex(/^[a-z]{20}$/),
  ownerRigId: rigIdSchema,
}).strict();

const logicalLeaseResourceSchema = logicalLeaseTargetSchema.extend({
  ownerRigId: rigIdSchema,
  state: z.enum(['ACTIVE', 'RELEASED']),
  acquiredAt: capturedAt,
  releasedAt: capturedAt.nullable(),
  expiresAt: capturedAt,
}).strict();

const serviceAccountResourceSchema = serviceAccountIdentitySchema.extend({
  projectId: gcpProjectId,
  ownerRigId: rigIdSchema.nullable(),
  configurationDigestSha256: sha256,
  iamPolicyDigestSha256: sha256,
}).strict();

const secretResourceSchema = z.object({
  name: nonEmpty,
  role: z.enum(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE', 'SHARED_PREEXISTING']),
  projectId: gcpProjectId,
  ownerRigId: rigIdSchema.nullable(),
  configurationDigestSha256: sha256,
  iamPolicyDigestSha256: sha256,
}).strict();

const protectedNonResourceDispositionSchema = z.object({
  identityId: nonEmpty,
  identityClass: z.enum(['SUPERVISED_OPERATOR', 'SUPERVISED_INVOKER']),
  disposition: z.literal('PROTECTED_PREEXISTING'),
  configurationDigestSha256: sha256,
  iamPolicyDigestSha256: sha256,
}).strict();

const resourcesSchema = z.object({
  supabaseProjects: z.array(supabaseProjectSchema),
  cloudRunServices: z.array(cloudRunServiceSchema),
  schedulerJobs: z.array(schedulerJobSchema),
  vertexEndpoints: z.array(vertexEndpointSchema),
  queues: z.array(dynamicResourceSchema),
  containedLogicalQueues: z.array(containedLogicalQueueSchema),
  leases: z.array(logicalLeaseResourceSchema),
  serviceAccounts: z.array(serviceAccountResourceSchema),
  secretNames: z.array(secretResourceSchema),
  protectedNonResourceDispositions: z.array(protectedNonResourceDispositionSchema),
}).strict();

const inventorySchema = z.object({
  schemaVersion: z.literal(S33_TEARDOWN_SCHEMA_VERSION),
  kind: z.literal('s33-teardown-inventory'),
  closeoutId: safeId,
  gitHeadSha: gitSha,
  phase: z.enum(['before', 'after']),
  capturedAt,
  scope: scopeSchema,
  resources: resourcesSchema,
}).strict();

const captureMetadataSchema = z.object({
  schemaVersion: z.literal('arkova.s33.l2.teardown-capture-metadata/v1'),
  gitTreeSha: gitSha,
  operator: z.object({
    operatorId: evidenceActorId,
    role: z.enum(['RTE', 'LANE2_TEARDOWN_OPERATOR']),
    organization: z.literal('ARKOVA'),
  }).strict(),
  signer: z.object({
    keyId: evidenceActorId,
    algorithm: z.literal('Ed25519'),
    publicKeyFingerprintSha256: sha256,
    detachedSignatureArtifactSha256: sha256,
    verificationStatus: z.literal('UNVERIFIED_EXTERNAL_ARTIFACT'),
    signedAt: capturedAt,
  }).strict(),
}).strict();

type Declaration = z.infer<typeof declarationSchema>;
type Inventory = z.infer<typeof inventorySchema>;
type ResourceCollection = Inventory['resources'];
type CaptureMetadata = z.infer<typeof captureMetadataSchema>;

export interface S33TeardownResourceIdentity {
  readonly provider: 'GCP' | 'SUPABASE';
  readonly kind:
    | 'isolated-project'
    | 'cloud-run-service'
    | 'cloud-scheduler-job'
    | 'vertex-endpoint'
    | 'queue'
    | 'contained-logical-queue'
    | 'logical-lease'
    | 'service-account'
    | 'secret';
  readonly scopeId: string;
  readonly resourceId: string;
  readonly ownerRigId: 'RIG-G1' | 'RIG-B1' | 'RIG-R' | null;
}

export interface S33TeardownTargetResource extends S33TeardownResourceIdentity {
  readonly rigId: 'RIG-G1' | 'RIG-B1' | 'RIG-R' | null;
  readonly billingClass: 'RECURRING_PAID' | 'NO_RECURRING_CHARGE';
  readonly targetProvenance: Readonly<{
    authority: 'CTO';
    origin: 'S33_ISOLATED_RIG_RESOURCE';
    decisionArtifactSha256: string;
    candidateGitHeadSha: string;
    candidateGitTreeSha: string;
    imageDigestSha256: string;
    provisionArtifactSha256: string;
    provisionConfigSha256: string;
  }>;
}

export interface S33TeardownProtectedResource extends S33TeardownResourceIdentity {
  readonly configurationDigestSha256: string;
  readonly capturedConfigurationDigestSha256: string | null;
  readonly capturedIamPolicyDigestSha256: string | null;
  readonly protectionClass:
    | 'DECLARED_PRE_EXISTING_VERTEX_INPUT'
    | 'DECLARED_SHARED_SECRET'
    | 'NON_TARGET_INVENTORY';
}

export interface S33TeardownResourceBoundary {
  readonly schemaVersion: 'arkova.s33.l2.teardown-resource-boundary/v1';
  readonly closeoutId: string;
  readonly gitHeadSha: string;
  readonly gitTreeSha: string;
  readonly scope: Readonly<Declaration['scope']>;
  readonly rigIds: readonly ['RIG-B1', 'RIG-G1', 'RIG-R'];
  readonly boundaryStatus: 'COMPLETE' | 'PARTIAL_RIG_R_CTO_BINDING_REQUIRED';
  readonly releaseBoundaryComplete: boolean;
  readonly unboundRigIds: readonly ('RIG-G1' | 'RIG-B1' | 'RIG-R')[];
  readonly targetResources: readonly S33TeardownTargetResource[];
  readonly protectedResources: readonly S33TeardownProtectedResource[];
  readonly protectedNonResourceDispositions: readonly Readonly<
    z.infer<typeof protectedNonResourceDispositionSchema>
  >[];
}

export interface S33TeardownInventoryCapture {
  readonly schemaVersion: typeof S33_TEARDOWN_CAPTURE_SCHEMA_VERSION;
  readonly kind: 's33-teardown-inventory-capture';
  readonly closeoutId: string;
  readonly gitHeadSha: string;
  readonly gitTreeSha: string;
  readonly phase: 'before' | 'after';
  readonly capturedAt: string;
  readonly inventory: Readonly<Inventory>;
  readonly resourceBoundary: S33TeardownResourceBoundary;
  readonly operator: Readonly<CaptureMetadata['operator']>;
  readonly signer: Readonly<CaptureMetadata['signer']>;
  readonly inventoryArtifactSha256: string;
  readonly resourceBoundarySha256: string;
  readonly captureArtifactSha256: string;
}

export interface S33TeardownTargetOutcome extends S33TeardownTargetResource {
  readonly state: 'REMOVED' | 'RELEASED_EXPIRED' | 'REMAINS' | 'MISSING_FROM_BEFORE';
  readonly projectedMonthlyRecurringUsd: 0 | null;
  readonly evidenceArtifactSha256: string;
}

export interface S33TeardownCapturedVerification {
  readonly schemaVersion: typeof S33_TEARDOWN_CAPTURED_VERIFICATION_SCHEMA_VERSION;
  readonly kind: 's33-teardown-captured-verification';
  readonly mode: 'CAPTURED_IMMUTABLE_VERIFY_ONLY';
  readonly closeoutId: string;
  readonly gitHeadSha: string;
  readonly gitTreeSha: string;
  readonly verified: boolean;
  readonly protectedResourcesUntouched: boolean;
  readonly releaseBoundaryComplete: boolean;
  readonly boundaryStatus: S33TeardownResourceBoundary['boundaryStatus'];
  readonly unboundRigIds: S33TeardownResourceBoundary['unboundRigIds'];
  readonly releaseAcceptance: false;
  readonly recurringCostVerdict: 'recurring_cost_zero' | 'blocked';
  readonly recurring_cost_zero: boolean;
  readonly projectedMonthlyRecurringUsd: 0 | null;
  readonly signatureVerification: 'UNVERIFIED_EXTERNAL_ARTIFACT';
  readonly mutationsAttempted: 0;
  readonly operator: Readonly<CaptureMetadata['operator']>;
  readonly signer: Readonly<{
    keyId: string;
    algorithm: 'Ed25519';
    publicKeyFingerprintSha256: string;
    verificationStatus: 'UNVERIFIED_EXTERNAL_ARTIFACT';
    beforeDetachedSignatureArtifactSha256: string;
    afterDetachedSignatureArtifactSha256: string;
  }>;
  readonly beforeCapturedAt: string;
  readonly afterCapturedAt: string;
  readonly beforeInventoryArtifactSha256: string;
  readonly afterInventoryArtifactSha256: string;
  readonly beforeCaptureArtifactSha256: string;
  readonly afterCaptureArtifactSha256: string;
  readonly resourceBoundarySha256: string;
  readonly afterResourceBoundarySha256: string;
  readonly targetOutcomes: readonly S33TeardownTargetOutcome[];
  readonly namedDiffs: S33TeardownDryRunVerification['namedDiffs'];
  readonly failures: readonly string[];
  readonly verificationDigestSha256: string;
}

export interface S33NamedInventoryDiff {
  readonly removed: readonly string[];
  readonly added: readonly string[];
  readonly unchanged: readonly string[];
}

export interface S33TeardownDryRunVerification {
  readonly schemaVersion: 1;
  readonly kind: 's33-teardown-dry-run-verification';
  readonly mode: 'DRY_RUN_VERIFY_ONLY';
  readonly closeoutId: string;
  readonly gitHeadSha: string;
  readonly verified: boolean;
  readonly zeroRecurringRigCost: boolean;
  readonly sharedSecretsUntouched: boolean;
  readonly mutationsAttempted: 0;
  readonly namedDiffs: {
    readonly supabaseProjects: S33NamedInventoryDiff;
    readonly cloudRunServices: S33NamedInventoryDiff;
    readonly schedulerJobs: S33NamedInventoryDiff;
    readonly vertexEndpoints: S33NamedInventoryDiff;
    readonly queues: S33NamedInventoryDiff;
    readonly containedLogicalQueues: S33NamedInventoryDiff;
    readonly leases: S33NamedInventoryDiff;
    readonly serviceAccounts: S33NamedInventoryDiff;
    readonly secretNames: S33NamedInventoryDiff;
    readonly protectedNonResourceDispositions: S33NamedInventoryDiff;
  };
  readonly failures: readonly string[];
}

interface NamedResource {
  readonly identity: string;
  readonly display: string;
  readonly ownerRigId: 'RIG-G1' | 'RIG-B1' | 'RIG-R' | null;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function snapshot(raw: unknown, label: string): unknown {
  if (typeof raw === 'string') return parseJsonRejectingDuplicateKeys(raw, label);
  if (!raw || typeof raw !== 'object') throw new Error(`${label} must be a JSON object or string.`);
  try {
    return structuredClone(raw);
  } catch (error) {
    throw new TypeError(`${label} cannot be captured as immutable data.`, { cause: error });
  }
}

function parseStrict<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const parsed = schema.safeParse(snapshot(raw, label));
  if (!parsed.success) {
    throw new Error(`${label} schema rejected: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertUnique(label: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate identities.`);
}

function dynamicTargetIdentity(
  target: z.infer<typeof dynamicResourceTargetSchema>,
): string {
  return `${target.provider}\u0000${target.scopeId}\u0000${target.resourceId}`;
}

function bindingProvenance(binding: NonNullable<Declaration['rigs'][number]['targetBinding']>) {
  return {
    authority: binding.authority,
    origin: 'S33_ISOLATED_RIG_RESOURCE' as const,
    decisionArtifactSha256: binding.decisionArtifactSha256,
    candidateGitHeadSha: binding.candidateGitHeadSha,
    candidateGitTreeSha: binding.candidateGitTreeSha,
    imageDigestSha256: binding.imageDigestSha256,
    provisionArtifactSha256: binding.provisionArtifactSha256,
    provisionConfigSha256: binding.provisionConfigSha256,
  };
}

function validateDeclaration(declaration: Declaration): void {
  const rigIds = sorted(declaration.rigs.map(({ rigId }) => rigId));
  if (stable(rigIds) !== stable(['RIG-B1', 'RIG-G1', 'RIG-R'])) {
    throw new Error('Teardown declaration requires exactly RIG-G1, RIG-B1, and RIG-R.');
  }

  const rigG1 = declaration.rigs.find(({ rigId }) => rigId === 'RIG-G1')!;
  const rigB1 = declaration.rigs.find(({ rigId }) => rigId === 'RIG-B1');
  const rigR = declaration.rigs.find(({ rigId }) => rigId === 'RIG-R')!;

  for (const rig of declaration.rigs) {
    const hasBoundIdentity = rig.supabaseProjectRef !== null
      && rig.supabaseProjectName !== null
      && rig.cloudRunServiceNames.length > 0
      && rig.perRigSecrets.length > 0;
    if (rig.targetBinding === null) {
      if (
        rig.supabaseProjectRef !== null
        || rig.supabaseProjectName !== null
        || rig.cloudRunServiceNames.length > 0
        || rig.schedulerJobNames.length > 0
        || rig.queueTargets.length > 0
        || rig.containedLogicalQueueIds.length > 0
        || rig.leaseTargets.length > 0
        || rig.serviceAccountIdentities.length > 0
        || rig.perRigSecrets.length > 0
      ) {
        throw new Error(`${rig.rigId} has target identities without an explicit CTO target binding.`);
      }
    } else if (!hasBoundIdentity) {
      throw new Error(`${rig.rigId} CTO target binding requires explicit Supabase, service, and secret identities.`);
    }
  }

  if (rigG1.targetBinding === null) {
    throw new Error('RIG-G1 teardown boundary requires an explicit CTO target binding.');
  }
  if (
    stable(sorted(rigG1.cloudRunServiceNames)) !== stable([...RIG_G1_CLOUD_RUN_SERVICES])
    || rigG1.schedulerJobNames.length !== 0
    || stable(sorted(rigG1.perRigSecrets.map(({ name }) => name)))
      !== stable([...RIG_G1_SECRET_NAMES])
  ) {
    throw new Error(
      'RIG-G1 teardown requires exactly the public/tuned Cloud Run arms, zero Scheduler jobs, and the isolated Supabase secret pair.',
    );
  }

  if (!rigB1 || rigB1.targetBinding === null) {
    throw new Error('RIG-B1 teardown requires an explicit CTO target binding.');
  }
  if (
    rigB1.cloudRunServiceNames.length !== 1
    || rigB1.cloudRunServiceNames[0] !== RIG_B1_CLOUD_RUN_SERVICE
  ) {
    throw new Error('RIG-B1 teardown requires exactly its one canonical Cloud Run service identity.');
  }
  const [rigB1Service] = rigB1.cloudRunServiceNames;
  const expectedRigB1SchedulerJobs = sorted(RIG_B1_SCHEDULER_SUFFIXES.map(
    (suffix) => `${rigB1Service}-${suffix}`,
  ));
  if (stable(sorted(rigB1.schedulerJobNames)) !== stable(expectedRigB1SchedulerJobs)) {
    throw new Error('RIG-B1 teardown requires the exact frozen six-job Scheduler target set.');
  }

  if (rigR.targetBinding !== null) {
    if (
      rigR.supabaseProjectName !== RIG_R_SUPABASE_PROJECT_NAME
      || stable(rigR.cloudRunServiceNames) !== stable([RIG_R_CLOUD_RUN_SERVICE])
      || rigR.schedulerJobNames.length !== 0
    ) {
      throw new Error(
        'RIG-R teardown requires its CTO-bound isolated project, canonical Cloud Run service, and zero Scheduler jobs.',
      );
    }
    if (
      rigR.queueTargets.length !== 0
      || rigR.containedLogicalQueueIds.length === 0
      || rigR.leaseTargets.length !== 1
      || rigR.leaseTargets[0].scopeId !== rigR.supabaseProjectRef
      || rigR.serviceAccountIdentities.length !== 1
      || rigR.serviceAccountIdentities[0].role !== 'RUNTIME'
      || rigR.perRigSecrets.length !== 2
      || stable(sorted(rigR.perRigSecrets.map(({ role }) => role)))
        !== stable(['SUPABASE_SERVICE_ROLE', 'SUPABASE_URL'])
    ) {
      throw new Error(
        'RIG-R teardown requires zero managed queues, exhaustive contained queues, one exclusive lease, one runtime identity, zero OIDC identities, and the generated Supabase secret pair.',
      );
    }
  }

  const boundRigs = declaration.rigs.filter(({ targetBinding }) => targetBinding !== null);
  if (boundRigs.some(({ targetBinding }) => (
    targetBinding!.candidateGitHeadSha !== declaration.gitHeadSha
  ))) {
    throw new Error('Every bound rig must target the declaration exact candidate head SHA.');
  }
  if (new Set(boundRigs.map(({ targetBinding }) => targetBinding!.candidateGitTreeSha)).size !== 1) {
    throw new Error('Every bound rig must target one exact candidate tree SHA.');
  }
  if (new Set(boundRigs.map(({ targetBinding }) => targetBinding!.imageDigestSha256)).size !== 1) {
    throw new Error('Every bound rig must target one exact candidate image digest.');
  }
  assertUnique(
    'Teardown Supabase project refs',
    boundRigs.map((rig) => rig.supabaseProjectRef as string),
  );
  assertUnique(
    'Teardown Supabase project names',
    boundRigs.map((rig) => rig.supabaseProjectName as string),
  );
  assertUnique(
    'Teardown Cloud Run services',
    declaration.rigs.flatMap((rig) => rig.cloudRunServiceNames),
  );
  assertUnique(
    'Teardown Scheduler jobs',
    declaration.rigs.flatMap((rig) => rig.schedulerJobNames),
  );
  assertUnique(
    'Teardown queue targets',
    declaration.rigs.flatMap((rig) => rig.queueTargets.map(dynamicTargetIdentity)),
  );
  assertUnique(
    'Teardown contained logical queues',
    declaration.rigs.flatMap((rig) => rig.containedLogicalQueueIds.map(
      (queueId) => `${rig.supabaseProjectRef}\u0000${queueId}`,
    )),
  );
  assertUnique(
    'Teardown lease targets',
    declaration.rigs.flatMap((rig) => rig.leaseTargets.map(dynamicTargetIdentity)),
  );
  assertUnique(
    'Teardown service-account identities',
    declaration.rigs.flatMap((rig) => rig.serviceAccountIdentities.map(({ email }) => email)),
  );
  for (const rig of boundRigs) {
    if (
      rig.perRigSecrets.length !== 2
      || stable(sorted(rig.perRigSecrets.map(({ role }) => role)))
        !== stable(['SUPABASE_SERVICE_ROLE', 'SUPABASE_URL'])
    ) {
      throw new Error(`${rig.rigId} requires exactly the generated Supabase secret role pair.`);
    }
    if (rig.serviceAccountIdentities.some(
      ({ email }) => !email.endsWith(`@${declaration.scope.gcpProjectId}.iam.gserviceaccount.com`),
    )) {
      throw new Error(`${rig.rigId} service-account identity is outside the declared GCP project.`);
    }
  }
  const perRigSecrets = declaration.rigs.flatMap((rig) => rig.perRigSecrets.map(({ name }) => name));
  assertUnique('Teardown per-rig secrets', perRigSecrets);
  assertUnique('Protected shared secrets', declaration.protectedSharedSecretNames);
  assertUnique(
    'Protected non-resource identities',
    declaration.protectedNonResourceIdentityIds,
  );
  assertUnique(
    'Protected Vertex endpoints',
    declaration.protectedVertexEndpointResourceNames,
  );
  assertUnique(
    'Teardown Vertex endpoint targets',
    declaration.vertexEndpointTargets.map(({ resourceName }) => resourceName),
  );
  if (rigR.targetBinding === null) {
    if (declaration.vertexEndpointTargets.some(({ ownerRigId }) => ownerRigId === 'RIG-R')) {
      throw new Error('Unbound RIG-R cannot declare a temporary Vertex endpoint target.');
    }
  } else if (
    declaration.vertexEndpointTargets.length !== 1
    || declaration.vertexEndpointTargets[0].ownerRigId !== 'RIG-R'
  ) {
    throw new Error('Bound RIG-R requires exactly one RIG-R-owned temporary Vertex endpoint target.');
  }
  const protectedVertexEndpoints = new Set(
    declaration.protectedVertexEndpointResourceNames,
  );
  if (declaration.vertexEndpointTargets.some(
    ({ resourceName }) => protectedVertexEndpoints.has(resourceName),
  )) {
    throw new Error('A pre-existing protected Vertex endpoint cannot enter the teardown target set.');
  }
  for (const target of declaration.vertexEndpointTargets) {
    const owner = declaration.rigs.find(({ rigId }) => rigId === target.ownerRigId)!;
    if (owner.targetBinding === null) {
      throw new Error(`${target.ownerRigId} Vertex target requires an explicit CTO target binding.`);
    }
    if (stable(target.provenance) !== stable(bindingProvenance(owner.targetBinding))) {
      throw new Error(
        `${target.ownerRigId} Vertex target provenance contradicts its CTO target binding.`,
      );
    }
  }
  const protectedSecrets = new Set(declaration.protectedSharedSecretNames);
  if (perRigSecrets.some((name) => protectedSecrets.has(name))) {
    throw new Error('A per-rig teardown secret cannot also be a protected shared secret.');
  }
}

function declarationBoundaryState(declaration: Declaration) {
  const unboundRigIds = declaration.rigs
    .filter(({ targetBinding }) => targetBinding === null)
    .map(({ rigId }) => rigId)
    .sort((left, right) => left.localeCompare(right));
  const releaseBoundaryComplete = unboundRigIds.length === 0;
  return {
    boundaryStatus: releaseBoundaryComplete
      ? 'COMPLETE' as const
      : 'PARTIAL_RIG_R_CTO_BINDING_REQUIRED' as const,
    releaseBoundaryComplete,
    unboundRigIds,
  };
}

function namedResources(resources: ResourceCollection): Record<keyof ResourceCollection, NamedResource[]> {
  return {
    supabaseProjects: resources.supabaseProjects.map(({ ref, name, ownerRigId }) => ({
      identity: `${ownerRigId ?? 'NON_TARGET'}\u0000${ref}\u0000${name}`,
      display: `${name} (${ref})`,
      ownerRigId,
    })),
    cloudRunServices: resources.cloudRunServices.map(({ name, projectId, region, ownerRigId }) => ({
      identity: `${ownerRigId ?? 'NON_TARGET'}\u0000${projectId}\u0000${region}\u0000${name}`,
      display: `${name} (${projectId}/${region})`,
      ownerRigId,
    })),
    schedulerJobs: resources.schedulerJobs.map(({
      name, projectId, location, targetService, ownerRigId,
    }) => ({
      identity: `${ownerRigId ?? 'NON_TARGET'}\u0000${projectId}\u0000${location}\u0000${name}`
        + `\u0000${targetService}`,
      display: `${name} (${projectId}/${location} -> ${targetService})`,
      ownerRigId,
    })),
    vertexEndpoints: resources.vertexEndpoints.map((endpoint) => ({
      identity: stable(endpoint),
      display: `${endpoint.displayName} (${endpoint.resourceName})`,
      ownerRigId: endpoint.ownerRigId,
    })),
    queues: resources.queues.map((queue) => ({
      identity: stable(queue),
      display: `${queue.resourceId} (${queue.provider}/${queue.scopeId})`,
      ownerRigId: queue.ownerRigId,
    })),
    containedLogicalQueues: resources.containedLogicalQueues.map((queue) => ({
      identity: stable(queue),
      display: `${queue.queueId} (contained by ${queue.supabaseProjectRef})`,
      ownerRigId: queue.ownerRigId,
    })),
    leases: resources.leases.map((lease) => ({
      identity: stable({
        provider: lease.provider,
        scopeId: lease.scopeId,
        resourceId: lease.resourceId,
        role: lease.role,
        ownerRigId: lease.ownerRigId,
      }),
      display: `${lease.resourceId} (${lease.role})`,
      ownerRigId: lease.ownerRigId,
    })),
    serviceAccounts: resources.serviceAccounts.map((account) => ({
      identity: stable({
        email: account.email,
        role: account.role,
        projectId: account.projectId,
        ownerRigId: account.ownerRigId,
      }),
      display: `${account.email} (${account.role})`,
      ownerRigId: account.ownerRigId,
    })),
    secretNames: resources.secretNames.map((secret) => ({
      identity: secret.ownerRigId === null
        ? stable(secret)
        : stable({
            name: secret.name,
            role: secret.role,
            projectId: secret.projectId,
            ownerRigId: secret.ownerRigId,
          }),
      display: secret.name,
      ownerRigId: secret.ownerRigId,
    })),
    protectedNonResourceDispositions: resources.protectedNonResourceDispositions.map(
      (disposition) => ({
        identity: stable(disposition),
        display: `${disposition.identityId} (${disposition.identityClass})`,
        ownerRigId: null,
      }),
    ),
  };
}

function validateInventoryUniqueness(inventory: Inventory, label: string): void {
  const resources = namedResources(inventory.resources);
  for (const [kind, entries] of Object.entries(resources)) {
    assertUnique(`${label} ${kind}`, entries.map(({ identity }) => identity));
  }
  assertUnique(
    `${label} Supabase refs`,
    inventory.resources.supabaseProjects.map(({ ref }) => ref),
  );
  assertUnique(
    `${label} Cloud Run names`,
    inventory.resources.cloudRunServices.map(({ name }) => name),
  );
  assertUnique(
    `${label} Scheduler names`,
    inventory.resources.schedulerJobs.map(({ name }) => name),
  );
  assertUnique(
    `${label} Vertex resource names`,
    inventory.resources.vertexEndpoints.map(({ resourceName }) => resourceName),
  );
  assertUnique(
    `${label} queue locators`,
    inventory.resources.queues.map(dynamicTargetIdentity),
  );
  assertUnique(
    `${label} contained logical queues`,
    inventory.resources.containedLogicalQueues.map(
      ({ queueId, supabaseProjectRef }) => `${supabaseProjectRef}\u0000${queueId}`,
    ),
  );
  assertUnique(
    `${label} lease locators`,
    inventory.resources.leases.map(dynamicTargetIdentity),
  );
  assertUnique(
    `${label} service-account emails`,
    inventory.resources.serviceAccounts.map(({ email }) => email),
  );
  assertUnique(
    `${label} secret names`,
    inventory.resources.secretNames.map(({ name }) => name),
  );
  assertUnique(
    `${label} protected non-resource identities`,
    inventory.resources.protectedNonResourceDispositions.map(({ identityId }) => identityId),
  );
}

function validateInventoryScope(inventory: Inventory, label: string): void {
  const { gcpProjectId: projectId, gcpRegion: region } = inventory.scope;
  if (inventory.resources.cloudRunServices.some(
    (service) => service.projectId !== projectId || service.region !== region,
  )) throw new Error(`${label} Cloud Run capture contains a project/region outside its declared scope.`);
  if (inventory.resources.schedulerJobs.some(
    (job) => job.projectId !== projectId || job.location !== region,
  )) throw new Error(`${label} Scheduler capture contains a project/location outside its declared scope.`);
  const vertexPrefix = `projects/${projectId}/locations/${region}/endpoints/`;
  if (inventory.resources.vertexEndpoints.some(
    (endpoint) => endpoint.location !== region || !endpoint.resourceName.startsWith(vertexPrefix),
  )) throw new Error(`${label} Vertex capture contains a project/location outside its declared scope.`);
  if (inventory.resources.serviceAccounts.some(({ projectId: accountProjectId }) => (
    accountProjectId !== projectId
  ))) {
    throw new Error(`${label} service-account capture contains a project outside its declared scope.`);
  }
  if (inventory.resources.secretNames.some(({ projectId: secretProjectId }) => (
    secretProjectId !== projectId
  ))) throw new Error(`${label} secret capture contains a project outside its declared scope.`);
  const capturedSupabaseRefs = new Set(
    inventory.resources.supabaseProjects.map(({ ref }) => ref),
  );
  if (inventory.resources.containedLogicalQueues.some(
    ({ supabaseProjectRef }) => !capturedSupabaseRefs.has(supabaseProjectRef),
  )) throw new Error(`${label} contained logical queue lacks its owning Supabase project.`);
}

const RIG_LABELED_ID = /(?:^|[-_.])(s33|rig[-_.]?[gbr][0-9]?|soak)(?:[-_.]|$)/i;

function validateExhaustiveOwnerDiscovery(
  declaration: Declaration,
  inventory: Inventory,
  label: string,
): void {
  const protectedEndpoints = new Set(declaration.protectedVertexEndpointResourceNames);
  const protectedSecrets = new Set(declaration.protectedSharedSecretNames);
  const protectedNonResources = new Set(declaration.protectedNonResourceIdentityIds);
  const rigBySupabaseProjectRef = new Map(declaration.rigs.flatMap((rig) => (
    rig.supabaseProjectRef === null ? [] : [[rig.supabaseProjectRef, rig.rigId] as const]
  )));
  if (inventory.resources.queues.some((queue) => (
    rigBySupabaseProjectRef.has(queue.scopeId)
    && queue.ownerRigId !== rigBySupabaseProjectRef.get(queue.scopeId)
  ))) {
    throw new Error(`${label} hides a managed queue inside an isolated rig project.`);
  }
  const unownedRigLabeled = [
    ...inventory.resources.supabaseProjects.map(({ name, ownerRigId }) => ({
      identity: name,
      ownerRigId,
      protected: false,
    })),
    ...inventory.resources.cloudRunServices.map(({ name, ownerRigId }) => ({
      identity: name,
      ownerRigId,
      protected: false,
    })),
    ...inventory.resources.schedulerJobs.map(({ name, ownerRigId }) => ({
      identity: name,
      ownerRigId,
      protected: false,
    })),
    ...inventory.resources.vertexEndpoints.map(({ resourceName, displayName, ownerRigId }) => ({
      identity: displayName,
      ownerRigId,
      protected: protectedEndpoints.has(resourceName),
    })),
    ...inventory.resources.queues.map(({ resourceId, ownerRigId }) => ({
      identity: resourceId,
      ownerRigId,
      protected: false,
    })),
    ...inventory.resources.serviceAccounts.map(({ email, ownerRigId }) => ({
      identity: email,
      ownerRigId,
      protected: false,
    })),
    ...inventory.resources.secretNames.map(({ name, ownerRigId }) => ({
      identity: name,
      ownerRigId,
      protected: protectedSecrets.has(name),
    })),
    ...inventory.resources.protectedNonResourceDispositions.map(({ identityId }) => ({
      identity: identityId,
      ownerRigId: null,
      protected: protectedNonResources.has(identityId),
    })),
  ].filter(({ identity, ownerRigId, protected: isProtected }) => (
    ownerRigId === null && !isProtected && RIG_LABELED_ID.test(identity)
  ));
  if (unownedRigLabeled.length > 0) {
    throw new Error(
      `${label} contains a rig-labeled resource without exhaustive owner/target discovery.`,
    );
  }
}

function validateProtectedCapturePresence(
  declaration: Declaration,
  inventory: Inventory,
  label: string,
): void {
  const capturedEndpoints = new Set(
    inventory.resources.vertexEndpoints
      .filter(({ ownerRigId }) => ownerRigId === null)
      .map(({ resourceName }) => resourceName),
  );
  if (declaration.protectedVertexEndpointResourceNames.some(
    (resourceName) => !capturedEndpoints.has(resourceName),
  )) {
    throw new Error(`${label} omits a declared protected pre-existing Vertex endpoint.`);
  }
  const capturedSecrets = new Set(inventory.resources.secretNames
    .filter(({ ownerRigId, role }) => ownerRigId === null && role === 'SHARED_PREEXISTING')
    .map(({ name }) => name));
  if (declaration.protectedSharedSecretNames.some(
    (name) => !capturedSecrets.has(name),
  )) {
    throw new Error(`${label} omits a declared protected shared secret.`);
  }
  const capturedProtectedIdentities = new Set(
    inventory.resources.protectedNonResourceDispositions.map(({ identityId }) => identityId),
  );
  if (declaration.protectedNonResourceIdentityIds.some(
    (identityId) => !capturedProtectedIdentities.has(identityId),
  )) {
    throw new Error(`${label} omits a declared protected operator/invoker identity.`);
  }
}

function diff(before: readonly NamedResource[], after: readonly NamedResource[]): S33NamedInventoryDiff {
  const beforeByIdentity = new Map(before.map((entry) => [entry.identity, entry.display]));
  const afterByIdentity = new Map(after.map((entry) => [entry.identity, entry.display]));
  return {
    removed: sorted([...beforeByIdentity]
      .filter(([identity]) => !afterByIdentity.has(identity))
      .map(([, display]) => display)),
    added: sorted([...afterByIdentity]
      .filter(([identity]) => !beforeByIdentity.has(identity))
      .map(([, display]) => display)),
    unchanged: sorted([...beforeByIdentity]
      .filter(([identity]) => afterByIdentity.has(identity))
      .map(([, display]) => display)),
  };
}

function exactSetEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function targetIdentities(declaration: Declaration, before: Inventory): Record<keyof ResourceCollection, Set<string>> {
  const boundRigs = declaration.rigs.filter(({ targetBinding }) => targetBinding !== null);
  const vertexNames = new Set(
    declaration.vertexEndpointTargets.map(({ resourceName }) => resourceName),
  );
  return {
    supabaseProjects: new Set(boundRigs.map(
      ({ rigId, supabaseProjectRef, supabaseProjectName }) => (
        `${rigId}\u0000${supabaseProjectRef!}\u0000${supabaseProjectName!}`
      ),
    )),
    cloudRunServices: new Set(boundRigs.flatMap((rig) => rig.cloudRunServiceNames.map(
      (name) => `${rig.rigId}\u0000${declaration.scope.gcpProjectId}`
        + `\u0000${declaration.scope.gcpRegion}\u0000${name}`,
    ))),
    schedulerJobs: new Set(boundRigs.flatMap((rig) => rig.schedulerJobNames.map(
      (name) => `${rig.rigId}\u0000${declaration.scope.gcpProjectId}`
        + `\u0000${declaration.scope.gcpRegion}\u0000${name}`
        + `\u0000${rig.cloudRunServiceNames[0]}`,
    ))),
    vertexEndpoints: new Set(before.resources.vertexEndpoints
      .filter(({ resourceName }) => vertexNames.has(resourceName))
      .map((endpoint) => stable(endpoint))),
    queues: new Set(boundRigs.flatMap((rig) => rig.queueTargets.map((target) => stable({
      ...target,
      ownerRigId: rig.rigId,
    })))),
    containedLogicalQueues: new Set(boundRigs.flatMap((rig) => (
      rig.containedLogicalQueueIds.map((queueId) => stable({
        queueId,
        supabaseProjectRef: rig.supabaseProjectRef!,
        ownerRigId: rig.rigId,
      }))
    ))),
    leases: new Set(boundRigs.flatMap((rig) => rig.leaseTargets.map((target) => stable({
      ...target,
      ownerRigId: rig.rigId,
    })))),
    serviceAccounts: new Set(boundRigs.flatMap((rig) => (
      rig.serviceAccountIdentities.map((identity) => stable({
        ...identity,
        projectId: declaration.scope.gcpProjectId,
        ownerRigId: rig.rigId,
      }))
    ))),
    secretNames: new Set(boundRigs.flatMap((rig) => rig.perRigSecrets.map((secret) => stable({
      ...secret,
      projectId: declaration.scope.gcpProjectId,
      ownerRigId: rig.rigId,
    })))),
    protectedNonResourceDispositions: new Set(),
  };
}

function targetPresenceFailures(
  declaration: Declaration,
  before: Inventory,
  after: Inventory,
  targets: Record<keyof ResourceCollection, Set<string>>,
): { failures: string[]; allRecurringTargetsRemoved: boolean } {
  const failures: string[] = [];
  const beforeNamed = namedResources(before.resources);
  const afterNamed = namedResources(after.resources);
  const kinds = Object.keys(beforeNamed) as (keyof ResourceCollection)[];
  let allRecurringTargetsRemoved = true;

  for (const kind of kinds) {
    const expected = targets[kind];
    const beforeIds = new Set(beforeNamed[kind].map(({ identity }) => identity));
    const afterIds = new Set(afterNamed[kind].map(({ identity }) => identity));
    const missingBefore = [...expected].filter((identity) => !beforeIds.has(identity));
    const stragglers = [...expected].filter((identity) => afterIds.has(identity));
    if (missingBefore.length > 0) failures.push(`${kind} target inventory is incomplete before teardown.`);
    if (kind === 'leases') {
      const missingDisposition = [...expected].filter((identity) => !afterIds.has(identity));
      if (missingDisposition.length > 0) {
        failures.push('Logical lease release/expiry disposition is missing after teardown.');
      }
    } else if (stragglers.length > 0) {
      failures.push(`${kind} target straggler remains after teardown.`);
    }
    if (
      kind !== 'secretNames'
      && (missingBefore.length > 0 || (kind !== 'leases' && stragglers.length > 0))
    ) {
      allRecurringTargetsRemoved = false;
    }
    const undeclaredOwned = [...beforeNamed[kind], ...afterNamed[kind]]
      .filter(({ ownerRigId }) => ownerRigId !== null)
      .filter(({ identity }) => !expected.has(identity));
    if (undeclaredOwned.length > 0) {
      failures.push(`Undeclared owner-bound ${kind} resource is outside the teardown target set.`);
      allRecurringTargetsRemoved = false;
    }

    const beforeNonTargets = new Set([...beforeIds].filter((identity) => !expected.has(identity)));
    const afterNonTargets = new Set([...afterIds].filter((identity) => !expected.has(identity)));
    if (!exactSetEqual(beforeNonTargets, afterNonTargets)) {
      failures.push(`Non-target ${kind} inventory drifted during teardown.`);
    }
  }

  const declaredVertexNames = new Set(
    declaration.vertexEndpointTargets.map(({ resourceName }) => resourceName),
  );
  const capturedVertexNames = new Set(before.resources.vertexEndpoints.map(({ resourceName }) => resourceName));
  if ([...declaredVertexNames].some((name) => !capturedVertexNames.has(name))) {
    failures.push('vertexEndpoints target inventory is incomplete before teardown.');
    allRecurringTargetsRemoved = false;
  }
  const afterVertexNames = new Set(after.resources.vertexEndpoints.map(({ resourceName }) => resourceName));
  if (declaration.protectedVertexEndpointResourceNames.some(
    (name) => !capturedVertexNames.has(name) || !afterVertexNames.has(name),
  )) {
    failures.push('A protected pre-existing Vertex endpoint is missing before or after teardown.');
    allRecurringTargetsRemoved = false;
  }
  const declaredRigServices = new Set(declaration.rigs
    .filter(({ targetBinding }) => targetBinding !== null)
    .flatMap(({ cloudRunServiceNames }) => cloudRunServiceNames));
  const allowedSchedulerTargets = targets.schedulerJobs;
  const undeclaredRigTargetJobs = [...before.resources.schedulerJobs, ...after.resources.schedulerJobs]
    .filter(({ targetService }) => declaredRigServices.has(targetService))
    .filter(({ name, projectId, location, targetService, ownerRigId }) => !allowedSchedulerTargets.has(
      `${ownerRigId ?? 'NON_TARGET'}\u0000${projectId}\u0000${location}\u0000${name}`
        + `\u0000${targetService}`,
    ));
  if (undeclaredRigTargetJobs.length > 0) {
    failures.push('Undeclared Scheduler job targets a declared rig service.');
    allRecurringTargetsRemoved = false;
  }
  for (const rig of declaration.rigs.filter(({ targetBinding }) => targetBinding !== null)) {
    for (const target of rig.leaseTargets) {
      const beforeLease = before.resources.leases.find((lease) => (
        lease.ownerRigId === rig.rigId
        && dynamicTargetIdentity(lease) === dynamicTargetIdentity(target)
      ));
      const afterLease = after.resources.leases.find((lease) => (
        lease.ownerRigId === rig.rigId
        && dynamicTargetIdentity(lease) === dynamicTargetIdentity(target)
      ));
      if (
        !beforeLease
        || beforeLease.state !== 'ACTIVE'
        || beforeLease.releasedAt !== null
        || Date.parse(beforeLease.acquiredAt) > Date.parse(before.capturedAt)
        || Date.parse(beforeLease.acquiredAt) >= Date.parse(beforeLease.expiresAt)
        || Date.parse(beforeLease.expiresAt) <= Date.parse(before.capturedAt)
      ) {
        failures.push(`${rig.rigId} logical lease before-state is not one valid active lease.`);
      }
      if (
        !afterLease
        || afterLease.state !== 'RELEASED'
        || afterLease.releasedAt === null
        || Date.parse(afterLease.releasedAt) < Date.parse(beforeLease?.acquiredAt ?? after.capturedAt)
        || Date.parse(afterLease.releasedAt) <= Date.parse(before.capturedAt)
        || Date.parse(afterLease.releasedAt) > Date.parse(afterLease.expiresAt)
        || Date.parse(afterLease.releasedAt) > Date.parse(after.capturedAt)
        || Date.parse(afterLease.expiresAt) > Date.parse(after.capturedAt)
        || afterLease.acquiredAt !== beforeLease?.acquiredAt
        || afterLease.expiresAt !== beforeLease?.expiresAt
      ) {
        failures.push(`${rig.rigId} logical lease release and expiry are not proven after teardown.`);
      }
    }
  }
  return { failures, allRecurringTargetsRemoved };
}

export function verifyS33TeardownDryRun(
  declarationRaw: unknown,
  beforeRaw: unknown,
  afterRaw: unknown,
): S33TeardownDryRunVerification {
  const declaration = parseStrict(declarationSchema, declarationRaw, 'S3.3 teardown declaration');
  const before = parseStrict(inventorySchema, beforeRaw, 'S3.3 teardown before inventory');
  const after = parseStrict(inventorySchema, afterRaw, 'S3.3 teardown after inventory');
  validateDeclaration(declaration);
  validateInventoryUniqueness(before, 'Before inventory');
  validateInventoryUniqueness(after, 'After inventory');
  validateInventoryScope(before, 'Before inventory');
  validateInventoryScope(after, 'After inventory');
  validateExhaustiveOwnerDiscovery(declaration, before, 'Before inventory');
  validateExhaustiveOwnerDiscovery(declaration, after, 'After inventory');

  if (before.phase !== 'before' || after.phase !== 'after') {
    throw new Error('Teardown captures must be ordered before then after.');
  }
  if (
    before.closeoutId !== declaration.closeoutId
    || after.closeoutId !== declaration.closeoutId
    || before.gitHeadSha !== declaration.gitHeadSha
    || after.gitHeadSha !== declaration.gitHeadSha
    || stable(before.scope) !== stable(declaration.scope)
    || stable(after.scope) !== stable(declaration.scope)
  ) throw new Error('Teardown closeout/head/scope identity is contradictory.');
  if (Date.parse(after.capturedAt) <= Date.parse(before.capturedAt)) {
    throw new Error('Teardown after capturedAt must be later than the before capturedAt time.');
  }

  const targets = targetIdentities(declaration, before);
  const presence = targetPresenceFailures(declaration, before, after, targets);
  const protectedShared = new Set(declaration.protectedSharedSecretNames);
  const beforeSecrets = new Map(before.resources.secretNames.map((secret) => [
    secret.name,
    stable(secret),
  ]));
  const afterSecrets = new Map(after.resources.secretNames.map((secret) => [
    secret.name,
    stable(secret),
  ]));
  const sharedSecretsUntouched = [...protectedShared].every(
    (name) => beforeSecrets.has(name) && beforeSecrets.get(name) === afterSecrets.get(name),
  );
  const failures = [...presence.failures];
  if (!sharedSecretsUntouched) {
    failures.push('A protected shared secret is missing or its configuration/IAM digest drifted.');
  }

  const beforeNamed = namedResources(before.resources);
  const afterNamed = namedResources(after.resources);
  const result = {
    schemaVersion: S33_TEARDOWN_SCHEMA_VERSION,
    kind: 's33-teardown-dry-run-verification' as const,
    mode: 'DRY_RUN_VERIFY_ONLY' as const,
    closeoutId: declaration.closeoutId,
    gitHeadSha: declaration.gitHeadSha,
    verified: failures.length === 0,
    zeroRecurringRigCost: declarationBoundaryState(declaration).releaseBoundaryComplete
      && presence.allRecurringTargetsRemoved
      && failures.length === 0,
    sharedSecretsUntouched,
    mutationsAttempted: 0 as const,
    namedDiffs: {
      supabaseProjects: diff(beforeNamed.supabaseProjects, afterNamed.supabaseProjects),
      cloudRunServices: diff(beforeNamed.cloudRunServices, afterNamed.cloudRunServices),
      schedulerJobs: diff(beforeNamed.schedulerJobs, afterNamed.schedulerJobs),
      vertexEndpoints: diff(beforeNamed.vertexEndpoints, afterNamed.vertexEndpoints),
      queues: diff(beforeNamed.queues, afterNamed.queues),
      containedLogicalQueues: diff(
        beforeNamed.containedLogicalQueues,
        afterNamed.containedLogicalQueues,
      ),
      leases: diff(beforeNamed.leases, afterNamed.leases),
      serviceAccounts: diff(beforeNamed.serviceAccounts, afterNamed.serviceAccounts),
      secretNames: diff(beforeNamed.secretNames, afterNamed.secretNames),
      protectedNonResourceDispositions: diff(
        beforeNamed.protectedNonResourceDispositions,
        afterNamed.protectedNonResourceDispositions,
      ),
    },
    failures,
  } satisfies S33TeardownDryRunVerification;
  return deepFreeze(result);
}

const INVENTORY_CAPTURES = new WeakSet<S33TeardownInventoryCapture>();
const CAPTURED_VERIFICATIONS = new WeakSet<S33TeardownCapturedVerification>();

function resourceIdentityKey(resource: S33TeardownResourceIdentity): string {
  return [
    resource.provider,
    resource.kind,
    resource.scopeId,
    resource.resourceId,
    resource.ownerRigId ?? 'NON_TARGET',
  ].join('\u0000');
}

function sortResourceIdentities<T extends S33TeardownResourceIdentity>(
  resources: readonly T[],
): T[] {
  return [...resources].sort((left, right) => (
    resourceIdentityKey(left).localeCompare(resourceIdentityKey(right))
  ));
}

function declarationTargetResources(
  declaration: Declaration,
): S33TeardownTargetResource[] {
  const targets: S33TeardownTargetResource[] = [];
  for (const rig of declaration.rigs.filter(({ targetBinding }) => targetBinding !== null)) {
    const targetProvenance = bindingProvenance(rig.targetBinding!);
    targets.push({
      provider: 'SUPABASE',
      kind: 'isolated-project',
      scopeId: declaration.scope.supabaseOrgId,
      resourceId: rig.supabaseProjectRef!,
      ownerRigId: rig.rigId,
      rigId: rig.rigId,
      billingClass: 'RECURRING_PAID',
      targetProvenance,
    });
    for (const name of rig.cloudRunServiceNames) {
      targets.push({
        provider: 'GCP',
        kind: 'cloud-run-service',
        scopeId: declaration.scope.gcpProjectId,
        resourceId: name,
        ownerRigId: rig.rigId,
        rigId: rig.rigId,
        billingClass: 'RECURRING_PAID',
        targetProvenance,
      });
    }
    for (const name of rig.schedulerJobNames) {
      targets.push({
        provider: 'GCP',
        kind: 'cloud-scheduler-job',
        scopeId: `${declaration.scope.gcpProjectId}/${declaration.scope.gcpRegion}`,
        resourceId: name,
        ownerRigId: rig.rigId,
        rigId: rig.rigId,
        billingClass: 'RECURRING_PAID',
        targetProvenance,
      });
    }
    for (const target of rig.queueTargets) {
      targets.push({
        ...target,
        kind: 'queue',
        ownerRigId: rig.rigId,
        rigId: rig.rigId,
        billingClass: 'NO_RECURRING_CHARGE',
        targetProvenance,
      });
    }
    for (const queueId of rig.containedLogicalQueueIds) {
      targets.push({
        provider: 'SUPABASE',
        kind: 'contained-logical-queue',
        scopeId: rig.supabaseProjectRef!,
        resourceId: queueId,
        ownerRigId: rig.rigId,
        rigId: rig.rigId,
        billingClass: 'NO_RECURRING_CHARGE',
        targetProvenance,
      });
    }
    for (const target of rig.leaseTargets) {
      targets.push({
        ...target,
        kind: 'logical-lease',
        ownerRigId: rig.rigId,
        rigId: rig.rigId,
        billingClass: 'NO_RECURRING_CHARGE',
        targetProvenance,
      });
    }
    for (const account of rig.serviceAccountIdentities) {
      targets.push({
        provider: 'GCP',
        kind: 'service-account',
        scopeId: declaration.scope.gcpProjectId,
        resourceId: account.email,
        ownerRigId: rig.rigId,
        rigId: rig.rigId,
        billingClass: 'NO_RECURRING_CHARGE',
        targetProvenance,
      });
    }
    for (const { name } of rig.perRigSecrets) {
      targets.push({
        provider: 'GCP',
        kind: 'secret',
        scopeId: declaration.scope.gcpProjectId,
        resourceId: name,
        ownerRigId: rig.rigId,
        rigId: rig.rigId,
        billingClass: 'NO_RECURRING_CHARGE',
        targetProvenance,
      });
    }
  }
  for (const target of declaration.vertexEndpointTargets) {
    targets.push({
      provider: 'GCP',
      kind: 'vertex-endpoint',
      scopeId: `${declaration.scope.gcpProjectId}/${declaration.scope.gcpRegion}`,
      resourceId: target.resourceName,
      ownerRigId: target.ownerRigId,
      rigId: target.ownerRigId,
      billingClass: 'RECURRING_PAID',
      targetProvenance: { ...target.provenance },
    });
  }
  return sortResourceIdentities(targets);
}

function inventoryResourceEntries(
  inventory: Inventory,
): S33TeardownProtectedResource[] {
  const resources: S33TeardownProtectedResource[] = [];
  for (const project of inventory.resources.supabaseProjects) {
    resources.push({
      provider: 'SUPABASE',
      kind: 'isolated-project',
      scopeId: inventory.scope.supabaseOrgId,
      resourceId: project.ref,
      ownerRigId: project.ownerRigId,
      configurationDigestSha256: digestS33Evidence(project, 'Supabase inventory resource'),
      capturedConfigurationDigestSha256: null,
      capturedIamPolicyDigestSha256: null,
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const service of inventory.resources.cloudRunServices) {
    resources.push({
      provider: 'GCP',
      kind: 'cloud-run-service',
      scopeId: service.projectId,
      resourceId: service.name,
      ownerRigId: service.ownerRigId,
      configurationDigestSha256: digestS33Evidence(service, 'Cloud Run inventory resource'),
      capturedConfigurationDigestSha256: null,
      capturedIamPolicyDigestSha256: null,
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const job of inventory.resources.schedulerJobs) {
    resources.push({
      provider: 'GCP',
      kind: 'cloud-scheduler-job',
      scopeId: `${job.projectId}/${job.location}`,
      resourceId: job.name,
      ownerRigId: job.ownerRigId,
      configurationDigestSha256: digestS33Evidence(job, 'Scheduler inventory resource'),
      capturedConfigurationDigestSha256: null,
      capturedIamPolicyDigestSha256: null,
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const endpoint of inventory.resources.vertexEndpoints) {
    resources.push({
      provider: 'GCP',
      kind: 'vertex-endpoint',
      scopeId: `${inventory.scope.gcpProjectId}/${endpoint.location}`,
      resourceId: endpoint.resourceName,
      ownerRigId: endpoint.ownerRigId,
      configurationDigestSha256: digestS33Evidence(endpoint, 'Vertex inventory resource'),
      capturedConfigurationDigestSha256: endpoint.configurationDigestSha256,
      capturedIamPolicyDigestSha256: endpoint.iamPolicyDigestSha256,
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const queue of inventory.resources.queues) {
    resources.push({
      provider: queue.provider,
      kind: 'queue',
      scopeId: queue.scopeId,
      resourceId: queue.resourceId,
      ownerRigId: queue.ownerRigId,
      configurationDigestSha256: digestS33Evidence(queue, 'Queue inventory resource'),
      capturedConfigurationDigestSha256: null,
      capturedIamPolicyDigestSha256: null,
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const queue of inventory.resources.containedLogicalQueues) {
    resources.push({
      provider: 'SUPABASE',
      kind: 'contained-logical-queue',
      scopeId: queue.supabaseProjectRef,
      resourceId: queue.queueId,
      ownerRigId: queue.ownerRigId,
      configurationDigestSha256: digestS33Evidence(
        queue,
        'Contained logical queue inventory resource',
      ),
      capturedConfigurationDigestSha256: null,
      capturedIamPolicyDigestSha256: null,
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const lease of inventory.resources.leases) {
    resources.push({
      provider: lease.provider,
      kind: 'logical-lease',
      scopeId: lease.scopeId,
      resourceId: lease.resourceId,
      ownerRigId: lease.ownerRigId,
      configurationDigestSha256: digestS33Evidence(lease, 'Lease inventory resource'),
      capturedConfigurationDigestSha256: null,
      capturedIamPolicyDigestSha256: null,
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const account of inventory.resources.serviceAccounts) {
    resources.push({
      provider: 'GCP',
      kind: 'service-account',
      scopeId: account.projectId,
      resourceId: account.email,
      ownerRigId: account.ownerRigId,
      configurationDigestSha256: digestS33Evidence(account, 'Service-account inventory resource'),
      capturedConfigurationDigestSha256: account.configurationDigestSha256,
      capturedIamPolicyDigestSha256: account.iamPolicyDigestSha256,
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const secret of inventory.resources.secretNames) {
    resources.push({
      provider: 'GCP',
      kind: 'secret',
      scopeId: secret.projectId,
      resourceId: secret.name,
      ownerRigId: secret.ownerRigId,
      configurationDigestSha256: digestS33Evidence(secret, 'Secret inventory resource'),
      capturedConfigurationDigestSha256: secret.configurationDigestSha256,
      capturedIamPolicyDigestSha256: secret.iamPolicyDigestSha256,
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  return sortResourceIdentities(resources);
}

function buildResourceBoundary(
  declaration: Declaration,
  inventory: Inventory,
  gitTreeSha: string,
): S33TeardownResourceBoundary {
  const targetResources = declarationTargetResources(declaration);
  const targetKeys = new Set(targetResources.map(resourceIdentityKey));
  const protectedVertexInputs = new Set(
    declaration.protectedVertexEndpointResourceNames,
  );
  const protectedSharedSecrets = new Set(declaration.protectedSharedSecretNames);
  const protectedResources = inventoryResourceEntries(inventory)
    .filter((resource) => !targetKeys.has(resourceIdentityKey(resource)))
    .map((resource): S33TeardownProtectedResource => ({
      ...resource,
      protectionClass: resource.kind === 'vertex-endpoint'
        && protectedVertexInputs.has(resource.resourceId)
        ? 'DECLARED_PRE_EXISTING_VERTEX_INPUT'
        : resource.kind === 'secret'
          && protectedSharedSecrets.has(resource.resourceId)
          ? 'DECLARED_SHARED_SECRET'
          : 'NON_TARGET_INVENTORY',
    }));
  const boundaryState = declarationBoundaryState(declaration);
  return deepFreeze({
    schemaVersion: 'arkova.s33.l2.teardown-resource-boundary/v1' as const,
    closeoutId: declaration.closeoutId,
    gitHeadSha: declaration.gitHeadSha,
    gitTreeSha,
    scope: { ...declaration.scope },
    rigIds: ['RIG-B1', 'RIG-G1', 'RIG-R'] as const,
    ...boundaryState,
    targetResources,
    protectedResources,
    protectedNonResourceDispositions: inventory.resources.protectedNonResourceDispositions
      .map((disposition) => ({ ...disposition })),
  });
}

function capturePayload(
  capture: Omit<S33TeardownInventoryCapture, 'captureArtifactSha256'>,
): Omit<S33TeardownInventoryCapture, 'captureArtifactSha256'> {
  return capture;
}

export function captureS33TeardownInventory(
  declarationRaw: unknown,
  inventoryRaw: unknown,
  metadataRaw: unknown,
): S33TeardownInventoryCapture {
  const declaration = parseStrict(
    declarationSchema,
    declarationRaw,
    'S3.3 teardown declaration',
  );
  const inventory = parseStrict(
    inventorySchema,
    inventoryRaw,
    'S3.3 teardown inventory capture',
  );
  const metadata = parseStrict(
    captureMetadataSchema,
    metadataRaw,
    'S3.3 teardown capture metadata',
  );
  validateDeclaration(declaration);
  validateInventoryUniqueness(inventory, `${inventory.phase} inventory`);
  validateInventoryScope(inventory, `${inventory.phase} inventory`);
  validateExhaustiveOwnerDiscovery(
    declaration,
    inventory,
    `${inventory.phase} inventory`,
  );
  validateProtectedCapturePresence(
    declaration,
    inventory,
    `${inventory.phase} inventory`,
  );
  if (
    inventory.closeoutId !== declaration.closeoutId
    || inventory.gitHeadSha !== declaration.gitHeadSha
    || stable(inventory.scope) !== stable(declaration.scope)
  ) {
    throw new Error('Teardown capture closeout/head/scope identity is contradictory.');
  }
  if (Date.parse(metadata.signer.signedAt) < Date.parse(inventory.capturedAt)) {
    throw new Error('Teardown capture signer time cannot precede inventory capture time.');
  }
  const candidateTreeShas = new Set(declaration.rigs
    .flatMap(({ targetBinding }) => targetBinding ? [targetBinding.candidateGitTreeSha] : []));
  if (candidateTreeShas.size !== 1 || !candidateTreeShas.has(metadata.gitTreeSha)) {
    throw new Error('Teardown capture tree must equal the exact CTO-bound candidate tree SHA.');
  }
  if (declaration.rigs.some(
    ({ targetBinding }) => targetBinding !== null
      && Date.parse(targetBinding.boundAt) > Date.parse(inventory.capturedAt),
  )) {
    throw new Error('Teardown target binding time cannot follow the inventory capture time.');
  }

  const resourceBoundary = buildResourceBoundary(
    declaration,
    inventory,
    metadata.gitTreeSha,
  );
  const inventoryArtifactSha256 = digestS33Evidence(
    inventory,
    'S3.3 teardown inventory capture',
  );
  const resourceBoundarySha256 = digestS33Evidence(
    resourceBoundary,
    'S3.3 teardown resource boundary',
  );
  const payload = capturePayload({
    schemaVersion: S33_TEARDOWN_CAPTURE_SCHEMA_VERSION,
    kind: 's33-teardown-inventory-capture',
    closeoutId: declaration.closeoutId,
    gitHeadSha: declaration.gitHeadSha,
    gitTreeSha: metadata.gitTreeSha,
    phase: inventory.phase,
    capturedAt: inventory.capturedAt,
    inventory,
    resourceBoundary,
    operator: { ...metadata.operator },
    signer: { ...metadata.signer },
    inventoryArtifactSha256,
    resourceBoundarySha256,
  });
  const capture = deepFreeze<S33TeardownInventoryCapture>({
    ...payload,
    captureArtifactSha256: digestS33Evidence(
      payload,
      'S3.3 teardown captured artifact',
    ),
  });
  INVENTORY_CAPTURES.add(capture);
  return capture;
}

function requireInventoryCapture(
  candidate: unknown,
  phase: 'before' | 'after',
): S33TeardownInventoryCapture {
  if (!candidate || typeof candidate !== 'object' || !INVENTORY_CAPTURES.has(
    candidate as S33TeardownInventoryCapture,
  )) {
    throw new Error(`S3.3 ${phase} inventory requires an immutable provenance-bound capture.`);
  }
  const capture = candidate as S33TeardownInventoryCapture;
  if (capture.phase !== phase) {
    throw new Error(`S3.3 teardown capture phase must be ${phase}.`);
  }
  return capture;
}

function assertCaptureIntegrity(
  declaration: Declaration,
  capture: S33TeardownInventoryCapture,
): void {
  const recomputedInventoryDigest = digestS33Evidence(
    capture.inventory,
    'S3.3 teardown inventory capture',
  );
  const recomputedBoundary = buildResourceBoundary(
    declaration,
    capture.inventory as Inventory,
    capture.gitTreeSha,
  );
  const recomputedBoundaryDigest = digestS33Evidence(
    recomputedBoundary,
    'S3.3 teardown resource boundary',
  );
  const { captureArtifactSha256, ...payload } = capture;
  const recomputedCaptureDigest = digestS33Evidence(
    payload,
    'S3.3 teardown captured artifact',
  );
  if (
    capture.inventoryArtifactSha256 !== recomputedInventoryDigest
    || capture.resourceBoundarySha256 !== recomputedBoundaryDigest
    || captureArtifactSha256 !== recomputedCaptureDigest
    || stable(capture.resourceBoundary) !== stable(recomputedBoundary)
  ) {
    throw new Error('S3.3 teardown immutable capture digest or resource boundary is contradictory.');
  }
  if (
    capture.closeoutId !== declaration.closeoutId
    || capture.gitHeadSha !== declaration.gitHeadSha
    || capture.inventory.closeoutId !== declaration.closeoutId
    || capture.inventory.gitHeadSha !== declaration.gitHeadSha
  ) {
    throw new Error('S3.3 teardown immutable capture identity is stale or contradictory.');
  }
}

function signerIdentity(capture: S33TeardownInventoryCapture) {
  return {
    keyId: capture.signer.keyId,
    algorithm: capture.signer.algorithm,
    publicKeyFingerprintSha256: capture.signer.publicKeyFingerprintSha256,
    verificationStatus: capture.signer.verificationStatus,
  };
}

function targetOutcomes(
  targets: readonly S33TeardownTargetResource[],
  before: S33TeardownInventoryCapture,
  after: S33TeardownInventoryCapture,
): S33TeardownTargetOutcome[] {
  const beforeKeys = new Set(inventoryResourceEntries(before.inventory as Inventory).map(
    resourceIdentityKey,
  ));
  const afterKeys = new Set(inventoryResourceEntries(after.inventory as Inventory).map(
    resourceIdentityKey,
  ));
  return targets.map((resource) => {
    const key = resourceIdentityKey(resource);
    const releasedLease = resource.kind === 'logical-lease'
      && after.inventory.resources.leases.some((lease) => (
        lease.ownerRigId === resource.ownerRigId
        && lease.scopeId === resource.scopeId
        && lease.resourceId === resource.resourceId
        && lease.state === 'RELEASED'
        && lease.releasedAt !== null
        && Date.parse(lease.expiresAt) <= Date.parse(after.capturedAt)
      ));
    const state = !beforeKeys.has(key)
      ? 'MISSING_FROM_BEFORE'
      : releasedLease
        ? 'RELEASED_EXPIRED'
        : afterKeys.has(key)
          ? 'REMAINS'
          : 'REMOVED';
    return {
      ...resource,
      state,
      projectedMonthlyRecurringUsd: state === 'REMOVED' || state === 'RELEASED_EXPIRED'
        ? 0 as const
        : null,
      evidenceArtifactSha256: digestS33Evidence({
        afterCaptureArtifactSha256: after.captureArtifactSha256,
        resource,
        state,
      }, 'S3.3 teardown target outcome'),
    };
  });
}

export function verifyS33TeardownCapturedInventories(
  declarationRaw: unknown,
  beforeRaw: unknown,
  afterRaw: unknown,
): S33TeardownCapturedVerification {
  const declaration = parseStrict(
    declarationSchema,
    declarationRaw,
    'S3.3 teardown declaration',
  );
  validateDeclaration(declaration);
  const before = requireInventoryCapture(beforeRaw, 'before');
  const after = requireInventoryCapture(afterRaw, 'after');
  assertCaptureIntegrity(declaration, before);
  assertCaptureIntegrity(declaration, after);
  if (
    before.gitTreeSha !== after.gitTreeSha
    || stable(before.operator) !== stable(after.operator)
    || stable(signerIdentity(before)) !== stable(signerIdentity(after))
  ) {
    throw new Error('S3.3 teardown tree/operator/signer identity is contradictory across captures.');
  }
  if (
    before.signer.detachedSignatureArtifactSha256
    === after.signer.detachedSignatureArtifactSha256
  ) {
    throw new Error('Before and after teardown captures require distinct detached signature artifacts.');
  }

  const dryRun = verifyS33TeardownDryRun(
    declaration,
    before.inventory,
    after.inventory,
  );
  const boundaryUnchanged = before.resourceBoundarySha256 === after.resourceBoundarySha256;
  const protectedResourcesUntouched = boundaryUnchanged && dryRun.sharedSecretsUntouched;
  const failures = [...dryRun.failures];
  if (!boundaryUnchanged) {
    failures.push('Protected non-target resource boundary drifted between immutable captures.');
  }
  const outcomes = targetOutcomes(
    before.resourceBoundary.targetResources,
    before,
    after,
  );
  const verified = dryRun.verified && protectedResourcesUntouched && failures.length === 0;
  const releaseBoundaryComplete = before.resourceBoundary.releaseBoundaryComplete;
  const recurringCostZero = verified
    && releaseBoundaryComplete
    && dryRun.zeroRecurringRigCost;
  const resultWithoutDigest = {
    schemaVersion: S33_TEARDOWN_CAPTURED_VERIFICATION_SCHEMA_VERSION,
    kind: 's33-teardown-captured-verification' as const,
    mode: 'CAPTURED_IMMUTABLE_VERIFY_ONLY' as const,
    closeoutId: declaration.closeoutId,
    gitHeadSha: declaration.gitHeadSha,
    gitTreeSha: before.gitTreeSha,
    verified,
    protectedResourcesUntouched,
    releaseBoundaryComplete,
    boundaryStatus: before.resourceBoundary.boundaryStatus,
    unboundRigIds: before.resourceBoundary.unboundRigIds,
    releaseAcceptance: false as const,
    recurringCostVerdict: recurringCostZero
      ? 'recurring_cost_zero' as const
      : 'blocked' as const,
    recurring_cost_zero: recurringCostZero,
    projectedMonthlyRecurringUsd: recurringCostZero ? 0 as const : null,
    signatureVerification: 'UNVERIFIED_EXTERNAL_ARTIFACT' as const,
    mutationsAttempted: 0 as const,
    operator: { ...before.operator },
    signer: {
      ...signerIdentity(before),
      beforeDetachedSignatureArtifactSha256:
        before.signer.detachedSignatureArtifactSha256,
      afterDetachedSignatureArtifactSha256:
        after.signer.detachedSignatureArtifactSha256,
    },
    beforeCapturedAt: before.capturedAt,
    afterCapturedAt: after.capturedAt,
    beforeInventoryArtifactSha256: before.inventoryArtifactSha256,
    afterInventoryArtifactSha256: after.inventoryArtifactSha256,
    beforeCaptureArtifactSha256: before.captureArtifactSha256,
    afterCaptureArtifactSha256: after.captureArtifactSha256,
    resourceBoundarySha256: before.resourceBoundarySha256,
    afterResourceBoundarySha256: after.resourceBoundarySha256,
    targetOutcomes: outcomes,
    namedDiffs: dryRun.namedDiffs,
    failures,
  };
  const result = deepFreeze<S33TeardownCapturedVerification>({
    ...resultWithoutDigest,
    verificationDigestSha256: digestS33Evidence(
      resultWithoutDigest,
      'S3.3 teardown captured verification',
    ),
  });
  CAPTURED_VERIFICATIONS.add(result);
  return result;
}

export function requireS33TeardownCapturedVerification(
  candidate: unknown,
): S33TeardownCapturedVerification {
  if (!candidate || typeof candidate !== 'object' || !CAPTURED_VERIFICATIONS.has(
    candidate as S33TeardownCapturedVerification,
  )) {
    throw new Error('S3.3 teardown consumer requires a provenance-bound captured verification.');
  }
  return candidate as S33TeardownCapturedVerification;
}
