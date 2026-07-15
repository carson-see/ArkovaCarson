/**
 * Deterministic, offline-only Wave-3 drain driver and evidence validators.
 *
 * The driver freezes the exact 10k/12.5k Zipf workloads and the distinct
 * Trigger A/A/B/D plus org-scheduler executions. It does not seed, schedule,
 * broadcast, or contact a rig.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  buildR3AcceptancePlan,
  type OrgGlobalFlushExpectation,
  type OrgSchedulerExpectation,
} from './batch-drain-harness-lib';
import { parseUtcTimestamp } from './batch-drain-time';

const HEAD_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export type Wave3DrainTrigger =
  | 'trigger-a-size'
  | 'trigger-b-age'
  | 'trigger-d-force'
  | 'org-scheduler';
export type Wave3DrainTriggerCause =
  | 'SIZE_THRESHOLD'
  | 'AGE_THRESHOLD'
  | 'FORCE'
  | 'ORG_SCHEDULER';

export interface Wave3DrainTriggerSpec {
  readonly trigger: Wave3DrainTrigger;
  readonly cause: Wave3DrainTriggerCause;
  readonly method: 'POST';
  readonly path: string;
  readonly body: null;
  readonly policy: Readonly<{
    force: boolean;
    pendingMinimum: number;
    pendingMaximumExclusive: number | null;
    oldestPendingAgeMinimumSeconds: number | null;
  }>;
}

export const WAVE3_DRAIN_TRIGGER_SPECS: readonly Wave3DrainTriggerSpec[] = Object.freeze([
  deepFreeze<Wave3DrainTriggerSpec>({
    trigger: 'trigger-a-size', cause: 'SIZE_THRESHOLD', method: 'POST',
    path: '/jobs/batch-anchors', body: null,
    policy: {
      force: false, pendingMinimum: 10_000, pendingMaximumExclusive: null,
      oldestPendingAgeMinimumSeconds: null,
    },
  }),
  deepFreeze<Wave3DrainTriggerSpec>({
    trigger: 'trigger-b-age', cause: 'AGE_THRESHOLD', method: 'POST',
    path: '/jobs/batch-anchors', body: null,
    policy: {
      force: false, pendingMinimum: 3_000, pendingMaximumExclusive: 10_000,
      oldestPendingAgeMinimumSeconds: 3 * 60 * 60,
    },
  }),
  deepFreeze<Wave3DrainTriggerSpec>({
    trigger: 'trigger-d-force', cause: 'FORCE', method: 'POST',
    path: '/jobs/batch-anchors?force=true', body: null,
    policy: {
      force: true, pendingMinimum: 0, pendingMaximumExclusive: null,
      oldestPendingAgeMinimumSeconds: null,
    },
  }),
  deepFreeze<Wave3DrainTriggerSpec>({
    trigger: 'org-scheduler', cause: 'ORG_SCHEDULER', method: 'POST',
    path: '/jobs/org-queue-scheduler', body: null,
    policy: {
      force: false, pendingMinimum: 1, pendingMaximumExclusive: null,
      oldestPendingAgeMinimumSeconds: null,
    },
  }),
]);

export interface Wave3TriggerPreconditions {
  pending: number;
  oldestPendingAgeSeconds: number | null;
  force: boolean;
}

export interface Wave3TriggerRemainderState {
  stateId:
    | 'over-capacity-cycle-1'
    | 'over-capacity-cycle-2'
    | 'convergence-cycle-3'
    | 'forced-control'
    | 'org-scheduler-control';
  pendingBefore: number;
  drainedLeaves: number;
  pendingAfter: number;
  converged: boolean;
}

export interface Wave3TriggerExecutionExpectation extends Wave3DrainTriggerSpec {
  readonly runId: string;
  readonly executionOrdinal: number;
  readonly schedulerExecutionId: string;
  readonly gitHeadSha: string;
  readonly imageDigest: string;
  readonly planDigest: string;
  readonly preconditions: Readonly<Wave3TriggerPreconditions>;
  readonly remainder: Readonly<Wave3TriggerRemainderState>;
}

export interface Wave3TriggerObservation extends Wave3TriggerExecutionExpectation {
  observedAt: string;
  evidenceArtifactSha256: string;
  observationDigestSha256: string;
}

export type Wave3TriggerIdentityCapture = Wave3TriggerObservation;

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
  readonly triggerSpecs: readonly Wave3DrainTriggerSpec[];
  readonly triggerExecutionPlan: readonly Wave3TriggerExecutionExpectation[];
}

export interface TriggerIdentityEvidenceSummary {
  readonly capturedTriggers: readonly [
    'trigger-a-size',
    'trigger-b-age',
    'trigger-d-force',
  ];
  readonly orgSchedulerCaptured: true;
  readonly executionCount: 5;
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

const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const canonicalRunIdSchema = z.string().min(1).max(128).refine(
  (value) => value === value.trim(),
  'runId must not contain leading or trailing whitespace',
);
const canonicalExecutionIdSchema = z.string().min(1).max(255).refine(
  (value) => value === value.trim(),
  'schedulerExecutionId must not contain leading or trailing whitespace',
);
const triggerPolicySchema = z.object({
  force: z.boolean(),
  pendingMinimum: nonNegativeSafeIntegerSchema,
  pendingMaximumExclusive: nonNegativeSafeIntegerSchema.nullable(),
  oldestPendingAgeMinimumSeconds: nonNegativeSafeIntegerSchema.nullable(),
}).strict();
const triggerPreconditionsSchema = z.object({
  pending: nonNegativeSafeIntegerSchema,
  oldestPendingAgeSeconds: nonNegativeSafeIntegerSchema.nullable(),
  force: z.boolean(),
}).strict();
const triggerRemainderSchema = z.object({
  stateId: z.enum([
    'over-capacity-cycle-1',
    'over-capacity-cycle-2',
    'convergence-cycle-3',
    'forced-control',
    'org-scheduler-control',
  ]),
  pendingBefore: nonNegativeSafeIntegerSchema,
  drainedLeaves: nonNegativeSafeIntegerSchema,
  pendingAfter: nonNegativeSafeIntegerSchema,
  converged: z.boolean(),
}).strict();
const triggerObservationSchema = z.object({
  trigger: z.enum([
    'trigger-a-size',
    'trigger-b-age',
    'trigger-d-force',
    'org-scheduler',
  ]),
  cause: z.enum(['SIZE_THRESHOLD', 'AGE_THRESHOLD', 'FORCE', 'ORG_SCHEDULER']),
  method: z.literal('POST'),
  path: z.enum([
    '/jobs/batch-anchors',
    '/jobs/batch-anchors?force=true',
    '/jobs/org-queue-scheduler',
  ]),
  body: z.null(),
  policy: triggerPolicySchema,
  runId: canonicalRunIdSchema,
  executionOrdinal: z.number().int().positive().safe(),
  schedulerExecutionId: canonicalExecutionIdSchema,
  gitHeadSha: z.string().regex(HEAD_SHA),
  imageDigest: z.string().regex(IMAGE_DIGEST),
  planDigest: z.string().regex(IMAGE_DIGEST),
  preconditions: triggerPreconditionsSchema,
  remainder: triggerRemainderSchema,
  observedAt: z.string(),
  evidenceArtifactSha256: z.string().regex(IMAGE_DIGEST),
  observationDigestSha256: z.string().regex(IMAGE_DIGEST),
}).strict();

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

function executionId(runId: string, trigger: Wave3DrainTrigger, ordinal: number): string {
  return `sched-${trigger}-${ordinal}-${createHash('sha256')
    .update(`${runId}:${trigger}:${ordinal}`).digest('hex').slice(0, 16)}`;
}

type TriggerExecutionShape = Omit<
  Wave3TriggerExecutionExpectation,
  'runId' | 'schedulerExecutionId' | 'gitHeadSha' | 'imageDigest' | 'planDigest'
>;

function triggerSpec(trigger: Wave3DrainTrigger): Wave3DrainTriggerSpec {
  const spec = WAVE3_DRAIN_TRIGGER_SPECS.find((candidate) => candidate.trigger === trigger);
  if (!spec) throw new Error(`Missing Wave-3 trigger specification for ${trigger}.`);
  return spec;
}

function buildTriggerExecutionShapes(
  orgScheduler: OrgSchedulerExpectation,
): TriggerExecutionShape[] {
  const size = triggerSpec('trigger-a-size');
  const age = triggerSpec('trigger-b-age');
  const force = triggerSpec('trigger-d-force');
  const org = triggerSpec('org-scheduler');
  const healthyPending = orgScheduler.passes.reduce(
    (total, pass) => total + pass.transactions.reduce(
      (passTotal, transaction) => passTotal + transaction.leaves,
      0,
    ),
    0,
  );
  const poisonPending = orgScheduler.poisons.reduce(
    (total, poison) => total + poison.anchorsRemaining,
    0,
  );
  const orgPending = healthyPending + poisonPending;
  const firstOrgDrain = orgScheduler.passes[0]?.transactions.reduce(
    (total, transaction) => total + transaction.leaves,
    0,
  ) ?? 0;
  if (orgPending < 1 || firstOrgDrain < 1 || firstOrgDrain > orgPending) {
    throw new Error('Org-scheduler trigger execution requires a non-empty exact first pass.');
  }
  return [
    {
      ...size,
      executionOrdinal: 1,
      preconditions: { pending: 12_500, oldestPendingAgeSeconds: null, force: false },
      remainder: {
        stateId: 'over-capacity-cycle-1', pendingBefore: 12_500,
        drainedLeaves: 10_000, pendingAfter: 2_500, converged: false,
      },
    },
    {
      ...size,
      executionOrdinal: 2,
      preconditions: { pending: 15_000, oldestPendingAgeSeconds: null, force: false },
      remainder: {
        stateId: 'over-capacity-cycle-2', pendingBefore: 15_000,
        drainedLeaves: 10_000, pendingAfter: 5_000, converged: false,
      },
    },
    {
      ...age,
      executionOrdinal: 1,
      preconditions: { pending: 5_000, oldestPendingAgeSeconds: 3 * 60 * 60, force: false },
      remainder: {
        stateId: 'convergence-cycle-3', pendingBefore: 5_000,
        drainedLeaves: 5_000, pendingAfter: 0, converged: true,
      },
    },
    {
      ...force,
      executionOrdinal: 1,
      preconditions: { pending: 2_500, oldestPendingAgeSeconds: 0, force: true },
      remainder: {
        stateId: 'forced-control', pendingBefore: 2_500,
        drainedLeaves: 2_500, pendingAfter: 0, converged: true,
      },
    },
    {
      ...org,
      executionOrdinal: 1,
      preconditions: {
        pending: orgPending,
        oldestPendingAgeSeconds: null,
        force: false,
      },
      remainder: {
        stateId: 'org-scheduler-control',
        pendingBefore: orgPending,
        drainedLeaves: firstOrgDrain,
        pendingAfter: orgPending - firstOrgDrain,
        converged: orgPending - firstOrgDrain === 0,
      },
    },
  ];
}

export function buildWave3DrainDriverPlan(input: {
  readonly runId: string;
  readonly gitHeadSha: string;
  readonly imageDigest: string;
  readonly orgs: number;
}): Wave3DrainDriverPlan {
  if (
    !input.runId
    || input.runId !== input.runId.trim()
    || input.runId.length > 128
  ) throw new Error('Wave-3 drain driver runId must be 1-128 non-whitespace-trimmed characters.');
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
  const triggerSpecs = WAVE3_DRAIN_TRIGGER_SPECS.map((spec) => ({ ...spec }));
  const triggerExecutionShapes = buildTriggerExecutionShapes(acceptance.orgScheduler);
  const publicCore = {
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
    triggerSpecs,
  };
  const planDigest = sha256({ ...publicCore, triggerExecutionShapes });
  const triggerExecutionPlan = triggerExecutionShapes.map((shape): Wave3TriggerExecutionExpectation => ({
    ...shape,
    runId: input.runId,
    schedulerExecutionId: executionId(input.runId, shape.trigger, shape.executionOrdinal),
    gitHeadSha: input.gitHeadSha,
    imageDigest: input.imageDigest,
    planDigest,
  }));
  return deepFreeze({ ...publicCore, planDigest, triggerExecutionPlan });
}

export function digestWave3TriggerObservation(
  observation: Omit<Wave3TriggerObservation, 'observationDigestSha256'> | Wave3TriggerObservation,
): string {
  const digestInput = Object.fromEntries(
    Object.entries(observation).filter(([key]) => key !== 'observationDigestSha256'),
  );
  return sha256(digestInput);
}

function assertTriggerCausePreconditions(observation: Wave3TriggerObservation): void {
  const { pending, oldestPendingAgeSeconds, force } = observation.preconditions;
  requireNonNegativeInteger(pending, `${observation.trigger}.preconditions.pending`);
  if (oldestPendingAgeSeconds !== null) {
    requireNonNegativeInteger(
      oldestPendingAgeSeconds,
      `${observation.trigger}.preconditions.oldestPendingAgeSeconds`,
    );
  }
  if (observation.trigger === 'trigger-a-size') {
    if (
      observation.cause !== 'SIZE_THRESHOLD'
      || observation.path !== '/jobs/batch-anchors'
      || force
      || pending < 10_000
    ) throw new Error('Trigger A requires an unforced size cause with pending >= 10,000.');
    return;
  }
  if (observation.trigger === 'trigger-b-age') {
    if (
      observation.cause !== 'AGE_THRESHOLD'
      || observation.path !== '/jobs/batch-anchors'
      || force
      || pending < 3_000
      || pending >= 10_000
      || oldestPendingAgeSeconds === null
      || oldestPendingAgeSeconds < 3 * 60 * 60
    ) throw new Error('Trigger B requires an unforced age cause at 3,000 <= pending < 10,000 and oldest >= 3h.');
    return;
  }
  if (observation.trigger === 'org-scheduler') {
    if (
      observation.cause !== 'ORG_SCHEDULER'
      || observation.path !== '/jobs/org-queue-scheduler'
      || force
      || pending < 1
    ) throw new Error('Org-scheduler requires its distinct unforced route and non-empty pending precondition.');
    return;
  }
  if (
    observation.cause !== 'FORCE'
    || observation.path !== '/jobs/batch-anchors?force=true'
    || !force
  ) throw new Error('Trigger D requires the forced batch-anchors route and force precondition.');
}

export function assertTriggerIdentityCaptures(
  plan: Wave3DrainDriverPlan,
  rawCaptures: unknown,
): TriggerIdentityEvidenceSummary {
  const captures = z.array(triggerObservationSchema).parse(rawCaptures) as Wave3TriggerObservation[];
  if (captures.length !== plan.triggerExecutionPlan.length) {
    throw new Error('Trigger identity capture must contain the exact five A/A/B/D/org-scheduler executions.');
  }
  const executionIds = new Set<string>();
  const evidenceArtifacts = new Set<string>();
  let previousObservedAt: number | null = null;
  plan.triggerExecutionPlan.forEach((expected, index) => {
    const actual = captures[index];
    if (!actual) throw new Error(`Trigger identity capture ${index} is missing.`);
    const observedAt = parseUtcTimestamp(actual.observedAt, `${expected.trigger} observedAt`);
    if (previousObservedAt !== null && observedAt <= previousObservedAt) {
      throw new Error('Trigger observation timestamps must be unique and strictly increasing.');
    }
    previousObservedAt = observedAt;
    if (!IMAGE_DIGEST.test(actual.evidenceArtifactSha256)) {
      throw new Error(`${expected.trigger} immutable evidence artifact digest is invalid.`);
    }
    if (evidenceArtifacts.has(actual.evidenceArtifactSha256)) {
      throw new Error('Trigger immutable evidence artifact identities must be unique.');
    }
    evidenceArtifacts.add(actual.evidenceArtifactSha256);
    if (actual.observationDigestSha256 !== digestWave3TriggerObservation(actual)) {
      throw new Error(`${expected.trigger} observation digest does not bind its exact evidence fields.`);
    }
    if (actual.schedulerExecutionId !== expected.schedulerExecutionId) {
      throw new Error(`${expected.trigger} execution identity mismatch or reuse.`);
    }
    if (executionIds.has(actual.schedulerExecutionId)) {
      throw new Error('Trigger scheduler execution IDs must be unique and cannot be reused.');
    }
    executionIds.add(actual.schedulerExecutionId);
    assertTriggerCausePreconditions(actual);
    for (const [field, value] of Object.entries(actual.remainder)) {
      if (typeof value === 'number') {
        requireNonNegativeInteger(value, `${expected.trigger}.remainder.${field}`);
      }
    }
    if (
      actual.remainder.pendingBefore !== actual.preconditions.pending
      || actual.remainder.pendingAfter
        !== actual.remainder.pendingBefore - actual.remainder.drainedLeaves
    ) throw new Error(`${expected.trigger} remainder does not bind its exact preconditions.`);
    const actualExpectation = {
      trigger: actual.trigger,
      cause: actual.cause,
      method: actual.method,
      path: actual.path,
      body: actual.body,
      policy: actual.policy,
      runId: actual.runId,
      executionOrdinal: actual.executionOrdinal,
      schedulerExecutionId: actual.schedulerExecutionId,
      gitHeadSha: actual.gitHeadSha,
      imageDigest: actual.imageDigest,
      planDigest: actual.planDigest,
      preconditions: actual.preconditions,
      remainder: actual.remainder,
    };
    if (
      stableJson(actualExpectation) !== stableJson(expected)
    ) throw new Error(`${expected.trigger} cause, precondition, route, remainder, head, image, or plan identity mismatch.`);
  });
  const capturedTriggers = [...new Set(captures
    .filter(({ trigger }) => trigger !== 'org-scheduler')
    .map(({ trigger }) => trigger))];
  if (stableJson(capturedTriggers) !== stableJson([
    'trigger-a-size', 'trigger-b-age', 'trigger-d-force',
  ])) throw new Error('Trigger A/B/D evidence is collapsed or incomplete.');
  if (captures.filter(({ trigger }) => trigger === 'org-scheduler').length !== 1) {
    throw new Error('Distinct org-scheduler execution evidence is required exactly once.');
  }
  return deepFreeze({
    capturedTriggers: [
      'trigger-a-size',
      'trigger-b-age',
      'trigger-d-force',
    ] as const,
    orgSchedulerCaptured: true as const,
    executionCount: 5 as const,
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
