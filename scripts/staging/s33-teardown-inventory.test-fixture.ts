import {
  captureS33TeardownInventory,
  verifyS33TeardownCapturedInventories,
} from './s33-teardown-inventory';

export const TEST_TEARDOWN_HEAD_SHA = 'a'.repeat(40);
export const TEST_TEARDOWN_TREE_SHA = 'b'.repeat(40);
export const TEST_TEARDOWN_SCOPE = {
  gcpProjectId: 'arkova1',
  gcpRegion: 'us-central1',
  supabaseOrgId: 'byhkazrpmivhcsuqjtva',
} as const;

export const TEST_PROTECTED_G1_V6_ENDPOINT =
  'projects/arkova1/locations/us-central1/endpoints/6611494259700793344' as const;
export const TEST_ONLY_RIG_R_TARGET_ENDPOINT =
  'projects/arkova1/locations/us-central1/endpoints/9000000000000000001' as const;

const targetBinding = (artifactCharacter: string) => ({
  authority: 'CTO',
  decisionArtifactSha256: `sha256:${artifactCharacter.repeat(64)}`,
  candidateGitHeadSha: TEST_TEARDOWN_HEAD_SHA,
  candidateGitTreeSha: TEST_TEARDOWN_TREE_SHA,
  imageDigestSha256: `sha256:${'f'.repeat(64)}`,
  provisionArtifactSha256: `sha256:${String(Number(artifactCharacter) + 4).repeat(64)}`,
  provisionConfigSha256: `sha256:${String(Number(artifactCharacter) + 6).repeat(64)}`,
  boundAt: '2026-07-16T12:00:00.000Z',
} as const);

const g1Binding = targetBinding('1');
const b1Binding = targetBinding('2');
const testOnlyRigRBinding = targetBinding('3');

