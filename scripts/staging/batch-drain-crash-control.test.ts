import { describe, expect, it } from 'vitest';

import {
  CRASH_KILLPOINTS,
  CrashDisarmAggregateError,
  orchestrateCrashCase,
  type CrashBarrier,
  type CrashCaseInput,
  type CrashControlPort,
  type CrashKillpoint,
  type CrashObservation,
} from './batch-drain-crash-control';
import type { DrainPassExpectation, DrainPassObservation } from './batch-drain-observation';

const BATCH_ID = 'batch-crash-offline';
const EXECUTION_ID = 'scheduler-crash-offline';
const FAULT_WINDOW_ID = 'fault-window-crash-offline';
const ORG_ID = 'org-crash-offline';
const TX_ID = 'a'.repeat(64);
const TX_HASH = 'b'.repeat(64);
const ROOT = 'c'.repeat(64);
const FINGERPRINTS = ['1'.repeat(64), '2'.repeat(64)];

function drainExpectation(): DrainPassExpectation {
  return {
    batchId: BATCH_ID,
    armedTrigger: 'org-scheduler',
    schedulerExecutionId: EXECUTION_ID,
    faultWindow: {
      id: FAULT_WINDOW_ID,
      startsAt: '2026-07-13T12:00:00.000Z',
      endsAt: '2026-07-13T12:05:00.000Z',
    },
    claims: FINGERPRINTS.map((fingerprint) => ({ fingerprint, orgId: ORG_ID, outcome: 'drained' as const })),
    transactions: [{
      txId: TX_ID,
      batchId: BATCH_ID,
      merkleRoot: ROOT,
      signedBytesSha256: TX_HASH,
      leaves: FINGERPRINTS.map((fingerprint, merkleIndex) => ({ fingerprint, orgId: ORG_ID, merkleIndex })),
    }],
    ledgerDeltas: [{ orgId: ORG_ID, delta: -2 }],
  };
}

function makeInput(killpoint: CrashKillpoint): CrashCaseInput {
  return { runId: `offline-${killpoint}`, killpoint, expectation: drainExpectation() };
}

function drainObservation(): DrainPassObservation {
  return {
    execution: {
      schedulerExecutionId: EXECUTION_ID,
      armedTrigger: 'org-scheduler',
      faultWindowId: FAULT_WINDOW_ID,
      startedAt: '2026-07-13T12:00:05.000Z',
      completedAt: '2026-07-13T12:00:20.000Z',
    },
    triggerFirings: [{
      trigger: 'org-scheduler',
      schedulerExecutionId: EXECUTION_ID,
      batchId: BATCH_ID,
      firedAt: '2026-07-13T12:00:06.000Z',
    }],
    passRows: FINGERPRINTS.map((fingerprint) => ({
      fingerprint,
      orgId: ORG_ID,
      batchId: BATCH_ID,
      schedulerExecutionId: EXECUTION_ID,
      status: 'SUBMITTED' as const,
      chainTxId: TX_ID,
      merkleRoot: ROOT,
      observedOutcome: 'drained' as const,
    })),
    transactions: [{ txId: TX_ID, batchId: BATCH_ID, merkleRoot: ROOT, signedBytesSha256: TX_HASH }],
    txLeaves: FINGERPRINTS.map((fingerprint, merkleIndex) => ({
      txId: TX_ID,
      batchId: BATCH_ID,
      fingerprint,
      orgId: ORG_ID,
      merkleIndex,
    })),
    proofs: FINGERPRINTS.map((fingerprint, merkleIndex) => ({
      txId: TX_ID,
      batchId: BATCH_ID,
      fingerprint,
      orgId: ORG_ID,
      merkleRoot: ROOT,
      merkleIndex,
      verified: true,
    })),
    ledgerDeltas: [{ schedulerExecutionId: EXECUTION_ID, orgId: ORG_ID, delta: -2 }],
  };
}

