import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { deriveS33RigB1SchedulerExecutionIdentity } from '../../services/worker/src/jobs/s33-rig-b1-scenario';
import {
  buildS33B1Wave3LiveScenarioPlan,
  executeS33B1Wave3LiveScenarios,
  type S33B1Wave3LiveScenario,
} from './s33-b1-wave3-live-scenario-executor';
import {
  createS33B1Wave3LiveScenarioProductionPortForTest,
  s33B1Wave3RawCaptureFilePaths,
  type S33B1ScenarioRpcName,
  type S33B1ScenarioRpcTransport,
} from './s33-b1-wave3-live-scenario-production-adapter';

const D = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const LEASE_ID = '11111111-1111-4111-8111-111111111111';

function digestRaw(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function plan() {
  return buildS33B1Wave3LiveScenarioPlan({
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
    serviceAudience: 'https://arkova-worker-s33-rig-b1-staging-abc-uc.a.run.app',
    authorityExpiresAt: '2026-07-18T21:00:00.000Z',
    runHardStopAt: '2026-07-18T21:00:00.000Z',
  });
}

interface Call {
  readonly name: S33B1ScenarioRpcName;
  readonly args: Readonly<Record<string, unknown>>;
}

class FakeRpc implements S33B1ScenarioRpcTransport {
  readonly calls: Call[] = [];
  private generation = 0;
  private capture = '';

  constructor(private readonly hangOutcome = false) {}

  async invoke(
    name: S33B1ScenarioRpcName,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push({ name, args });
    if (name === 'get_s33_rig_b1_scenario_control') {
      return { generation: this.generation, activeLeaseId: null, phase: null, expiresAt: null };
    }
    if (name === 'acquire_s33_rig_b1_scenario_lease') {
      this.generation += 1;
      this.capture = String(args.p_capture_id);
      return {
        captureId: this.capture,
        scenarioLeaseId: LEASE_ID,
        generation: this.generation,
        phase: 'PREPARING',
        expiresAt: '2026-07-16T20:04:00.000Z',
      };
    }
    if (name === 'prepare_s33_rig_b1_scenario_seed') {
      return {
        captureId: args.p_capture_id,
        scenarioLeaseId: LEASE_ID,
        generation: this.generation,
        scenarioId: args.p_scenario_id,
        namespaceId: args.p_namespace_id,
        seedManifestSha256: digestRaw(JSON.stringify(args)),
        pending: args.p_expected_pending,
        oldestPendingAgeSeconds: args.p_minimum_oldest_age_seconds,
        isolation: 'repeatable-read',
        observedAt: '2026-07-16T20:00:01.000Z',
      };
    }
    if (name === 'arm_s33_rig_b1_scenario_lease') {
      this.generation += 1;
      return {
        captureId: args.p_capture_id,
        scenarioLeaseId: LEASE_ID,
        generation: this.generation,
        phase: 'ARMED',
        expiresAt: '2026-07-16T20:04:00.000Z',
      };
    }
    if (name === 'observe_s33_rig_b1_scenario_outcome') {
      if (this.hangOutcome) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('outcome aborted')), { once: true });
        });
      }
      const scenario = scenarioFromOutcomeArgs(args);
      const scheduleTime = new Date(
        Date.parse('2026-07-16T20:05:00.000Z') + scenario.executionOrdinal * 1_000,
      ).toISOString();
      const identity = deriveS33RigB1SchedulerExecutionIdentity(
        scenario.targetJobResource,
        scheduleTime,
      );
      const batchId = `batch-${scenario.executionSlot.replaceAll(':', '-')}`;
      const broadcastPass = {
          outcome: 'broadcast' as const,
          batchId: `${batchId}-1`,
          armedTrigger: scenario.expected.trigger,
          schedulerExecutionId: identity.executionId,
          faultWindow: {
            id: scenario.faultWindowId,
            startsAt: '2026-07-16T20:05:00.000Z',
            endsAt: '2026-07-16T20:05:01.000Z',
          },
          claims: [{ fingerprint: '1'.repeat(64), orgId: 'org-rig-b1-001' }],
      };
      const passes = scenario.executionSlot === 'org-scheduler:1' ? [broadcastPass, {
        outcome: 'no-broadcast' as const,
        outcomeId: `denial-${scenario.executionSlot.replaceAll(':', '-')}`,
        armedTrigger: 'org-scheduler' as const,
        schedulerExecutionId: identity.executionId,
        faultWindow: {
          id: scenario.faultWindowId,
          startsAt: '2026-07-16T20:05:00.000Z',
          endsAt: '2026-07-16T20:05:01.000Z',
        },
        claims: [{ fingerprint: '2'.repeat(64), orgId: 'org-rig-b1-002' }],
        deniedGate: {
          fingerprint: '2'.repeat(64),
          orgId: 'org-rig-b1-002',
          decision: 'denied' as const,
          reason: 'insufficient queue credits',
          referenceId: 'credit-denial-rig-b1-002',
          requiredAmount: 1,
          balanceBefore: 0,
          balanceAfter: 0,
        },
      }] : [broadcastPass];
      const evidenceArtifactRaw = JSON.stringify({
        schemaVersion: 'arkova.s33.rig-b1.execution-capture/v1',
        captureId: scenario.captureId,
        scenarioId: scenario.scenarioId,
        schedulerExecutionId: identity.executionId,
        faultWindowId: scenario.faultWindowId,
        declarationWindow: {
          scenarioId: scenario.scenarioId,
          kind: scenario.executionSlot,
          armedTrigger: scenario.expected.trigger,
          expectedInitialPending: scenario.expected.pendingBefore,
          expectedFinalPending: scenario.expected.pendingAfter,
          passes,
        },
        recoveries: [],
      });
      return {
        captureId: scenario.captureId,
        scenarioLeaseId: LEASE_ID,
        generation: this.generation,
        scenarioId: scenario.scenarioId,
        namespaceId: scenario.namespaceId,
        faultWindowId: scenario.faultWindowId,
        targetJobResource: scenario.targetJobResource,
        schedulerJobResource: scenario.targetJobResource,
        schedulerScheduleTime: identity.scheduleTime,
        schedulerExecutionId: identity.executionId,
        routePath: scenario.routePath,
        workerRevision: plan().workerRevision,
        pendingBefore: scenario.expected.pendingBefore,
        drainedLeaves: scenario.expected.drainedLeaves,
        pendingAfter: scenario.expected.pendingAfter,
        poisonPending: scenario.expected.poisonPending,
        startedAt: '2026-07-16T20:05:00.000Z',
        completedAt: '2026-07-16T20:05:01.000Z',
        evidenceArtifactRaw,
        evidenceArtifactSha256: digestRaw(evidenceArtifactRaw),
      };
    }
    if (name === 'complete_s33_rig_b1_scenario_execution') {
      this.generation += 1;
      const next = args.p_next_scenario as Record<string, unknown> | null;
      const completedCapture = String(args.p_capture_id);
      if (next !== null) this.capture = String(next.captureId);
      return {
        captureId: completedCapture,
        scenarioLeaseId: LEASE_ID,
        generation: this.generation,
        phase: next === null ? 'COMPLETED' : 'PREPARING',
        ...(next === null ? {} : { expiresAt: '2026-07-16T20:09:00.000Z' }),
      };
    }
    if (name === 'abort_s33_rig_b1_scenario_lease') {
      this.generation += 1;
      return {
        captureId: args.p_capture_id,
        scenarioLeaseId: LEASE_ID,
        generation: this.generation,
        phase: 'FAILED',
      };
    }
    if (name === 'cleanup_s33_rig_b1_scenario_run') {
      return {
        scenarioLeaseId: LEASE_ID,
        preservedCaptureIds: args.p_preserve_capture_ids,
        deletedRows: 12_500,
      };
    }
    throw new Error(`Unexpected RPC ${name}`);
  }
}

