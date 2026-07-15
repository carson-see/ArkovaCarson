import { describe, expect, it } from 'vitest';

import {
  assertBacklogConvergenceObservation,
  assertPoisonIsolationAndLeakage,
  assertTriggerIdentityCaptures,
  buildWave3DrainDriverPlan,
  digestWave3TriggerObservation,
  type PoisonIsolationRowObservation,
  type Wave3TriggerObservation,
} from './batch-drain-wave3-driver';

const HEAD_SHA = 'a'.repeat(40);
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;

function buildPlan() {
  return buildWave3DrainDriverPlan({
    runId: 's33-w3-b-offline-driver',
    gitHeadSha: HEAD_SHA,
    imageDigest: IMAGE_DIGEST,
    orgs: 30,
  });
}

function triggerObservations(): Wave3TriggerObservation[] {
  const plan = buildPlan();
  return plan.triggerExecutionPlan.map((execution, index) => {
    const observation = {
      ...structuredClone(execution),
      observedAt: `2026-07-16T12:${String(index * 5).padStart(2, '0')}:00.000Z`,
      evidenceArtifactSha256: `sha256:${String(index + 1).repeat(64)}`,
    };
    return {
      ...observation,
      observationDigestSha256: digestWave3TriggerObservation(observation),
    };
  });
}

describe('Wave 3 B deterministic 10k/12.5k drain driver', () => {
  it('builds deterministic >=30-org Zipf drivers with exact 10k and 12.5k totals', () => {
    const first = buildPlan();
    const second = buildPlan();

    expect(first).toEqual(second);
    expect(first.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.eligible10000.orgInputs).toHaveLength(30);
    expect(first.eligible10000.initialPending).toBe(10_000);
    expect(first.eligible10000.orgInputs.reduce((sum, row) => sum + row.anchors, 0)).toBe(10_000);
    expect(first.eligible12500.orgInputs).toHaveLength(30);
    expect(first.eligible12500.initialPending).toBe(12_500);
    expect(first.eligible12500.orgInputs.reduce((sum, row) => sum + row.anchors, 0)).toBe(12_500);
    expect(first.eligible12500.passes.map(({ leaves, pendingRemainder }) => ({ leaves, pendingRemainder })))
      .toEqual([
        { leaves: 10_000, pendingRemainder: 2_500 },
        { leaves: 2_500, pendingRemainder: 0 },
      ]);
    expect(first.poisonIsolation.poisons.length).toBeGreaterThan(0);
  });

  it('fails closed below 30 organizations', () => {
    expect(() => buildWave3DrainDriverPlan({
      runId: 'too-small', gitHeadSha: HEAD_SHA, imageDigest: IMAGE_DIGEST, orgs: 29,
    })).toThrow(/at least 30/i);
  });

  it('rejects non-canonical or overlong run identities before digesting the plan', () => {
    for (const runId of ['', ' leading-space', 'trailing-space ', 'x'.repeat(129)]) {
      expect(() => buildWave3DrainDriverPlan({
        runId, gitHeadSha: HEAD_SHA, imageDigest: IMAGE_DIGEST, orgs: 30,
      })).toThrow(/runId|1-128|whitespace/i);
    }
  });
});