function makeBarrier(killpoint: CrashKillpoint): CrashBarrier {
  const afterMerkle = killpoint !== 'after-claim';
  const afterIntent = killpoint === 'after-intent-persist'
    || killpoint === 'after-broadcast-before-submit'
    || killpoint === 'after-submit-persist';
  const afterNetwork = killpoint === 'after-broadcast-before-submit' || killpoint === 'after-submit-persist';
  return {
    runId: `offline-${killpoint}`,
    killpoint,
    batchId: BATCH_ID,
    armedTrigger: 'org-scheduler',
    schedulerExecutionId: EXECUTION_ID,
    faultWindowId: FAULT_WINDOW_ID,
    reachedAt: '2026-07-13T12:00:10.000Z',
    workerId: 'worker-before',
    claimedLeaves: FINGERPRINTS.map((fingerprint) => ({ fingerprint, orgId: ORG_ID })),
    ...(afterMerkle ? { merkleRoot: ROOT } : {}),
    ...(afterIntent ? { intentTxId: TX_ID, signedBytesSha256: TX_HASH } : {}),
    ...(afterNetwork ? {
      networkAcceptance: {
        txId: TX_ID,
        rawTxSha256: TX_HASH,
        nodeId: 'signet-node-offline-fixture',
        state: 'mempool' as const,
        observedAt: '2026-07-13T12:00:09.000Z',
      },
    } : {}),
    ...(killpoint === 'after-submit-persist' ? {
      phase4Persisted: {
        batchId: BATCH_ID,
        txId: TX_ID,
        rowCount: FINGERPRINTS.length,
        persistedAt: '2026-07-13T12:00:09.500Z',
      },
    } : {}),
  };
}

interface PortOverrides {
  barrier?: CrashBarrier;
  observation?: CrashObservation;
  replacementWorkerId?: string;
  armError?: Error;
  disarmError?: Error;
}

function makePort(
  killpoint: CrashKillpoint,
  overrides: PortOverrides = {},
): { port: CrashControlPort; events: string[] } {
  const events: string[] = [];
  const barrier = overrides.barrier ?? makeBarrier(killpoint);
  const observation: CrashObservation = overrides.observation ?? {
    runId: `offline-${killpoint}`,
    finalWorkerId: overrides.replacementWorkerId ?? 'worker-after',
    drain: drainObservation(),
    broadcastAttempts: [{
      batchId: BATCH_ID,
      schedulerExecutionId: EXECUTION_ID,
      txId: TX_ID,
      signedBytesSha256: TX_HASH,
    }],
  };

  return {
    events,
    port: {
      async arm(input) {
        events.push(`arm:${input.killpoint}`);
        if (overrides.armError) throw overrides.armError;
      },
      async start(input) { events.push(`start:${input.runId}`); },
      async waitForKillpoint(input) { events.push(`barrier:${input.killpoint}`); return barrier; },
      async terminate(input) { events.push(`terminate:${input.workerId}`); },
      async waitForRestart(input) {
        events.push(`restart:${input.previousWorkerId}`);
        return { workerId: overrides.replacementWorkerId ?? 'worker-after' };
      },
      async recover(input) { events.push(`recover:${input.runId}`); },
      async inspect(input) { events.push(`inspect:${input.runId}`); return observation; },
      async disarm(input) {
        events.push(`disarm:${input.killpoint}`);
        if (overrides.disarmError) throw overrides.disarmError;
      },
    },
  };
}

