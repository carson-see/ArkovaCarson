import { describe, expect, it, vi } from 'vitest';

import {
  G1_PAIRED_START_CONTRACT,
  runS33G1PairedStartDriver,
  validateS33G1PairedStartAdmission,
  type S33G1AdmissionArm,
  type S33G1ArmStartObservation,
  type S33G1ContinuationScope,
  type S33G1ObservedArm,
  type S33G1PairedStartPort,
  type S33G1PairedStartReceipt,
  type S33G1PreclockReadiness,
} from './s33-g1-paired-start-driver';
import type {
  G1Scope,
  VerifiedG1SpendApproval,
} from './s33-g1-spend-approval.mjs';

const headSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const imageDigest = `sha256:${'c'.repeat(64)}`;
const corpusDigest = `sha256:${'d'.repeat(64)}`;
const approvalDigest = `sha256:${'e'.repeat(64)}`;
const controlRef = 'abcdefghijklmnopqrst';
const tunedRef = 'bcdefghijklmnopqrstu';
const authorizationTime = '2026-07-16T18:00:00.000Z';
const continuationAuthorizationTime = '2026-07-17T13:44:30.000Z';
const continuationApprovalExpiresAt = '2026-07-20T04:00:00.000Z';
const controllerHeadSha = '4'.repeat(40);
const controllerTreeSha = '5'.repeat(40);
const parentReceiptId = 'g1-paired-start:parent-authority:parent-soak:parent-lease';
const parentReceiptGeneration = '1784254529424380';
const parentReceiptSha256 = `sha256:${'2'.repeat(64)}`;
const parentReceiptUri =
  `gs://arkova1-s33-immutable-authority-ledger/s33/g1/paired-start-receipts/${'1'.repeat(64)}.json`;
const parentControlStartedAt = '2026-07-17T02:15:27.158Z';
const parentTunedStartedAt = '2026-07-17T02:15:27.166Z';

const scope = {
  rigClass: 'RIG-G1' as const,
  rigName: 's33-g1',
  rigProfile: 'gemini' as const,
  soakId: 'soak-s33-g1',
  rigId: 'RIG-G1' as const,
  leaseId: 'lease-s33-g1',
  corpusDigest,
  endpointId: '733001' as const,
  endpointResource: G1_PAIRED_START_CONTRACT.tuned.endpoint,
  endpointDisplayName: 'arkova-s33-rig-g1-b-tuned-v6',
  vertexModelResource: G1_PAIRED_START_CONTRACT.tuned.modelVersion,
  checkpointId: '6' as const,
  deployedModelId: '7330011' as const,
  deployedModelDisplayName: 'arkova-s33-rig-g1-b-tuned-v6',
  deploymentResourcesMode: 'TUNED_GEMINI_AUTOMATIC_RESOURCES' as const,
  minReplicaCount: 1 as const,
  maxReplicaCount: 1 as const,
  controlRuntimeServiceAccount: G1_PAIRED_START_CONTRACT.control.runtimeServiceAccount,
  tunedRuntimeServiceAccount: G1_PAIRED_START_CONTRACT.tuned.runtimeServiceAccount,
  controlService: G1_PAIRED_START_CONTRACT.control.service,
  tunedService: G1_PAIRED_START_CONTRACT.tuned.service,
  controlProjectName: G1_PAIRED_START_CONTRACT.control.projectName,
  tunedProjectName: G1_PAIRED_START_CONTRACT.tuned.projectName,
  controlSupabaseUrlSecret: 'supabase-url-s33-g1-a-staging@1' as const,
  controlSupabaseServiceRoleSecret: 'supabase-service-role-key-s33-g1-a-staging@1' as const,
  tunedSupabaseUrlSecret: 'supabase-url-s33-g1-b-staging@1' as const,
  tunedSupabaseServiceRoleSecret: 'supabase-service-role-key-s33-g1-b-staging@1' as const,
  controlRunId: 's33-g1-control-v6',
  tunedRunId: 's33-g1-tuned-v6',
  controlQueue: 's33-g1-control-queue',
  tunedQueue: 's33-g1-tuned-queue',
  pairedCadenceMaxMin: 30 as const,
  secretReferences: {
    stripeSecretKey: 'stripe-secret-key-staging@1' as const,
    stripeWebhookSecret: 'stripe-webhook-secret-staging@1' as const,
    apiKeyHmacSecret: 'api-key-hmac-secret-staging@1' as const,
    cronSecret: 'cron-secret@1' as const,
    geminiApiKey: 'gemini-api-key@2' as const,
  },
  immutableLedger: {
    backend: 'gcs-if-generation-match-0-locked-retention',
    bucket: 'arkova1-s33-immutable-authority-ledger',
    projectId: 'arkova1',
    requiresPerObjectRetention: true,
  },
} satisfies G1Scope;

