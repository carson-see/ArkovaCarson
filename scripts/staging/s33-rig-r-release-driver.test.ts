import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  RIG_R_RELEASE_TOPOLOGY,
  runS33RigRReleaseDriver,
  validateS33RigRProvisionBinding,
  type S33RigRReleaseDriverPort,
} from './s33-rig-r-release-driver';

const here = dirname(fileURLToPath(import.meta.url));
const provisioner = resolve(here, 'provision-isolated-rig.sh');
const teardown = resolve(here, 'teardown-isolated-rig.sh');

interface RunResult {
  code: number;
  out: string;
}

function run(script: string, args: string[], env: Record<string, string> = {}): RunResult {
  try {
    return {
      code: 0,
      out: execFileSync('bash', [script, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      code: failure.status ?? 1,
      out: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

const headSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const imageDigest = `sha256:${'c'.repeat(64)}`;
const provisionDigest = `sha256:${'d'.repeat(64)}`;
const endpoint = 'projects/arkova1/locations/us-central1/endpoints/9000000000000000001';
const model = RIG_R_RELEASE_TOPOLOGY.protectedV6RollbackModel;
const deployedModelId = '9000000000000000003';
const leaseId = 'lease-s33-r-release';

const binding = () => ({
  schemaVersion: 'arkova.s33.rig-r.provision-binding/v1' as const,
  rigId: 'RIG-R' as const,
  rigName: 's33-r' as const,
  profile: 'gemini-release' as const,
  tier: 'T3' as const,
  candidateHeadSha: headSha,
  candidateTreeSha: treeSha,
  imageDigest,
  provisionArtifactSha256: provisionDigest,
  gcpProjectId: 'arkova1' as const,
  supabaseProjectName: 'arkova-soak-s33-r' as const,
  cloudRunService: 'arkova-worker-s33-r-staging' as const,
  runtimeServiceAccount: 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com' as const,
  vertexEndpoint: endpoint,
  vertexModel: model,
  deployedModelId,
  containedDatabaseQueues: ['ai-rollback', 'chain-fault'] as const,
  managedSchedulerJobs: [] as const,
  managedQueues: [] as const,
  oidcIdentities: [] as const,
  leaseId,
  requiredWorkerUptimeMin: 2880 as const,
  requiredWallMin: 2910,
  provisionStartedAt: '2026-07-16T12:00:00.000Z',
  expiresAt: '2026-07-19T00:00:00.000Z',
});

const rigREnv = {
  STAGING_RIG_ID: 'RIG-R',
  STAGING_RIG_PROFILE: 'gemini-release',
  STAGING_TIER: 'T3',
  STAGING_REQUIRED_UPTIME_MIN: '2880',
  STAGING_REQUIRED_WALL_MIN: '2910',
  STAGING_RUNTIME_SA_EMAIL: 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
  STAGING_SOURCE_HEAD_SHA: headSha,
  STAGING_RIG_R_CANDIDATE_TREE_SHA: treeSha,
  STAGING_RIG_R_VERTEX_ENDPOINT: endpoint,
  STAGING_RIG_R_VERTEX_MODEL: model,
  STAGING_RIG_R_DEPLOYED_MODEL_ID: deployedModelId,
  STAGING_RIG_R_PROVISION_ARTIFACT_SHA256: provisionDigest,
  STAGING_RIG_R_PROVISION_STARTED_AT: '2026-07-16T12:00:00.000Z',
  STAGING_RIG_R_EXPIRES_AT: '2026-07-19T00:00:00.000Z',
  STAGING_LEASE_ID: leaseId,
};

describe('RIG-R exact provision and teardown topology', () => {
  it('admits only the canonical gemini-release RIG-R without Scheduler, OIDC, or managed queues', () => {
    const result = run(provisioner, ['--name', 's33-r', '--profile', 'gemini-release'], rigREnv);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('Supabase project:  arkova-soak-s33-r');
    expect(result.out).toContain('Cloud Run service: arkova-worker-s33-r-staging');
    expect(result.out).toContain('s33-rig-r-runtime@arkova1.iam.gserviceaccount.com');
    expect(result.out).toContain(endpoint);
    expect(result.out).toContain(deployedModelId);
    expect(result.out).toContain('ai-rollback');
    expect(result.out).toContain('chain-fault');
    expect(result.out).not.toContain('scheduler jobs create');
    expect(result.out).not.toContain('--oidc-service-account-email');
    expect(result.out).not.toContain('tasks queues create');
  });

  it.each([
    ['RIG-R with the generic gemini profile', 'RIG-R', 'gemini'],
    ['RIG-R with mock', 'RIG-R', 'mock'],
    ['another rig with gemini-release', 'RIG-B1', 'gemini-release'],
  ])('rejects %s before any project create', (_label, rigId, profile) => {
    const result = run(provisioner, ['--name', 's33-r', '--profile', profile], {
      ...rigREnv,
      STAGING_RIG_ID: rigId,
      STAGING_RIG_PROFILE: profile,
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/RIG-R|gemini-release|profile/i);
    expect(result.out).not.toContain('supabase projects create');
  });

  it('keeps live RIG-R apply fail-closed without an immutable CTO approval envelope', () => {
    const result = run(provisioner, [
      '--name', 's33-r', '--profile', 'gemini-release', '--apply',
    ], {
      ...rigREnv,
      CONFIRM_PROVISION: 's33-r',
      CONFIRM_REAL_CONFIG: 'gemini-release',
      CONFIRM_POST_W3_PROVISION: 'RIG-R',
    });
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/STAGING_RIG_R_PROVISION_APPROVAL_ARTIFACT|Ed25519 approval envelope/i);
    expect(result.out).not.toContain('supabase projects create');
    expect(result.out).not.toContain('executing:');
  });

  it('emits the complete RIG-R teardown in safe order and a $0 residual assertion', () => {
    const result = run(teardown, [
      '--project-ref', 'abcdefghijklmnopqrst',
      '--rig-name', 's33-r',
      '--rig-id', 'RIG-R',
      '--service', 'arkova-worker-s33-r-staging',
      '--vertex-endpoint', endpoint,
      '--vertex-model', model,
      '--deployed-model-id', deployedModelId,
      '--runtime-sa', 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
      '--lease-id', leaseId,
    ]);
    expect(result.code, result.out).toBe(0);
    const ordered = [
      `ai endpoints undeploy-model ${endpoint.split('/').at(-1)}`,
      `ai endpoints delete ${endpoint.split('/').at(-1)}`,
      'run services delete arkova-worker-s33-r-staging',
      'secrets delete supabase-url-s33-r-staging',
      'secrets delete supabase-service-role-key-s33-r-staging',
      'supabase projects delete abcdefghijklmnopqrst',
      'projects remove-iam-policy-binding arkova1',
      'iam service-accounts delete s33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
      `storage rm gs://arkova-training-data/s33/rig-leases/${leaseId}.json`,
    ];
    let cursor = -1;
    for (const fragment of ordered) {
      const next = result.out.indexOf(fragment);
      expect(next, `${fragment}\n${result.out}`).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(result.out).not.toContain('ai models delete');
    expect(result.out).toContain('projected_monthly_recurring_usd');
    expect(result.out).toContain('zero_residual_scheduler');
    expect(result.out).toContain('zero_residual_managed_queue');
    expect(result.out).toContain('zero_residual_oidc');
  });

  it('refuses the protected v6 rollback endpoint before any teardown command', () => {
    const result = run(teardown, [
      '--project-ref', 'abcdefghijklmnopqrst',
      '--rig-name', 's33-r',
      '--rig-id', 'RIG-R',
      '--service', 'arkova-worker-s33-r-staging',
      '--vertex-endpoint', RIG_R_RELEASE_TOPOLOGY.protectedV6RollbackEndpoint,
      '--vertex-model', model,
      '--deployed-model-id', deployedModelId,
      '--runtime-sa', 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
      '--lease-id', leaseId,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.out).toMatch(/protected.*v6|rollback.*endpoint/i);
    expect(result.out).not.toContain('run services delete');
  });
});

describe('RIG-R release driver', () => {
  it('freezes the exact one-service, no-Scheduler/no-OIDC binding and enforces TTL bounds', () => {
    const validated = validateS33RigRProvisionBinding(binding());
    expect(validated).toEqual(binding());
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.containedDatabaseQueues)).toBe(true);

    expect(() => validateS33RigRProvisionBinding({
      ...binding(),
      expiresAt: '2026-07-18T00:00:00.000Z',
    })).toThrow(/expiry|wall|360/i);
    expect(() => validateS33RigRProvisionBinding({
      ...binding(),
      expiresAt: '2026-07-20T13:00:00.000Z',
    })).toThrow(/72/i);
    expect(() => validateS33RigRProvisionBinding({
      ...binding(),
      vertexEndpoint: RIG_R_RELEASE_TOPOLOGY.protectedV6RollbackEndpoint,
    })).toThrow(/protected.*rollback/i);
    expect(() => validateS33RigRProvisionBinding({
      ...binding(),
      vertexModel: 'projects/arkova1/locations/us-central1/models/9000000000000000002',
    })).toThrow(/vertexModel|6611494259700793344/i);
  });

  it('delegates smoke, eval, evidence-chain validation, and teardown without redefining gates', async () => {
    const calls: string[] = [];
    const releaseEvidence = Object.freeze({
      releaseAcceptance: false,
      status: 'AUTHORITY_BOUND',
      exactHeadSha: headSha,
      exactTreeSha: treeSha,
    });
    const port: S33RigRReleaseDriverPort = {
      runV6Smoke: vi.fn(async () => { calls.push('smoke'); }),
      runV6Eval: vi.fn(async () => { calls.push('eval'); }),
      loadReleaseEvidence: vi.fn(async () => { calls.push('evidence'); return releaseEvidence; }),
      requireReleaseEvidence: vi.fn((value) => { calls.push('validate'); return value; }),
      teardown: vi.fn(async () => { calls.push('teardown'); }),
      now: vi.fn(() => new Date('2026-07-16T12:30:00.000Z')),
    };

    const result = await runS33RigRReleaseDriver(binding(), port);
    expect(calls).toEqual(['smoke', 'eval', 'evidence', 'validate']);
    expect(result.status).toBe('SOAK_EVIDENCE_BOUND');
    expect(result.releaseEvidence).toBe(releaseEvidence);
    expect(port.teardown).not.toHaveBeenCalled();
  });

  it.each(['smoke', 'eval', 'evidence'] as const)(
    'tears the isolated rig down when %s fails',
    async (failurePoint) => {
      const calls: string[] = [];
      const fail = async (name: string): Promise<void> => {
        calls.push(name);
        if (failurePoint === name) throw new Error(`${name} failed`);
      };
      const port: S33RigRReleaseDriverPort = {
        runV6Smoke: () => fail('smoke'),
        runV6Eval: () => fail('eval'),
        loadReleaseEvidence: async () => {
          calls.push('evidence');
          if (failurePoint === 'evidence') throw new Error('evidence failed');
          return { exactHeadSha: headSha, exactTreeSha: treeSha };
        },
        requireReleaseEvidence: (value) => value,
        teardown: async () => { calls.push('teardown'); },
        now: () => new Date('2026-07-16T12:30:00.000Z'),
      };
      await expect(runS33RigRReleaseDriver(binding(), port)).rejects.toThrow(/failed/);
      expect(calls.at(-1)).toBe('teardown');
    },
  );

  it('tears down when release evidence is valid but bound to another candidate', async () => {
    const teardown = vi.fn(async () => undefined);
    const port: S33RigRReleaseDriverPort = {
      runV6Smoke: vi.fn(async () => undefined),
      runV6Eval: vi.fn(async () => undefined),
      loadReleaseEvidence: vi.fn(async () => ({
        exactHeadSha: 'e'.repeat(40),
        exactTreeSha: treeSha,
      })),
      requireReleaseEvidence: (value) => value,
      teardown,
      now: () => new Date('2026-07-16T12:30:00.000Z'),
    };

    await expect(runS33RigRReleaseDriver(binding(), port)).rejects.toThrow(/exact.*HEAD\/tree/i);
    expect(teardown).toHaveBeenCalledWith(expect.any(Object), 'driver-failure');
  });

  it('tears down immediately when the authority-bound hard stop has been reached', async () => {
    const port: S33RigRReleaseDriverPort = {
      runV6Smoke: vi.fn(),
      runV6Eval: vi.fn(),
      loadReleaseEvidence: vi.fn(),
      requireReleaseEvidence: vi.fn(),
      teardown: vi.fn(async () => undefined),
      now: () => new Date('2026-07-19T00:00:00.000Z'),
    };
    const result = await runS33RigRReleaseDriver(binding(), port);
    expect(result.status).toBe('HARD_STOP_TEARDOWN');
    expect(port.teardown).toHaveBeenCalledOnce();
    expect(port.runV6Smoke).not.toHaveBeenCalled();
  });
});