describe('orchestrateCrashCase — deterministic five-boundary control plane', () => {
  it('includes the post-submit/Phase-4-persist boundary', () => {
    expect(CRASH_KILLPOINTS).toContain('after-submit-persist');
  });

  it.each(CRASH_KILLPOINTS)('correlates, kills, restarts, recovers, inspects, and disarms at %s', async (killpoint) => {
    const { port, events } = makePort(killpoint);
    const evidence = await orchestrateCrashCase(makeInput(killpoint), port);

    expect(evidence).toMatchObject({
      verdict: 'pass',
      batchId: BATCH_ID,
      armedTrigger: 'org-scheduler',
      schedulerExecutionId: EXECUTION_ID,
      faultWindowId: FAULT_WINDOW_ID,
      uniqueNetworkTxIds: [TX_ID],
    });
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

  it('requires node acceptance of the exact signed transaction before a post-broadcast kill', async () => {
    const killpoint: CrashKillpoint = 'after-broadcast-before-submit';
    const missing = makeBarrier(killpoint);
    delete missing.networkAcceptance;
    const first = makePort(killpoint, { barrier: missing });
    await expect(orchestrateCrashCase(makeInput(killpoint), first.port)).rejects.toThrow(/network acceptance/);
    expect(first.events).not.toContain('terminate:worker-before');

    const mismatched = makeBarrier(killpoint);
    mismatched.networkAcceptance!.rawTxSha256 = 'd'.repeat(64);
    const second = makePort(killpoint, { barrier: mismatched });
    await expect(orchestrateCrashCase(makeInput(killpoint), second.port)).rejects.toThrow(/exact signed bytes/);
    expect(second.events).not.toContain('terminate:worker-before');
  });

  it('requires Phase-4 persistence evidence before the post-submit kill', async () => {
    const killpoint: CrashKillpoint = 'after-submit-persist';
    const barrier = makeBarrier(killpoint);
    delete barrier.phase4Persisted;
    const { port, events } = makePort(killpoint, { barrier });

    await expect(orchestrateCrashCase(makeInput(killpoint), port)).rejects.toThrow(/Phase-4 persistence/);
    expect(events).not.toContain('terminate:worker-before');
  });

  it.each([
    ['batch id', (barrier: CrashBarrier) => { barrier.batchId = 'unrelated'; }],
    ['armed trigger', (barrier: CrashBarrier) => { barrier.armedTrigger = 'global-flush'; }],
    ['scheduler execution', (barrier: CrashBarrier) => { barrier.schedulerExecutionId = 'unrelated'; }],
    ['fault window', (barrier: CrashBarrier) => { barrier.faultWindowId = 'unrelated'; }],
    ['claimed leaves', (barrier: CrashBarrier) => { barrier.claimedLeaves[0]!.orgId = 'unrelated'; }],
    ['root', (barrier: CrashBarrier) => { barrier.merkleRoot = 'd'.repeat(64); }],
  ])('rejects a barrier correlated to an unrelated %s', async (_label, mutate) => {
    const killpoint: CrashKillpoint = 'after-intent-persist';
    const barrier = makeBarrier(killpoint);
    mutate(barrier);
    const { port, events } = makePort(killpoint, { barrier });

    await expect(orchestrateCrashCase(makeInput(killpoint), port)).rejects.toThrow();
    expect(events).not.toContain('terminate:worker-before');
  });

  it('rejects crash evidence whose rows, proofs, or credits belong to another batch', async () => {
    const killpoint: CrashKillpoint = 'after-claim';
    const actual = drainObservation();
    actual.passRows[0]!.batchId = 'unrelated';
    const { port } = makePort(killpoint, {
      observation: {
        runId: `offline-${killpoint}`,
        finalWorkerId: 'worker-after',
        drain: actual,
        broadcastAttempts: [{
          batchId: BATCH_ID,
          schedulerExecutionId: EXECUTION_ID,
          txId: TX_ID,
          signedBytesSha256: TX_HASH,
        }],
      },
    });
    await expect(orchestrateCrashCase(makeInput(killpoint), port)).rejects.toThrow(/pass row/);
  });

  it('validates the declared transaction/root before arming or terminating', async () => {
    const killpoint: CrashKillpoint = 'after-merkle-tree';
    const input = makeInput(killpoint);
    input.expectation.transactions[0]!.merkleRoot = 'not-a-root';
    const barrier = makeBarrier(killpoint);
    barrier.merkleRoot = 'not-a-root';
    const { port, events } = makePort(killpoint, { barrier });

    await expect(orchestrateCrashCase(input, port)).rejects.toThrow(/merkleRoot/);
    expect(events).toEqual([]);
  });

  it('preserves both the primary and disarm failures', async () => {
    const killpoint: CrashKillpoint = 'after-claim';
    const barrier = makeBarrier(killpoint);
    barrier.batchId = 'unrelated';
    const { port } = makePort(killpoint, { barrier, disarmError: new Error('disarm failed') });

    let caught: unknown;
    try {
      await orchestrateCrashCase(makeInput(killpoint), port);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CrashDisarmAggregateError);
    expect((caught as CrashDisarmAggregateError).primaryError).toBeInstanceOf(Error);
    expect((caught as CrashDisarmAggregateError).disarmError).toEqual(new Error('disarm failed'));
    expect((caught as CrashDisarmAggregateError).errors).toHaveLength(2);
  });

  it('attempts disarm and preserves both failures even when arm itself rejects', async () => {
    const killpoint: CrashKillpoint = 'after-claim';
    const { port, events } = makePort(killpoint, {
      armError: new Error('arm failed after side effect'),
      disarmError: new Error('disarm failed'),
    });

    let caught: unknown;
    try {
      await orchestrateCrashCase(makeInput(killpoint), port);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CrashDisarmAggregateError);
    expect((caught as CrashDisarmAggregateError).primaryError).toEqual(new Error('arm failed after side effect'));
    expect((caught as CrashDisarmAggregateError).disarmError).toEqual(new Error('disarm failed'));
    expect(events).toEqual([`arm:${killpoint}`, `disarm:${killpoint}`]);
  });
});
