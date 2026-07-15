/**
 * Deterministic, offline-only Wave-3 drain driver and evidence validators.
 *
 * The driver freezes the exact 10k/12.5k Zipf workloads and three trigger
 * identities. It does not seed, schedule, broadcast, or contact a rig.
 */

import { createHash } from 'node:crypto';

import {
  buildR3AcceptancePlan,
  type OrgGlobalFlushExpectation,
  type OrgSchedulerExpectation,
} from './batch-drain-harness-lib';

const HEAD_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export type Wave3DrainTrigger = 'global-policy' | 'global-flush' | 'org-scheduler';

export interface Wave3DrainTriggerSpec {
  readonly trigger: Wave3DrainTrigger;
  readonly method: 'POST';
  readonly path: string;
  readonly body: null;
}

export const WAVE3_DRAIN_TRIGGER_SPECS: readonly Wave3DrainTriggerSpec[] = Object.freeze([
  Object.freeze({ trigger: 'global-policy', method: 'POST', path: '/jobs/batch-anchors', body: null }),
  Object.freeze({ trigger: 'global-flush', method: 'POST', path: '/jobs/batch-anchors?force=true', body: null }),
  Object.freeze({ trigger: 'org-scheduler', method: 'POST', path: '/jobs/org-queue-scheduler', body: null }),
]);

export interface Wave3TriggerIdentityCapture extends Wave3DrainTriggerSpec {
  readonly runId: string;
  readonly schedulerExecutionId: string;
  readonly gitHeadSha: string;
  readonly imageDigest: string;
  readonly planDigest: string;
}

export type BacklogPhase = 'over-capacity' | 'convergence';

export interface BacklogCycle {
  readonly cycle: number;
  readonly phase: BacklogPhase;
  readonly pendingBefore: number;
  readonly inflow: number;
  readonly pendingAfterInflow: number;
  readonly drainedLeaves: number;
  readonly pendingAfter: number;
}

export interface BacklogConvergencePlan {
  readonly capacity: 10_000;
  readonly inflowMultiplier: 1.25;
  readonly cycles: readonly BacklogCycle[];
}

export interface Wave3DrainDriverPlan {
  readonly mode: 'OFFLINE_PLAN_ONLY';
  readonly liveEvidenceStatus: 'DEFERRED_POST_WAVE3';
  readonly runId: string;
  readonly gitHeadSha: string;
  readonly imageDigest: string;
  readonly planDigest: string;
  readonly eligible10000: OrgGlobalFlushExpectation;
  readonly eligible12500: OrgGlobalFlushExpectation;
  readonly poisonIsolation: OrgGlobalFlushExpectation;
  readonly orgScheduler: OrgSchedulerExpectation;
  readonly backlog: BacklogConvergencePlan;
  readonly triggerIdentities: readonly Wave3TriggerIdentityCapture[];
}

export interface TriggerIdentityEvidenceSummary {
  readonly capturedTriggers: readonly Wave3DrainTrigger[];
  readonly exactIdentity: true;
}

export interface BacklogConvergenceEvidenceSummary {
  readonly overloadedCycles: number;
  readonly finalPending: number;
  readonly converged: true;
}

export interface PoisonIsolationRowObservation {
  rowId: string;
  status: 'drained' | 'pending-poison';
  transactionOrgId: string | null;
  proofOrgId: string | null;
  ledgerOrgId: string | null;
}