const continuationScope = {
  schemaVersion: G1_PAIRED_START_CONTRACT.bindingContinuation.schemaVersion,
  parentReceiptId,
  parentReceiptUri,
  parentReceiptGeneration,
  parentReceiptSha256,
  parentControlStartedAt,
  parentTunedStartedAt,
  parentEarliestStartedAt: parentControlStartedAt,
  parentLatestStartedAt: parentTunedStartedAt,
  candidateTreeSha: treeSha,
  controllerHeadSha,
  controllerTreeSha,
  launchNotBefore: '2026-07-17T13:44:00.000Z',
  launchNotAfter: '2026-07-17T14:00:00.000Z',
  parentWorkerUptimeMin: G1_PAIRED_START_CONTRACT.bindingContinuation.parentWorkerUptimeMin,
  continuationWorkerUptimeMin: G1_PAIRED_START_CONTRACT.bindingContinuation.workerUptimeMin,
  continuationWallMin: G1_PAIRED_START_CONTRACT.bindingContinuation.wallMin,
  combinedRequiredWorkerUptimeMin:
    G1_PAIRED_START_CONTRACT.bindingContinuation.combinedRequiredWorkerUptimeMin,
  combinedRequiredWallMin:
    G1_PAIRED_START_CONTRACT.bindingContinuation.combinedRequiredWallMin,
} satisfies S33G1ContinuationScope;

function arm(rigId: 'RIG-G1-A' | 'RIG-G1-B') {
  const control = rigId === 'RIG-G1-A';
  return {
    rig_id: rigId,
    arm: control ? 'public_control' : 'tuned_v6',
    supabase_project_name: control ? scope.controlProjectName : scope.tunedProjectName,
    supabase_project_ref: control ? controlRef : tunedRef,
    service: control ? scope.controlService : scope.tunedService,
    runtime_service_account: control
      ? scope.controlRuntimeServiceAccount
      : scope.tunedRuntimeServiceAccount,
    runtime_service_account_unique_id: control ? '10001' : '10002',
    revision: control ? 'g1-a-00001' : 'g1-b-00001',
    url: control ? 'https://g1-a.example.run.app' : 'https://g1-b.example.run.app',
    run_id: control ? scope.controlRunId : scope.tunedRunId,
    queue: control ? scope.controlQueue : scope.tunedQueue,
    queue_binding: 'external_harness',
    clean_mirror: {
      artifact: control ? 'docs/staging/s33-g1/a.json' : 'docs/staging/s33-g1/b.json',
      attestation_id: `sha256:${control ? '1' : '2'}`.padEnd(71, control ? '1' : '2'),
      verified_at: '2026-07-16T17:30:00.000Z',
    },
    vertex_endpoint: control ? null : {
      resource: G1_PAIRED_START_CONTRACT.tuned.endpoint,
      model_version_resource: G1_PAIRED_START_CONTRACT.tuned.modelVersion,
      checkpoint_id: '6',
      deployed_model_id: '7330011',
    },
    authenticated_capability_probe: {
      status: control ? 'NOT_APPLICABLE' : 'PASSED_PRECLOCK_NO_CUSTOMER_DATA',
    },
  };
}

