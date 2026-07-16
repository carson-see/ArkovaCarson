import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  deriveS33RigB1SchedulerExecutionIdentity,
  gateS33RigB1ScenarioRequest,
  type S33RigB1ScenarioDb,
} from './s33-rig-b1-scenario.js';

const JOB =
  'projects/arkova1/locations/us-central1/jobs/arkova-worker-s33-rig-b1-staging-batch-anchors';
const FORCED_JOB = `${JOB}-forced-flush`;
const SCHEDULE_TIME = '2026-07-16T18:25:00Z';
const SERVICE_URL =
  'https://rig-b1---arkova-worker-s33-rig-b1-staging-abc-uc.a.run.app';
const CRON_PRINCIPAL = 's33-rig-b1-cron@arkova1.iam.gserviceaccount.com';

type GateMode = 'NORMAL' | 'TARGET_EXECUTE' | 'CONTROLLED_SKIP' | 'PREPARING_SKIP' | 'TARGET_REPLAY';

function rpcResult(mode: GateMode, executionJob = JOB, targetJob = JOB) {
  return {
    data: mode === 'NORMAL' ? { mode } : {
      mode,
      generation: 7,
      scenarioLeaseId: '10000000-0000-4000-8000-000000000001',
      scenarioId: 'overload-a1',
      targetJobResource: targetJob,
      namespaceId: 's33-b1-ns-001',
      expectedPending: 12_500,
      faultWindowId: 'fault-overload-a1',
      soakId: 'soak-b1-live',
      runLeaseId: 'lease-b1-live',
      workerRevision: 'arkova-worker-s33-rig-b1-staging-00001-abc',
      executionId: deriveS33RigB1SchedulerExecutionIdentity(executionJob, SCHEDULE_TIME).executionId,
      scheduleTime: '2026-07-16T18:25:00.000Z',
      expiresAt: '2026-07-16T18:29:00.000Z',
    },
    error: null,
  };
}

function db(mode: GateMode, executionJob = JOB, targetJob = JOB): S33RigB1ScenarioDb {
  return { rpc: vi.fn().mockResolvedValue(rpcResult(mode, executionJob, targetJob)) };
}

const exactAuth = {
  accepted: true as const,
  method: 'google-oidc' as const,
  cronSecretValid: true,
  oidcPrincipal: CRON_PRINCIPAL,
  oidcEmailVerified: true,
  oidcAudience: SERVICE_URL,
};

const exactService = {
  serviceName: 'arkova-worker-s33-rig-b1-staging',
  serviceRevision: 'arkova-worker-s33-rig-b1-staging-00001-abc',
  serviceAudience: SERVICE_URL,
} as const;