export interface PoisonIsolationEvidenceSummary {
  readonly totalRows: number;
  readonly poisonRows: number;
  readonly crossOrgLeaks: 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Cannot digest undefined driver data.');
  return encoded;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer.`);
}

function executionId(runId: string, trigger: Wave3DrainTrigger): string {
  return `sched-${trigger}-${createHash('sha256').update(`${runId}:${trigger}`).digest('hex').slice(0, 16)}`;
}

export function buildWave3DrainDriverPlan(input: {
  readonly runId: string;
  readonly gitHeadSha: string;
  readonly imageDigest: string;
  readonly orgs: number;
}): Wave3DrainDriverPlan {
  if (!input.runId?.trim()) throw new Error('Wave-3 drain driver runId is required.');
  if (!HEAD_SHA.test(input.gitHeadSha)) throw new Error('Wave-3 drain driver head must be lowercase 40-hex.');
  if (!IMAGE_DIGEST.test(input.imageDigest)) throw new Error('Wave-3 drain driver image digest is invalid.');
  if (!Number.isSafeInteger(input.orgs) || input.orgs < 30) {
    throw new Error(`Wave-3 drain driver requires at least 30 organizations; received ${input.orgs}.`);
  }

  const acceptance = buildR3AcceptancePlan({ runId: input.runId, orgs: input.orgs });
  const backlog: BacklogConvergencePlan = {
    capacity: 10_000,
    inflowMultiplier: 1.25,
    cycles: [
      {
        cycle: 1,
        phase: 'over-capacity',
        pendingBefore: 0,
        inflow: 12_500,
        pendingAfterInflow: 12_500,
        drainedLeaves: 10_000,
        pendingAfter: 2_500,
      },
      {
        cycle: 2,
        phase: 'over-capacity',
        pendingBefore: 2_500,
        inflow: 12_500,
        pendingAfterInflow: 15_000,
        drainedLeaves: 10_000,
        pendingAfter: 5_000,
      },
      {
        cycle: 3,
        phase: 'convergence',
        pendingBefore: 5_000,
        inflow: 0,
        pendingAfterInflow: 5_000,
        drainedLeaves: 5_000,
        pendingAfter: 0,
      },
    ],
  };
  const core = {
    mode: 'OFFLINE_PLAN_ONLY' as const,
    liveEvidenceStatus: 'DEFERRED_POST_WAVE3' as const,
    runId: input.runId,
    gitHeadSha: input.gitHeadSha,
    imageDigest: input.imageDigest,
    eligible10000: acceptance.globalEligible10000,
    eligible12500: acceptance.globalEligible12500,
    poisonIsolation: acceptance.poisonIsolation,
    orgScheduler: acceptance.orgScheduler,
    backlog,
  };
  const planDigest = sha256(core);
  const triggerIdentities = WAVE3_DRAIN_TRIGGER_SPECS.map((spec): Wave3TriggerIdentityCapture => ({
    ...spec,
    runId: input.runId,
    schedulerExecutionId: executionId(input.runId, spec.trigger),
    gitHeadSha: input.gitHeadSha,
    imageDigest: input.imageDigest,
    planDigest,
  }));
  return deepFreeze({ ...core, planDigest, triggerIdentities });
}

export function assertTriggerIdentityCaptures(
  plan: Wave3DrainDriverPlan,
  captures: readonly Wave3TriggerIdentityCapture[],
): TriggerIdentityEvidenceSummary {
  if (captures.length !== plan.triggerIdentities.length) {
    throw new Error('Trigger identity capture must contain exactly three trigger identities.');
  }
  const executionIds = new Set<string>();
  plan.triggerIdentities.forEach((expected, index) => {
    const actual = captures[index];
    if (!actual) throw new Error(`Trigger identity capture ${index} is missing.`);
    if (actual.schedulerExecutionId !== expected.schedulerExecutionId) {
      throw new Error(`${expected.trigger} execution identity mismatch or reuse.`);
    }
    if (executionIds.has(actual.schedulerExecutionId)) {
      throw new Error('Trigger scheduler execution IDs must be unique and cannot be reused.');
    }
    executionIds.add(actual.schedulerExecutionId);
    if (
      actual.trigger !== expected.trigger
      || actual.method !== expected.method
      || actual.path !== expected.path
      || actual.body !== null
      || actual.runId !== plan.runId
      || actual.gitHeadSha !== plan.gitHeadSha
      || actual.imageDigest !== plan.imageDigest
      || actual.planDigest !== plan.planDigest
    ) throw new Error(`${expected.trigger} path, body, head, image, or plan identity mismatch.`);
  });
  return deepFreeze({
    capturedTriggers: plan.triggerIdentities.map(({ trigger }) => trigger),
    exactIdentity: true as const,
  });
}

export function assertBacklogConvergenceObservation(
  plan: BacklogConvergencePlan,
  cycles: readonly BacklogCycle[],
): BacklogConvergenceEvidenceSummary {
  if (cycles.length !== plan.cycles.length) {
    throw new Error('Backlog observation must contain the exact planned drain cycles.');
  }
  cycles.forEach((actual, index) => {
    const expected = plan.cycles[index]!;
    for (const [field, value] of Object.entries(actual)) {
      if (typeof value === 'number') requireNonNegativeInteger(value, `cycles[${index}].${field}`);
    }
    if (
      actual.pendingAfterInflow !== actual.pendingBefore + actual.inflow
      || actual.pendingAfter !== actual.pendingAfterInflow - actual.drainedLeaves
      || actual.drainedLeaves > plan.capacity
    ) throw new Error(`Backlog cycle ${actual.cycle} has an invalid pending remainder.`);
    if (index > 0 && actual.pendingBefore !== cycles[index - 1]!.pendingAfter) {
      throw new Error(`Backlog cycle ${actual.cycle} does not continue the prior pending remainder.`);
    }
    if (stableJson(actual) !== stableJson(expected)) {
      throw new Error(`Backlog cycle ${actual.cycle} does not match the exact convergence plan.`);
    }
  });
  const finalPending = cycles.at(-1)?.pendingAfter;
  if (finalPending !== 0) throw new Error('Backlog final cycle did not converge to zero pending rows.');
  return deepFreeze({
    overloadedCycles: cycles.filter(({ phase }) => phase === 'over-capacity').length,
    finalPending,
    converged: true as const,
  });
}

export function assertPoisonIsolationAndLeakage(
  plan: OrgGlobalFlushExpectation,
  rows: readonly PoisonIsolationRowObservation[],
): PoisonIsolationEvidenceSummary {
  if (rows.length !== plan.orderedRows.length) {
    throw new Error('Poison isolation observation must contain every exact planned row.');
  }
  const poisonOrgs = new Set(plan.poisons.map(({ orgId }) => orgId));
  const rowIds = new Set<string>();
  let poisonRows = 0;
  plan.orderedRows.forEach((expected, index) => {
    const actual = rows[index];
    if (!actual || actual.rowId !== expected.rowId) {
      throw new Error(`Poison isolation row ${index} does not match exact planned ownership order.`);
    }
    if (rowIds.has(actual.rowId)) throw new Error(`Duplicate poison-isolation row ${actual.rowId}.`);
    rowIds.add(actual.rowId);
    if (poisonOrgs.has(expected.orgId)) {
      poisonRows += 1;
      if (
        actual.status !== 'pending-poison'
        || actual.transactionOrgId !== null
        || actual.proofOrgId !== null
        || actual.ledgerOrgId !== null
      ) throw new Error(`Poison row ${actual.rowId} violated pending isolation.`);
      return;
    }
    if (
      actual.status !== 'drained'
      || actual.transactionOrgId !== expected.orgId
      || actual.proofOrgId !== expected.orgId
      || actual.ledgerOrgId !== expected.orgId
    ) throw new Error(`Healthy row ${actual.rowId} has a cross-org ownership leak.`);
  });
  if (poisonRows !== plan.finalPending) {
    throw new Error('Poison pending count does not match the exact isolation plan.');
  }
  return deepFreeze({ totalRows: rows.length, poisonRows, crossOrgLeaks: 0 as const });
}