export const TEST_TEARDOWN_DECLARATION = {
  schemaVersion: 1,
  kind: 's33-teardown-declaration',
  closeoutId: 's33-rc-2026-07-15',
  gitHeadSha: TEST_TEARDOWN_HEAD_SHA,
  scope: TEST_TEARDOWN_SCOPE,
  rigs: [
    {
      rigId: 'RIG-G1',
      targetBinding: g1Binding,
      supabaseProjectRef: 'abcdefghijklmnopqrst',
      supabaseProjectName: 'arkova-soak-rig-g1',
      cloudRunServiceNames: [
        'arkova-worker-s33-g1-public-staging',
        'arkova-worker-s33-g1-tuned-staging',
      ],
      schedulerJobNames: [],
      queueTargets: [],
      containedLogicalQueueIds: [],
      leaseTargets: [],
      serviceAccountIdentities: [],
      perRigSecrets: [
        { name: 'supabase-url-s33-g1-staging', role: 'SUPABASE_URL' },
        {
          name: 'supabase-service-role-key-s33-g1-staging',
          role: 'SUPABASE_SERVICE_ROLE',
        },
      ],
    },
    {
      rigId: 'RIG-B1',
      targetBinding: b1Binding,
      supabaseProjectRef: 'bcdefghijklmnopqrstu',
      supabaseProjectName: 'arkova-soak-rig-b1',
      cloudRunServiceNames: ['arkova-worker-s33-rig-b1-staging'],
      schedulerJobNames: [
        'arkova-worker-s33-rig-b1-staging-batch-anchors',
        'arkova-worker-s33-rig-b1-staging-check-confirmations',
        'arkova-worker-s33-rig-b1-staging-populate-confirmation-proofs',
        'arkova-worker-s33-rig-b1-staging-org-queue-scheduler',
        'arkova-worker-s33-rig-b1-staging-batch-anchors-forced-flush',
        'arkova-worker-s33-rig-b1-staging-recover-broadcasts',
      ],
      queueTargets: [],
      containedLogicalQueueIds: [],
      leaseTargets: [],
      serviceAccountIdentities: [],
      perRigSecrets: [
        { name: 'supabase-url-s33-rig-b1-staging', role: 'SUPABASE_URL' },
        {
          name: 'supabase-service-role-key-s33-rig-b1-staging',
          role: 'SUPABASE_SERVICE_ROLE',
        },
      ],
    },
    {
      rigId: 'RIG-R',
      // Test-only complete binding. Production must remain null until the CTO
      // supplies the actual RIG-R resource/provision artifacts.
      targetBinding: testOnlyRigRBinding,
      supabaseProjectRef: 'cdefghijklmnopqrstuv',
      supabaseProjectName: 'arkova-soak-s33-r',
      cloudRunServiceNames: ['arkova-worker-s33-r-staging'],
      schedulerJobNames: [],
      queueTargets: [],
      containedLogicalQueueIds: ['ai-rollback', 'chain-fault'],
      leaseTargets: [{
        provider: 'SUPABASE',
        scopeId: 'cdefghijklmnopqrstuv',
        resourceId: 'test-only-rig-r-exclusive-lease',
        role: 'RIG_EXCLUSIVE_LEASE',
      }],
      serviceAccountIdentities: [{
        email: 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
        role: 'RUNTIME',
      }],
      perRigSecrets: [
        { name: 'supabase-url-s33-r-staging', role: 'SUPABASE_URL' },
        {
          name: 'supabase-service-role-key-s33-r-staging',
          role: 'SUPABASE_SERVICE_ROLE',
        },
      ],
    },
  ],
  protectedVertexEndpointResourceNames: [TEST_PROTECTED_G1_V6_ENDPOINT],
  vertexEndpointTargets: [
    {
      resourceName: TEST_ONLY_RIG_R_TARGET_ENDPOINT,
      ownerRigId: 'RIG-R',
      provenance: {
        authority: 'CTO',
        origin: 'S33_ISOLATED_RIG_RESOURCE',
        decisionArtifactSha256: testOnlyRigRBinding.decisionArtifactSha256,
        candidateGitHeadSha: testOnlyRigRBinding.candidateGitHeadSha,
        candidateGitTreeSha: testOnlyRigRBinding.candidateGitTreeSha,
        imageDigestSha256: testOnlyRigRBinding.imageDigestSha256,
        provisionArtifactSha256: testOnlyRigRBinding.provisionArtifactSha256,
        provisionConfigSha256: testOnlyRigRBinding.provisionConfigSha256,
      },
    },
  ],
  protectedSharedSecretNames: ['api-key-hmac-secret-staging', 'stripe-secret-key-staging'],
  protectedNonResourceIdentityIds: ['s33-supervised-operator', 's33-supervised-invoker'],
} as const;

export const TEST_PRE_SOAK_TEARDOWN_DECLARATION = {
  ...TEST_TEARDOWN_DECLARATION,
  rigs: TEST_TEARDOWN_DECLARATION.rigs.map((rig) => rig.rigId === 'RIG-R'
    ? {
        rigId: 'RIG-R' as const,
        targetBinding: null,
        supabaseProjectRef: null,
        supabaseProjectName: null,
        cloudRunServiceNames: [],
        schedulerJobNames: [],
        queueTargets: [],
        containedLogicalQueueIds: [],
        leaseTargets: [],
        serviceAccountIdentities: [],
        perRigSecrets: [],
      }
    : rig),
  vertexEndpointTargets: [],
} as const;

