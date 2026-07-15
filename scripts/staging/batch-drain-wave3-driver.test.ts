import { describe, expect, it } from 'vitest';

import {
  assertBacklogConvergenceObservation,
  assertPoisonIsolationAndLeakage,
  assertTriggerIdentityCaptures,
  buildWave3DrainDriverPlan,
  type PoisonIsolationRowObservation,
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
});

describe('exact global-policy/global-flush/org-scheduler identity capture', () => {
  it('binds distinct execution IDs to the exact POST path, empty body, head, image, and plan digest', () => {
    const plan = buildPlan();
    expect(plan.triggerIdentities).toEqual([
      expect.objectContaining({
        trigger: 'global-policy', method: 'POST', path: '/jobs/batch-anchors', body: null,
        gitHeadSha: HEAD_SHA, imageDigest: IMAGE_DIGEST, planDigest: plan.planDigest,
      }),
      expect.objectContaining({
        trigger: 'global-flush', method: 'POST', path: '/jobs/batch-anchors?force=true', body: null,
        gitHeadSha: HEAD_SHA, imageDigest: IMAGE_DIGEST, planDigest: plan.planDigest,
      }),
      expect.objectContaining({
        trigger: 'org-scheduler', method: 'POST', path: '/jobs/org-queue-scheduler', body: null,
        gitHeadSha: HEAD_SHA, imageDigest: IMAGE_DIGEST, planDigest: plan.planDigest,
      }),
    ]);
    expect(new Set(plan.triggerIdentities.map(({ schedulerExecutionId }) => schedulerExecutionId)).size).toBe(3);
    expect(assertTriggerIdentityCaptures(plan, structuredClone(plan.triggerIdentities))).toMatchObject({
      capturedTriggers: ['global-policy', 'global-flush', 'org-scheduler'],
      exactIdentity: true,
    });
  });

  it('rejects route-based trigger collapse, execution reuse, stale heads, and non-empty request bodies', () => {
    const plan = buildPlan();

    const collapsed = plan.triggerIdentities.map((identity) => ({ ...identity }));
    collapsed[0] = { ...collapsed[0]!, path: '/jobs/batch-anchors?force=true' };
    expect(() => assertTriggerIdentityCaptures(plan, collapsed)).toThrow(/global-policy|path|identity/i);

    const reused = plan.triggerIdentities.map((identity) => ({ ...identity }));
    reused[1] = { ...reused[1]!, schedulerExecutionId: reused[0]!.schedulerExecutionId };
    expect(() => assertTriggerIdentityCaptures(plan, reused)).toThrow(/execution|unique|reuse/i);

    const stale = plan.triggerIdentities.map((identity) => ({ ...identity }));
    stale[2] = { ...stale[2]!, gitHeadSha: 'c'.repeat(40) };
    expect(() => assertTriggerIdentityCaptures(plan, stale)).toThrow(/head|identity/i);

    const body = plan.triggerIdentities.map((identity) => ({ ...identity }));
    body[1] = { ...body[1]!, body: {} as never };
    expect(() => assertTriggerIdentityCaptures(plan, body)).toThrow(/body|empty|identity/i);
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
