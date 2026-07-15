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
  provisionArtifactSha256: sha256,
  boundAt: capturedAt,
}).strict();

const rigSchema = z.object({
  rigId: z.enum(['RIG-G1', 'RIG-B1', 'RIG-R']),
  targetBinding: targetBindingSchema.nullable(),
  supabaseProjectRef: z.string().regex(/^[a-z]{20}$/).nullable(),
  supabaseProjectName: nonEmpty.nullable(),
  cloudRunServiceNames: z.array(nonEmpty),
  schedulerJobNames: z.array(nonEmpty),
  perRigSecretNames: z.array(nonEmpty),
}).strict();

const vertexEndpointTargetSchema = z.object({
  resourceName: vertexEndpointResourceName,
  ownerRigId: z.enum(['RIG-G1', 'RIG-B1', 'RIG-R']),
  provenance: z.object({
    authority: z.literal('CTO'),
    origin: z.literal('S33_ISOLATED_RIG_RESOURCE'),
    decisionArtifactSha256: sha256,
    provisionArtifactSha256: sha256,
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
}).strict();

const supabaseProjectSchema = z.object({
  ref: z.string().regex(/^[a-z]{20}$/),
  name: nonEmpty,
}).strict();

const cloudRunServiceSchema = z.object({
  name: nonEmpty,
  projectId: gcpProjectId,
  region: gcpRegion,
}).strict();

const schedulerJobSchema = z.object({
  name: nonEmpty,
  projectId: gcpProjectId,
  location: gcpRegion,
  targetService: nonEmpty,
}).strict();

const vertexEndpointSchema = z.object({
  resourceName: vertexEndpointResourceName,
  displayName: nonEmpty,
  location: nonEmpty,
  deployedModelIds: z.array(nonEmpty),
}).strict();

const resourcesSchema = z.object({
  supabaseProjects: z.array(supabaseProjectSchema),
  cloudRunServices: z.array(cloudRunServiceSchema),
  schedulerJobs: z.array(schedulerJobSchema),
  vertexEndpoints: z.array(vertexEndpointSchema),
  secretNames: z.array(nonEmpty),
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
    | 'secret';
  readonly scopeId: string;
  readonly resourceId: string;
}

export interface S33TeardownTargetResource extends S33TeardownResourceIdentity {
  readonly rigId: 'RIG-G1' | 'RIG-B1' | 'RIG-R' | null;
  readonly billingClass: 'RECURRING_PAID' | 'NO_RECURRING_CHARGE';
  readonly targetProvenance: Readonly<{
    authority: 'CTO';
    origin: 'S33_ISOLATED_RIG_RESOURCE';
    decisionArtifactSha256: string;
    provisionArtifactSha256: string;
  }>;
}

export interface S33TeardownProtectedResource extends S33TeardownResourceIdentity {
  readonly configurationDigestSha256: string;
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
  readonly state: 'REMOVED' | 'REMAINS' | 'MISSING_FROM_BEFORE';
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
    readonly secretNames: S33NamedInventoryDiff;
  };
  readonly failures: readonly string[];
}

interface NamedResource {
  readonly identity: string;
  readonly display: string;
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
      && rig.perRigSecretNames.length > 0;
    if (rig.targetBinding === null) {
      if (
        rig.supabaseProjectRef !== null
        || rig.supabaseProjectName !== null
        || rig.cloudRunServiceNames.length > 0
        || rig.schedulerJobNames.length > 0
        || rig.perRigSecretNames.length > 0
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
    || stable(sorted(rigG1.perRigSecretNames)) !== stable([...RIG_G1_SECRET_NAMES])
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

  if (
    rigR.targetBinding !== null
    && rigR.schedulerJobNames.length > 0
    && rigR.cloudRunServiceNames.length !== 1
  ) {
    throw new Error(
      'RIG-R Scheduler targets require one unambiguous CTO-bound Cloud Run service identity.',
    );
  }

  const boundRigs = declaration.rigs.filter(({ targetBinding }) => targetBinding !== null);
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
  const perRigSecrets = declaration.rigs.flatMap((rig) => rig.perRigSecretNames);
  assertUnique('Teardown per-rig secrets', perRigSecrets);
  assertUnique('Protected shared secrets', declaration.protectedSharedSecretNames);
  assertUnique(
    'Protected Vertex endpoints',
    declaration.protectedVertexEndpointResourceNames,
  );
  assertUnique(
    'Teardown Vertex endpoint targets',
    declaration.vertexEndpointTargets.map(({ resourceName }) => resourceName),
  );
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
    if (
      target.provenance.decisionArtifactSha256
        !== owner.targetBinding.decisionArtifactSha256
      || target.provenance.provisionArtifactSha256
        !== owner.targetBinding.provisionArtifactSha256
    ) {
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
    supabaseProjects: resources.supabaseProjects.map(({ ref, name }) => ({
      identity: `${ref}\u0000${name}`,
      display: `${name} (${ref})`,
    })),
    cloudRunServices: resources.cloudRunServices.map(({ name, projectId, region }) => ({
      identity: `${projectId}\u0000${region}\u0000${name}`,
      display: `${name} (${projectId}/${region})`,
    })),
    schedulerJobs: resources.schedulerJobs.map(({ name, projectId, location, targetService }) => ({
      identity: `${projectId}\u0000${location}\u0000${name}\u0000${targetService}`,
      display: `${name} (${projectId}/${location} -> ${targetService})`,
    })),
    vertexEndpoints: resources.vertexEndpoints.map((endpoint) => ({
      identity: stable(endpoint),
      display: `${endpoint.displayName} (${endpoint.resourceName})`,
    })),
    secretNames: resources.secretNames.map((name) => ({ identity: name, display: name })),
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
}

function validateProtectedCapturePresence(
  declaration: Declaration,
  inventory: Inventory,
  label: string,
): void {
  const capturedEndpoints = new Set(
    inventory.resources.vertexEndpoints.map(({ resourceName }) => resourceName),
  );
  if (declaration.protectedVertexEndpointResourceNames.some(
    (resourceName) => !capturedEndpoints.has(resourceName),
  )) {
    throw new Error(`${label} omits a declared protected pre-existing Vertex endpoint.`);
  }
  const capturedSecrets = new Set(inventory.resources.secretNames);
  if (declaration.protectedSharedSecretNames.some(
    (name) => !capturedSecrets.has(name),
  )) {
    throw new Error(`${label} omits a declared protected shared secret.`);
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
      ({ supabaseProjectRef, supabaseProjectName }) => `${supabaseProjectRef!}\u0000${supabaseProjectName!}`,
    )),
    cloudRunServices: new Set(boundRigs.flatMap((rig) => rig.cloudRunServiceNames.map(
      (name) => `${declaration.scope.gcpProjectId}\u0000${declaration.scope.gcpRegion}\u0000${name}`,
    ))),
    schedulerJobs: new Set(boundRigs.flatMap((rig) => rig.schedulerJobNames.map(
      (name) => `${declaration.scope.gcpProjectId}\u0000${declaration.scope.gcpRegion}\u0000${name}`
        + `\u0000${rig.cloudRunServiceNames[0]}`,
    ))),
    vertexEndpoints: new Set(before.resources.vertexEndpoints
      .filter(({ resourceName }) => vertexNames.has(resourceName))
      .map((endpoint) => stable(endpoint))),
    secretNames: new Set(boundRigs.flatMap((rig) => rig.perRigSecretNames)),
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
    if (stragglers.length > 0) failures.push(`${kind} target straggler remains after teardown.`);
    if (kind !== 'secretNames' && (missingBefore.length > 0 || stragglers.length > 0)) {
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
    .filter(({ name, projectId, location, targetService }) => !allowedSchedulerTargets.has(
      `${projectId}\u0000${location}\u0000${name}\u0000${targetService}`,
    ));
  if (undeclaredRigTargetJobs.length > 0) {
    failures.push('Undeclared Scheduler job targets a declared rig service.');
    allRecurringTargetsRemoved = false;
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
  const beforeSecrets = new Set(before.resources.secretNames);
  const afterSecrets = new Set(after.resources.secretNames);
  const sharedSecretsUntouched = [...protectedShared].every(
    (name) => beforeSecrets.has(name) && afterSecrets.has(name),
  );
  const failures = [...presence.failures];
  if (!sharedSecretsUntouched) failures.push('A protected shared secret is missing before or after teardown.');

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
      secretNames: diff(beforeNamed.secretNames, afterNamed.secretNames),
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
    const targetProvenance = {
      authority: rig.targetBinding!.authority,
      origin: 'S33_ISOLATED_RIG_RESOURCE' as const,
      decisionArtifactSha256: rig.targetBinding!.decisionArtifactSha256,
      provisionArtifactSha256: rig.targetBinding!.provisionArtifactSha256,
    };
    targets.push({
      provider: 'SUPABASE',
      kind: 'isolated-project',
      scopeId: declaration.scope.supabaseOrgId,
      resourceId: rig.supabaseProjectRef!,
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
        rigId: rig.rigId,
        billingClass: 'RECURRING_PAID',
        targetProvenance,
      });
    }
    for (const name of rig.perRigSecretNames) {
      targets.push({
        provider: 'GCP',
        kind: 'secret',
        scopeId: declaration.scope.gcpProjectId,
        resourceId: name,
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
      configurationDigestSha256: digestS33Evidence(project, 'Supabase inventory resource'),
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const service of inventory.resources.cloudRunServices) {
    resources.push({
      provider: 'GCP',
      kind: 'cloud-run-service',
      scopeId: service.projectId,
      resourceId: service.name,
      configurationDigestSha256: digestS33Evidence(service, 'Cloud Run inventory resource'),
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const job of inventory.resources.schedulerJobs) {
    resources.push({
      provider: 'GCP',
      kind: 'cloud-scheduler-job',
      scopeId: `${job.projectId}/${job.location}`,
      resourceId: job.name,
      configurationDigestSha256: digestS33Evidence(job, 'Scheduler inventory resource'),
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const endpoint of inventory.resources.vertexEndpoints) {
    resources.push({
      provider: 'GCP',
      kind: 'vertex-endpoint',
      scopeId: `${inventory.scope.gcpProjectId}/${endpoint.location}`,
      resourceId: endpoint.resourceName,
      configurationDigestSha256: digestS33Evidence(endpoint, 'Vertex inventory resource'),
      protectionClass: 'NON_TARGET_INVENTORY',
    });
  }
  for (const name of inventory.resources.secretNames) {
    resources.push({
      provider: 'GCP',
      kind: 'secret',
      scopeId: inventory.scope.gcpProjectId,
      resourceId: name,
      configurationDigestSha256: digestS33Evidence(name, 'Secret inventory resource'),
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
    const state = !beforeKeys.has(key)
      ? 'MISSING_FROM_BEFORE'
      : afterKeys.has(key)
        ? 'REMAINS'
        : 'REMOVED';
    return {
      ...resource,
      state,
      projectedMonthlyRecurringUsd: state === 'REMOVED' ? 0 as const : null,
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
