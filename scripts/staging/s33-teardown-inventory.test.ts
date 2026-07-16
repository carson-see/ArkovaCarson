import { describe, expect, it } from 'vitest';

import {
  S33_TEARDOWN_SCHEMA_VERSION,
  captureS33TeardownInventory,
  requireS33TeardownCapturedVerification,
  verifyS33TeardownCapturedInventories,
  verifyS33TeardownDryRun,
} from './s33-teardown-inventory';
import {
  TEST_TEARDOWN_DECLARATION,
  TEST_TEARDOWN_HEAD_SHA,
  TEST_ONLY_RIG_R_TARGET_ENDPOINT,
  TEST_PRE_SOAK_TEARDOWN_DECLARATION,
  TEST_PROTECTED_G1_V6_ENDPOINT,
  TEST_TEARDOWN_TREE_SHA,
  testTeardownAfterInventory,
  testTeardownBeforeInventory,
  testTeardownCaptureMetadata,
} from './s33-teardown-inventory.test-fixture';

const headSha = TEST_TEARDOWN_HEAD_SHA;
const scope = TEST_TEARDOWN_DECLARATION.scope;
const declaration = TEST_TEARDOWN_DECLARATION;

const targetSupabaseProjects = declaration.rigs.map((rig) => ({
  ref: rig.supabaseProjectRef,
  name: rig.supabaseProjectName,
}));
const targetSchedulerJobs = declaration.rigs.flatMap((rig) =>
  rig.schedulerJobNames.map((name) => ({
    name,
    projectId: scope.gcpProjectId,
    location: scope.gcpRegion,
    targetService: rig.cloudRunServiceNames[0],
  })),
);
const targetSecretNames = declaration.rigs.flatMap(
  (rig) => rig.perRigSecrets.map(({ name }) => name),
);

const before = testTeardownBeforeInventory('2026-07-15T16:00:00.000Z');
const after = testTeardownAfterInventory(
  '2026-07-15T17:00:00.000Z',
  '2026-07-15T16:00:00.000Z',
);