describe('exact Trigger A/B/D cause and identity capture', () => {
  it('binds two size cycles, age convergence, and force control to exact causes and immutable identities', () => {
    const plan = buildPlan();
    expect(plan.triggerExecutionPlan).toEqual([
      expect.objectContaining({
        trigger: 'trigger-a-size', cause: 'SIZE_THRESHOLD',
        method: 'POST', path: '/jobs/batch-anchors', body: null,
        preconditions: { pending: 12_500, oldestPendingAgeSeconds: null, force: false },
        remainder: {
          stateId: 'over-capacity-cycle-1', pendingBefore: 12_500,
          drainedLeaves: 10_000, pendingAfter: 2_500, converged: false,
        },
        gitHeadSha: HEAD_SHA, imageDigest: IMAGE_DIGEST, planDigest: plan.planDigest,
      }),
      expect.objectContaining({
        trigger: 'trigger-a-size', cause: 'SIZE_THRESHOLD',
        method: 'POST', path: '/jobs/batch-anchors', body: null,
        preconditions: { pending: 15_000, oldestPendingAgeSeconds: null, force: false },
        remainder: {
          stateId: 'over-capacity-cycle-2', pendingBefore: 15_000,
          drainedLeaves: 10_000, pendingAfter: 5_000, converged: false,
        },
        gitHeadSha: HEAD_SHA, imageDigest: IMAGE_DIGEST, planDigest: plan.planDigest,
      }),
      expect.objectContaining({
        trigger: 'trigger-b-age', cause: 'AGE_THRESHOLD',
        method: 'POST', path: '/jobs/batch-anchors', body: null,
        preconditions: { pending: 5_000, oldestPendingAgeSeconds: 10_800, force: false },
        remainder: {
          stateId: 'convergence-cycle-3', pendingBefore: 5_000,
          drainedLeaves: 5_000, pendingAfter: 0, converged: true,
        },
        gitHeadSha: HEAD_SHA, imageDigest: IMAGE_DIGEST, planDigest: plan.planDigest,
      }),
      expect.objectContaining({
        trigger: 'trigger-d-force', cause: 'FORCE',
        method: 'POST', path: '/jobs/batch-anchors?force=true', body: null,
        preconditions: { pending: 2_500, oldestPendingAgeSeconds: 0, force: true },
        remainder: {
          stateId: 'forced-control', pendingBefore: 2_500,
          drainedLeaves: 2_500, pendingAfter: 0, converged: true,
        },
        gitHeadSha: HEAD_SHA, imageDigest: IMAGE_DIGEST, planDigest: plan.planDigest,
      }),
      expect.objectContaining({
        trigger: 'org-scheduler', cause: 'ORG_SCHEDULER',
        method: 'POST', path: '/jobs/org-queue-scheduler', body: null,
        gitHeadSha: HEAD_SHA, imageDigest: IMAGE_DIGEST, planDigest: plan.planDigest,
      }),
    ]);
    const observations = triggerObservations();
    expect(new Set(observations.map(({ schedulerExecutionId }) => schedulerExecutionId)).size).toBe(5);
    expect(new Set(observations.map(({ evidenceArtifactSha256 }) => evidenceArtifactSha256)).size).toBe(5);
    expect(assertTriggerIdentityCaptures(plan, observations)).toMatchObject({
      capturedTriggers: ['trigger-a-size', 'trigger-b-age', 'trigger-d-force'],
      orgSchedulerCaptured: true,
      executionCount: 5,
      exactIdentity: true,
    });
  });

  it('rejects route-only/collapsed A+B, execution reuse, stale heads, and mutable evidence identity', () => {
    const plan = buildPlan();
    const valid = triggerObservations();

    const collapsed = structuredClone(valid);
    collapsed[2] = {
      ...collapsed[2]!,
      trigger: 'trigger-a-size',
      cause: 'SIZE_THRESHOLD',
      preconditions: { ...collapsed[0]!.preconditions },
    };
    collapsed[2]!.observationDigestSha256 = digestWave3TriggerObservation(collapsed[2]!);
    expect(() => assertTriggerIdentityCaptures(plan, collapsed)).toThrow(/Trigger B|cause|precondition|collapsed/i);

    const reused = structuredClone(valid);
    reused[1] = { ...reused[1]!, schedulerExecutionId: reused[0]!.schedulerExecutionId };
    reused[1]!.observationDigestSha256 = digestWave3TriggerObservation(reused[1]!);
    expect(() => assertTriggerIdentityCaptures(plan, reused)).toThrow(/execution|unique|reuse/i);

    const stale = structuredClone(valid);
    stale[2] = { ...stale[2]!, gitHeadSha: 'c'.repeat(40) };
    stale[2]!.observationDigestSha256 = digestWave3TriggerObservation(stale[2]!);
    expect(() => assertTriggerIdentityCaptures(plan, stale)).toThrow(/head|identity/i);

    const mutableEvidence = structuredClone(valid);
    mutableEvidence[0] = {
      ...mutableEvidence[0]!,
      remainder: { ...mutableEvidence[0]!.remainder, pendingAfter: 2_499 },
    };
    expect(() => assertTriggerIdentityCaptures(plan, mutableEvidence)).toThrow(/digest|remainder|identity/i);
  });

  it('rejects a dropped org-scheduler execution and unknown top-level or nested observation fields', () => {
    const plan = buildPlan();
    const droppedOrgScheduler = triggerObservations().slice(0, 4);
    expect(() => assertTriggerIdentityCaptures(plan, droppedOrgScheduler))
      .toThrow(/org.scheduler|five|exact/i);

    const extraTopLevel = structuredClone(triggerObservations()) as unknown as Array<Record<string, unknown>>;
    extraTopLevel[0]!.secret = 'must-not-survive';
    expect(() => assertTriggerIdentityCaptures(plan, extraTopLevel))
      .toThrow(/unrecognized|unknown|strict|secret/i);

    const extraNested = structuredClone(triggerObservations()) as unknown as Array<Record<string, unknown>>;
    (extraNested[2]!.preconditions as Record<string, unknown>).routeOnlyAlias = true;
    expect(() => assertTriggerIdentityCaptures(plan, extraNested))
      .toThrow(/unrecognized|unknown|strict|routeOnlyAlias/i);

    const paddedIdentity = structuredClone(triggerObservations());
    paddedIdentity[0] = { ...paddedIdentity[0]!, runId: ` ${paddedIdentity[0]!.runId}` };
    paddedIdentity[0]!.observationDigestSha256 = digestWave3TriggerObservation(paddedIdentity[0]!);
    expect(() => assertTriggerIdentityCaptures(plan, paddedIdentity))
      .toThrow(/runId|whitespace|identity/i);
  });

  it('rejects Trigger A below 10k, Trigger B outside 3k..<10k or younger than 3h, and non-forced D', () => {
    const plan = buildPlan();
    const aBelow = triggerObservations();
    aBelow[0] = {
      ...aBelow[0]!,
      preconditions: { ...aBelow[0]!.preconditions, pending: 9_999 },
    };
    aBelow[0]!.observationDigestSha256 = digestWave3TriggerObservation(aBelow[0]!);
    expect(() => assertTriggerIdentityCaptures(plan, aBelow)).toThrow(/Trigger A|10,?000|precondition/i);

    const bTooYoung = triggerObservations();
    bTooYoung[2] = {
      ...bTooYoung[2]!,
      preconditions: { ...bTooYoung[2]!.preconditions, oldestPendingAgeSeconds: 10_799 },
    };
    bTooYoung[2]!.observationDigestSha256 = digestWave3TriggerObservation(bTooYoung[2]!);
    expect(() => assertTriggerIdentityCaptures(plan, bTooYoung)).toThrow(/Trigger B|3h|precondition/i);

    const dUnforced = triggerObservations();
    dUnforced[3] = {
      ...dUnforced[3]!,
      preconditions: { ...dUnforced[3]!.preconditions, force: false },
    };
    dUnforced[3]!.observationDigestSha256 = digestWave3TriggerObservation(dUnforced[3]!);
    expect(() => assertTriggerIdentityCaptures(plan, dUnforced)).toThrow(/Trigger D|force|precondition/i);
  });
});