const targetSupabaseProjects = TEST_TEARDOWN_DECLARATION.rigs.map((rig) => ({
  ref: rig.supabaseProjectRef,
  name: rig.supabaseProjectName,
  ownerRigId: rig.rigId,
}));
const targetCloudRunServices = TEST_TEARDOWN_DECLARATION.rigs.flatMap((rig) =>
  rig.cloudRunServiceNames.map((name) => ({
    name,
    projectId: TEST_TEARDOWN_SCOPE.gcpProjectId,
    region: TEST_TEARDOWN_SCOPE.gcpRegion,
    ownerRigId: rig.rigId,
  })),
);
const targetSchedulerJobs = TEST_TEARDOWN_DECLARATION.rigs.flatMap((rig) =>
  rig.schedulerJobNames.map((name) => ({
    name,
    projectId: TEST_TEARDOWN_SCOPE.gcpProjectId,
    location: TEST_TEARDOWN_SCOPE.gcpRegion,
    targetService: rig.cloudRunServiceNames[0],
    ownerRigId: rig.rigId,
  })),
);
const targetSecrets = TEST_TEARDOWN_DECLARATION.rigs.flatMap((rig) => (
  rig.perRigSecrets.map((secret) => ({
    ...secret,
    projectId: TEST_TEARDOWN_SCOPE.gcpProjectId,
    ownerRigId: rig.rigId,
    configurationDigestSha256: `sha256:${'8'.repeat(64)}`,
    iamPolicyDigestSha256: `sha256:${'9'.repeat(64)}`,
  }))
));
const rigR = TEST_TEARDOWN_DECLARATION.rigs.find(({ rigId }) => rigId === 'RIG-R')!;
const targetContainedLogicalQueues = rigR.containedLogicalQueueIds.map((queueId) => ({
  queueId,
  supabaseProjectRef: rigR.supabaseProjectRef,
  ownerRigId: rigR.rigId,
}));
const targetServiceAccounts = rigR.serviceAccountIdentities.map((account) => ({
  ...account,
  projectId: TEST_TEARDOWN_SCOPE.gcpProjectId,
  ownerRigId: rigR.rigId,
  configurationDigestSha256: `sha256:${'a'.repeat(64)}`,
  iamPolicyDigestSha256: `sha256:${'b'.repeat(64)}`,
}));

const protectedNonResourceDispositions = [
  {
    identityId: 's33-supervised-operator',
    identityClass: 'SUPERVISED_OPERATOR',
    disposition: 'PROTECTED_PREEXISTING',
    configurationDigestSha256: `sha256:${'c'.repeat(64)}`,
    iamPolicyDigestSha256: `sha256:${'d'.repeat(64)}`,
  },
  {
    identityId: 's33-supervised-invoker',
    identityClass: 'SUPERVISED_INVOKER',
    disposition: 'PROTECTED_PREEXISTING',
    configurationDigestSha256: `sha256:${'e'.repeat(64)}`,
    iamPolicyDigestSha256: `sha256:${'f'.repeat(64)}`,
  },
] as const;

