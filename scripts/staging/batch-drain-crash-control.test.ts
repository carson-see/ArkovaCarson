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
  type RecoveryEvidence,
  type RestartEvidence,
  type TerminationEvidence,
} from './batch-drain-crash-control';
import { parseCrashReplayCapture, ReplayCrashControlAdapter } from './batch-drain-crash-adapter';
import type { DrainPassExpectation, DrainPassObservation } from './batch-drain-observation';

const BATCH_ID = 'batch-crash-offline';
const EXECUTION_ID = 'scheduler-crash-offline';
const FAULT_WINDOW_ID = 'fault-window-crash-offline';
const ORG_ID = 'org-crash-offline';
const TX_ID = 'a'.repeat(64);
const TX_HASH = 'b'.repeat(64);
const HEAD_SHA = 'c'.repeat(40);
const IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
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
    claims: FINGERPRINTS.map((fingerprint) => ({ fingerprint, orgId: ORG_ID })),
  };
}

function makeInput(killpoint: CrashKillpoint): CrashCaseInput {
  return {
    runId: `offline-${killpoint}`,
    killpoint,
    expectation: drainExpectation(),
    runtime: { headSha: HEAD_SHA, imageDigest: IMAGE_DIGEST },
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
    pendingBefore: 2,
    pendingAfter: 0,
    passRows: FINGERPRINTS.map((fingerprint, index) => ({
      fingerprint,
      orgId: ORG_ID,
      batchId: BATCH_ID,
      schedulerExecutionId: EXECUTION_ID,
      claimOrder: index + 1,
      status: 'SUBMITTED' as const,
      chainTxId: TX_ID,
      merkleRoot: ROOT,
      creditDenialReason: null,
      queueCreditChargedAt: null,
      queueCreditDeniedAt: null,
    })),
    transactions: [{
      txId: TX_ID,
      batchId: BATCH_ID,
      merkleRoot: ROOT,
      signedBytesSha256: TX_HASH,
      network: 'signet',
      nodeId: 'signet-node-offline-fixture',
      chainState: 'mempool',
      acceptedAt: '2026-07-13T12:00:12.000Z',
    }],
    txLeaves: FINGERPRINTS.map((fingerprint, merkleIndex) => ({
      txId: TX_ID,
      batchId: BATCH_ID,
      fingerprint,
      orgId: ORG_ID,
      merkleIndex,
    })),
    proofs: [
      {
        txId: TX_ID, batchId: BATCH_ID, fingerprint: FINGERPRINTS[0]!, orgId: ORG_ID,
        merkleRoot: ROOT, merkleIndex: 0, leafCount: 2,
        proofPath: [{ hash: FINGERPRINTS[1]!, position: 'right' }],
      },
      {
        txId: TX_ID, batchId: BATCH_ID, fingerprint: FINGERPRINTS[1]!, orgId: ORG_ID,
        merkleRoot: ROOT, merkleIndex: 1, leafCount: 2,
        proofPath: [{ hash: FINGERPRINTS[0]!, position: 'left' }],
      },
    ],
    creditGateEvents: FINGERPRINTS.map((fingerprint, index) => ({
      eventId: `gate-${index}`,
      schedulerExecutionId: EXECUTION_ID,
      fingerprint,
      orgId: ORG_ID,
      decision: 'not-required' as const,
      reason: null,
      referenceId: null,
      requiredAmount: 0,
      balanceBefore: null,
      balanceAfter: null,
      occurredAt: '2026-07-13T12:00:07.000Z',
    })),
    creditLedgerEvents: [],
    orgBalances: [{ schedulerExecutionId: EXECUTION_ID, orgId: ORG_ID, before: 10, after: 10 }],
    ledgerDeltas: [{ schedulerExecutionId: EXECUTION_ID, orgId: ORG_ID, delta: 0 }],
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
    headSha: HEAD_SHA,
    imageDigest: IMAGE_DIGEST,
    claimedLeaves: FINGERPRINTS.map((fingerprint, index) => ({
      fingerprint, orgId: ORG_ID, claimOrder: index + 1,
    })),
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
        network: 'signet' as const,
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

function termination(): TerminationEvidence {
  return {
    workerId: 'worker-before',
    source: 'cloud-run-audit-log',
    logEntryId: 'log-termination',
    signal: 'SIGKILL',
    requestedAt: '2026-07-13T12:00:11.000Z',
    exitedAt: '2026-07-13T12:00:12.000Z',
    headSha: HEAD_SHA,
    imageDigest: IMAGE_DIGEST,
  };
}

function restart(): RestartEvidence {
  return {
    previousWorkerId: 'worker-before',
    workerId: 'worker-after',
    source: 'cloud-run-audit-log',
    logEntryId: 'log-restart',
    startedAt: '2026-07-13T12:00:13.000Z',
    headSha: HEAD_SHA,
    imageDigest: IMAGE_DIGEST,
  };
}

function recovery(): RecoveryEvidence {
  return {
    recoverySchedulerExecutionId: 'scheduler-recovery-offline',
    correlatedDrainExecutionId: EXECUTION_ID,
    faultWindowId: FAULT_WINDOW_ID,
    source: 'cloud-scheduler',
    endpointPath: '/jobs/recover-broadcasts',
    httpStatus: 200,
    startedAt: '2026-07-13T12:00:14.000Z',
    completedAt: '2026-07-13T12:00:15.000Z',
  };
}

function crashObservation(killpoint: CrashKillpoint): CrashObservation {
  return {
    runId: `offline-${killpoint}`,
    finalWorkerId: 'worker-after',
    observedAt: '2026-07-13T12:00:20.000Z',
    drain: drainObservation(),
    broadcastAttempts: [{
      batchId: BATCH_ID,
      schedulerExecutionId: EXECUTION_ID,
      txId: TX_ID,
      signedBytesSha256: TX_HASH,
    }],
    processUptime: [
      {
        workerId: 'worker-before', source: 'cloud-run-audit-log',
        startedAt: '2026-07-13T11:59:00.000Z', observedUntil: '2026-07-13T12:00:12.000Z',
        uptimeMs: 72_000, logEntryIds: ['log-start-before', 'log-termination'],
        headSha: HEAD_SHA, imageDigest: IMAGE_DIGEST,
      },
      {
        workerId: 'worker-after', source: 'cloud-run-audit-log',
        startedAt: '2026-07-13T12:00:13.000Z', observedUntil: '2026-07-13T12:00:20.000Z',
        uptimeMs: 7_000, logEntryIds: ['log-restart', 'log-observed'],
        headSha: HEAD_SHA, imageDigest: IMAGE_DIGEST,
      },
    ],
  };
}

interface PortOverrides {
  barrier?: CrashBarrier;
  observation?: CrashObservation;
  termination?: TerminationEvidence;
  restart?: RestartEvidence;
  recovery?: RecoveryEvidence;
  armError?: Error;
  disarmError?: Error;
}

function makePort(killpoint: CrashKillpoint, overrides: PortOverrides = {}): { port: CrashControlPort; events: string[] } {
  const events: string[] = [];
  return {
    events,
    port: {
      evidenceMode: 'offline-replay',
      async arm(input) {
        events.push(`arm:${input.killpoint}`);
        if (overrides.armError) throw overrides.armError;
      },
      async start(input) { events.push(`start:${input.runId}`); },
      async waitForKillpoint(input) {
        events.push(`barrier:${input.killpoint}`);
        return overrides.barrier ?? makeBarrier(killpoint);
      },
      async terminate(input) {
        events.push(`terminate:${input.workerId}`);
        return overrides.termination ?? termination();
      },
      async waitForRestart(input) {
        events.push(`restart:${input.previousWorkerId}`);
        return overrides.restart ?? restart();
      },
      async recover(input) {
        events.push(`recover:${input.runId}`);
        return overrides.recovery ?? recovery();
      },
      async inspect(input) {
        events.push(`inspect:${input.runId}`);
        return overrides.observation ?? crashObservation(killpoint);
      },
      async disarm(input) {
        events.push(`disarm:${input.killpoint}`);
        if (overrides.disarmError) throw overrides.disarmError;
      },
    },
  };
}

describe('orchestrateCrashCase — observed five-stage process lifecycle', () => {
  it.each(CRASH_KILLPOINTS)('passes a fully correlated %s case', async (killpoint) => {
    const { port, events } = makePort(killpoint);
    const evidence = await orchestrateCrashCase(makeInput(killpoint), port);
    expect(evidence).toMatchObject({
      verdict: 'pass',
      evidenceMode: 'offline-replay',
      batchId: BATCH_ID,
      transactionIds: [TX_ID],
      merkleRoots: [ROOT],
      terminatedAt: '2026-07-13T12:00:12.000Z',
      restartedAt: '2026-07-13T12:00:13.000Z',
      recoveredAt: '2026-07-13T12:00:15.000Z',
      initialWorkerUptimeMs: 72_000,
      replacementWorkerUptimeMs: 7_000,
    });
    expect(events).toContain('terminate:worker-before');
    expect(events[events.length - 1]).toBe(`disarm:${killpoint}`);
  });

  it('captures postIntent only after a durable barrier, never from input', async () => {
    expect('postIntent' in makeInput('after-intent-persist')).toBe(false);
    const early = await orchestrateCrashCase(makeInput('after-claim'), makePort('after-claim').port);
    expect(early.postIntent).toBeNull();
    const late = await orchestrateCrashCase(
      makeInput('after-intent-persist'),
      makePort('after-intent-persist').port,
    );
    expect(late.postIntent).toEqual({ txId: TX_ID, signedBytesSha256: TX_HASH });

    const injected = { ...makeInput('after-claim'), postIntent: { txId: TX_ID, signedBytesSha256: TX_HASH } };
    await expect(orchestrateCrashCase(injected, makePort('after-claim').port)).rejects.toThrow(/must not be predeclared/);
  });

  it('preserves durable claim order as Merkle identity', async () => {
    const barrier = makeBarrier('after-merkle-tree');
    barrier.claimedLeaves.reverse();
    const { port, events } = makePort('after-merkle-tree', { barrier });
    await expect(orchestrateCrashCase(makeInput('after-merkle-tree'), port)).rejects.toThrow(/durable claim order/);
    expect(events).not.toContain('terminate:worker-before');
  });

  it('forbids later-stage evidence at an earlier killpoint', async () => {
    const barrier = makeBarrier('after-claim');
    barrier.merkleRoot = ROOT;
    barrier.merkleBuiltAt = '2026-07-13T12:00:08.000Z';
    const { port, events } = makePort('after-claim', { barrier });
    await expect(orchestrateCrashCase(makeInput('after-claim'), port)).rejects.toThrow(/later-stage evidence/);
    expect(events).not.toContain('terminate:worker-before');
  });

  it('requires exact signet acceptance before a post-broadcast kill', async () => {
    const killpoint: CrashKillpoint = 'after-broadcast-before-submit';
    const barrier = makeBarrier(killpoint);
    barrier.networkAcceptance!.rawTxSha256 = 'e'.repeat(64);
    const { port, events } = makePort(killpoint, { barrier });
    await expect(orchestrateCrashCase(makeInput(killpoint), port)).rejects.toThrow(/exact durable signed transaction/);
    expect(events).not.toContain('terminate:worker-before');
  });

  it('requires Phase-4 persistence before the post-submit kill', async () => {
    const barrier = makeBarrier('after-submit-persist');
    delete barrier.phase4Persisted;
    const { port, events } = makePort('after-submit-persist', { barrier });
    await expect(orchestrateCrashCase(makeInput('after-submit-persist'), port)).rejects.toThrow(/Phase-4 persistence/);
    expect(events).not.toContain('terminate:worker-before');
  });

  it('validates real termination/restart/recovery chronology and exact runtime', async () => {
    const badRestart = restart();
    badRestart.startedAt = '2026-07-13T12:00:11.500Z';
    await expect(orchestrateCrashCase(
      makeInput('after-claim'),
      makePort('after-claim', { restart: badRestart }).port,
    )).rejects.toThrow(/chronology/);

    const badRuntime = termination();
    badRuntime.imageDigest = `sha256:${'e'.repeat(64)}`;
    await expect(orchestrateCrashCase(
      makeInput('after-claim'),
      makePort('after-claim', { termination: badRuntime }).port,
    )).rejects.toThrow(/exact tested head and image/);

    const crossFaultRecovery = { ...recovery(), faultWindowId: 'unrelated-fault-window' };
    await expect(orchestrateCrashCase(
      makeInput('after-claim'),
      makePort('after-claim', { recovery: crossFaultRecovery }).port,
    )).rejects.toThrow(/recovery.*fault window|fault window.*recovery/i);
  });

  it('rejects fabricated uptime arithmetic or missing audit entries', async () => {
    const actual = crashObservation('after-claim');
    actual.processUptime[1]!.uptimeMs = 8_000;
    await expect(orchestrateCrashCase(
      makeInput('after-claim'),
      makePort('after-claim', { observation: actual }).port,
    )).rejects.toThrow(/uptime milliseconds/);
  });

  it('requires exact lifecycle-to-uptime log identity bijection and no extra records', async () => {
    const unrelated = crashObservation('after-claim');
    const badTermination = termination();
    badTermination.logEntryId = 'not-present-in-initial-uptime';
    await expect(orchestrateCrashCase(
      makeInput('after-claim'),
      makePort('after-claim', { observation: unrelated, termination: badTermination }).port,
    )).rejects.toThrow(/termination.*uptime|log.*bijection/i);

    const extra = crashObservation('after-claim');
    extra.processUptime.push({ ...extra.processUptime[0]!, logEntryIds: [...extra.processUptime[0]!.logEntryIds] });
    await expect(orchestrateCrashCase(
      makeInput('after-claim'),
      makePort('after-claim', { observation: extra }).port,
    )).rejects.toThrow(/exact.*two|extra.*uptime/i);
  });

  it('independently derives and rejects an unrelated Merkle root before termination', async () => {
    const barrier = makeBarrier('after-merkle-tree');
    barrier.merkleRoot = 'e'.repeat(64);
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

  it('validates and replays a strict captured crash lifecycle offline', async () => {
    const killpoint: CrashKillpoint = 'after-intent-persist';
    const capture = parseCrashReplayCapture(JSON.stringify({
      schemaVersion: 1,
      captureId: 'crash-replay-offline',
      runId: `offline-${killpoint}`,
      barrier: makeBarrier(killpoint),
      termination: termination(),
      restart: restart(),
      recovery: recovery(),
      observation: crashObservation(killpoint),
    }));
    await expect(orchestrateCrashCase(
      makeInput(killpoint),
      new ReplayCrashControlAdapter(capture),
    )).resolves.toMatchObject({
      verdict: 'pass',
      evidenceMode: 'offline-replay',
      postIntent: { txId: TX_ID, signedBytesSha256: TX_HASH },
      restartedFrom: 'worker-before',
      restartedTo: 'worker-after',
    });
  });
});