function embeddedApproval(role: 'founder' | 'cto' = 'cto') {
  return {
    status: 'VERIFIED' as const,
    approvalId: 'approval-s33-g1-001',
    canonicalSha256: approvalDigest,
    approverIdentity: G1_PAIRED_START_CONTRACT.ctoIdentity,
    approverRole: role,
    candidateSourceHeadSha: headSha,
    candidateImageDigest: imageDigest,
    expiresAt: '2026-07-17T18:00:00.000Z',
    scope,
  };
}

function embeddedContinuationApproval(expiresAt = continuationApprovalExpiresAt) {
  return {
    ...embeddedApproval(),
    approvalId: 'approval-s33-g1-cont-001',
    expiresAt,
    scope: { ...scope, continuation: continuationScope },
  };
}

function admission() {
  return {
    schema_version: 2 as const,
    kind: 'isolated_rig_admission' as const,
    generated_at: '2026-07-16T17:45:00.000Z',
    rig_name: 's33-g1' as const,
    rig_id: 'RIG-G1' as const,
    profile: 'gemini' as const,
    soak_id: scope.soakId,
    lease_id: scope.leaseId,
    gcp_project_id: 'arkova1' as const,
    tier: 'T2' as const,
    required_uptime_min: 720,
    required_wall_min: 750,
    sha: headSha,
    declared_source_head: headSha,
    source_head_image_digest: imageDigest,
    image_digest: imageDigest,
    deployed_image_digest: imageDigest,
    deployed_source_head: headSha,
    preflight_result: 'environment_type=clean_mirror_pair' as const,
    g1: {
      corpus_digest: corpusDigest,
      tier: 'T2' as const,
      paired_cadence_max_min: 30 as const,
      execution_state: 'PAUSED' as const,
      background_execution: 'disabled' as const,
      actual_soak_clock: {
        status: 'DEFERRED_CTO_AUTHORITY' as const,
        deployment_timestamps_are_soak_clocks: false as const,
      },
      spend_approval: embeddedApproval(),
      shared_inputs: { image: `repo/worker@${imageDigest}`, corpus_digest: corpusDigest },
      arms: [arm('RIG-G1-A'), arm('RIG-G1-B')],
    },
  };
}

function continuationAdmission(expiresAt = continuationApprovalExpiresAt) {
  const value = admission();
  return {
    ...value,
    generated_at: continuationAuthorizationTime,
    g1: {
      ...value.g1,
      spend_approval: embeddedContinuationApproval(expiresAt),
    },
  };
}

function verifiedApproval(role: 'founder' | 'cto' = 'cto'): VerifiedG1SpendApproval {
  return {
    ...embeddedApproval(role),
    sourceReference: 'ari:cloud:confluence:tenant:page/123',
    immutableRevisionId: 'revision-42',
    authorityRosterRootSha256: `sha256:${'f'.repeat(64)}`,
    isolatedSupabaseProjectCount: 4,
    isolatedSupabaseProjectMonthlyEachUsd: 10,
    isolatedSupabaseProjectsMonthlyTotalUsd: 40,
    g1VariableComputeModelCapUsd: 120,
    s33TotalCapUsd: 200,
    ownerIdentity: 'lane-4-sm',
    raci: {
      responsibleIdentity: 'lane-4-sm',
      accountableIdentity: G1_PAIRED_START_CONTRACT.ctoIdentity,
      consultedIdentities: ['cto'],
      informedIdentities: ['rte'],
    },
    approvalVerifiedAt: authorizationTime,
    verifierIdentity: 'arkova.s33.verifier.public-ed25519.v1',
    verificationMethod: 'ed25519-pinned-authority-roster',
    runtimeVerifiedAt: authorizationTime,
    trustRootKeyId: 'arkova.s33.g1-spend.ed25519.v1',
    trustRootKeyFingerprint: 'f'.repeat(64),
    authorityActivatedAtUtc: '2026-07-16T13:52:06Z',
  };
}

