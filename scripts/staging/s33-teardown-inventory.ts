/**
 * Strict, side-effect-free S3.3 teardown inventory verifier.
 *
 * The verifier consumes already-captured before/after inventories. It has no
 * cloud client, credential, command execution, or deletion capability.
 */

import { z } from 'zod';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';

export const S33_TEARDOWN_SCHEMA_VERSION = 1 as const;

const gitSha = z.string().regex(/^[0-9a-f]{40}$/);
const nonEmpty = z.string().min(1);
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/);
const capturedAt = z.string().datetime({ offset: true });
const gcpProjectId = z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
const gcpRegion = z.string().regex(/^[a-z]+-[a-z]+\d$/);
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

const rigSchema = z.object({
  rigId: z.enum(['RIG-G1', 'RIG-B1', 'RIG-R']),
  supabaseProjectRef: z.string().regex(/^[a-z]{20}$/),
  supabaseProjectName: nonEmpty,
  cloudRunServiceNames: z.array(nonEmpty).min(1),
  schedulerJobNames: z.array(nonEmpty).min(1),
  perRigSecretNames: z.array(nonEmpty).min(1),
}).strict();

const declarationSchema = z.object({
  schemaVersion: z.literal(S33_TEARDOWN_SCHEMA_VERSION),
  kind: z.literal('s33-teardown-declaration'),
  closeoutId: safeId,
  gitHeadSha: gitSha,
  scope: scopeSchema,
  rigs: z.array(rigSchema).length(3),
  vertexEndpointResourceNames: z.array(nonEmpty).min(1),
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
  resourceName: z.string().regex(
    /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z]+-[a-z]+\d\/endpoints\/[1-9]\d*$/,
  ),
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

type Declaration = z.infer<typeof declarationSchema>;
type Inventory = z.infer<typeof inventorySchema>;
type ResourceCollection = Inventory['resources'];

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

  const rigB1 = declaration.rigs.find(({ rigId }) => rigId === 'RIG-B1');
  if (declaration.rigs.some(({ cloudRunServiceNames }) => cloudRunServiceNames.length !== 1)) {
    throw new Error('Each teardown rig requires exactly one owning Cloud Run service identity.');
  }
  if (!rigB1) {
    throw new Error('RIG-B1 teardown requires exactly one Cloud Run service identity.');
  }
  const [rigB1Service] = rigB1.cloudRunServiceNames;
  const expectedRigB1SchedulerJobs = sorted(RIG_B1_SCHEDULER_SUFFIXES.map(
    (suffix) => `${rigB1Service}-${suffix}`,
  ));
  if (stable(sorted(rigB1.schedulerJobNames)) !== stable(expectedRigB1SchedulerJobs)) {
    throw new Error('RIG-B1 teardown requires the exact frozen six-job Scheduler target set.');
  }

  assertUnique('Teardown Supabase project refs', declaration.rigs.map((rig) => rig.supabaseProjectRef));
  assertUnique('Teardown Supabase project names', declaration.rigs.map((rig) => rig.supabaseProjectName));
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
  assertUnique('Teardown Vertex endpoints', declaration.vertexEndpointResourceNames);
  const protectedSecrets = new Set(declaration.protectedSharedSecretNames);
  if (perRigSecrets.some((name) => protectedSecrets.has(name))) {
    throw new Error('A per-rig teardown secret cannot also be a protected shared secret.');
  }
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
  const vertexNames = new Set(declaration.vertexEndpointResourceNames);
  return {
    supabaseProjects: new Set(declaration.rigs.map(
      ({ supabaseProjectRef, supabaseProjectName }) => `${supabaseProjectRef}\u0000${supabaseProjectName}`,
    )),
    cloudRunServices: new Set(declaration.rigs.flatMap((rig) => rig.cloudRunServiceNames.map(
      (name) => `${declaration.scope.gcpProjectId}\u0000${declaration.scope.gcpRegion}\u0000${name}`,
    ))),
    schedulerJobs: new Set(declaration.rigs.flatMap((rig) => rig.schedulerJobNames.map(
      (name) => `${declaration.scope.gcpProjectId}\u0000${declaration.scope.gcpRegion}\u0000${name}`
        + `\u0000${rig.cloudRunServiceNames[0]}`,
    ))),
    vertexEndpoints: new Set(before.resources.vertexEndpoints
      .filter(({ resourceName }) => vertexNames.has(resourceName))
      .map((endpoint) => stable(endpoint))),
    secretNames: new Set(declaration.rigs.flatMap((rig) => rig.perRigSecretNames)),
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

  const declaredVertexNames = new Set(declaration.vertexEndpointResourceNames);
  const capturedVertexNames = new Set(before.resources.vertexEndpoints.map(({ resourceName }) => resourceName));
  if ([...declaredVertexNames].some((name) => !capturedVertexNames.has(name))) {
    failures.push('vertexEndpoints target inventory is incomplete before teardown.');
    allRecurringTargetsRemoved = false;
  }
  const declaredRigServices = new Set(declaration.rigs.flatMap(({ cloudRunServiceNames }) => cloudRunServiceNames));
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
    zeroRecurringRigCost: presence.allRecurringTargetsRemoved && failures.length === 0,
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
