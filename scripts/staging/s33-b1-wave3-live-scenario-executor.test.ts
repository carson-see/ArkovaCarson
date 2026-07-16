import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { deriveS33RigB1SchedulerExecutionIdentity } from '../../services/worker/src/jobs/s33-rig-b1-scenario';
import {
  S33_B1_WAVE3_EXECUTION_SLOTS,
  assertGenuineS33B1Wave3ScenarioMaterial,
  buildS33B1Wave3LiveScenarioPlan,
  executeS33B1Wave3LiveScenarios,
  loadS33B1Wave3LiveScenarioPlan,
  resolveS33B1Wave3ScenarioCapture,
  serializeS33B1Wave3LiveScenarioPlan,
  type S33B1LiveExecutionObservation,
  type S33B1ScenarioCompletionObservation,
  type S33B1ScenarioControlObservation,
  type S33B1ScenarioLeaseObservation,
  type S33B1ScenarioSeedObservation,
  type S33B1Wave3LiveScenario,
  type S33B1Wave3LiveScenarioPlan,
  type S33B1Wave3LiveScenarioPort,
  type S33B1Wave3PlanInput,
} from './s33-b1-wave3-live-scenario-executor';

const D = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const LEASE_ID = '11111111-1111-4111-8111-111111111111';

function planInput(): S33B1Wave3PlanInput {
  return {
    planId: 's33-b1-wave3-live-001',
    runId: 's33-b1-wave3-run-001',
    startApprovalId: 'start-b1-s33-001',
    admissionSha256: D('1'),
    receiptSha256: D('2'),
    gitHeadSha: 'a'.repeat(40),
    imageDigest: D('3'),
    soakId: 's33-b1-soak-001',
    runLeaseId: 's33-b1-run-lease-001',
    workerRevision: 'arkova-worker-s33-rig-b1-staging-00001-aaa',
    serviceAudience: 'https://rig-b1.example.test',
    authorityExpiresAt: '2026-07-18T21:00:00.000Z',
    runHardStopAt: '2026-07-18T21:00:00.000Z',
  };
}