function continuationVerifiedApproval(
  expiresAt = continuationApprovalExpiresAt,
): VerifiedG1SpendApproval {
  return {
    ...verifiedApproval(),
    ...embeddedContinuationApproval(expiresAt),
    approvalVerifiedAt: continuationAuthorizationTime,
    runtimeVerifiedAt: continuationAuthorizationTime,
  };
}

function parentReceipt() {
  return {
    schemaVersion: G1_PAIRED_START_CONTRACT.schemaVersion,
    receiptId: parentReceiptId,
    candidateHeadSha: headSha,
    candidateTreeSha: treeSha,
    imageDigest,
    corpusDigest,
    earliestStartedAt: parentControlStartedAt,
    latestStartedAt: parentTunedStartedAt,
    arms: [
      { rigId: 'RIG-G1-A' as const, startedAt: parentControlStartedAt },
      { rigId: 'RIG-G1-B' as const, startedAt: parentTunedStartedAt },
    ],
  };
}

function observed(input: S33G1AdmissionArm): S33G1ObservedArm {
  return {
    rigId: input.rig_id,
    supabaseProjectName: input.supabase_project_name,
    supabaseProjectRef: input.supabase_project_ref,
    service: input.service,
    runtimeServiceAccount: input.runtime_service_account,
    runtimeServiceAccountUniqueId: input.runtime_service_account_unique_id,
    revision: input.revision,
    url: input.url,
    imageDigest,
    sourceHeadSha: headSha,
    cleanMirrorAttestationId: input.clean_mirror.attestation_id,
    runId: input.run_id,
    queue: input.queue,
  };
}

function started(input: S33G1AdmissionArm, at: string): S33G1ArmStartObservation {
  return {
    rigId: input.rig_id,
    runId: input.run_id,
    queue: input.queue,
    sessionIdentity: `session-${input.rig_id.toLowerCase()}`,
    startedAt: at,
    evidencePath: `docs/staging/s33-g1/${input.run_id}.json`,
    logPath: `docs/staging/s33-g1/${input.run_id}.log`,
  };
}

function preclockReady(
  input: S33G1AdmissionArm,
  at: string = authorizationTime,
): S33G1PreclockReadiness {
  const control = input.rig_id === 'RIG-G1-A';
  const identities = Array.from({ length: 4 }, (_, index) => ({
    userId: `${control ? '11111111-1111-4111-8111-11111111111' : '22222222-2222-4222-8222-22222222222'}${index + 1}`,
    label: `${control ? 'g1-a' : 'g1-b'}-user-${index + 1}`,
    initialSessionEstablishedAt: at,
    refreshRotationVerifiedAt: at,
  }));
  return {
    status: 'PRECLOCK_AUTH_READY',
    rigId: input.rig_id,
    supabaseProjectRef: input.supabase_project_ref,
    service: input.service,
    revision: input.revision,
    url: input.url,
    imageDigest,
    sourceHeadSha: headSha,
    runtimeServiceAccount: input.runtime_service_account,
    appBoundary: {
      route: '/api/v1/ai/template',
      cloudRunIngress: 'ALLOW_UNAUTHENTICATED_APP_AUTH_REQUIRED',
      unauthenticatedHttpStatus: 401,
      invalidBearerHttpStatus: 401,
      validExactUserHttpStatus: 200,
      validExactUserId: identities[0]!.userId,
    },
    sessionPool: {
      minimumRequired: 4,
      secretPersistence: 'NONE',
      refreshRotationCount: identities.length,
      identities,
    },
    verifiedAt: at,
  };
}

