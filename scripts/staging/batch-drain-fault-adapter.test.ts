import { describe, expect, it, vi } from 'vitest';

import {
  LIVE_FAULT_CONTROLLER_MAX_BUFFER_BYTES,
  LIVE_FAULT_CONTROLLER_TIMEOUT_MS,
  LIVE_FAULT_ENABLE_TOKEN,
  ReplayFaultControlAdapter,
  createRigB1LiveFaultControlAdapterForTest,
  parseFaultReplayCapture,
  type LiveFaultCommandRunner,
} from './batch-drain-fault-adapter';
import type { FaultCaseInput, FaultObservation } from './batch-drain-fault-control';

const HEAD_SHA = '7'.repeat(40);
const IMAGE_DIGEST = `sha256:${'8'.repeat(64)}`;
const input: FaultCaseInput = {
  schemaVersion: 1,
  runId: 'fault-fee-adapter',
  scenario: 'fee-ceiling',
  batchId: 'batch-fault-adapter',
  schedulerExecutionId: 'scheduler-fault-adapter',
  faultWindow: { id: 'fault-window-adapter', startsAt: '2026-07-15T14:00:00.000Z', endsAt: '2026-07-15T14:10:00.000Z' },
  runtime: { headSha: HEAD_SHA, imageDigest: IMAGE_DIGEST },
  anchorIds: ['40000000-0000-4000-8000-000000000001'],
  txId: null,
  fingerprintRoot: null,
  retryLimit: 0,
};

function observation(phase: 'fault-active' | 'fault-cleared'): FaultObservation {
  const cleared = phase === 'fault-cleared';
  return {
    schemaVersion: 1,
    runId: input.runId,
    scenario: input.scenario,
    phase,
    batchId: input.batchId,
    schedulerExecutionId: input.schedulerExecutionId,
    faultWindowId: input.faultWindow.id,
    runtime: input.runtime,
    observedAt: cleared ? '2026-07-15T14:00:08.000Z' : '2026-07-15T14:00:04.000Z',
    journal: cleared ? {
      journalId: '50000000-0000-4000-8000-000000000001', batchId: input.batchId,
      txId: '9'.repeat(64), fingerprintRoot: 'a'.repeat(64), anchorIds: input.anchorIds,
      createdAt: '2026-07-15T14:00:05.000Z', recoveryStatus: 'PERSISTED',
      holdReason: null, heldAt: null, resolvedAt: '2026-07-15T14:00:07.000Z', observedAt: '2026-07-15T14:00:08.000Z',
    } : null,
    anchors: [{ anchorId: input.anchorIds[0]!, status: cleared ? 'SUBMITTED' : 'PENDING', chainTxId: cleared ? '9'.repeat(64) : null }],
    networkTxIds: cleared ? ['9'.repeat(64)] : [],
    broadcastAttempts: cleared ? 1 : 0,
    refundAnchorIds: [],
    fee: {
      estimateSatVb: cleared ? 49 : 51,
      ceilingSatVb: 50,
      baseCeilingSatVb: 50,
      oldestPendingAt: '2026-07-15T13:50:00.000Z',
      evaluatedBeforeClaim: true,
    },
    provider: null,
    reorg: null,
  };
}

function rawCapture(): string {
  return JSON.stringify({
    schemaVersion: 1,
    captureId: 'fault-replay-capture',
    runId: input.runId,
    active: observation('fault-active'),
    cleared: observation('fault-cleared'),
  });
}

