import { describe, expect, it, vi } from 'vitest';

import { runS33B1SchedulerStartCliForTest } from './s33-b1-scheduler-start';

const ARGV = [
  '--admission', 'admission.json',
  '--preclock', 'preclock.json',
  '--start-authority', 'start.json',
  '--provision-approval-artifact', 'provision.json',
  '--cto-confirmation', 'START_B1:exact',
] as const;

function started() {
  return {
    status: 'RIG_B1_SOAK_STARTED' as const,
    receipt: {
      schemaVersion: 'arkova.s33.rig-b1.scheduler-start-receipt/v1',
      status: 'COUNTED_START' as const,
      scheduler: {
        projectId: 'arkova1',
        location: 'us-central1',
        serviceUrl: 'https://worker.example.run.app',
        cadence: '*/5 * * * *',
        jobs: [],
      },
    },
  } as never;
}

function completed() {
  return {
    status: 'RIG_B1_SOAK_COMPLETED' as const,
    workerUptimeMin: 2_880,
    wallMin: 2_910,
    evidence: {},
  } as never;
}

describe('RIG-B1 foreground start CLI', () => {
  it('reads distinct START and PROVISION artifacts and does not resolve before the supervisor', async () => {
    const files = new Map([
      ['admission.json', 'admission-raw'],
      ['preclock.json', 'preclock-raw'],
      ['start.json', 'start-authority-raw'],
      ['provision.json', 'provision-authority-raw'],
    ]);
    let release!: (value: ReturnType<typeof completed>) => void;
    const foreground = new Promise<ReturnType<typeof completed>>((resolve) => { release = resolve; });
    const executeStart = vi.fn(async () => started());
    const supervise = vi.fn(() => foreground);
    let resolved = false;
    const execution = runS33B1SchedulerStartCliForTest(ARGV, {
      readBoundedText: async (path) => files.get(path) ?? Promise.reject(new Error('missing')),
      executeStart,
      supervise,
    }).then((value) => {
      resolved = true;
      return value;
    });

    await vi.waitFor(() => expect(supervise).toHaveBeenCalledOnce());
    expect(resolved).toBe(false);
    expect(executeStart).toHaveBeenCalledWith(
      'admission-raw',
      'preclock-raw',
      'start-authority-raw',
      'START_B1:exact',
    );
    expect(supervise).toHaveBeenCalledWith(expect.objectContaining({
      admissionRaw: 'admission-raw',
      provisionApprovalArtifactPath: 'provision.json',
    }), expect.objectContaining({ aborted: false }));

    release(completed());
    await expect(execution).resolves.toEqual(completed());
  });

  it('never enters the foreground supervisor when START fails', async () => {
    const supervise = vi.fn();
    await expect(runS33B1SchedulerStartCliForTest(ARGV, {
      readBoundedText: async (path) => `${path}-raw`,
      executeStart: async () => { throw new Error('signed START rejected'); },
      supervise,
    })).rejects.toThrow(/signed START rejected/u);
    expect(supervise).not.toHaveBeenCalled();
  });

  it('threads an external termination signal into the foreground supervisor', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const execution = runS33B1SchedulerStartCliForTest(ARGV, {
      readBoundedText: async (path) => `${path}-raw`,
      executeStart: async () => started(),
      supervise: (_context, signal) => {
        observedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    }, controller.signal);
    await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
    controller.abort(new Error('SIGINT'));
    await expect(execution).rejects.toThrow(/SIGINT/i);
  });
});