describe('S3.3 teardown inventory dry-run verifier', () => {
  it('strictly verifies the complete named close-out diff without mutation capability', () => {
    const result = verifyS33TeardownDryRun(declaration, before, after);

    expect(S33_TEARDOWN_SCHEMA_VERSION).toBe(1);
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: 's33-teardown-dry-run-verification',
      mode: 'DRY_RUN_VERIFY_ONLY',
      closeoutId: declaration.closeoutId,
      gitHeadSha: headSha,
      verified: true,
      zeroRecurringRigCost: true,
      sharedSecretsUntouched: true,
      mutationsAttempted: 0,
      failures: [],
    });
    expect(result.namedDiffs.supabaseProjects.removed).toEqual(
      targetSupabaseProjects.map(({ ref, name }) => `${name} (${ref})`).sort(),
    );
    expect(result.namedDiffs.vertexEndpoints.removed).toEqual([
      `test-only-rig-r-endpoint (${TEST_ONLY_RIG_R_TARGET_ENDPOINT})`,
    ]);
    expect(result.namedDiffs.schedulerJobs.removed).toHaveLength(targetSchedulerJobs.length);
    expect(result.namedDiffs.secretNames.removed).toEqual([...targetSecretNames].sort());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.namedDiffs)).toBe(true);
    expect(Object.isFrozen(result.namedDiffs.supabaseProjects.removed)).toBe(true);
  });

  it('fails closed on a teardown straggler while retaining the named diff', () => {
    const straggler = before.resources.schedulerJobs[0];
    const result = verifyS33TeardownDryRun(declaration, before, {
      ...after,
      resources: {
        ...after.resources,
        schedulerJobs: [...after.resources.schedulerJobs, straggler],
      },
    });

    expect(result.verified).toBe(false);
    expect(result.zeroRecurringRigCost).toBe(false);
    expect(result.failures.join('\n')).toMatch(/scheduler.*straggler|target.*scheduler/i);
  });

  it('rejects an incomplete RIG-B1 Scheduler target declaration even when the omitted job is unchanged', () => {
    const rigB1 = declaration.rigs.find((rig) => rig.rigId === 'RIG-B1')!;
    const omittedName = rigB1.schedulerJobNames[rigB1.schedulerJobNames.length - 1];
    const omittedJob = before.resources.schedulerJobs.find(({ name }) => name === omittedName)!;
    const incompleteDeclaration = {
      ...declaration,
      rigs: declaration.rigs.map((rig) => rig.rigId === 'RIG-B1'
        ? { ...rig, schedulerJobNames: rig.schedulerJobNames.slice(0, -1) }
        : rig),
    };

    expect(() => verifyS33TeardownDryRun(incompleteDeclaration, before, {
      ...after,
      resources: {
        ...after.resources,
        schedulerJobs: [...after.resources.schedulerJobs, omittedJob],
      },
    })).toThrow(/RIG-B1|six|Scheduler|target|exact/i);
  });

  it('rejects declared Scheduler jobs captured outside the declared location and owning rig service', () => {
    const declaredNames = new Set<string>(declaration.rigs.flatMap((rig) => [...rig.schedulerJobNames]));
    const wrongBefore = {
      ...before,
      resources: {
        ...before.resources,
        schedulerJobs: before.resources.schedulerJobs.map((job) => declaredNames.has(job.name)
          ? { ...job, location: 'europe-west1', targetService: 'unrelated-service' }
          : job),
      },
    };

    expect(() => verifyS33TeardownDryRun(declaration, wrongBefore, after)).toThrow(
      /project|scope|location|region|target|service|Scheduler/i,
    );
  });

  it('rejects an undeclared Scheduler job targeting any declared rig service even when unchanged', () => {
    const targetService = declaration.rigs.find((rig) => rig.rigId === 'RIG-B1')!.cloudRunServiceNames[0];
    const undeclared = {
      name: `${targetService}-undeclared-recurring-job`,
      projectId: scope.gcpProjectId,
      location: scope.gcpRegion,
      targetService,
      ownerRigId: 'RIG-B1' as const,
    };
    const result = verifyS33TeardownDryRun(declaration, {
      ...before,
      resources: {
        ...before.resources,
        schedulerJobs: [...before.resources.schedulerJobs, undeclared],
      },
    }, {
      ...after,
      resources: {
        ...after.resources,
        schedulerJobs: [...after.resources.schedulerJobs, undeclared],
      },
    });

    expect(result.verified).toBe(false);
    expect(result.zeroRecurringRigCost).toBe(false);
    expect(result.failures.join('\n')).toMatch(/undeclared|Scheduler|rig.*service|target/i);
  });

  it('fails when a protected shared secret disappears or unrelated inventory drifts', () => {
    const result = verifyS33TeardownDryRun(declaration, before, {
      ...after,
      resources: {
        ...after.resources,
        secretNames: after.resources.secretNames.filter(
          ({ name }) => name !== 'stripe-secret-key-staging'
            && name !== 'protected-unrelated-secret',
        ),
      },
    });

    expect(result.verified).toBe(false);
    expect(result.sharedSecretsUntouched).toBe(false);
    expect(result.failures.join('\n')).toMatch(/protected shared secret|non-target.*secret/i);
  });

  it('rejects cross-closeout capture identity and non-monotonic capture time', () => {
    expect(() => verifyS33TeardownDryRun(declaration, before, {
      ...after,
      closeoutId: 'different-closeout',
    })).toThrow(/closeout|identity/i);
    expect(() => verifyS33TeardownDryRun(declaration, before, {
      ...after,
      capturedAt: before.capturedAt,
    })).toThrow(/capturedAt|after|time/i);
  });

  it('rejects unknown fields, duplicate keys, and an incomplete three-rig declaration', () => {
    expect(() => verifyS33TeardownDryRun(
      { ...declaration, unknown: true },
      before,
      after,
    )).toThrow(/schema|unrecognized|unknown/i);

    const duplicate = JSON.stringify(before).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    expect(() => verifyS33TeardownDryRun(declaration, duplicate, after)).toThrow(/duplicate/i);

    expect(() => verifyS33TeardownDryRun(
      { ...declaration, rigs: declaration.rigs.slice(0, 2) },
      before,
      after,
    )).toThrow(/RIG-G1|RIG-B1|RIG-R|three|rig/i);
  });

  it('enforces the CTO-bound RIG-R cardinality without guessed managed resources', () => {
    const rigR = declaration.rigs.find(({ rigId }) => rigId === 'RIG-R')!;
    const variants = [
      { ...rigR, supabaseProjectName: 'wrong-rig-r-project' },
      { ...rigR, cloudRunServiceNames: ['wrong-rig-r-service'] },
      { ...rigR, schedulerJobNames: ['forbidden-rig-r-scheduler'] },
      {
        ...rigR,
        queueTargets: [{ provider: 'GCP' as const, scopeId: 'arkova1', resourceId: 'queue-1' }],
      },
      {
        ...rigR,
        serviceAccountIdentities: [{
          email: 's33-rig-r-oidc@arkova1.iam.gserviceaccount.com',
          role: 'OIDC' as const,
        }],
      },
      { ...rigR, leaseTargets: [] },
      { ...rigR, perRigSecrets: rigR.perRigSecrets.slice(0, 1) },
    ];
    for (const invalidRigR of variants) {
      expect(() => verifyS33TeardownDryRun({
        ...declaration,
        rigs: declaration.rigs.map((rig) => rig.rigId === 'RIG-R' ? invalidRigR : rig),
      }, before, after)).toThrow(/RIG-R|queue|lease|runtime|OIDC|secret|project|service|Scheduler/i);
    }
  });

  it('requires exactly one RIG-R-owned provision-bound temporary Vertex endpoint', () => {
    const [target] = declaration.vertexEndpointTargets;
    expect(() => verifyS33TeardownDryRun({
      ...declaration,
      vertexEndpointTargets: [],
    }, before, after)).toThrow(/RIG-R|exactly one|Vertex|endpoint/i);
    expect(() => verifyS33TeardownDryRun({
      ...declaration,
      vertexEndpointTargets: [target, {
        ...target,
        resourceName: 'projects/arkova1/locations/us-central1/endpoints/9000000000000000002',
      }],
    }, before, after)).toThrow(/RIG-R|exactly one|Vertex|endpoint/i);
    expect(() => verifyS33TeardownDryRun({
      ...declaration,
      vertexEndpointTargets: [{
        ...target,
        provenance: {
          ...target.provenance,
          provisionConfigSha256: `sha256:${'0'.repeat(64)}`,
        },
      }],
    }, before, after)).toThrow(/provenance|binding|contradict/i);
  });

  it('binds every rig to one exact candidate head/tree/image identity', () => {
    const rigR = declaration.rigs.find(({ rigId }) => rigId === 'RIG-R')!;
    expect(() => verifyS33TeardownDryRun({
      ...declaration,
      rigs: declaration.rigs.map((rig) => rig.rigId === 'RIG-R'
        ? {
            ...rigR,
            targetBinding: {
              ...rigR.targetBinding,
              candidateGitHeadSha: 'f'.repeat(40),
            },
          }
        : rig),
    }, before, after)).toThrow(/candidate|head|SHA|exact/i);
    expect(() => verifyS33TeardownDryRun({
      ...declaration,
      rigs: declaration.rigs.map((rig) => rig.rigId === 'RIG-R'
        ? {
            ...rigR,
            targetBinding: {
              ...rigR.targetBinding,
              imageDigestSha256: `sha256:${'0'.repeat(64)}`,
            },
          }
        : rig),
    }, before, after)).toThrow(/candidate|image|digest|exact/i);
  });

  it('blocks closure until the exclusive lease is both released and expired', () => {
    const notExpired = {
      ...after,
      resources: {
        ...after.resources,
        leases: after.resources.leases.map((lease) => ({
          ...lease,
          expiresAt: new Date(Date.parse(after.capturedAt) + 60_000).toISOString(),
        })),
      },
    };
    const result = verifyS33TeardownDryRun(declaration, before, notExpired);
    expect(result.verified).toBe(false);
    expect(result.zeroRecurringRigCost).toBe(false);
    expect(result.failures.join('\n')).toMatch(/lease|release|expiry|expired/i);
  });

  it('rejects undeclared owner-bound and unowned rig-labeled discoveries', () => {
    const extra = {
      name: 'arkova-worker-s33-r-extra',
      projectId: scope.gcpProjectId,
      region: scope.gcpRegion,
      ownerRigId: 'RIG-R' as const,
    };
    const result = verifyS33TeardownDryRun(declaration, {
      ...before,
      resources: {
        ...before.resources,
        cloudRunServices: [...before.resources.cloudRunServices, extra],
      },
    }, {
      ...after,
      resources: {
        ...after.resources,
        cloudRunServices: [...after.resources.cloudRunServices, extra],
      },
    });
    expect(result.verified).toBe(false);
    expect(result.failures.join('\n')).toMatch(/undeclared|owner-bound|target set/i);

    expect(() => verifyS33TeardownDryRun(declaration, {
      ...before,
      resources: {
        ...before.resources,
        cloudRunServices: [...before.resources.cloudRunServices, {
          ...extra,
          ownerRigId: null,
        }],
      },
    }, after)).toThrow(/rig-labeled|owner|exhaustive|discovery/i);

    const rigR = declaration.rigs.find(({ rigId }) => rigId === 'RIG-R')!;
    expect(() => verifyS33TeardownDryRun(declaration, {
      ...before,
      resources: {
        ...before.resources,
        queues: [{
          provider: 'SUPABASE',
          scopeId: rigR.supabaseProjectRef!,
          resourceId: 'innocuous-name',
          ownerRigId: null,
        }],
      },
    }, after)).toThrow(/managed queue|isolated rig|owner|hides/i);
  });
});