describe('1.25x backlog and poison isolation', () => {
  it('plans two overloaded cycles and converges after inflow stops', () => {
    const plan = buildPlan();
    expect(plan.backlog.capacity).toBe(10_000);
    expect(plan.backlog.inflowMultiplier).toBe(1.25);
    expect(plan.backlog.cycles).toEqual([
      {
        cycle: 1, phase: 'over-capacity', pendingBefore: 0, inflow: 12_500,
        pendingAfterInflow: 12_500, drainedLeaves: 10_000, pendingAfter: 2_500,
      },
      {
        cycle: 2, phase: 'over-capacity', pendingBefore: 2_500, inflow: 12_500,
        pendingAfterInflow: 15_000, drainedLeaves: 10_000, pendingAfter: 5_000,
      },
      {
        cycle: 3, phase: 'convergence', pendingBefore: 5_000, inflow: 0,
        pendingAfterInflow: 5_000, drainedLeaves: 5_000, pendingAfter: 0,
      },
    ]);
    expect(assertBacklogConvergenceObservation(plan.backlog, structuredClone(plan.backlog.cycles)))
      .toMatchObject({ overloadedCycles: 2, finalPending: 0, converged: true });
  });

  it('rejects an incorrect 10k/2.5k remainder or a non-converging final cycle', () => {
    const plan = buildPlan();
    const wrongRemainder = plan.backlog.cycles.map((cycle) => ({ ...cycle }));
    wrongRemainder[0] = { ...wrongRemainder[0]!, pendingAfter: 2_499 };
    expect(() => assertBacklogConvergenceObservation(plan.backlog, wrongRemainder))
      .toThrow(/remainder|cycle|pending/i);

    const stuck = plan.backlog.cycles.map((cycle) => ({ ...cycle }));
    stuck[2] = { ...stuck[2]!, drainedLeaves: 4_999, pendingAfter: 1 };
    expect(() => assertBacklogConvergenceObservation(plan.backlog, stuck))
      .toThrow(/converge|final|cycle|pending/i);
  });

  it('accepts only exact healthy-row ownership while poison rows remain isolated and pending', () => {
    const plan = buildPlan();
    const poisonOrgs = new Set(plan.poisonIsolation.poisons.map(({ orgId }) => orgId));
    const rows: PoisonIsolationRowObservation[] = plan.poisonIsolation.orderedRows.map((row) => ({
      rowId: row.rowId,
      status: poisonOrgs.has(row.orgId) ? 'pending-poison' : 'drained',
      transactionOrgId: poisonOrgs.has(row.orgId) ? null : row.orgId,
      proofOrgId: poisonOrgs.has(row.orgId) ? null : row.orgId,
      ledgerOrgId: poisonOrgs.has(row.orgId) ? null : row.orgId,
    }));

    expect(assertPoisonIsolationAndLeakage(plan.poisonIsolation, rows)).toMatchObject({
      totalRows: 12_500,
      poisonRows: plan.poisonIsolation.finalPending,
      crossOrgLeaks: 0,
    });

    const leaked = structuredClone(rows);
    const healthyIndex = leaked.findIndex(({ status }) => status === 'drained');
    leaked[healthyIndex] = { ...leaked[healthyIndex]!, proofOrgId: 'org-cross-tenant' };
    expect(() => assertPoisonIsolationAndLeakage(plan.poisonIsolation, leaked)).toThrow(/cross-org|leak|ownership/i);

    const contaminated = structuredClone(rows);
    const poisonIndex = contaminated.findIndex(({ status }) => status === 'pending-poison');
    contaminated[poisonIndex] = {
      ...contaminated[poisonIndex]!,
      status: 'drained',
      transactionOrgId: 'org-cross-tenant',
      proofOrgId: 'org-cross-tenant',
      ledgerOrgId: 'org-cross-tenant',
    };
    expect(() => assertPoisonIsolationAndLeakage(plan.poisonIsolation, contaminated))
      .toThrow(/poison|pending|isolation/i);
  });
});