describe('fault control adapters', () => {
  it('strictly parses offline replay and rejects unknown or duplicate JSON keys', async () => {
    const capture = parseFaultReplayCapture(rawCapture());
    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.isFrozen(capture.active)).toBe(true);
    expect(Object.isFrozen(capture.active.anchors)).toBe(true);
    expect(() => { (capture.active as { runId: string }).runId = 'mutated'; }).toThrow(TypeError);
    const replay = new ReplayFaultControlAdapter(capture);
    await replay.arm(input);
    await replay.start(input);
    await expect(replay.waitForFault(input)).resolves.toMatchObject({ phase: 'fault-active' });
    await replay.clear(input);
    await expect(replay.inspect(input)).resolves.toMatchObject({ phase: 'fault-cleared' });
    await replay.disarm(input);

    const unknown = JSON.parse(rawCapture());
    unknown.extra = true;
    expect(() => parseFaultReplayCapture(JSON.stringify(unknown))).toThrow(/schema rejected/i);
    expect(() => parseFaultReplayCapture(rawCapture().replace('"captureId"', '"runId":"duplicate","captureId"')))
      .toThrow(/duplicate/i);
    expect(() => new ReplayFaultControlAdapter(structuredClone(capture))).toThrow(/parsed.*capture|provenance/i);
  });

  it('never invokes the fixed live controller without the exact run-specific two-part gate', async () => {
    const runner: LiveFaultCommandRunner = { run: vi.fn() };
    const adapter = createRigB1LiveFaultControlAdapterForTest({
      rigId: 'RIG-B1', gcpProjectId: 'arkova1', region: 'us-central1',
      workerService: 'arkova-worker-s33-rig-b1-staging',
    }, {}, runner);
    await expect(adapter.arm(input)).rejects.toThrow(/not explicitly enabled/i);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('uses a fixed allowlisted argv vector only after the exact gate', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      schemaVersion: 1, action: 'arm', runId: input.runId, status: 'ok',
    }));
    const target = {
      rigId: 'RIG-B1', gcpProjectId: 'arkova1', region: 'us-central1',
      workerService: 'arkova-worker-s33-rig-b1-staging',
    } as const;
    const adapter = createRigB1LiveFaultControlAdapterForTest(target, {
      ARKOVA_LIVE_FAULT_EXECUTION: LIVE_FAULT_ENABLE_TOKEN,
      ARKOVA_LIVE_FAULT_RUN_ID: input.runId,
    }, { run });
    (target as { workerService: string }).workerService = 'mutated-after-construction';
    await adapter.arm(input);
    expect(run).toHaveBeenCalledWith([
      'arm', '--rig', 'RIG-B1', '--project', 'arkova1', '--service', 'arkova-worker-s33-rig-b1-staging',
      '--region', 'us-central1', '--run-id', input.runId, '--scenario', 'fee-ceiling',
      '--head-sha', HEAD_SHA, '--image-digest', IMAGE_DIGEST, '--batch-id', input.batchId,
      '--scheduler-execution-id', input.schedulerExecutionId, '--fault-window-id', input.faultWindow.id,
    ]);
  });

  it('rejects flag-shaped identities, non-RIG-B1 targets, and unknown controller response fields', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({
      schemaVersion: 1, action: 'arm', runId: input.runId, status: 'ok', extra: true,
    }));
    const gate = {
      ARKOVA_LIVE_FAULT_EXECUTION: LIVE_FAULT_ENABLE_TOKEN,
      ARKOVA_LIVE_FAULT_RUN_ID: input.runId,
    };
    expect(() => createRigB1LiveFaultControlAdapterForTest({
      rigId: 'RIG-B1', gcpProjectId: 'arkova1', region: 'us-central1', workerService: 'other-service',
    }, gate, { run })).toThrow(/allowlist/i);

    const adapter = createRigB1LiveFaultControlAdapterForTest({
      rigId: 'RIG-B1', gcpProjectId: 'arkova1', region: 'us-central1',
      workerService: 'arkova-worker-s33-rig-b1-staging',
    }, gate, { run });
    await expect(adapter.arm(input)).rejects.toThrow(/schema rejected/i);

    const flagged = { ...input, runId: '--project' };
    const flaggedAdapter = createRigB1LiveFaultControlAdapterForTest({
      rigId: 'RIG-B1', gcpProjectId: 'arkova1', region: 'us-central1',
      workerService: 'arkova-worker-s33-rig-b1-staging',
    }, { ...gate, ARKOVA_LIVE_FAULT_RUN_ID: '--project' }, { run });
    await expect(flaggedAdapter.arm(flagged)).rejects.toThrow(/identity allowlist/i);

    const invalidRuntime = structuredClone(input);
    invalidRuntime.runtime.headSha = '--project';
    await expect(adapter.arm(invalidRuntime)).rejects.toThrow(/runtime.*allowlist/i);
  });

  it('pins bounded no-shell controller execution limits', () => {
    expect(LIVE_FAULT_CONTROLLER_TIMEOUT_MS).toBe(60_000);
    expect(LIVE_FAULT_CONTROLLER_MAX_BUFFER_BYTES).toBe(32 * 1024 * 1024);
  });
});
