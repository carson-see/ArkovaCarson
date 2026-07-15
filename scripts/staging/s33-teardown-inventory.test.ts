import { describe, expect, it } from 'vitest';

import {
  S33_TEARDOWN_SCHEMA_VERSION,
  verifyS33TeardownDryRun,
} from './s33-teardown-inventory';

const headSha = 'a'.repeat(40);
const scope = {
  gcpProjectId: 'arkova1',
  gcpRegion: 'us-central1',
  supabaseOrgId: 'byhkazrpmivhcsuqjtva',
};

const declaration = {
  schemaVersion: 1,
  kind: 's33-teardown-declaration',
  closeoutId: 's33-rc-2026-07-15',
  gitHeadSha: headSha,
  scope,
  rigs: [
    {
      rigId: 'RIG-G1',
      supabaseProjectRef: 'abcdefghijklmnopqrst',
      supabaseProjectName: 'arkova-soak-rig-g1',
      cloudRunServiceNames: ['arkova-worker-rig-g1-staging'],
      schedulerJobNames: ['arkova-worker-rig-g1-staging-classify-proof-backcatalog'],
      perRigSecretNames: ['cron-rig-g1', 'supabase-service-role-key-rig-g1-staging'],
    },
    {
      rigId: 'RIG-B1',
      supabaseProjectRef: 'bcdefghijklmnopqrstu',
      supabaseProjectName: 'arkova-soak-rig-b1',
      cloudRunServiceNames: ['arkova-worker-rig-b1-staging'],
      schedulerJobNames: [
        'arkova-worker-rig-b1-staging-batch-anchors',
        'arkova-worker-rig-b1-staging-check-confirmations',
        'arkova-worker-rig-b1-staging-populate-confirmation-proofs',
        'arkova-worker-rig-b1-staging-org-queue-scheduler',
        'arkova-worker-rig-b1-staging-batch-anchors-forced-flush',
        'arkova-worker-rig-b1-staging-recover-broadcasts',
      ],
      perRigSecretNames: ['cron-rig-b1', 'supabase-service-role-key-rig-b1-staging'],
    },
    {
      rigId: 'RIG-R',
      supabaseProjectRef: 'cdefghijklmnopqrstuv',
      supabaseProjectName: 'arkova-soak-rig-r',
      cloudRunServiceNames: ['arkova-worker-rig-r-staging'],
      schedulerJobNames: ['arkova-worker-rig-r-staging-classify-proof-backcatalog'],
      perRigSecretNames: ['cron-rig-r', 'supabase-service-role-key-rig-r-staging'],
    },
  ],
  vertexEndpointResourceNames: [
    'projects/arkova1/locations/us-central1/endpoints/6611494259700793344',
  ],
  protectedSharedSecretNames: ['api-key-hmac-secret-staging', 'stripe-secret-key-staging'],
} as const;

const targetSupabaseProjects = declaration.rigs.map((rig) => ({
  ref: rig.supabaseProjectRef,
  name: rig.supabaseProjectName,
}));
const targetCloudRunServices = declaration.rigs.flatMap((rig) =>
  rig.cloudRunServiceNames.map((name) => ({ name, projectId: scope.gcpProjectId, region: scope.gcpRegion })),
);
const targetSchedulerJobs = declaration.rigs.flatMap((rig) =>
  rig.schedulerJobNames.map((name) => ({
    name,
    projectId: scope.gcpProjectId,
    location: scope.gcpRegion,
    targetService: rig.cloudRunServiceNames[0],
  })),
);
const targetSecretNames = declaration.rigs.flatMap((rig) => [...rig.perRigSecretNames]);

const before = {
  schemaVersion: 1,
  kind: 's33-teardown-inventory',
  closeoutId: declaration.closeoutId,
  gitHeadSha: headSha,
  phase: 'before',
  capturedAt: '2026-07-15T16:00:00.000Z',
  scope,
  resources: {
    supabaseProjects: [
      ...targetSupabaseProjects,
      { ref: 'zabcdefghijklmnopqrs', name: 'unrelated-project' },
    ],
    cloudRunServices: [
      ...targetCloudRunServices,
      { name: 'unrelated-service', projectId: scope.gcpProjectId, region: scope.gcpRegion },
    ],
    schedulerJobs: [
      ...targetSchedulerJobs,
      {
        name: 'unrelated-job',
        projectId: scope.gcpProjectId,
        location: scope.gcpRegion,
        targetService: 'unrelated-service',
      },
    ],
    vertexEndpoints: [
      {
        resourceName: declaration.vertexEndpointResourceNames[0],
        displayName: 'rig-r-v6',
        location: scope.gcpRegion,
        deployedModelIds: ['model-rig-r'],
      },
      {
        resourceName: 'projects/arkova1/locations/us-central1/endpoints/1000000000000000001',
        displayName: 'unrelated-endpoint',
        location: scope.gcpRegion,
        deployedModelIds: [],
      },
    ],
    secretNames: [
      ...targetSecretNames,
      ...declaration.protectedSharedSecretNames,
      'unrelated-secret',
    ],
  },
} as const;

const after = {
  ...before,
  phase: 'after',
  capturedAt: '2026-07-15T17:00:00.000Z',
  resources: {
    supabaseProjects: [{ ref: 'zabcdefghijklmnopqrs', name: 'unrelated-project' }],
    cloudRunServices: [{
      name: 'unrelated-service', projectId: scope.gcpProjectId, region: scope.gcpRegion,
    }],
    schedulerJobs: [
      {
        name: 'unrelated-job',
        projectId: scope.gcpProjectId,
        location: scope.gcpRegion,
        targetService: 'unrelated-service',
      },
    ],
    vertexEndpoints: [before.resources.vertexEndpoints[1]],
    secretNames: [...declaration.protectedSharedSecretNames, 'unrelated-secret'],
  },
} as const;

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
      'rig-r-v6 (projects/arkova1/locations/us-central1/endpoints/6611494259700793344)',
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
    const declaredNames = new Set(declaration.rigs.flatMap((rig) => [...rig.schedulerJobNames]));
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
          (name) => name !== 'stripe-secret-key-staging' && name !== 'unrelated-secret',
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
});
