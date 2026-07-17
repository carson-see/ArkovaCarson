/**
 * S3.3 RIG-R release controller.
 *
 * This is deliberately a thin orchestrator. The existing v6 smoke/eval tools
 * own their gates, and the existing release-evidence-chain module owns evidence
 * acceptance. This controller only binds those operations to the exact RIG-R
 * topology and guarantees teardown on a failed operation or authority-bound
 * hard stop. Cryptographic verification belongs to the provision authority
 * boundary; this controller never promotes caller strings into authority.
 */

import { z } from 'zod';

import { requireS33RigRReleaseEvidence } from './s33-rig-r-release-evidence';

export const RIG_R_RELEASE_TOPOLOGY = Object.freeze({
  rigId: 'RIG-R',
  rigName: 's33-r',
  profile: 'gemini-release',
  gcpProjectId: 'arkova1',
  supabaseProjectName: 'arkova-soak-s33-r',
  cloudRunService: 'arkova-worker-s33-r-staging',
  runtimeServiceAccount: 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
  runtimeImpersonatorServiceAccount: '270018525501-compute@developer.gserviceaccount.com',
  runtimeImpersonationRole: 'roles/iam.serviceAccountTokenCreator',
  runtimeImpersonationMember:
    'serviceAccount:270018525501-compute@developer.gserviceaccount.com',
  region: 'us-central1',
  releaseEndpoint: 'projects/arkova1/locations/us-central1/endpoints/733014',
  releaseDeployedModelId: '7330141',
  containedDatabaseQueues: Object.freeze(['ai-rollback', 'chain-fault'] as const),
  protectedV6RollbackEndpoint:
    'projects/arkova1/locations/us-central1/endpoints/6611494259700793344',
  protectedV6RollbackModel:
    'projects/270018525501/locations/us-central1/models/6611494259700793344',
  smokeCommand: Object.freeze([
    'npx',
    'tsx',
    'services/worker/scripts/smoke-test-gemini-golden-v6.ts',
  ] as const),
  evalCommand: Object.freeze([
    'services/worker/scripts/eval-and-analyze-v6.sh',
  ] as const),
  rollbackContract: 'docs/runbooks/v6-cutover.md#rollback-single-command',
  releaseEvidenceContract: 'scripts/staging/s33-release-evidence-chain.ts',
} as const);

const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const provisionBindingSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-r.provision-binding/v1'),
  rigId: z.literal(RIG_R_RELEASE_TOPOLOGY.rigId),
  rigName: z.literal(RIG_R_RELEASE_TOPOLOGY.rigName),
  profile: z.literal(RIG_R_RELEASE_TOPOLOGY.profile),
  tier: z.literal('T3'),
  candidateHeadSha: gitSha,
  candidateTreeSha: gitSha,
  imageDigest: sha256,
  provisionArtifactSha256: sha256,
  gcpProjectId: z.literal(RIG_R_RELEASE_TOPOLOGY.gcpProjectId),
  supabaseProjectName: z.literal(RIG_R_RELEASE_TOPOLOGY.supabaseProjectName),
  cloudRunService: z.literal(RIG_R_RELEASE_TOPOLOGY.cloudRunService),
  runtimeServiceAccount: z.literal(RIG_R_RELEASE_TOPOLOGY.runtimeServiceAccount),
  runtimeImpersonatorServiceAccount: z.literal(
    RIG_R_RELEASE_TOPOLOGY.runtimeImpersonatorServiceAccount,
  ),
  runtimeImpersonationRole: z.literal(RIG_R_RELEASE_TOPOLOGY.runtimeImpersonationRole),
  runtimeImpersonationMember: z.literal(RIG_R_RELEASE_TOPOLOGY.runtimeImpersonationMember),
  vertexEndpoint: z.literal(RIG_R_RELEASE_TOPOLOGY.releaseEndpoint),
  vertexModel: z.literal(RIG_R_RELEASE_TOPOLOGY.protectedV6RollbackModel),
  deployedModelId: z.literal(RIG_R_RELEASE_TOPOLOGY.releaseDeployedModelId),
  containedDatabaseQueues: z.tuple([
    z.literal('ai-rollback'),
    z.literal('chain-fault'),
  ]),
  managedSchedulerJobs: z.tuple([]),
  managedQueues: z.tuple([]),
  oidcIdentities: z.tuple([]),
  leaseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u),
  requiredWorkerUptimeMin: z.literal(2880),
  requiredWallMin: z.number().int().min(2910).safe(),
  provisionStartedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  const startedAt = Date.parse(value.provisionStartedAt);
  const expiresAt = Date.parse(value.expiresAt);
  const minimumExpiry = startedAt + (value.requiredWallMin + 360) * 60_000;
  const maximumExpiry = startedAt + 72 * 60 * 60_000;
  if (expiresAt < minimumExpiry) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'RIG-R hard-stop expiry must cover the wall floor plus 360 minutes.',
    });
  }
  if (expiresAt > maximumExpiry) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'RIG-R hard-stop expiry cannot exceed 72 hours from provision start.',
    });
  }
});

