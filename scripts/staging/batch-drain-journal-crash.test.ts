import { describe, expect, it } from 'vitest';

import {
  DEFAULT_JOURNAL_AMBIGUITY_WINDOW_MS,
  assertJournalCrashEvidence,
  type JournalCrashCase,
  type JournalCrashEvidence,
  type TxidJournalSnapshot,
} from './batch-drain-journal-crash';

const HEAD_SHA = 'a'.repeat(40);
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const TX_ID = 'c'.repeat(64);
const ROOT = 'd'.repeat(64);
const ANCHOR_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
];

function journal(status: TxidJournalSnapshot['recoveryStatus']): TxidJournalSnapshot {
  const terminal = status === 'ADOPTED' || status === 'REVERTED' || status === 'PERSISTED';
  return {
    journalId: '10000000-0000-4000-8000-000000000001',
    batchId: 'batch-b1-b4',
    txId: TX_ID,
    fingerprintRoot: ROOT,
    anchorIds: ANCHOR_IDS,
    createdAt: '2026-07-15T12:00:01.000Z',
    recoveryStatus: status,
    holdReason: status === 'HELD' ? 'chain_client_unavailable' : null,
    heldAt: status === 'HELD' ? '2026-07-15T12:00:03.000Z' : null,
    resolvedAt: terminal ? '2026-07-15T12:31:02.000Z' : null,
    observedAt: terminal ? '2026-07-15T12:31:03.000Z' : '2026-07-15T12:00:02.000Z',
  };
}

function evidence(crashCase: JournalCrashCase): JournalCrashEvidence {
  const postJournal = crashCase !== 'B1';
  const networkAtBarrier = crashCase === 'B3' || crashCase === 'B4';
  const finalStatus = crashCase === 'B2'
    ? 'REVERTED'
    : crashCase === 'B3'
      ? 'ADOPTED'
      : crashCase === 'B4'
        ? 'PERSISTED'
        : null;
  const finalAnchorStatus = crashCase === 'B3' || crashCase === 'B4' ? 'SUBMITTED' : 'PENDING';
  return {
    schemaVersion: 1,
    crashCase,
    runId: `run-${crashCase.toLowerCase()}`,
    batchId: 'batch-b1-b4',
    schedulerExecutionId: 'scheduler-b1-b4',
    faultWindowId: 'fault-window-b1-b4',
    runtime: { headSha: HEAD_SHA, imageDigest: IMAGE_DIGEST },
    txId: postJournal ? TX_ID : null,
    fingerprintRoot: postJournal ? ROOT : null,
    anchorIds: ANCHOR_IDS,
    barrier: {
      observedAt: crashCase === 'B4' ? '2026-07-15T12:31:03.000Z' : '2026-07-15T12:00:02.000Z',
      journal: postJournal
        ? journal(crashCase === 'B4' ? 'PERSISTED' : 'PENDING')
        : null,
      networkTxIds: networkAtBarrier ? [TX_ID] : [],
      broadcastAttempts: networkAtBarrier ? [{ txId: TX_ID, signedBytesSha256: 'e'.repeat(64) }] : [],
    },
    recovery: {
      observedAt: '2026-07-15T12:31:04.000Z',
      journal: finalStatus ? journal(finalStatus) : null,
      lookups: crashCase === 'B2'
        ? [
            { source: 'getblock-rpc', outcome: 'not-found', txId: TX_ID, confirmations: null, observedAt: '2026-07-15T12:31:01.000Z' },
            { source: 'mempool-space', outcome: 'not-found', txId: TX_ID, confirmations: null, observedAt: '2026-07-15T12:31:01.500Z' },
          ]
        : crashCase === 'B3'
          ? [{ source: 'getblock-rpc', outcome: 'found', txId: TX_ID, confirmations: 0, observedAt: '2026-07-15T12:00:04.000Z' }]
          : [],
      anchors: ANCHOR_IDS.map((anchorId) => ({
        anchorId,
        status: finalAnchorStatus,
        chainTxId: finalAnchorStatus === 'SUBMITTED' ? TX_ID : null,
        creditDisposition: crashCase === 'B2' ? 'refunded' : 'not-charged',
      })),
      networkTxIds: networkAtBarrier ? [TX_ID] : [],
      broadcastAttempts: networkAtBarrier ? [{ txId: TX_ID, signedBytesSha256: 'e'.repeat(64) }] : [],
    },
  };
}