function digestRaw(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestStable(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

interface FakePortOptions {
  readonly corruptSeedCapture?: boolean;
  readonly corruptSchedulerExecutionId?: boolean;
  readonly hangLive?: boolean;
  readonly hangIdle?: boolean;
  readonly failLeaseRelease?: boolean;
  readonly expireOnWaitCall?: number;
}

class FakePort implements S33B1Wave3LiveScenarioPort {
  readonly events: string[] = [];
  readonly liveEntered: Promise<void>;
  private resolveLiveEntered!: () => void;
  private nowMs = Date.parse('2026-07-16T20:00:00.000Z');
  private waitCalls = 0;

  constructor(private readonly options: FakePortOptions = {}) {
    this.liveEntered = new Promise((resolve) => { this.resolveLiveEntered = resolve; });
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    this.waitCalls += 1;
    if (this.waitCalls === this.options.expireOnWaitCall) {
      this.nowMs += milliseconds;
      return Promise.resolve();
    }
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('timer cancelled')), { once: true });
    });
  }

  async observeControl(signal: AbortSignal): Promise<S33B1ScenarioControlObservation> {
    void signal;
    this.events.push('observe-control');
    return { generation: 0, activeLeaseId: null, phase: null, expiresAt: null };
  }

  async acquirePreparing(input: Readonly<{
    expectedGeneration: number;
    scenario: S33B1Wave3LiveScenario;
    plan: S33B1Wave3LiveScenarioPlan;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioLeaseObservation> {
    this.events.push(`acquire:${input.scenario.executionSlot}`);
    return {
      captureId: input.scenario.captureId,
      scenarioLeaseId: LEASE_ID,
      generation: input.expectedGeneration + 1,
      phase: 'PREPARING',
      expiresAt: '2026-07-16T20:04:00.000Z',
    };
  }

  async prepareSeed(input: Readonly<{
    scenarioLeaseId: string;
    generation: number;
    scenario: S33B1Wave3LiveScenario;
    plan: S33B1Wave3LiveScenarioPlan;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioSeedObservation> {
    this.events.push(`seed:${input.scenario.executionSlot}`);
    return {
      captureId: this.options.corruptSeedCapture ? D('f') : input.scenario.captureId,
      scenarioLeaseId: input.scenarioLeaseId,
      generation: input.generation,
      scenarioId: input.scenario.scenarioId,
      namespaceId: input.scenario.namespaceId,
      seedManifestSha256: digestStable({ executionSlot: input.scenario.executionSlot }),
      pending: input.scenario.seed.expectedPending,
      oldestPendingAgeSeconds: input.scenario.seed.minimumOldestAgeSeconds,
      isolation: 'repeatable-read',
      observedAt: '2026-07-16T20:00:01.000Z',
    };
  }

  async arm(input: Readonly<{
    scenarioLeaseId: string;
    expectedGeneration: number;
    seed: S33B1ScenarioSeedObservation;
    scenario: S33B1Wave3LiveScenario;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioLeaseObservation> {
    this.events.push(`arm:${input.scenario.executionSlot}`);
    return {
      captureId: input.scenario.captureId,
      scenarioLeaseId: input.scenarioLeaseId,
      generation: input.expectedGeneration + 1,
      phase: 'ARMED',
      expiresAt: '2026-07-16T20:04:00.000Z',
    };
  }

  async awaitLiveExecution(input: Readonly<{
    scenarioLeaseId: string;
    generation: number;
    scenario: S33B1Wave3LiveScenario;
    plan: S33B1Wave3LiveScenarioPlan;
    signal: AbortSignal;
  }>): Promise<S33B1LiveExecutionObservation> {
    this.events.push(`live:${input.scenario.executionSlot}`);
    this.resolveLiveEntered();
    if (this.options.hangLive) {
      await new Promise<never>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          this.events.push('live-aborted');
          reject(new Error('live operation aborted'));
        }, { once: true });
      });
    }
    const scheduleTime = new Date(
      Date.parse('2026-07-16T20:05:00.000Z') + input.scenario.executionOrdinal * 1_000
        + S33_B1_WAVE3_EXECUTION_SLOTS.indexOf(input.scenario.executionSlot) * 10_000,
    ).toISOString();
    const identity = deriveS33RigB1SchedulerExecutionIdentity(
      input.scenario.targetJobResource,
      scheduleTime,
    );
    const evidenceArtifactRaw = JSON.stringify({
      captureId: input.scenario.captureId,
      executionSlot: input.scenario.executionSlot,
      schedulerExecutionId: identity.executionId,
    });
    return {
      captureId: input.scenario.captureId,
      scenarioLeaseId: input.scenarioLeaseId,
      generation: input.generation,
      scenarioId: input.scenario.scenarioId,
      namespaceId: input.scenario.namespaceId,
      faultWindowId: input.scenario.faultWindowId,
      targetJobResource: input.scenario.targetJobResource,
      schedulerJobResource: input.scenario.targetJobResource,
      schedulerScheduleTime: identity.scheduleTime,
      schedulerExecutionId: this.options.corruptSchedulerExecutionId ? D('e') : identity.executionId,
      routePath: input.scenario.routePath,
      workerRevision: input.plan.workerRevision,
      pendingBefore: input.scenario.expected.pendingBefore,
      drainedLeaves: input.scenario.expected.drainedLeaves,
      pendingAfter: input.scenario.expected.pendingAfter,
      poisonPending: input.scenario.expected.poisonPending,
      startedAt: '2026-07-16T20:05:00.000Z',
      completedAt: '2026-07-16T20:05:01.000Z',
      evidenceArtifactRaw,
      evidenceArtifactSha256: digestRaw(evidenceArtifactRaw),
    };
  }

  async complete(input: Readonly<{
    scenarioLeaseId: string;
    expectedGeneration: number;
    schedulerExecutionId: string;
    resultDigest: string;
    captureId: string;
    nextScenario: S33B1Wave3LiveScenario | null;
    signal: AbortSignal;
  }>): Promise<S33B1ScenarioCompletionObservation> {
    this.events.push(`complete:${input.captureId}`);
    return {
      captureId: input.captureId,
      scenarioLeaseId: input.scenarioLeaseId,
      generation: input.expectedGeneration + 1,
      phase: input.nextScenario === null ? 'COMPLETED' : 'PREPARING',
    };
  }

  async abortAndAwaitIdle(input: Readonly<{
    reason: string;
    deadline: string;
    signal: AbortSignal;
  }>): Promise<void> {
    this.events.push('abort-and-idle');
    if (this.options.hangIdle) {
      await new Promise<never>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          this.events.push('idle-aborted');
          reject(new Error('idle proof aborted'));
        }, { once: true });
      });
    }
  }

  async abortScenarioLease(input: Readonly<{
    scenarioLeaseId: string | null;
    reason: string;
    deadline: string;
    signal: AbortSignal;
  }>): Promise<void> {
    void input;
    this.events.push('abort-lease');
    if (this.options.failLeaseRelease) throw new Error('lease release failed');
  }

  async cleanupScenarioRun(input: Readonly<{
    planId: string;
    runId: string;
    scenarioLeaseId: string | null;
    preserveCaptureIds: readonly string[];
    deadline: string;
    signal: AbortSignal;
  }>): Promise<void> {
    void input;
    this.events.push('cleanup');
  }
}