function port(overrides: Partial<S33G1PairedStartPort> = {}) {
  let receipt: S33G1PairedStartReceipt | null = null;
  const base: S33G1PairedStartPort = {
    now: () => new Date(authorizationTime),
    verifySignedApproval: () => verifiedApproval(),
    resolveCandidateTreeSha: async () => treeSha,
    observeArm: async (input) => observed(input),
    prepareArm: async ({ arm: input }) => preclockReady(input),
    startArm: async ({ arm: input }) => started(
      input,
      input.rig_id === 'RIG-G1-A'
        ? '2026-07-16T18:01:00.000Z'
        : '2026-07-16T18:06:00.000Z',
    ),
    stopArm: vi.fn(async () => undefined),
    cleanupArmPreparation: vi.fn(async () => undefined),
    loadStartReceipt: async () => receipt,
    persistStartReceipt: async (value) => { receipt = structuredClone(value); },
    ...overrides,
  };
  return base;
}

function continuationPort(overrides: Partial<S33G1PairedStartPort> = {}) {
  return port({
    now: () => new Date(continuationAuthorizationTime),
    verifySignedApproval: () => continuationVerifiedApproval(),
    prepareArm: async ({ arm: input }) => preclockReady(input, continuationAuthorizationTime),
    startArm: async ({ arm: input }) => started(
      input,
      input.rig_id === 'RIG-G1-A'
        ? '2026-07-17T13:45:00.000Z'
        : '2026-07-17T13:45:00.008Z',
    ),
    observeControllerProvenance: async () => ({ headSha: controllerHeadSha, treeSha: controllerTreeSha }),
    loadStartReceiptArtifact: async () => ({
      uri: parentReceiptUri,
      generation: parentReceiptGeneration,
      sha256: parentReceiptSha256,
      receipt: parentReceipt(),
    }),
    ...overrides,
  });
}

const confirmation = 'START_G1:approval-s33-g1-001:soak-s33-g1:lease-s33-g1';
const continuationConfirmation =
  'START_G1:approval-s33-g1-cont-001:soak-s33-g1:lease-s33-g1';

describe('RIG-G1 paired-start admission', () => {
  it('binds the exact SHA/image/corpus and two distinct physical/run identities', () => {
    const value = validateS33G1PairedStartAdmission(admission());
    expect(value.g1.arms.map((item) => item.rig_id)).toEqual(['RIG-G1-A', 'RIG-G1-B']);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.g1.arms)).toBe(true);
  });

  it.each([
    ['source SHA', (value: ReturnType<typeof admission>) => { value.deployed_source_head = '9'.repeat(40); }],
    ['image digest', (value: ReturnType<typeof admission>) => { value.deployed_image_digest = `sha256:${'9'.repeat(64)}`; }],
    ['corpus digest', (value: ReturnType<typeof admission>) => { value.g1.corpus_digest = `sha256:${'9'.repeat(64)}`; }],
    ['project ref', (value: ReturnType<typeof admission>) => { value.g1.arms[1].supabase_project_ref = controlRef; }],
    ['run id', (value: ReturnType<typeof admission>) => { value.g1.arms[1].run_id = scope.controlRunId; }],
    ['queue', (value: ReturnType<typeof admission>) => { value.g1.arms[1].queue = scope.controlQueue; }],
    ['runtime identity', (value: ReturnType<typeof admission>) => { value.g1.arms[1].runtime_service_account = scope.controlRuntimeServiceAccount; }],
  ])('rejects %s substitution before observation/start', (_label, mutate) => {
    const value = admission();
    mutate(value);
    expect(() => validateS33G1PairedStartAdmission(value)).toThrow(/exact|distinct|identity|scope|digest/i);
  });
});