function scenarioFromOutcomeArgs(args: Readonly<Record<string, unknown>>): S33B1Wave3LiveScenario {
  const found = plan().scenarios.find(({ captureId }) => captureId === args.p_capture_id);
  if (found === undefined) throw new Error('Fake transport received unknown capture id.');
  return found;
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  void milliseconds;
  return new Promise((_resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

describe('S3.3 RIG-B1 Wave-3 production scenario adapter', () => {
  it('derives six distinct fixed-root capture paths only from soak and declaration identity', () => {
    const paths = s33B1Wave3RawCaptureFilePaths('s33-b1-soak-001', 'a'.repeat(64));
    expect(new Set(Object.values(paths))).toHaveLength(6);
    expect(Object.values(paths).every((path) => (
      path.startsWith('/var/lib/arkova/s33-evidence/captures/') && path.endsWith('.json')
    ))).toBe(true);
    expect(s33B1Wave3RawCaptureFilePaths('s33-b1-soak-001', 'a'.repeat(64))).toEqual(paths);
    expect(() => s33B1Wave3RawCaptureFilePaths('../escape', 'a'.repeat(64))).toThrow(/exact soak/u);
  });

  it('maps the exact immutable plan to the fixed PostgREST RPC sequence', async () => {
    const transport = new FakeRpc();
    const productionPort = createS33B1Wave3LiveScenarioProductionPortForTest({
      rpc: transport,
      now: () => new Date('2026-07-16T20:00:00.000Z'),
      wait: abortableWait,
    });
    const exactPlan = plan();
    const material = await executeS33B1Wave3LiveScenarios(
      exactPlan,
      productionPort,
      new AbortController().signal,
    );

    expect(material.captures).toHaveLength(5);
    expect(transport.calls.map(({ name }) => name)).toEqual([
      'get_s33_rig_b1_scenario_control',
      'acquire_s33_rig_b1_scenario_lease',
      ...exactPlan.scenarios.flatMap((_scenario, index) => [
        'prepare_s33_rig_b1_scenario_seed',
        'arm_s33_rig_b1_scenario_lease',
        'observe_s33_rig_b1_scenario_outcome',
        'complete_s33_rig_b1_scenario_execution',
        ...(index === exactPlan.scenarios.length - 1 ? ['cleanup_s33_rig_b1_scenario_run'] : []),
      ]),
    ]);
    const acquire = transport.calls.find(({ name }) => name === 'acquire_s33_rig_b1_scenario_lease')!;
    expect(acquire.args).toMatchObject({
      p_capture_id: exactPlan.scenarios[0].captureId,
      p_plan_id: exactPlan.planId,
      p_run_id: exactPlan.runId,
      p_approval_id: exactPlan.startApprovalId,
      p_admission_sha256: exactPlan.admissionSha256,
      p_receipt_sha256: exactPlan.receiptSha256,
      p_authority_expires_at: exactPlan.runHardStopAt,
    });
    for (const call of transport.calls.slice(0, 3)) {
      expect(Object.keys(call.args).some((key) => key.includes('scheduler_execution'))).toBe(false);
    }
  });

  it('aborts an in-flight outcome fetch, proves idle, releases the exact lease, then cleans up', async () => {
    const transport = new FakeRpc(true);
    const productionPort = createS33B1Wave3LiveScenarioProductionPortForTest({
      rpc: transport,
      now: () => new Date('2026-07-16T20:00:00.000Z'),
      wait: abortableWait,
    });
    const controller = new AbortController();
    const execution = executeS33B1Wave3LiveScenarios(plan(), productionPort, controller.signal);
    while (!transport.calls.some(({ name }) => name === 'observe_s33_rig_b1_scenario_outcome')) {
      await Promise.resolve();
    }
    controller.abort(new Error('operator stop'));
    await expect(execution).rejects.toThrow(/operator stop/u);
    expect(transport.calls.slice(-2).map(({ name }) => name)).toEqual([
      'abort_s33_rig_b1_scenario_lease',
      'cleanup_s33_rig_b1_scenario_run',
    ]);
    expect(transport.calls.at(-2)?.args).toMatchObject({
      p_scenario_lease_id: LEASE_ID,
      p_capture_id: plan().scenarios[0].captureId,
    });
  });
});