export function testTeardownBeforeInventory(
  capturedAt = '2026-07-16T13:00:00.000Z',
) {
  return {
    schemaVersion: 1,
    kind: 's33-teardown-inventory',
    closeoutId: TEST_TEARDOWN_DECLARATION.closeoutId,
    gitHeadSha: TEST_TEARDOWN_HEAD_SHA,
    phase: 'before',
    capturedAt,
    scope: TEST_TEARDOWN_SCOPE,
    resources: {
      supabaseProjects: [
        ...targetSupabaseProjects,
        { ref: 'zabcdefghijklmnopqrs', name: 'protected-shared-project', ownerRigId: null },
      ],
      cloudRunServices: [
        ...targetCloudRunServices,
        {
          name: 'protected-shared-service',
          projectId: TEST_TEARDOWN_SCOPE.gcpProjectId,
          region: TEST_TEARDOWN_SCOPE.gcpRegion,
          ownerRigId: null,
        },
      ],
      schedulerJobs: [
        ...targetSchedulerJobs,
        {
          name: 'protected-shared-job',
          projectId: TEST_TEARDOWN_SCOPE.gcpProjectId,
          location: TEST_TEARDOWN_SCOPE.gcpRegion,
          targetService: 'protected-shared-service',
          ownerRigId: null,
        },
      ],
      vertexEndpoints: [
        {
          resourceName: TEST_ONLY_RIG_R_TARGET_ENDPOINT,
          displayName: 'test-only-rig-r-endpoint',
          location: TEST_TEARDOWN_SCOPE.gcpRegion,
          deployedModelIds: ['test-only-rig-r-model'],
          ownerRigId: 'RIG-R',
          configurationDigestSha256: `sha256:${'1'.repeat(64)}`,
          iamPolicyDigestSha256: `sha256:${'2'.repeat(64)}`,
        },
        {
          resourceName: TEST_PROTECTED_G1_V6_ENDPOINT,
          displayName: 'rig-r-v6',
          location: TEST_TEARDOWN_SCOPE.gcpRegion,
          deployedModelIds: ['model-rig-r'],
          ownerRigId: null,
          configurationDigestSha256: `sha256:${'3'.repeat(64)}`,
          iamPolicyDigestSha256: `sha256:${'4'.repeat(64)}`,
        },
        {
          resourceName: 'projects/arkova1/locations/us-central1/endpoints/1000000000000000001',
          displayName: 'protected-shared-endpoint',
          location: TEST_TEARDOWN_SCOPE.gcpRegion,
          deployedModelIds: [],
          ownerRigId: null,
          configurationDigestSha256: `sha256:${'5'.repeat(64)}`,
          iamPolicyDigestSha256: `sha256:${'6'.repeat(64)}`,
        },
      ],
      queues: [],
      containedLogicalQueues: targetContainedLogicalQueues,
      leases: [{
        ...rigR.leaseTargets[0],
        ownerRigId: 'RIG-R',
        state: 'ACTIVE',
        acquiredAt: new Date(Date.parse(capturedAt) - 10 * 60_000).toISOString(),
        releasedAt: null,
        expiresAt: new Date(Date.parse(capturedAt) + 5 * 60_000).toISOString(),
      }],
      serviceAccounts: targetServiceAccounts,
      secretNames: [
        ...targetSecrets,
        ...TEST_TEARDOWN_DECLARATION.protectedSharedSecretNames.map((name) => ({
          name,
          role: 'SHARED_PREEXISTING' as const,
          projectId: TEST_TEARDOWN_SCOPE.gcpProjectId,
          ownerRigId: null,
          configurationDigestSha256: `sha256:${'7'.repeat(64)}`,
          iamPolicyDigestSha256: `sha256:${'8'.repeat(64)}`,
        })),
        {
          name: 'protected-unrelated-secret',
          role: 'SHARED_PREEXISTING',
          projectId: TEST_TEARDOWN_SCOPE.gcpProjectId,
          ownerRigId: null,
          configurationDigestSha256: `sha256:${'9'.repeat(64)}`,
          iamPolicyDigestSha256: `sha256:${'a'.repeat(64)}`,
        },
      ],
      protectedNonResourceDispositions,
    },
  } as const;
}

export function testTeardownAfterInventory(
  capturedAt = '2026-07-16T13:10:00.000Z',
  beforeCapturedAt = '2026-07-16T13:00:00.000Z',
) {
  const before = testTeardownBeforeInventory(beforeCapturedAt);
  return {
    ...before,
    phase: 'after',
    capturedAt,
    resources: {
      supabaseProjects: [before.resources.supabaseProjects.at(-1)!],
      cloudRunServices: [before.resources.cloudRunServices.at(-1)!],
      schedulerJobs: [before.resources.schedulerJobs.at(-1)!],
      vertexEndpoints: before.resources.vertexEndpoints.slice(1),
      queues: [],
      containedLogicalQueues: [],
      leases: before.resources.leases.map((lease) => ({
        ...lease,
        state: 'RELEASED' as const,
        releasedAt: new Date(Date.parse(lease.expiresAt) - 60_000).toISOString(),
      })),
      serviceAccounts: [],
      secretNames: before.resources.secretNames.filter(({ ownerRigId }) => ownerRigId === null),
      protectedNonResourceDispositions: before.resources.protectedNonResourceDispositions,
    },
  } as const;
}

export function testTeardownCaptureMetadata(
  phase: 'before' | 'after',
  overrides: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 'arkova.s33.l2.teardown-capture-metadata/v1',
    gitTreeSha: TEST_TEARDOWN_TREE_SHA,
    operator: {
      operatorId: 'rte-s33-closeout',
      role: 'RTE',
      organization: 'ARKOVA',
    },
    signer: {
      keyId: 'arkova-s33-cto-release-test-only',
      algorithm: 'Ed25519',
      publicKeyFingerprintSha256: `sha256:${'c'.repeat(64)}`,
      detachedSignatureArtifactSha256: `sha256:${phase === 'before' ? 'd' : 'e'}`.padEnd(71, phase === 'before' ? 'd' : 'e'),
      verificationStatus: 'UNVERIFIED_EXTERNAL_ARTIFACT',
      signedAt: phase === 'before'
        ? '2026-07-16T13:01:00.000Z'
        : '2026-07-16T13:11:00.000Z',
    },
    ...overrides,
  };
}