describe('S3.3 RIG-B1 Wave-3 live scenario executor', () => {
  it('builds and reloads only the exact immutable five-slot plan', () => {
    const plan = buildS33B1Wave3LiveScenarioPlan(planInput());
    expect(plan.scenarios.map(({ executionSlot }) => executionSlot)).toEqual(S33_B1_WAVE3_EXECUTION_SLOTS);
    expect(plan.scenarios.map(({ targetJobResource }) => targetJobResource)).toEqual([
      expect.stringContaining('-batch-anchors'),
      expect.stringContaining('-batch-anchors'),
      expect.stringContaining('-batch-anchors'),
      expect.stringContaining('-batch-anchors-forced-flush'),
      expect.stringContaining('-org-queue-scheduler'),
    ]);
    expect(plan.scenarios.slice(0, 3).map(({ namespaceId }) => namespaceId)).toEqual([
      plan.scenarios[0].namespaceId,
      plan.scenarios[0].namespaceId,
      plan.scenarios[0].namespaceId,
    ]);
    expect(plan.scenarios.map(({ expected }) => expected.pendingAfter)).toEqual([2_500, 5_000, 0, 0, 197]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(loadS33B1Wave3LiveScenarioPlan(serializeS33B1Wave3LiveScenarioPlan(plan))).toEqual(plan);

    const parsed = JSON.parse(serializeS33B1Wave3LiveScenarioPlan(plan)) as Record<string, unknown> & {
      scenarios: Array<Record<string, unknown>>;
      planSha256: string;
    };
    parsed.scenarios[0]!.executionSlot = 'trigger-a-size:2';
    const body = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key !== 'planSha256'),
    );
    parsed.planSha256 = digestStable(body);
    expect(() => loadS33B1Wave3LiveScenarioPlan(JSON.stringify(parsed))).toThrow(/exact five execution-slot topology/u);
    expect(() => buildS33B1Wave3LiveScenarioPlan({
      ...planInput(), authorityExpiresAt: '2026-07-18T20:59:59.000Z',
    })).toThrow(/must equal the signed START run hard stop/u);
  });

  it('executes exact ordered server-derived captures and returns only genuine branded handles', async () => {
    const plan = buildS33B1Wave3LiveScenarioPlan(planInput());
    const port = new FakePort();
    const material = await executeS33B1Wave3LiveScenarios(plan, port, new AbortController().signal);

    expect(material.captures.map(({ executionSlot }) => executionSlot)).toEqual(S33_B1_WAVE3_EXECUTION_SLOTS);
    expect(resolveS33B1Wave3ScenarioCapture(material.captures[0]).observation.schedulerExecutionId)
      .toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(() => assertGenuineS33B1Wave3ScenarioMaterial(material, {
      admissionSha256: plan.admissionSha256,
      receiptSha256: plan.receiptSha256,
      sourceHeadSha: plan.gitHeadSha,
      imageDigest: plan.imageDigest,
      soakId: plan.soakId,
      leaseId: plan.runLeaseId,
    })).not.toThrow();
    expect(() => assertGenuineS33B1Wave3ScenarioMaterial({ ...material }, {
      admissionSha256: plan.admissionSha256,
      receiptSha256: plan.receiptSha256,
      sourceHeadSha: plan.gitHeadSha,
      imageDigest: plan.imageDigest,
      soakId: plan.soakId,
      leaseId: plan.runLeaseId,
    })).toThrow(/differs from the exact supervisor identity/u);
    expect(port.events.slice(-3)).toEqual(['abort-and-idle', 'abort-lease', 'cleanup']);
  });

  it('rejects a forged plan and capture-id mismatch before arming, then proves idle before cleanup', async () => {
    const plan = buildS33B1Wave3LiveScenarioPlan(planInput());
    await expect(executeS33B1Wave3LiveScenarios(
      { ...plan } as S33B1Wave3LiveScenarioPlan,
      new FakePort(),
      new AbortController().signal,
    )).rejects.toThrow(/immutable branded plan handle/u);

    const port = new FakePort({ corruptSeedCapture: true });
    await expect(executeS33B1Wave3LiveScenarios(
      plan, port, new AbortController().signal,
    )).rejects.toThrow(/capture, lease, or generation identity/u);
    expect(port.events).not.toContain(`arm:${plan.scenarios[0].executionSlot}`);
    expect(port.events.slice(-3)).toEqual(['abort-and-idle', 'abort-lease', 'cleanup']);
  });

  it('rejects a synthetic Scheduler execution id before completion and preserves cleanup order', async () => {
    const plan = buildS33B1Wave3LiveScenarioPlan(planInput());
    const port = new FakePort({ corruptSchedulerExecutionId: true });
    await expect(executeS33B1Wave3LiveScenarios(
      plan, port, new AbortController().signal,
    )).rejects.toThrow(/server-derived identity/u);
    expect(port.events.some((event) => event.startsWith('complete:'))).toBe(false);
    expect(port.events.slice(-3)).toEqual(['abort-and-idle', 'abort-lease', 'cleanup']);
  });

  it('propagates operator abort into a hung mutation and reaches idle before releasing its lease', async () => {
    const plan = buildS33B1Wave3LiveScenarioPlan(planInput());
    const port = new FakePort({ hangLive: true });
    const controller = new AbortController();
    const execution = executeS33B1Wave3LiveScenarios(plan, port, controller.signal);
    await port.liveEntered;
    controller.abort(new Error('operator abort'));
    await expect(execution).rejects.toThrow(/operator abort/u);
    expect(port.events.slice(-4)).toEqual(['live-aborted', 'abort-and-idle', 'abort-lease', 'cleanup']);
  });

  it('hard-stops a hung live operation and settles it before lease release', async () => {
    const plan = buildS33B1Wave3LiveScenarioPlan(planInput());
    const port = new FakePort({ hangLive: true, expireOnWaitCall: 5 });
    await expect(executeS33B1Wave3LiveScenarios(
      plan, port, new AbortController().signal,
    )).rejects.toThrow(/exceeded the signed RIG-B1 run hard stop/u);
    expect(port.events.slice(-4)).toEqual(['live-aborted', 'abort-and-idle', 'abort-lease', 'cleanup']);
  });

  it('fails closed when idle proof times out and never releases the lease or seeded rows', async () => {
    const plan = buildS33B1Wave3LiveScenarioPlan(planInput());
    const port = new FakePort({ corruptSeedCapture: true, hangIdle: true, expireOnWaitCall: 4 });
    await expect(executeS33B1Wave3LiveScenarios(
      plan, port, new AbortController().signal,
    )).rejects.toThrow(/hard-stop cleanup also failed/u);
    expect(port.events.slice(-2)).toEqual(['abort-and-idle', 'idle-aborted']);
    expect(port.events).not.toContain('abort-lease');
    expect(port.events).not.toContain('cleanup');
  });

  it('never deletes seeded rows when lease abort/release fails', async () => {
    const plan = buildS33B1Wave3LiveScenarioPlan(planInput());
    const port = new FakePort({ corruptSeedCapture: true, failLeaseRelease: true });
    await expect(executeS33B1Wave3LiveScenarios(
      plan, port, new AbortController().signal,
    )).rejects.toThrow(/hard-stop cleanup also failed/u);
    expect(port.events.slice(-2)).toEqual(['abort-and-idle', 'abort-lease']);
    expect(port.events).not.toContain('cleanup');
  });
});
