import { describe, expect, it, vi } from 'vitest';

import {
  RIG_R_HEARTBEAT_INTERVAL_MIN,
  RIG_R_SESSION_REFRESH_INTERVAL_MIN,
  RIG_R_WALL_MIN,
  RIG_R_WORKER_UPTIME_MIN,
  hasExactReleaseAiFlagsForTest,
  runS33RigRBoundedRefreshBatchForTest,
  runS33RigRReleaseProduction,
  validateS33RigRReleaseAdmission,
  type S33RigRReleaseProductionPort,
} from './s33-rig-r-release-production-adapter';

const head = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const digest = `sha256:${'c'.repeat(64)}`;
const artifact = `sha256:${'d'.repeat(64)}`;
const now = '2026-07-16T18:00:00.000Z';
const expiresAt = '2026-07-19T17:00:00.000Z';
const confirmation =
  'START_RIG_R:rig-r-approval-1:s33-r-release-v6:lease-s33-r-release:real-provider-recovery-19';

function admission(): Record<string, unknown> {
  const approval = {
    status: 'VERIFIED',
    approvalId: 'rig-r-approval-1',
    canonicalSha256: artifact,
    approverIdentity: 'arkova.s33.approver.founder-cto.v1',
    candidate: {
      sourceHeadSha: head,
      sourceTreeSha: tree,
      sourceHeadImageRef: `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:${head}@${digest}`,
      imageDigest: digest,
      provisionArtifactSha256: artifact,
      rigName: 's33-r',
      rigProfile: 'gemini-release',
      soakId: 's33-r-release-v6',
      leaseId: 'lease-s33-r-release',
      requiredWallMin: 2910,
      vertexEndpointId: '733018',
      vertexEndpoint: 'projects/arkova1/locations/us-central1/endpoints/733018',
      vertexEndpointDisplayName: 'arkova-s33-rig-r-release-v6',
      vertexModel: 'projects/270018525501/locations/us-central1/models/6611494259700793344',
      vertexModelVersion: 'projects/270018525501/locations/us-central1/models/6611494259700793344@1',
      checkpointId: '6',
      deployedModelId: '7330181',
      deployedModelDisplayName: 'arkova-s33-rig-r-release-v6',
      deploymentResourcesMode: 'TUNED_GEMINI_AUTOMATIC_RESOURCES',
      minReplicaCount: 1,
      maxReplicaCount: 1,
      endpointIamRole: 'roles/aiplatform.endpointUser',
      endpointIamMember: 'serviceAccount:s33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
      runtimeImpersonatorServiceAccount:
        '270018525501-compute@developer.gserviceaccount.com',
      runtimeImpersonationRole: 'roles/iam.serviceAccountTokenCreator',
      runtimeImpersonationMember:
        'serviceAccount:270018525501-compute@developer.gserviceaccount.com',
      provisionStartedAt: '2026-07-16T17:00:00.000Z',
      expiresAt,
      teardownScriptSha256: `sha256:${'e'.repeat(64)}`,
      secretReferences: {
        supabaseUrl: 'supabase-url-s33-r-staging@1',
        supabaseServiceRoleKey: 'supabase-service-role-key-s33-r-staging@1',
        stripeSecretKey: 'stripe-secret-key-staging@1',
        stripeWebhookSecret: 'stripe-webhook-secret-staging@1',
        apiKeyHmacSecret: 'api-key-hmac-secret-staging@1',
        cronSecret: 'cron-secret@1',
        geminiApiKey: 'gemini-api-key@2',
      },
      immutableLedger: {
        backend: 'gcs-if-generation-match-0-locked-retention',
        bucket: 'arkova1-s33-immutable-authority-ledger',
        projectId: 'arkova1',
        requiresPerObjectRetention: true,
      },
    },
  };
  return {
    schema_version: 2,
    kind: 'isolated_rig_admission',
    generated_at: '2026-07-16T17:30:00.000Z',
    rig_name: 's33-r',
    rig_id: 'RIG-R',
    profile: 'gemini-release',
    soak_id: 's33-r-release-v6',
    lease_id: 'lease-s33-r-release',
    gcp_project_id: 'arkova1',
    supabase_org_id: 'byhkazrpmivhcsuqjtva',
    region: 'us-central1',
    cloud_run_service: 'arkova-worker-s33-r-staging',
    tier: 'T3',
    duration_min: 2880,
    required_uptime_min: 2880,
    required_wall_min: 2910,
    sha: head,
    declared_source_head: head,
    source_head_image_ref: `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:${head}`,
    source_head_image_digest: digest,
    image_digest: digest,
    deployed_revision: 'arkova-worker-s33-r-staging-00001-abc',
    deployed_image_ref: `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@${digest}`,
    deployed_image_digest: digest,
    deployed_source_head: head,
    tag_url: 'https://arkova-worker-s33-r-staging.example.run.app',
    supabase_project_ref: 'abcdefghijklmnopqrst',
    preflight_result: 'environment_type=clean_mirror',
    clean_mirror_attestation_id: `sha256:${'f'.repeat(64)}`,
    critical_config: {
      enable_ai_extraction: 'true',
      enable_vertex_ai: 'true',
      db_enable_verification_api: 'true',
      db_enable_ai_extraction: 'true',
      gemini_tuned_model: 'projects/arkova1/locations/us-central1/endpoints/733018',
      gemini_v6_prompt: 'true',
      gemini_tuned_response_schema: '<unset>',
    },
    scheduler: { applicable: false, jobs: [], activation_mode: 'PAUSED' },
    rig_r: {
      candidate_head_sha: head,
      candidate_tree_sha: tree,
      provision_artifact_sha256: artifact,
      tier: 'T3',
      required_worker_uptime_min: 2880,
      required_wall_min: 2910,
      provision_started_at: '2026-07-16T17:00:00.000Z',
      hard_stop_expires_at: expiresAt,
      cto_provision_authority_status: 'VERIFIED',
      provision_approval: approval,
      project: 'arkova1',
      region: 'us-central1',
      supabase_project_name: 'arkova-soak-s33-r',
      supabase_project_ref: 'abcdefghijklmnopqrst',
      cloud_run_service: 'arkova-worker-s33-r-staging',
      runtime_service_account: 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
      runtime_impersonator_service_account:
        '270018525501-compute@developer.gserviceaccount.com',
      runtime_impersonation_role: 'roles/iam.serviceAccountTokenCreator',
      runtime_impersonation_member:
        'serviceAccount:270018525501-compute@developer.gserviceaccount.com',
      vertex_endpoint: 'projects/arkova1/locations/us-central1/endpoints/733018',
      vertex_model: 'projects/270018525501/locations/us-central1/models/6611494259700793344',
      deployed_model_id: '7330181',
      chain_mode: 'mocked',
      contained_database_queues: ['ai-rollback', 'chain-fault'],
      scheduler_jobs: [],
      managed_queues: [],
      oidc_identities: [],
      lease: {
        cardinality: 1,
        lease_id: 'lease-s33-r-release',
        object_uri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-leases/RIG-R.singleton.json',
        object_name_is_code_fixed: true,
        acquisition: 'gcs-singleton-if-generation-match-0',
        release: 'ownership-verified-generation-bound-delete',
      },
    },
  };
}