function oneMinuteAfter(value: string): string {
  return new Date(Date.parse(value) + 60_000).toISOString();
}

export function buildTestTeardownCapturedVerification(options: {
  beforeCapturedAt?: string;
  afterCapturedAt?: string;
} = {}) {
  const beforeCapturedAt = options.beforeCapturedAt ?? '2026-07-16T13:00:00.000Z';
  const afterCapturedAt = options.afterCapturedAt ?? '2026-07-16T13:10:00.000Z';
  const beforeMetadata = testTeardownCaptureMetadata('before');
  const afterMetadata = testTeardownCaptureMetadata('after');
  const before = captureS33TeardownInventory(
    TEST_TEARDOWN_DECLARATION,
    testTeardownBeforeInventory(beforeCapturedAt),
    {
      ...beforeMetadata,
      signer: { ...beforeMetadata.signer, signedAt: oneMinuteAfter(beforeCapturedAt) },
    },
  );
  const after = captureS33TeardownInventory(
    TEST_TEARDOWN_DECLARATION,
    testTeardownAfterInventory(afterCapturedAt, beforeCapturedAt),
    {
      ...afterMetadata,
      signer: { ...afterMetadata.signer, signedAt: oneMinuteAfter(afterCapturedAt) },
    },
  );
  return verifyS33TeardownCapturedInventories(
    TEST_TEARDOWN_DECLARATION,
    before,
    after,
  );
}

export function buildTestPreSoakCapturedVerification() {
  const rigR = TEST_TEARDOWN_DECLARATION.rigs.find(({ rigId }) => rigId === 'RIG-R')!;
  const rigRServices = new Set<string>(rigR.cloudRunServiceNames);
  const rigRSchedulers = new Set<string>(rigR.schedulerJobNames);
  const rigRSecrets = new Set<string>(rigR.perRigSecrets.map(({ name }) => name));
  const fullBefore = testTeardownBeforeInventory();
  const partialBefore = {
    ...fullBefore,
    resources: {
      ...fullBefore.resources,
      supabaseProjects: fullBefore.resources.supabaseProjects.filter(
        ({ ref }) => ref !== rigR.supabaseProjectRef,
      ),
      cloudRunServices: fullBefore.resources.cloudRunServices.filter(
        ({ name }) => !rigRServices.has(name),
      ),
      schedulerJobs: fullBefore.resources.schedulerJobs.filter(
        ({ name }) => !rigRSchedulers.has(name),
      ),
      vertexEndpoints: fullBefore.resources.vertexEndpoints.filter(
        ({ resourceName }) => resourceName !== TEST_ONLY_RIG_R_TARGET_ENDPOINT,
      ),
      containedLogicalQueues: [],
      leases: [],
      serviceAccounts: fullBefore.resources.serviceAccounts.filter(
        ({ ownerRigId }) => ownerRigId !== 'RIG-R',
      ),
      secretNames: fullBefore.resources.secretNames.filter(
        ({ name }) => !rigRSecrets.has(name),
      ),
    },
  };
  const before = captureS33TeardownInventory(
    TEST_PRE_SOAK_TEARDOWN_DECLARATION,
    partialBefore,
    testTeardownCaptureMetadata('before'),
  );
  const after = captureS33TeardownInventory(
    TEST_PRE_SOAK_TEARDOWN_DECLARATION,
    {
      ...testTeardownAfterInventory(),
      resources: {
        ...testTeardownAfterInventory().resources,
        leases: [],
      },
    },
    testTeardownCaptureMetadata('after'),
  );
  return verifyS33TeardownCapturedInventories(
    TEST_PRE_SOAK_TEARDOWN_DECLARATION,
    before,
    after,
  );
}