describe('assertJournalCrashEvidence — SCRUM-2692 B1-B4', () => {
  it.each([
    ['B1', 'NO_JOURNAL_SAFE_REVERT'],
    ['B2', 'AFFIRMATIVE_ABSENCE_REVERT'],
    ['B3', 'EXACT_TX_ADOPT'],
    ['B4', 'POST_SUBMIT_PERSISTED'],
  ] as const)('accepts %s and derives %s without trusting a caller verdict', (crashCase, resolution) => {
    expect(assertJournalCrashEvidence(evidence(crashCase))).toMatchObject({
      crashCase,
      resolution,
      duplicateBroadcasts: 0,
      exactHeadSha: HEAD_SHA,
      exactImageDigest: IMAGE_DIGEST,
    });
  });

  it('B1 rejects any pre-sign journal, network transaction, or broadcast attempt', () => {
    const value = evidence('B1');
    value.barrier.journal = journal('PENDING');
    expect(() => assertJournalCrashEvidence(value)).toThrow(/B1.*journal/i);

    const withNetwork = evidence('B1');
    withNetwork.barrier.networkTxIds = [TX_ID];
    expect(() => assertJournalCrashEvidence(withNetwork)).toThrow(/B1.*network/i);
  });

  it('B2 requires two-source affirmative absence after the fixed ambiguity window', () => {
    const oneSource = evidence('B2');
    oneSource.recovery.lookups.pop();
    expect(() => assertJournalCrashEvidence(oneSource)).toThrow(/two-source.*absence/i);

    const tooEarly = evidence('B2');
    tooEarly.recovery.lookups.forEach((lookup) => { lookup.observedAt = '2026-07-15T12:29:59.999Z'; });
    expect(() => assertJournalCrashEvidence(tooEarly)).toThrow(/ambiguity window/i);
    expect(DEFAULT_JOURNAL_AMBIGUITY_WINDOW_MS).toBe(30 * 60 * 1000);

    const outage = evidence('B2');
    outage.recovery.lookups[1]!.outcome = 'unavailable';
    expect(() => assertJournalCrashEvidence(outage)).toThrow(/affirmative.*absence|not-found/i);
  });

  it('B2 requires one atomic cohort REVERT with PENDING anchors and compensated credits', () => {
    const partial = evidence('B2');
    partial.recovery.anchors[0]!.status = 'BROADCASTING';
    expect(() => assertJournalCrashEvidence(partial)).toThrow(/complete.*cohort|PENDING/i);

    const retainedCharge = evidence('B2');
    retainedCharge.recovery.anchors[0]!.creditDisposition = 'retained';
    expect(() => assertJournalCrashEvidence(retainedCharge)).toThrow(/credit.*compensat|refund/i);
  });

  it('B3 accepts only exact-tx ADOPT and forbids rebroadcast/refund', () => {
    const wrongTx = evidence('B3');
    wrongTx.recovery.lookups[0]!.txId = 'f'.repeat(64);
    expect(() => assertJournalCrashEvidence(wrongTx)).toThrow(/exact.*txid/i);

    const rebroadcast = evidence('B3');
    rebroadcast.recovery.broadcastAttempts.push({ txId: TX_ID, signedBytesSha256: 'e'.repeat(64) });
    expect(() => assertJournalCrashEvidence(rebroadcast)).toThrow(/rebroadcast|duplicate/i);

    const reverted = evidence('B3');
    reverted.recovery.journal = journal('REVERTED');
    expect(() => assertJournalCrashEvidence(reverted)).toThrow(/ADOPTED/i);
  });

  it('B4 requires PERSISTED at the barrier and proves recovery made no mutation', () => {
    const pending = evidence('B4');
    pending.barrier.journal = journal('PENDING');
    expect(() => assertJournalCrashEvidence(pending)).toThrow(/B4.*PERSISTED/i);

    const mutated = evidence('B4');
    mutated.recovery.journal = journal('ADOPTED');
    expect(() => assertJournalCrashEvidence(mutated)).toThrow(/no recovery mutation|PERSISTED/i);
  });

  it('rejects cross-run identity, incomplete cohorts, and impossible chronology', () => {
    const crossBatch = evidence('B3');
    crossBatch.recovery.journal!.batchId = 'other-batch';
    expect(() => assertJournalCrashEvidence(crossBatch)).toThrow(/identity|batch/i);

    const missing = evidence('B3');
    missing.recovery.anchors.pop();
    expect(() => assertJournalCrashEvidence(missing)).toThrow(/complete.*cohort/i);

    const backwards = evidence('B3');
    backwards.recovery.observedAt = '2026-07-15T11:59:59.000Z';
    expect(() => assertJournalCrashEvidence(backwards)).toThrow(/chronology/i);
  });
});