describe('S3.3 immutable teardown capture and recurring-cost verdict', () => {
  function captures() {
    return {
      before: captureS33TeardownInventory(
        TEST_TEARDOWN_DECLARATION,
        testTeardownBeforeInventory(),
        testTeardownCaptureMetadata('before'),
      ),
      after: captureS33TeardownInventory(
        TEST_TEARDOWN_DECLARATION,
        testTeardownAfterInventory(),
        testTeardownCaptureMetadata('after'),
      ),
    };
  }

  it('accepts the exact G1/B1 pre-soak boundary while failing closed on unbound RIG-R', () => {
    const fullInventory = testTeardownBeforeInventory();
    const rigR = TEST_TEARDOWN_DECLARATION.rigs.find(({ rigId }) => rigId === 'RIG-R')!;
    const g1 = TEST_PRE_SOAK_TEARDOWN_DECLARATION.rigs.find(({ rigId }) => rigId === 'RIG-G1')!;
    const rigRServices = new Set<string>(rigR.cloudRunServiceNames);
    const rigRSchedulers = new Set<string>(rigR.schedulerJobNames);
    const rigRSecrets = new Set<string>(rigR.perRigSecrets.map(({ name }) => name));
    const partialInventory = {
      ...fullInventory,
      resources: {
        ...fullInventory.resources,
        supabaseProjects: fullInventory.resources.supabaseProjects.filter(
          ({ ref }) => ref !== rigR.supabaseProjectRef,
        ),
        cloudRunServices: fullInventory.resources.cloudRunServices.filter(
          ({ name }) => !rigRServices.has(name),
        ),
        schedulerJobs: fullInventory.resources.schedulerJobs.filter(
          ({ name }) => !rigRSchedulers.has(name),
        ),
        vertexEndpoints: fullInventory.resources.vertexEndpoints.filter(
          ({ resourceName }) => resourceName !== TEST_ONLY_RIG_R_TARGET_ENDPOINT,
        ),
        containedLogicalQueues: [],
        leases: [],
        serviceAccounts: fullInventory.resources.serviceAccounts.filter(
          ({ ownerRigId }) => ownerRigId !== 'RIG-R',
        ),
        secretNames: fullInventory.resources.secretNames.filter(
          ({ name }) => !rigRSecrets.has(name),
        ),
      },
    };
    const capture = captureS33TeardownInventory(
      TEST_PRE_SOAK_TEARDOWN_DECLARATION,
      partialInventory,
      testTeardownCaptureMetadata('before'),
    );

    expect(capture.resourceBoundary).toMatchObject({
      boundaryStatus: 'PARTIAL_RIG_R_CTO_BINDING_REQUIRED',
      releaseBoundaryComplete: false,
      unboundRigIds: ['RIG-R'],
    });
    expect(capture.resourceBoundary.targetResources).toHaveLength(15);
    expect(capture.resourceBoundary.targetResources.filter(
      ({ rigId, kind }) => rigId === 'RIG-G1' && kind === 'cloud-run-service',
    ).map(({ resourceId }) => resourceId).sort()).toEqual([
      'arkova-worker-s33-g1-public-staging',
      'arkova-worker-s33-g1-tuned-staging',
    ]);
    expect(capture.resourceBoundary.targetResources.filter(
      ({ rigId, kind }) => rigId === 'RIG-G1' && kind === 'cloud-scheduler-job',
    )).toEqual([]);
    expect(capture.resourceBoundary.targetResources.filter(
      ({ rigId }) => rigId === 'RIG-G1',
    ).every(({ targetProvenance }) => (
      targetProvenance.authority === 'CTO'
      && targetProvenance.decisionArtifactSha256
        === g1.targetBinding!.decisionArtifactSha256
      && targetProvenance.provisionArtifactSha256
        === g1.targetBinding!.provisionArtifactSha256
    ))).toBe(true);
    expect(capture.resourceBoundary.protectedResources).toContainEqual(
      expect.objectContaining({
        kind: 'vertex-endpoint',
        resourceId: TEST_PROTECTED_G1_V6_ENDPOINT,
        protectionClass: 'DECLARED_PRE_EXISTING_VERTEX_INPUT',
      }),
    );

    const fullAfter = testTeardownAfterInventory();
    const partialAfterCapture = captureS33TeardownInventory(
      TEST_PRE_SOAK_TEARDOWN_DECLARATION,
      {
        ...fullAfter,
        resources: { ...fullAfter.resources, leases: [] },
      },
      testTeardownCaptureMetadata('after'),
    );
    const partialVerification = verifyS33TeardownCapturedInventories(
      TEST_PRE_SOAK_TEARDOWN_DECLARATION,
      capture,
      partialAfterCapture,
    );
    expect(partialVerification).toMatchObject({
      verified: true,
      releaseBoundaryComplete: false,
      boundaryStatus: 'PARTIAL_RIG_R_CTO_BINDING_REQUIRED',
      unboundRigIds: ['RIG-R'],
      recurringCostVerdict: 'blocked',
      recurring_cost_zero: false,
      projectedMonthlyRecurringUsd: null,
    });

    expect(() => captureS33TeardownInventory({
      ...TEST_PRE_SOAK_TEARDOWN_DECLARATION,
      vertexEndpointTargets: [{
        resourceName: TEST_PROTECTED_G1_V6_ENDPOINT,
        ownerRigId: 'RIG-G1',
        provenance: {
          authority: 'CTO',
          origin: 'S33_ISOLATED_RIG_RESOURCE',
          decisionArtifactSha256: g1.targetBinding!.decisionArtifactSha256,
          candidateGitHeadSha: g1.targetBinding!.candidateGitHeadSha,
          candidateGitTreeSha: g1.targetBinding!.candidateGitTreeSha,
          imageDigestSha256: g1.targetBinding!.imageDigestSha256,
          provisionArtifactSha256: g1.targetBinding!.provisionArtifactSha256,
          provisionConfigSha256: g1.targetBinding!.provisionConfigSha256,
        },
      }],
    }, partialInventory, testTeardownCaptureMetadata('before'))).toThrow(
      /Vertex|protected|target|overlap|pre-existing/i,
    );
  });

  it('binds immutable before/after artifacts to one explicit rig/resource boundary', () => {
    const { before: beforeCapture, after: afterCapture } = captures();
    const result = verifyS33TeardownCapturedInventories(
      TEST_TEARDOWN_DECLARATION,
      beforeCapture,
      afterCapture,
    );

    expect(beforeCapture).toMatchObject({
      schemaVersion: 'arkova.s33.l2.teardown-inventory-capture/v1',
      kind: 's33-teardown-inventory-capture',
      gitHeadSha: TEST_TEARDOWN_HEAD_SHA,
      gitTreeSha: TEST_TEARDOWN_TREE_SHA,
      phase: 'before',
    });
    expect(beforeCapture.resourceBoundary.targetResources).toHaveLength(24);
    expect(beforeCapture.resourceBoundary.rigIds).toEqual(['RIG-B1', 'RIG-G1', 'RIG-R']);
    expect(beforeCapture.resourceBoundary.protectedResources).toHaveLength(8);
    expect(beforeCapture.resourceBoundary.releaseBoundaryComplete).toBe(true);
    expect(beforeCapture.resourceBoundarySha256).toBe(afterCapture.resourceBoundarySha256);
    expect(beforeCapture.inventoryArtifactSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(beforeCapture.captureArtifactSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(beforeCapture.captureArtifactSha256).not.toBe(afterCapture.captureArtifactSha256);
    expect(Object.isFrozen(beforeCapture)).toBe(true);
    expect(Object.isFrozen(beforeCapture.resourceBoundary.targetResources)).toBe(true);

    expect(result).toMatchObject({
      schemaVersion: 'arkova.s33.l2.teardown-captured-verification/v1',
      kind: 's33-teardown-captured-verification',
      mode: 'CAPTURED_IMMUTABLE_VERIFY_ONLY',
      gitHeadSha: TEST_TEARDOWN_HEAD_SHA,
      gitTreeSha: TEST_TEARDOWN_TREE_SHA,
      verified: true,
      protectedResourcesUntouched: true,
      releaseAcceptance: false,
      recurringCostVerdict: 'recurring_cost_zero',
      recurring_cost_zero: true,
      projectedMonthlyRecurringUsd: 0,
      signatureVerification: 'UNVERIFIED_EXTERNAL_ARTIFACT',
      mutationsAttempted: 0,
      failures: [],
    });
    expect(result.targetOutcomes).toHaveLength(24);
    expect(result.targetOutcomes.filter(({ state }) => state === 'REMOVED')).toHaveLength(23);
    expect(result.targetOutcomes).toContainEqual(expect.objectContaining({
      kind: 'logical-lease',
      state: 'RELEASED_EXPIRED',
    }));
    expect(result.verificationDigestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(requireS33TeardownCapturedVerification(result)).toBe(result);
    expect(() => requireS33TeardownCapturedVerification(structuredClone(result)))
      .toThrow(/provenance|captured|verification/i);
  });

  it('snapshots mutable inputs once and rejects mutable raw inventory as consumer evidence', () => {
    const mutableBefore = structuredClone(testTeardownBeforeInventory()) as unknown as {
      resources: { supabaseProjects: unknown[] };
    };
    const beforeCapture = captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      mutableBefore,
      testTeardownCaptureMetadata('before'),
    );
    mutableBefore.resources.supabaseProjects.length = 0;
    expect(beforeCapture.inventory.resources.supabaseProjects).toHaveLength(4);

    const afterCapture = captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      testTeardownAfterInventory(),
      testTeardownCaptureMetadata('after'),
    );
    expect(() => verifyS33TeardownCapturedInventories(
      TEST_TEARDOWN_DECLARATION,
      testTeardownBeforeInventory(),
      afterCapture,
    )).toThrow(/provenance|capture|immutable/i);
  });

  it('blocks recurring_cost_zero on any protected-resource drift', () => {
    const beforeCapture = captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      testTeardownBeforeInventory(),
      testTeardownCaptureMetadata('before'),
    );
    const driftedAfter = structuredClone(testTeardownAfterInventory()) as unknown as {
      resources: { cloudRunServices: unknown[] };
    };
    driftedAfter.resources.cloudRunServices = [];
    const afterCapture = captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      driftedAfter,
      testTeardownCaptureMetadata('after'),
    );
    const result = verifyS33TeardownCapturedInventories(
      TEST_TEARDOWN_DECLARATION,
      beforeCapture,
      afterCapture,
    );

    expect(result.verified).toBe(false);
    expect(result.protectedResourcesUntouched).toBe(false);
    expect(result.recurringCostVerdict).toBe('blocked');
    expect(result.recurring_cost_zero).toBe(false);
    expect(result.projectedMonthlyRecurringUsd).toBeNull();
    expect(result.failures.join('\n')).toMatch(/protected|boundary|non-target|drift/i);
  });

  it('records a partial teardown outcome but cannot promote it to $0 or closure', () => {
    const beforeInventory = testTeardownBeforeInventory();
    const afterInventory = testTeardownAfterInventory();
    const straggler = beforeInventory.resources.cloudRunServices.find(
      ({ ownerRigId }) => ownerRigId === 'RIG-R',
    )!;
    const beforeCapture = captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      beforeInventory,
      testTeardownCaptureMetadata('before'),
    );
    const afterCapture = captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      {
        ...afterInventory,
        resources: {
          ...afterInventory.resources,
          cloudRunServices: [...afterInventory.resources.cloudRunServices, straggler],
        },
      },
      testTeardownCaptureMetadata('after'),
    );
    const result = verifyS33TeardownCapturedInventories(
      TEST_TEARDOWN_DECLARATION,
      beforeCapture,
      afterCapture,
    );

    expect(result.targetOutcomes).toContainEqual(expect.objectContaining({
      kind: 'cloud-run-service',
      ownerRigId: 'RIG-R',
      state: 'REMAINS',
      projectedMonthlyRecurringUsd: null,
    }));
    expect(result.verified).toBe(false);
    expect(result.recurring_cost_zero).toBe(false);
    expect(result.projectedMonthlyRecurringUsd).toBeNull();
  });

  it('binds protected v6/shared-secret/operator IAM and configuration digests before/after', () => {
    const beforeCapture = captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      testTeardownBeforeInventory(),
      testTeardownCaptureMetadata('before'),
    );
    const afterInventory = testTeardownAfterInventory();
    const drifted = {
      ...afterInventory,
      resources: {
        ...afterInventory.resources,
        vertexEndpoints: afterInventory.resources.vertexEndpoints.map((endpoint) => (
          endpoint.resourceName === TEST_PROTECTED_G1_V6_ENDPOINT
            ? { ...endpoint, iamPolicyDigestSha256: `sha256:${'0'.repeat(64)}` }
            : endpoint
        )),
      },
    };
    const afterCapture = captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      drifted,
      testTeardownCaptureMetadata('after'),
    );
    const result = verifyS33TeardownCapturedInventories(
      TEST_TEARDOWN_DECLARATION,
      beforeCapture,
      afterCapture,
    );

    expect(result.verified).toBe(false);
    expect(result.protectedResourcesUntouched).toBe(false);
    expect(result.recurring_cost_zero).toBe(false);
    expect(result.failures.join('\n')).toMatch(/protected|boundary|drift/i);
  });

  it('binds operator/signer metadata but never promotes unverified metadata to release authority', () => {
    const beforeCapture = captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      testTeardownBeforeInventory(),
      testTeardownCaptureMetadata('before'),
    );
    const afterCapture = captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      testTeardownAfterInventory(),
      testTeardownCaptureMetadata('after'),
    );
    const result = verifyS33TeardownCapturedInventories(
      TEST_TEARDOWN_DECLARATION,
      beforeCapture,
      afterCapture,
    );

    expect(result.operator).toEqual({
      operatorId: 'rte-s33-closeout',
      role: 'RTE',
      organization: 'ARKOVA',
    });
    expect(result.signer).toMatchObject({
      keyId: 'arkova-s33-cto-release-test-only',
      algorithm: 'Ed25519',
      publicKeyFingerprintSha256: `sha256:${'c'.repeat(64)}`,
      verificationStatus: 'UNVERIFIED_EXTERNAL_ARTIFACT',
    });
    expect(result.signatureVerification).toBe('UNVERIFIED_EXTERNAL_ARTIFACT');
    expect(result.releaseAcceptance).toBe(false);

    expect(() => captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      testTeardownBeforeInventory(),
      testTeardownCaptureMetadata('before', { privateKey: 'must-never-be-accepted' }),
    )).toThrow(/schema|unrecognized|privateKey/i);

    const mismatchedAfter = captureS33TeardownInventory(
      TEST_TEARDOWN_DECLARATION,
      testTeardownAfterInventory(),
      testTeardownCaptureMetadata('after', {
        operator: {
          operatorId: 'different-operator',
          role: 'RTE',
          organization: 'ARKOVA',
        },
      }),
    );
    expect(() => verifyS33TeardownCapturedInventories(
      TEST_TEARDOWN_DECLARATION,
      beforeCapture,
      mismatchedAfter,
    )).toThrow(/operator|identity|contradict/i);
  });
});