const releaseEvidenceIdentitySchema = z.object({
  exactHeadSha: gitSha,
  exactTreeSha: gitSha,
}).passthrough();

export type S33RigRProvisionBinding = z.infer<typeof provisionBindingSchema>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function validateS33RigRProvisionBinding(value: unknown): S33RigRProvisionBinding {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch (error) {
    throw new TypeError('RIG-R provision binding must be immutable JSON data.', { cause: error });
  }
  const parsed = provisionBindingSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error(`RIG-R provision binding rejected: ${z.prettifyError(parsed.error)}`);
  }
  return deepFreeze(parsed.data);
}

export interface S33RigRReleaseDriverPort {
  /** Runs the existing v6 smoke tool; non-success must reject. */
  runV6Smoke(binding: S33RigRProvisionBinding): Promise<void>;
  /** Runs the existing v6 eval/analyzer; non-success must reject. */
  runV6Eval(binding: S33RigRProvisionBinding): Promise<void>;
  /** Loads the exact already-composed release evidence for this run. */
  loadReleaseEvidence(binding: S33RigRProvisionBinding): Promise<unknown>;
  /** Normally requireS33RigRReleaseEvidence; injectable only for tests/adapters. */
  requireReleaseEvidence?(value: unknown): unknown;
  /** Executes the canonical isolated-rig teardown contract. */
  teardown(
    binding: S33RigRProvisionBinding,
    reason: 'authority-expiry' | 'driver-failure',
  ): Promise<void>;
  now(): Date;
}

export type S33RigRReleaseDriverResult = Readonly<
  | {
      status: 'SOAK_EVIDENCE_BOUND';
      binding: S33RigRProvisionBinding;
      releaseEvidence: unknown;
    }
  | {
      status: 'HARD_STOP_TEARDOWN';
      binding: S33RigRProvisionBinding;
      releaseEvidence: null;
    }
>;

/**
 * Run one release-controller pass. A supervisor invokes this controller for
 * the exact admission. The authority-bound expiry is checked before any test
 * call, and every failed delegated operation tears the isolated topology down.
 */
export async function runS33RigRReleaseDriver(
  rawBinding: unknown,
  port: S33RigRReleaseDriverPort,
): Promise<S33RigRReleaseDriverResult> {
  const binding = validateS33RigRProvisionBinding(rawBinding);
  const now = port.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('RIG-R release controller requires a valid current time.');
  }

  if (now.getTime() >= Date.parse(binding.expiresAt)) {
    await port.teardown(binding, 'authority-expiry');
    return deepFreeze({
      status: 'HARD_STOP_TEARDOWN' as const,
      binding,
      releaseEvidence: null,
    });
  }

  try {
    await port.runV6Smoke(binding);
    await port.runV6Eval(binding);
    const candidate = await port.loadReleaseEvidence(binding);
    const releaseEvidence = (port.requireReleaseEvidence
      ?? requireS33RigRReleaseEvidence)(candidate);
    const releaseIdentity = releaseEvidenceIdentitySchema.safeParse(releaseEvidence);
    if (!releaseIdentity.success) {
      throw new Error(
        `RIG-R release evidence identity rejected: ${z.prettifyError(releaseIdentity.error)}`,
      );
    }
    if (
      releaseIdentity.data.exactHeadSha !== binding.candidateHeadSha
      || releaseIdentity.data.exactTreeSha !== binding.candidateTreeSha
    ) {
      throw new Error('RIG-R release evidence does not bind the exact candidate HEAD/tree.');
    }
    return deepFreeze({
      status: 'SOAK_EVIDENCE_BOUND' as const,
      binding,
      releaseEvidence,
    });
  } catch (error) {
    try {
      await port.teardown(binding, 'driver-failure');
    } catch (teardownError) {
      throw new AggregateError(
        [error, teardownError],
        'RIG-R release operation and mandatory teardown both failed.',
      );
    }
    throw error;
  }
}