describe('RIG-B1 durable Scheduler scenario gate', () => {
  it('derives one versioned execution identity from the exact job resource and canonical schedule time', () => {
    const value = deriveS33RigB1SchedulerExecutionIdentity(JOB, '2026-07-16T14:25:00-04:00');
    const canonical = '2026-07-16T18:25:00.000Z';
    const expected = `sha256:${createHash('sha256')
      .update(`arkova.s33.rig-b1.scheduler-execution/v1\0${JOB}\0${canonical}`)
      .digest('hex')}`;

    expect(value).toEqual({
      jobResource: JOB,
      scheduleTime: canonical,
      executionId: expected,
    });
  });

  it('rejects malformed resources, non-canonical jobs, bad timestamps, and duplicate header arrays', async () => {
    expect(() => deriveS33RigB1SchedulerExecutionIdentity('jobs/fake', SCHEDULE_TIME))
      .toThrow(/job resource/i);
    expect(() => deriveS33RigB1SchedulerExecutionIdentity(JOB, 'not-a-time'))
      .toThrow(/schedule time/i);

    await expect(gateS33RigB1ScenarioRequest({
      routePath: '/jobs/batch-anchors',
      headers: {
        'x-cloudscheduler': 'true',
        'x-cloudscheduler-jobname': [JOB, FORCED_JOB],
        'x-cloudscheduler-scheduletime': SCHEDULE_TIME,
      },
      auth: exactAuth,
      ...exactService,
    }, db('TARGET_EXECUTE'))).rejects.toThrow(/duplicate|array|job.*header/i);
  });

  it('lets ordinary authenticated requests through only when the database proves no active scenario lease', async () => {
    const store = db('NORMAL');
    const value = await gateS33RigB1ScenarioRequest({
      routePath: '/jobs/batch-anchors', headers: {},
      auth: {
        accepted: true, method: 'cron-secret', cronSecretValid: true,
        oidcPrincipal: null, oidcEmailVerified: false, oidcAudience: null,
      },
      ...exactService,
    }, store);

    expect(value).toEqual({ mode: 'NORMAL' });
    expect(store.rpc).toHaveBeenCalledWith('gate_s33_rig_b1_scenario_execution', expect.objectContaining({
      p_job_resource: null,
      p_schedule_time: null,
      p_auth_method: 'cron-secret',
      p_oidc_audience: null,
      p_service_name: exactService.serviceName,
      p_service_audience: exactService.serviceAudience,
    }));
  });

  it('admits the exact target only under both Scheduler OIDC and cron-secret authentication', async () => {
    const store = db('TARGET_EXECUTE');
    const value = await gateS33RigB1ScenarioRequest({
      routePath: '/jobs/batch-anchors',
      headers: {
        'x-cloudscheduler': 'true',
        'x-cloudscheduler-jobname': JOB,
        'x-cloudscheduler-scheduletime': SCHEDULE_TIME,
      },
      auth: exactAuth,
      ...exactService,
    }, store);

    expect(value).toMatchObject({
      mode: 'TARGET_EXECUTE',
      context: {
        generation: 7,
        schedulerExecutionId: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        schedulerJobResource: JOB,
        schedulerScheduleTime: '2026-07-16T18:25:00.000Z',
        namespaceId: 's33-b1-ns-001',
        faultWindowId: 'fault-overload-a1',
      },
    });
    expect(store.rpc).toHaveBeenCalledWith('gate_s33_rig_b1_scenario_execution', {
      p_job_resource: JOB,
      p_schedule_time: '2026-07-16T18:25:00.000Z',
      p_route_path: '/jobs/batch-anchors',
      p_worker_id: exactService.serviceRevision,
      p_auth_method: 'google-oidc',
      p_auth_accepted: true,
      p_cron_secret_valid: true,
      p_oidc_principal: CRON_PRINCIPAL,
      p_oidc_email_verified: true,
      p_oidc_audience: SERVICE_URL,
      p_service_name: exactService.serviceName,
      p_service_audience: SERVICE_URL,
    });
  });

  it('returns a truthful controlled skip for every non-target exact Scheduler job', async () => {
    const store = db('CONTROLLED_SKIP', FORCED_JOB);
    const value = await gateS33RigB1ScenarioRequest({
      routePath: '/jobs/batch-anchors?force=true',
      headers: {
        'x-cloudscheduler': 'true',
        'x-cloudscheduler-jobname': FORCED_JOB,
        'x-cloudscheduler-scheduletime': SCHEDULE_TIME,
      },
      auth: exactAuth,
      ...exactService,
    }, store);

    expect(value).toMatchObject({
      mode: 'CONTROLLED_SKIP',
      statusCode: 200,
      body: {
        controlledSkip: true,
        reason: 's33_rig_b1_non_target_during_active_scenario',
      },
    });
  });

  it.each([
    [{ ...exactAuth, cronSecretValid: false }, /cron secret/i],
    [{ ...exactAuth, oidcPrincipal: 'attacker@arkova1.iam.gserviceaccount.com' }, /OIDC principal/i],
    [{ ...exactAuth, oidcEmailVerified: false }, /verified OIDC email/i],
    [{ ...exactAuth, method: 'platform-admin' as const }, /OIDC/i],
  ])('fails closed when an active lease is returned to a non-exact caller', async (auth, message) => {
    await expect(gateS33RigB1ScenarioRequest({
      routePath: '/jobs/batch-anchors',
      headers: {
        'x-cloudscheduler': 'true',
        'x-cloudscheduler-jobname': JOB,
        'x-cloudscheduler-scheduletime': SCHEDULE_TIME,
      },
      auth,
      ...exactService,
    }, db('TARGET_EXECUTE'))).rejects.toThrow(message);
  });

  it('rejects the scenario context outside the exact private RIG-B1 service', async () => {
    await expect(gateS33RigB1ScenarioRequest({
      routePath: '/jobs/batch-anchors',
      headers: {
        'x-cloudscheduler': 'true',
        'x-cloudscheduler-jobname': JOB,
        'x-cloudscheduler-scheduletime': SCHEDULE_TIME,
      },
      auth: exactAuth,
      ...exactService,
      serviceName: 'arkova-worker-s33-rig-b1-staging-lookalike',
    }, db('TARGET_EXECUTE'))).rejects.toThrow(/private RIG-B1 (?:service|K_SERVICE)/i);
  });

  it('fails closed on an empty revision or mismatched verified OIDC audience', async () => {
    const base = {
      routePath: '/jobs/batch-anchors',
      headers: {
        'x-cloudscheduler': 'true',
        'x-cloudscheduler-jobname': JOB,
        'x-cloudscheduler-scheduletime': SCHEDULE_TIME,
      },
      auth: exactAuth,
      ...exactService,
    } as const;
    await expect(gateS33RigB1ScenarioRequest({ ...base, serviceRevision: '' }, db('TARGET_EXECUTE')))
      .rejects.toThrow(/K_REVISION/i);
    await expect(gateS33RigB1ScenarioRequest({
      ...base,
      auth: { ...exactAuth, oidcAudience: 'https://lookalike.example.run.app' },
    }, db('TARGET_EXECUTE'))).rejects.toThrow(/OIDC audience/i);
  });

  it('fails closed if durable target semantics are swapped', async () => {
    const request = {
      routePath: '/jobs/batch-anchors',
      headers: {
        'x-cloudscheduler': 'true',
        'x-cloudscheduler-jobname': JOB,
        'x-cloudscheduler-scheduletime': SCHEDULE_TIME,
      },
      auth: exactAuth,
      ...exactService,
    } as const;
    await expect(gateS33RigB1ScenarioRequest(
      request, db('TARGET_EXECUTE', JOB, FORCED_JOB),
    )).rejects.toThrow(/non-target/i);
    await expect(gateS33RigB1ScenarioRequest(
      request, db('CONTROLLED_SKIP', JOB, JOB),
    )).rejects.toThrow(/skip the armed target/i);
  });

  it('truthfully skips the target itself while its lease is still PREPARING', async () => {
    const value = await gateS33RigB1ScenarioRequest({
      routePath: '/jobs/batch-anchors',
      headers: {
        'x-cloudscheduler': 'true',
        'x-cloudscheduler-jobname': JOB,
        'x-cloudscheduler-scheduletime': SCHEDULE_TIME,
      },
      auth: exactAuth,
      ...exactService,
    }, db('PREPARING_SKIP'));
    expect(value).toMatchObject({
      mode: 'CONTROLLED_SKIP',
      body: { reason: 's33_rig_b1_preparing' },
    });
  });
});