describe('RIG-G1 paired-start driver', () => {
  it('starts both arms concurrently and returns only after exact durable receipt reload', async () => {
    const adapter = port();
    const result = await runS33G1PairedStartDriver(admission(), '<signed-envelope>', confirmation, adapter);
    expect(result.status).toBe('PAIRED_SOAK_STARTED');
    expect(result.receipt).toMatchObject({
      candidateHeadSha: headSha,
      candidateTreeSha: treeSha,
      imageDigest,
      corpusDigest,
      startSkewMs: 5 * 60_000,
      maxStartSkewMs: 30 * 60_000,
    });
    expect(result.receipt.arms.map((item) => item.rigId)).toEqual(['RIG-G1-A', 'RIG-G1-B']);
    expect(result.receipt.preclockReadiness.map((item) => ({
      rigId: item.rigId,
      identityCount: item.sessionPool.identities.length,
      refreshRotationCount: item.sessionPool.refreshRotationCount,
    }))).toEqual([
      { rigId: 'RIG-G1-A', identityCount: 4, refreshRotationCount: 4 },
      { rigId: 'RIG-G1-B', identityCount: 4, refreshRotationCount: 4 },
    ]);
    expect(JSON.stringify(result.receipt)).not.toMatch(/"(?:accessToken|refreshToken|password|serviceRoleKey)"/u);
    expect(Object.isFrozen(result.receipt)).toBe(true);
  });

  it('reloads the exact immutable parent and persists a gap-free continuation receipt', async () => {
    const loadStartReceiptArtifact = vi.fn(async () => ({
      uri: parentReceiptUri,
      generation: parentReceiptGeneration,
      sha256: parentReceiptSha256,
      receipt: parentReceipt(),
    }));
    const result = await runS33G1PairedStartDriver(
      continuationAdmission(),
      '<signed-continuation-envelope>',
      continuationConfirmation,
      continuationPort({ loadStartReceiptArtifact }),
    );
    expect(loadStartReceiptArtifact).toHaveBeenCalledWith(parentReceiptId, parentReceiptGeneration);
    expect(result.receipt.continuation).toMatchObject({
      schemaVersion: G1_PAIRED_START_CONTRACT.bindingContinuation.schemaVersion,
      parentReceiptId,
      parentReceiptUri,
      parentReceiptGeneration,
      parentReceiptSha256,
      controllerHeadSha,
      controllerTreeSha,
      continuationWorkerUptimeMin: 2_195,
      continuationWallMin: 2_225,
    });
    for (const evidence of result.receipt.continuation!.arms) {
      expect(evidence.overlapMs).toBeGreaterThan(0);
      expect(evidence.combinedWorkerUptimeMin).toBeGreaterThanOrEqual(2_880);
      expect(evidence.combinedWallMin).toBeGreaterThanOrEqual(2_910);
    }
    expect(Object.isFrozen(result.receipt.continuation)).toBe(true);
  });

  it('rejects immutable-parent or controller substitution before either arm starts', async () => {
    const parentStart = vi.fn();
    await expect(runS33G1PairedStartDriver(
      continuationAdmission(),
      'signed',
      continuationConfirmation,
      continuationPort({
        loadStartReceiptArtifact: async () => ({
          uri: parentReceiptUri,
          generation: parentReceiptGeneration,
          sha256: `sha256:${'9'.repeat(64)}`,
          receipt: parentReceipt(),
        }),
        startArm: parentStart,
      }),
    )).rejects.toThrow(/immutable parent artifact/i);
    expect(parentStart).not.toHaveBeenCalled();

    const controllerStart = vi.fn();
    await expect(runS33G1PairedStartDriver(
      continuationAdmission(),
      'signed',
      continuationConfirmation,
      continuationPort({
        observeControllerProvenance: async () => ({
          headSha: '9'.repeat(40),
          treeSha: controllerTreeSha,
        }),
        startArm: controllerStart,
      }),
    )).rejects.toThrow(/controller provenance/i);
    expect(controllerStart).not.toHaveBeenCalled();
  });

  it('rejects parent receipt content substitution before either arm starts', async () => {
    const startArm = vi.fn();
    await expect(runS33G1PairedStartDriver(
      continuationAdmission(),
      'signed',
      continuationConfirmation,
      continuationPort({
        loadStartReceiptArtifact: async () => ({
          uri: parentReceiptUri,
          generation: parentReceiptGeneration,
          sha256: parentReceiptSha256,
          receipt: { ...parentReceipt(), candidateTreeSha: '9'.repeat(40) },
        }),
        startArm,
      }),
    )).rejects.toThrow(/parent receipt content/i);
    expect(startArm).not.toHaveBeenCalled();
  });

  it('contains both arms if actual continuation starts miss the signed overlap window', async () => {
    const stopArm = vi.fn(async () => undefined);
    const cleanupArmPreparation = vi.fn(async () => undefined);
    await expect(runS33G1PairedStartDriver(
      continuationAdmission(),
      'signed',
      continuationConfirmation,
      continuationPort({
        startArm: async ({ arm: input }) => started(
          input,
          input.rig_id === 'RIG-G1-A'
            ? '2026-07-17T14:00:00.001Z'
            : '2026-07-17T14:00:00.009Z',
        ),
        stopArm,
        cleanupArmPreparation,
      }),
    )).rejects.toThrow(/gap-free overlap window/i);
    expect(stopArm).toHaveBeenCalledTimes(2);
    expect(cleanupArmPreparation).toHaveBeenCalledTimes(2);
  });

  it('rejects insufficient continuation authority TTL before either arm starts', async () => {
    const expiresAt = '2026-07-19T03:00:00.000Z';
    const startArm = vi.fn();
    await expect(runS33G1PairedStartDriver(
      continuationAdmission(expiresAt),
      'signed',
      continuationConfirmation,
      continuationPort({
        verifySignedApproval: () => continuationVerifiedApproval(expiresAt),
        startArm,
      }),
    )).rejects.toThrow(/expires.*wall time/i);
    expect(startArm).not.toHaveBeenCalled();
  });

  it('cleans both arm preparations and starts neither arm when one preparation fails', async () => {
    const cleanupArmPreparation = vi.fn(async () => undefined);
    const startArm = vi.fn();
    const adapter = port({
      prepareArm: async ({ arm: input }) => {
        if (input.rig_id === 'RIG-G1-B') throw new Error('tuned auth preparation failed');
        return preclockReady(input);
      },
      cleanupArmPreparation,
      startArm,
    });
    await expect(runS33G1PairedStartDriver(admission(), 'signed', confirmation, adapter))
      .rejects.toThrow(/tuned auth preparation failed/i);
    expect(startArm).not.toHaveBeenCalled();
    expect(cleanupArmPreparation).toHaveBeenCalledTimes(2);
  });

  it('rejects an undersized refresh-verified pool before either arm starts and cleans both pools', async () => {
    const cleanupArmPreparation = vi.fn(async () => undefined);
    const startArm = vi.fn();
    const adapter = port({
      prepareArm: async ({ arm: input }) => {
        const readiness = preclockReady(input);
        return {
          ...readiness,
          sessionPool: {
            ...readiness.sessionPool,
            refreshRotationCount: 3,
            identities: readiness.sessionPool.identities.slice(0, 3),
          },
        } as S33G1PreclockReadiness;
      },
      cleanupArmPreparation,
      startArm,
    });
    await expect(runS33G1PairedStartDriver(admission(), 'signed', confirmation, adapter))
      .rejects.toThrow(/at least 4|too small|sessionPool/i);
    expect(startArm).not.toHaveBeenCalled();
    expect(cleanupArmPreparation).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['physical binding drift', (value: S33G1PreclockReadiness) => ({ ...value, revision: 'shadow-revision' })],
    ['refresh rotation before the initial session', (value: S33G1PreclockReadiness) => ({
      ...value,
      sessionPool: {
        ...value.sessionPool,
        identities: value.sessionPool.identities.map((identity, index) => index === 0 ? {
          ...identity,
          initialSessionEstablishedAt: '2026-07-16T18:00:01.000Z',
          refreshRotationVerifiedAt: authorizationTime,
        } : identity),
      },
    })],
  ])('rejects %s in pre-clock evidence before start and cleans both pools', async (_label, mutate) => {
    const cleanupArmPreparation = vi.fn(async () => undefined);
    const startArm = vi.fn();
    const adapter = port({
      prepareArm: async ({ arm: input }) => mutate(preclockReady(input)) as S33G1PreclockReadiness,
      cleanupArmPreparation,
      startArm,
    });
    await expect(runS33G1PairedStartDriver(admission(), 'signed', confirmation, adapter))
      .rejects.toThrow(/physical binding|refresh|session|authority window/i);
    expect(startArm).not.toHaveBeenCalled();
    expect(cleanupArmPreparation).toHaveBeenCalledTimes(2);
  });

  it('requires a CTO-role signature and the exact explicit start confirmation', async () => {
    const founder = port({
      verifySignedApproval: () => verifiedApproval('founder'),
    });
    await expect(runS33G1PairedStartDriver(admission(), 'signed', confirmation, founder))
      .rejects.toThrow(/CTO-signed/i);
    await expect(runS33G1PairedStartDriver(admission(), 'signed', 'START_G1:no', port()))
      .rejects.toThrow(/exact CTO confirmation/i);
  });

  it('rejects stale receipt replay and live physical identity drift before start', async () => {
    const stale = port({ loadStartReceipt: async () => ({ existing: true }) });
    await expect(runS33G1PairedStartDriver(admission(), 'signed', confirmation, stale))
      .rejects.toThrow(/already exists|replay/i);

    const startArm = vi.fn();
    const drift = port({
      observeArm: async (input) => ({ ...observed(input), revision: 'shadow-revision' }),
      startArm,
    });
    await expect(runS33G1PairedStartDriver(admission(), 'signed', confirmation, drift))
      .rejects.toThrow(/live observation|physical identity/i);
    expect(startArm).not.toHaveBeenCalled();
  });

  it('stops both started arms when signed 30-minute skew is exceeded', async () => {
    const stopArm = vi.fn(async () => undefined);
    const cleanupArmPreparation = vi.fn(async () => undefined);
    const adapter = port({
      startArm: async ({ arm: input }) => started(
        input,
        input.rig_id === 'RIG-G1-A'
          ? '2026-07-16T18:01:00.000Z'
          : '2026-07-16T18:32:00.001Z',
      ),
      stopArm,
      cleanupArmPreparation,
    });
    await expect(runS33G1PairedStartDriver(admission(), 'signed', confirmation, adapter))
      .rejects.toThrow(/30-minute|skew/i);
    expect(stopArm).toHaveBeenCalledTimes(2);
    expect(cleanupArmPreparation).toHaveBeenCalledTimes(2);
  });

  it('stops a successful sibling when the other arm fails to start', async () => {
    const stopArm = vi.fn(async () => undefined);
    const cleanupArmPreparation = vi.fn(async () => undefined);
    const adapter = port({
      startArm: async ({ arm: input }) => {
        if (input.rig_id === 'RIG-G1-B') throw new Error('tuned start failed');
        return started(input, '2026-07-16T18:01:00.000Z');
      },
      stopArm,
      cleanupArmPreparation,
    });
    await expect(runS33G1PairedStartDriver(admission(), 'signed', confirmation, adapter))
      .rejects.toThrow(/tuned start failed/i);
    expect(stopArm).toHaveBeenCalledOnce();
    expect(cleanupArmPreparation).toHaveBeenCalledTimes(2);
  });

  it('stops both arms if persistence cannot be reloaded exactly', async () => {
    let loads = 0;
    const stopArm = vi.fn(async () => undefined);
    const cleanupArmPreparation = vi.fn(async () => undefined);
    const adapter = port({
      loadStartReceipt: async () => {
        loads += 1;
        return loads === 1 ? null : { corrupted: true };
      },
      persistStartReceipt: async () => undefined,
      stopArm,
      cleanupArmPreparation,
    });
    await expect(runS33G1PairedStartDriver(admission(), 'signed', confirmation, adapter))
      .rejects.toThrow(/durable.*receipt|reload/i);
    expect(stopArm).toHaveBeenCalledTimes(2);
    expect(cleanupArmPreparation).toHaveBeenCalledTimes(2);
  });
});
