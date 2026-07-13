import { describe, expect, it } from 'vitest';

import {
  CRASH_KILLPOINTS,
  orchestrateCrashCase,
  type CrashBarrier,
  type CrashCaseInput,
  type CrashControlPort,
  type CrashKillpoint,
  type CrashObservation,
} from './batch-drain-crash-control';

const TX_ID = 'a'.repeat(64);
const TX_HASH = 'b'.repeat(64);
const LEAVES = 5;

function makeInput(killpoint: CrashKillpoint): CrashCaseInput {
  return { runId: `offline-${killpoint}`, killpoint, expectedLeaves: LEAVES };
}

function makePort(
  killpoint: CrashKillpoint,
  overrides: Partial<{ barrier: CrashBarrier; observation: CrashObservation; replacementWorkerId: string }> = {},
): { port: CrashControlPort; events: string[] } {
  const events: string[] = [];
  const afterIntent = killpoint === 'after-intent-persist' || killpoint === 'after-broadcast-before-submit';
  const barrier: CrashBarrier = overrides.barrier ?? {
    runId: `offline-${killpoint}`,
    killpoint,
    workerId: 'worker-before',
    ...(afterIntent ? { intentTxId: TX_ID, signedBytesSha256: TX_HASH } : {}),
  };
  const observation: CrashObservation = overrides.observation ?? {
    runId: `offline-${killpoint}`,
    finalWorkerId: overrides.replacementWorkerId ?? 'worker-after',
    statuses: { pending: 0, broadcasting: 0, submitted: LEAVES, secured: 0 },
    networkTxIds: [TX_ID],
    broadcastAttempts: [{ txId: TX_ID, signedBytesSha256: TX_HASH }],
  };

  return {
    events,
    port: {
      async arm(input) { events.push(`arm:${input.killpoint}`); },
      async start(input) { events.push(`start:${input.runId}`); },
      async waitForKillpoint(input) { events.push(`barrier:${input.killpoint}`); return barrier; },
      async terminate(input) { events.push(`terminate:${input.workerId}`); },
      async waitForRestart(input) {
        events.push(`restart:${input.previousWorkerId}`);
        return { workerId: overrides.replacementWorkerId ?? 'worker-after' };
      },
      async recover(input) { events.push(`recover:${input.runId}`); },
      async inspect(input) { events.push(`inspect:${input.runId}`); return observation; },
      async disarm(input) { events.push(`disarm:${input.killpoint}`); },
    },
  };
}

describe('orchestrateCrashCase — deterministic four-boundary control plane', () => {
  it.each(CRASH_KILLPOINTS)('arms, observes, kills, restarts, recovers, and disarms at %s', async (killpoint) => {
    const { port, events } = makePort(killpoint);
    const evidence = await orchestrateCrashCase(makeInput(killpoint), port);

    expect(evidence.verdict).toBe('pass');
    expect(evidence.uniqueNetworkTxIds).toEqual([TX_ID]);
    expect(events).toEqual([
      `arm:${killpoint}`,
      `start:offline-${killpoint}`,
      `barrier:${killpoint}`,
      'terminate:worker-before',
      'restart:worker-before',
      `recover:offline-${killpoint}`,
      `inspect:offline-${killpoint}`,
      `disarm:${killpoint}`,
    ]);
  });

  it('requires durable txid and signed-byte evidence at post-intent killpoints', async () => {
    const killpoint: CrashKillpoint = 'after-intent-persist';
    const { port, events } = makePort(killpoint, {
      barrier: { runId: `offline-${killpoint}`, killpoint, workerId: 'worker-before' },
    });

    await expect(orchestrateCrashCase(makeInput(killpoint), port)).rejects.toThrow(/intentTxId.*signedBytesSha256/);
    expect(events[events.length - 1]).toBe(`disarm:${killpoint}`);
  });

  it('fails on a second distinct network txid and always disarms', async () => {
    const killpoint: CrashKillpoint = 'after-broadcast-before-submit';
    const { port, events } = makePort(killpoint, {
      observation: {
        runId: `offline-${killpoint}`,
        finalWorkerId: 'worker-after',
        statuses: { pending: 0, broadcasting: 0, submitted: LEAVES, secured: 0 },
        networkTxIds: [TX_ID, 'c'.repeat(64)],
        broadcastAttempts: [
          { txId: TX_ID, signedBytesSha256: TX_HASH },
          { txId: 'c'.repeat(64), signedBytesSha256: 'd'.repeat(64) },
        ],
      },
    });

    await expect(orchestrateCrashCase(makeInput(killpoint), port)).rejects.toThrow(/exactly one network txid/);
    expect(events[events.length - 1]).toBe(`disarm:${killpoint}`);
  });

  it('accepts an idempotent same-byte rebroadcast at a post-intent boundary', async () => {
    const killpoint: CrashKillpoint = 'after-intent-persist';
    const { port } = makePort(killpoint, {
      observation: {
        runId: `offline-${killpoint}`,
        finalWorkerId: 'worker-after',
        statuses: { pending: 0, broadcasting: 0, submitted: LEAVES, secured: 0 },
        networkTxIds: [TX_ID],
        broadcastAttempts: [
          { txId: TX_ID, signedBytesSha256: TX_HASH },
          { txId: TX_ID, signedBytesSha256: TX_HASH },
        ],
      },
    });

    const evidence = await orchestrateCrashCase(makeInput(killpoint), port);
    expect(evidence.broadcastAttempts).toBe(2);
    expect(evidence.verdict).toBe('pass');
  });

  it('requires an actual worker replacement before recovery', async () => {
    const killpoint: CrashKillpoint = 'after-claim';
    const { port, events } = makePort(killpoint, { replacementWorkerId: 'worker-before' });

    await expect(orchestrateCrashCase(makeInput(killpoint), port)).rejects.toThrow(/worker did not restart/);
    expect(events[events.length - 1]).toBe(`disarm:${killpoint}`);
  });
});
