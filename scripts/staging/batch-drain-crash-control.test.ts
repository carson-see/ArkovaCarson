import { createHash } from 'node:crypto';

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
const FINGERPRINTS = ['1'.repeat(64), '2'.repeat(64)];

function doubleSha256(bytes: Uint8Array): string {
  const first = createHash('sha256').update(bytes).digest();
  return createHash('sha256').update(first).digest('hex');
}

const ROOT = doubleSha256(Buffer.concat(FINGERPRINTS.map((fingerprint) => Buffer.from(fingerprint, 'hex'))));

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
  };
}

function makeInput(killpoint: CrashKillpoint): CrashCaseInput {
  const postIntent = killpoint === 'after-intent-persist'
    || killpoint === 'after-broadcast-before-submit'
    || killpoint === 'after-submit-persist';
  return {
    runId: `offline-${killpoint}`,
    killpoint,
    expectation: drainExpectation(),
    ...(postIntent ? { postIntent: { txId: TX_ID, signedBytesSha256: TX_HASH } } : {}),
  };
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
    proofs: [
      {
        txId: TX_ID,
        batchId: BATCH_ID,
        fingerprint: FINGERPRINTS[0]!,
        orgId: ORG_ID,
        merkleRoot: ROOT,
        merkleIndex: 0,
        leafCount: 2,
        proofPath: [{ hash: FINGERPRINTS[1]!, position: 'right' }],
      },
      {
        txId: TX_ID,
        batchId: BATCH_ID,
        fingerprint: FINGERPRINTS[1]!,
        orgId: ORG_ID,
        merkleRoot: ROOT,
        merkleIndex: 1,
        leafCount: 2,
        proofPath: [{ hash: FINGERPRINTS[0]!, position: 'left' }],
      },
    ],
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
    claimedAt: '2026-07-13T12:00:07.000Z',
    reachedAt: '2026-07-13T12:00:10.000Z',
    workerId: 'worker-before',
    claimedLeaves: FINGERPRINTS.map((fingerprint) => ({ fingerprint, orgId: ORG_ID })),
    ...(afterMerkle ? { merkleRoot: ROOT, merkleBuiltAt: '2026-07-13T12:00:08.000Z' } : {}),
    ...(afterIntent ? {
      intentTxId: TX_ID,
      signedBytesSha256: TX_HASH,
      intentPersistedAt: '2026-07-13T12:00:08.500Z',
    } : {}),
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

describe('orchestrateCrashCase — exact five-stage offline control plane', () => {
  it.each(CRASH_KILLPOINTS)('passes a fully correlated %s case', async (killpoint) => {
    const { port, events } = makePort(killpoint);
    const evidence = await orchestrateCrashCase(makeInput(killpoint), port);
    expect(evidence).toMatchObject({
      verdict: 'pass',
      batchId: BATCH_ID,
      transactionIds: [TX_ID],
      merkleRoots: [ROOT],
    });
    expect(events).toContain('terminate:worker-before');
    expect(events[events.length - 1]).toBe(`disarm:${killpoint}`);
  });

  it('splits post-intent identity from pre-intent declarations', async () => {
    expect(makeInput('after-claim').postIntent).toBeUndefined();
    expect(makeInput('after-merkle-tree').postIntent).toBeUndefined();

    const early = makeInput('after-claim');
    early.postIntent = { txId: TX_ID, signedBytesSha256: TX_HASH };
    const earlyPort = makePort('after-claim');
    await expect(orchestrateCrashCase(early, earlyPort.port)).rejects.toThrow(/pre-intent.*must not declare/i);
    expect(earlyPort.events).toEqual([]);

    const late = makeInput('after-intent-persist');
    delete late.postIntent;
    const latePort = makePort('after-intent-persist');
    await expect(orchestrateCrashCase(late, latePort.port)).rejects.toThrow(/post-intent identity/i);
    expect(latePort.events).toEqual([]);
  });

  it('forbids later-stage evidence at earlier killpoints', async () => {
    const barrier = makeBarrier('after-claim');
    barrier.merkleRoot = ROOT;
    barrier.merkleBuiltAt = '2026-07-13T12:00:08.000Z';
    const { port, events } = makePort('after-claim', { barrier });
    await expect(orchestrateCrashCase(makeInput('after-claim'), port)).rejects.toThrow(/later-stage evidence/);
    expect(events).not.toContain('terminate:worker-before');
  });

  it('requires monotonic stage timestamps before releasing a barrier', async () => {
    const barrier = makeBarrier('after-intent-persist');
    barrier.merkleBuiltAt = '2026-07-13T12:00:06.000Z';
    const { port, events } = makePort('after-intent-persist', { barrier });
    await expect(orchestrateCrashCase(makeInput('after-intent-persist'), port)).rejects.toThrow(/stage chronology/);
    expect(events).not.toContain('terminate:worker-before');
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
    const barrier = makeBarrier('after-submit-persist');
    delete barrier.phase4Persisted;
    const { port, events } = makePort('after-submit-persist', { barrier });
    await expect(orchestrateCrashCase(makeInput('after-submit-persist'), port)).rejects.toThrow(/Phase-4 persistence/);
    expect(events).not.toContain('terminate:worker-before');
  });

  it('independently derives and rejects an unrelated Merkle root before termination', async () => {
    const barrier = makeBarrier('after-merkle-tree');
    barrier.merkleRoot = 'd'.repeat(64);
    const { port, events } = makePort('after-merkle-tree', { barrier });
    await expect(orchestrateCrashCase(makeInput('after-merkle-tree'), port)).rejects.toThrow(/recomputed claimed-leaf root/);
    expect(events).not.toContain('terminate:worker-before');
  });

  it('validates declarations before arming', async () => {
    const input = makeInput('after-claim');
    input.expectation.claims[0]!.fingerprint = 'not-a-fingerprint';
    const { port, events } = makePort('after-claim');
    await expect(orchestrateCrashCase(input, port)).rejects.toThrow(/fingerprint/);
    expect(events).toEqual([]);
  });

  it('preserves primary and disarm failures even when arm rejects', async () => {
    const { port, events } = makePort('after-claim', {
      armError: new Error('arm failed after side effect'),
      disarmError: new Error('disarm failed'),
    });
    let caught: unknown;
    try {
      await orchestrateCrashCase(makeInput('after-claim'), port);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CrashDisarmAggregateError);
    expect((caught as CrashDisarmAggregateError).errors).toHaveLength(2);
    expect(events).toEqual(['arm:after-claim', 'disarm:after-claim']);
  });
});