function port(overrides: Partial<S33RigRReleaseProductionPort> = {}): S33RigRReleaseProductionPort {
  const exact = admission();
  const rigR = exact.rig_r as Record<string, unknown>;
  const approval = rigR.provision_approval as Record<string, unknown>;
  const candidate = approval.candidate as Record<string, unknown>;
  let receipt: unknown | null = null;
  return {
    now: vi.fn(() => new Date(now)),
    verifyProvisionApproval: vi.fn(() => approval),
    observeExactIdentity: vi.fn(async () => ({
      candidateHeadSha: head,
      candidateTreeSha: tree,
      fullShaImageRef: candidate.sourceHeadImageRef,
      imageDigest: digest,
      imagePlatform: 'linux/amd64',
      revision: exact.deployed_revision,
      serviceUrl: exact.tag_url,
      runtimeServiceAccount: rigR.runtime_service_account,
      runtimeServiceAccountUniqueId: '100000000000000000001',
      supabaseProjectRef: exact.supabase_project_ref,
      vertexEndpoint: rigR.vertex_endpoint,
      vertexModel: rigR.vertex_model,
      deployedModelId: rigR.deployed_model_id,
      leaseId: exact.lease_id,
      leaseGeneration: '7',
      schedulerJobCount: 0,
      managedQueueCount: 0,
      oidcIdentityCount: 0,
      inProcessJobsDisabled: true,
      observedAt: now,
    })),
    preparePreclock: vi.fn(async () => ({
      status: 'PRECLOCK_AUTH_READY',
      verifiedAt: now,
      sessionIdentityCount: 4,
      sessionRefreshVerifiedCount: 4,
      cloudRunBoundary: {
        missingIngressTokenStatus: 401,
        missingAppTokenStatus: 401,
        invalidAppTokenStatus: 401,
        validExactUserStatus: 200,
      },
      vertexCapabilityProbe: {
        status: 'PASSED_PRECLOCK_NO_CUSTOMER_DATA',
        endpoint: rigR.vertex_endpoint,
        runtimeServiceAccount: rigR.runtime_service_account,
      },
    })),
    loadStartReceipt: vi.fn(async () => receipt),
    persistStartReceipt: vi.fn(async (value) => { receipt = structuredClone(value); }),
    runSupervisedHarness: vi.fn(async () => ({
      configuredWorkerUptimeMin: RIG_R_WORKER_UPTIME_MIN,
      configuredWallMin: RIG_R_WALL_MIN,
      workerUptimeMs: RIG_R_WORKER_UPTIME_MIN * 60_000,
      wallElapsedMs: RIG_R_WALL_MIN * 60_000,
      maximumHeartbeatGapMs: RIG_R_HEARTBEAT_INTERVAL_MIN * 60_000,
      sessionRefreshIntervalMs: RIG_R_SESSION_REFRESH_INTERVAL_MIN * 60_000,
      harnessDurationSec: RIG_R_WORKER_UPTIME_MIN * 60,
      liveEvalRounds: 96 as const,
      liveEvalMeritedRounds: 96 as const,
      liveEvalEvidencePath: 'docs/staging/s33-rig-r/s33-r-release-v6-live-eval.jsonl',
      liveEvalEvidenceSha256: `sha256:${'1'.repeat(64)}`,
      completedAt: '2026-07-18T18:30:00.000Z',
    })),
    runReleaseDriver: vi.fn(async () => ({ status: 'SOAK_EVIDENCE_BOUND' as const })),
    cleanupPreparation: vi.fn(async () => undefined),
    teardown: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('RIG-R production release start', () => {
  it('does not compensate or tear down infrastructure named only by unauthenticated input', async () => {
    const testPort = port({
      verifyProvisionApproval: vi.fn(() => { throw new Error('signature invalid'); }),
    });
    await expect(runS33RigRReleaseProduction(
      admission(), 'tampered-envelope', confirmation, testPort,
    )).rejects.toThrow(/signature invalid/i);
    expect(testPort.observeExactIdentity).not.toHaveBeenCalled();
    expect(testPort.cleanupPreparation).not.toHaveBeenCalled();
    expect(testPort.teardown).not.toHaveBeenCalled();
  });

  it('requires the exact approval/run/lease confirmation before observation or mutation', async () => {
    const testPort = port();
    await expect(runS33RigRReleaseProduction(
      admission(), 'signed-envelope', 'START_RIG_R:wrong:scope:lease', testPort,
    )).rejects.toThrow(/exact CTO confirmation|START_RIG_R/i);
    expect(testPort.observeExactIdentity).not.toHaveBeenCalled();
    expect(testPort.persistStartReceipt).not.toHaveBeenCalled();
    expect(testPort.teardown).not.toHaveBeenCalled();
  });

  it('rejects runtime impersonator drift before observing or starting the clock', async () => {
    const altered = admission();
    (altered.rig_r as Record<string, unknown>).runtime_impersonation_member =
      'serviceAccount:shadow@arkova1.iam.gserviceaccount.com';
    const testPort = port();
    await expect(runS33RigRReleaseProduction(
      altered, 'signed-envelope', confirmation, testPort,
    )).rejects.toThrow(/impersonation|literal|binding/i);
    expect(testPort.observeExactIdentity).not.toHaveBeenCalled();
    expect(testPort.persistStartReceipt).not.toHaveBeenCalled();
  });

  it('requires both revision flags and both DB gates to be exact true in immutable admission', () => {
    for (const flag of [
      'enable_ai_extraction',
      'enable_vertex_ai',
      'db_enable_verification_api',
      'db_enable_ai_extraction',
    ] as const) {
      const altered = admission();
      const criticalConfig = altered.critical_config as Record<string, unknown>;
      criticalConfig[flag] = 'false';
      expect(() => validateS33RigRReleaseAdmission(altered)).toThrow();
    }
  });

  it('requires both release AI flags independently on the observed revision', () => {
    const revision = (extraction: string, vertex: string) => ({
      metadata: { name: 'arkova-worker-s33-r-staging-00001-abc', labels: {} },
      spec: {
        serviceAccountName: 's33-rig-r-runtime@arkova1.iam.gserviceaccount.com',
        containers: [{
          image: `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@${digest}`,
          env: [
            { name: 'ENABLE_AI_EXTRACTION', value: extraction },
            { name: 'ENABLE_VERTEX_AI', value: vertex },
          ],
        }],
      },
      status: { imageDigest: digest },
    });
    expect(hasExactReleaseAiFlagsForTest(revision('true', 'true'))).toBe(true);
    expect(hasExactReleaseAiFlagsForTest(revision('false', 'true'))).toBe(false);
    expect(hasExactReleaseAiFlagsForTest(revision('true', 'false'))).toBe(false);
    const duplicate = revision('true', 'true');
    duplicate.spec.containers[0].env.push({ name: 'ENABLE_VERTEX_AI', value: 'true' });
    expect(() => hasExactReleaseAiFlagsForTest(duplicate)).toThrow(/duplicate ENABLE_VERTEX_AI/i);
  });

  it('writes and reloads the immutable start receipt before the exact 2880/2910 run', async () => {
    const testPort = port();
    const result = await runS33RigRReleaseProduction(admission(), 'signed-envelope', confirmation, testPort);
    expect(result.status).toBe('RIG_R_RELEASE_EVIDENCE_BOUND');
    expect(testPort.persistStartReceipt).toHaveBeenCalledBefore(
      testPort.runSupervisedHarness as ReturnType<typeof vi.fn>,
    );
    expect(testPort.runSupervisedHarness).toHaveBeenCalledWith(expect.objectContaining({
      workerUptimeMin: 2880,
      wallMin: 2910,
      heartbeatIntervalMin: 5,
      sessionRefreshIntervalMin: 45,
    }));
    expect(testPort.teardown).toHaveBeenCalledWith(
      expect.any(Object),
      'evidence-complete',
      expect.any(Object),
    );
    expect(testPort.runReleaseDriver).toHaveBeenCalledBefore(
      testPort.teardown as ReturnType<typeof vi.fn>,
    );
  });

  it('rejects a wrong live identity without trusting it as a teardown target', async () => {
    const testPort = port({
      observeExactIdentity: vi.fn(async () => ({
        ...(await port().observeExactIdentity(admission() as never) as Record<string, unknown>),
        candidateTreeSha: '9'.repeat(40),
      })),
    });
    await expect(runS33RigRReleaseProduction(admission(), 'signed-envelope', confirmation, testPort))
      .rejects.toThrow(/identity|tree/i);
    expect(testPort.runSupervisedHarness).not.toHaveBeenCalled();
    expect(testPort.teardown).not.toHaveBeenCalled();
  });

  it('rejects replay before preparation or another clock', async () => {
    const testPort = port({ loadStartReceipt: vi.fn(async () => ({ existing: true })) });
    await expect(runS33RigRReleaseProduction(admission(), 'signed-envelope', confirmation, testPort))
      .rejects.toThrow(/replay|already exists/i);
    expect(testPort.preparePreclock).not.toHaveBeenCalled();
    expect(testPort.runSupervisedHarness).not.toHaveBeenCalled();
  });

  it('contains a partial receipt failure and emits no completion', async () => {
    const testPort = port({
      persistStartReceipt: vi.fn(async () => { throw new Error('metadata readback failed'); }),
    });
    await expect(runS33RigRReleaseProduction(admission(), 'signed-envelope', confirmation, testPort))
      .rejects.toThrow(/metadata readback failed/);
    expect(testPort.runSupervisedHarness).not.toHaveBeenCalled();
    expect(testPort.teardown).toHaveBeenCalledOnce();
  });

  it('rejects an early harness exit and tears down', async () => {
    const testPort = port({
      runSupervisedHarness: vi.fn(async () => ({
        configuredWorkerUptimeMin: 2880,
        configuredWallMin: 2910,
        workerUptimeMs: 2879 * 60_000,
        wallElapsedMs: 2910 * 60_000,
        maximumHeartbeatGapMs: 5 * 60_000,
        sessionRefreshIntervalMs: 45 * 60_000,
        harnessDurationSec: 2879 * 60,
        liveEvalRounds: 96 as const,
        liveEvalMeritedRounds: 96 as const,
        liveEvalEvidencePath: 'docs/staging/s33-rig-r/s33-r-release-v6-live-eval.jsonl',
        liveEvalEvidenceSha256: `sha256:${'1'.repeat(64)}`,
        completedAt: '2026-07-18T18:30:00.000Z',
      })),
    });
    await expect(runS33RigRReleaseProduction(admission(), 'signed-envelope', confirmation, testPort))
      .rejects.toThrow(/2880|early|uptime/i);
    expect(testPort.runReleaseDriver).not.toHaveBeenCalled();
    expect(testPort.teardown).toHaveBeenCalledOnce();
  });

  it('rejects authority that cannot cover wall plus teardown reserve', async () => {
    const input = admission();
    const rigR = input.rig_r as Record<string, unknown>;
    const shortExpiry = '2026-07-18T18:31:00.000Z';
    rigR.hard_stop_expires_at = shortExpiry;
    const projection = rigR.provision_approval as { candidate: { expiresAt: string } };
    projection.candidate.expiresAt = shortExpiry;
    await expect(runS33RigRReleaseProduction(input, 'signed-envelope', confirmation, port()))
      .rejects.toThrow(/expiry|reserve|authority/i);
  });

  it('preserves both the operation and teardown failures', async () => {
    const testPort = port({
      runSupervisedHarness: vi.fn(async () => { throw new Error('harness failed'); }),
      teardown: vi.fn(async () => { throw new Error('teardown failed'); }),
    });
    await expect(runS33RigRReleaseProduction(admission(), 'signed-envelope', confirmation, testPort))
      .rejects.toSatisfy((error: unknown) => error instanceof AggregateError
        && error.errors.some((entry) => entry instanceof Error && /harness failed/.test(entry.message))
        && error.errors.some((entry) => entry instanceof Error && /teardown failed/.test(entry.message)));
  });

  it('attempts cleanup before teardown and still tears down after cleanup fails', async () => {
    const order: string[] = [];
    const testPort = port({
      runSupervisedHarness: vi.fn(async () => { throw new Error('harness failed'); }),
      cleanupPreparation: vi.fn(async () => {
        order.push('cleanup');
        throw new Error('cleanup failed');
      }),
      teardown: vi.fn(async () => { order.push('teardown'); }),
    });
    await expect(runS33RigRReleaseProduction(admission(), 'signed-envelope', confirmation, testPort))
      .rejects.toSatisfy((error: unknown) => error instanceof AggregateError
        && error.errors.some((entry) => entry instanceof Error && /cleanup failed/.test(entry.message)));
    expect(order).toEqual(['cleanup', 'teardown']);
  });

  it('retries only transiently failed session refresh operations', async () => {
    const transient = vi.fn()
      .mockRejectedValueOnce(new Error('transient refresh timeout'))
      .mockResolvedValue(undefined);
    const stable = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn(async () => undefined);
    await runS33RigRBoundedRefreshBatchForTest([
      { label: 'session A', run: transient },
      { label: 'session B', run: stable },
    ], sleep, new AbortController().signal);
    expect(transient).toHaveBeenCalledTimes(2);
    expect(stable).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('hard-stops a hanging post-harness release at authority expiry', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => undefined);
      const testPort = port({
        runReleaseDriver: vi.fn(() => never),
      });
      const execution = runS33RigRReleaseProduction(
        admission(), 'signed-envelope', confirmation, testPort,
      );
      const rejection = expect(execution).rejects.toThrow(/authority expired.*post-harness/i);
      while (!(testPort.runReleaseDriver as ReturnType<typeof vi.fn>).mock.calls.length) {
        await Promise.resolve();
      }
      await vi.advanceTimersByTimeAsync(Date.parse(expiresAt) - Date.parse(now));
      await rejection;
      expect(testPort.teardown).toHaveBeenCalledWith(
        expect.any(Object),
        'authority-expiry',
        expect.any(Object),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
