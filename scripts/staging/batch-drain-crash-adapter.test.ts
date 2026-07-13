import { describe, expect, it, vi } from 'vitest';

import {
  LIVE_CRASH_ENABLE_TOKEN,
  createRigB1LiveCrashControlAdapter,
  createRigB1LiveCrashControlAdapterForTest,
  parseCrashReplayCapture,
  ReplayCrashControlAdapter,
} from './batch-drain-crash-adapter';
import type { CrashCaseInput } from './batch-drain-crash-control';

const INPUT: CrashCaseInput = {
  runId: 'rig-b1-live-run',
  killpoint: 'after-claim',
  runtime: { headSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}` },
  expectation: {
    batchId: 'batch-live',
    armedTrigger: 'org-scheduler',
    schedulerExecutionId: 'scheduler-live',
    faultWindow: {
      id: 'fault-live', startsAt: '2026-07-13T12:00:00.000Z', endsAt: '2026-07-13T12:05:00.000Z',
    },
    claims: [{ fingerprint: 'c'.repeat(64), orgId: 'org-live' }],
  },
};

const TARGET = {
  rigId: 'RIG-B1' as const,
  gcpProjectId: 'arkova1' as const,
  workerService: 'arkova-worker-s33-rig-b1-staging',
  region: 'us-central1' as const,
};

describe('concrete crash capture adapters', () => {
  it('strictly rejects a replay capture with unknown fields', () => {
    expect(() => parseCrashReplayCapture(JSON.stringify({ schemaVersion: 1, invented: true }))).toThrow(
      /unrecognized|unknown/i,
    );
  });

  it('provides a concrete offline replay adapter', () => {
    expect(ReplayCrashControlAdapter).toBeTypeOf('function');
  });

  it('ships a concrete non-test live adapter but never invokes its fixed controller in tests', () => {
    expect(createRigB1LiveCrashControlAdapter).toBeTypeOf('function');
  });

  it('does not invoke the fixed live controller when its two-part gate is absent', async () => {
    const run = vi.fn();
    const adapter = createRigB1LiveCrashControlAdapterForTest(TARGET, {}, { run });
    await expect(adapter.arm(INPUT)).rejects.toThrow(/not explicitly enabled/);
    expect(run).not.toHaveBeenCalled();
  });

  it('uses a fixed allowlisted action/target vector only after the exact two-part gate', async () => {
    const run = vi.fn<(args: readonly string[]) => Promise<string>>(async () => JSON.stringify({
      schemaVersion: 1, action: 'arm', runId: INPUT.runId, status: 'ok',
    }));
    const adapter = createRigB1LiveCrashControlAdapterForTest(TARGET, {
      ARKOVA_LIVE_CRASH_EXECUTION: LIVE_CRASH_ENABLE_TOKEN,
      ARKOVA_LIVE_CRASH_RUN_ID: INPUT.runId,
    }, { run });
    await expect(adapter.arm(INPUT)).resolves.toBeUndefined();
    expect(adapter.evidenceMode).toBe('live-rig');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual(expect.arrayContaining([
      'arm', '--rig', 'RIG-B1', '--project', 'arkova1', '--service', TARGET.workerService,
      '--region', 'us-central1', '--run-id', INPUT.runId, '--killpoint', INPUT.killpoint,
    ]));
  });

  it('fails closed on a non-RIG-B1 target and unknown controller response fields', async () => {
    expect(() => createRigB1LiveCrashControlAdapterForTest(
      { ...TARGET, workerService: 'arkova-worker-prod' }, {}, { run: vi.fn() },
    )).toThrow(/allowlist|RIG-B1/i);

    const adapter = createRigB1LiveCrashControlAdapterForTest(TARGET, {
      ARKOVA_LIVE_CRASH_EXECUTION: LIVE_CRASH_ENABLE_TOKEN,
      ARKOVA_LIVE_CRASH_RUN_ID: INPUT.runId,
    }, { run: vi.fn<(args: readonly string[]) => Promise<string>>(async () => JSON.stringify({
      schemaVersion: 1, action: 'arm', runId: INPUT.runId, status: 'ok', invented: true,
    })) });
    await expect(adapter.arm(INPUT)).rejects.toThrow(/schema|unrecognized/i);
  });
});
