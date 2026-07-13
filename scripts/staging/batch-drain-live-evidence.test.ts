import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  SOAK_REQUIRED_UPTIME_MINUTES,
  deriveAndAssertLiveEvidence,
  parseImmutableRunDeclaration,
  parseRawCaptureSet,
  type ImmutableRunDeclaration,
  type RawCaptureDigests,
  type RawCaptureTextSet,
} from './batch-drain-live-evidence';

const BASE_SHA = '0'.repeat(40);
const HEAD_SHA = 'a'.repeat(40);
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const PROJECT_REF = 'abcdefghijklmnopqrst';
const FP_DRAINED = '1'.repeat(64);
const FP_POISON = '2'.repeat(64);
const TX_ID = 'c'.repeat(64);
const SIGNED_HASH = 'd'.repeat(64);

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function declarationValue(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    declarationId: 'decl-rig-b1-r3',
    gitBaseSha: BASE_SHA,
    gitHeadSha: HEAD_SHA,
    imageDigest: IMAGE_DIGEST,
    rigId: 'RIG-B1',
    gcpProjectId: 'arkova-rig-b1',
    projectRef: PROJECT_REF,
    soakId: 'soak-rig-b1-r3',
    leaseId: 'lease-rig-b1',
    cleanMirrorAttestationId: 'clean-mirror-rig-b1',
    workerService: 'arkova-worker-rig-b1',
    workerRevision: 'arkova-worker-rig-b1-00001',
    region: 'us-central1',
    soakStartedAt: '2026-07-13T12:00:00.000Z',
    soakEndedAt: '2026-07-15T12:30:00.000Z',
    windows: [{
      scenarioId: 'poison-window',
      kind: 'poison-isolation',
      armedTrigger: 'org-scheduler',
      expectedInitialPending: 2,
      expectedFinalPending: 1,
      passes: [{
        batchId: 'batch-live-1',
        armedTrigger: 'org-scheduler',
        schedulerExecutionId: 'scheduler-live-1',
        faultWindow: {
          id: 'window-live-1',
          startsAt: '2026-07-13T12:00:00.000Z',
          endsAt: '2026-07-13T12:01:00.000Z',
        },
        claims: [
          { fingerprint: FP_DRAINED, orgId: 'org-healthy' },
          { fingerprint: FP_POISON, orgId: 'org-poison' },
        ],
      }],
    }],
  };
}

function immutable(value: Record<string, unknown> = declarationValue()): ImmutableRunDeclaration {
  const raw = JSON.stringify(value);
  return parseImmutableRunDeclaration(raw, sha256(raw));
}

function rawCaptures(declaration: ImmutableRunDeclaration): RawCaptureTextSet {
  const common = (source: string, exportId: string) => ({
    schemaVersion: 1,
    source,
    exportId,
    declarationSha256: declaration.contentSha256,
    rigId: 'RIG-B1',
    soakId: 'soak-rig-b1-r3',
    gitHeadSha: HEAD_SHA,
    imageDigest: IMAGE_DIGEST,
    generatedAt: '2026-07-15T12:31:00.000Z',
  });
  return {
    scheduler: JSON.stringify({
      ...common('cloud-scheduler', 'export-scheduler'),
      records: [
        {
          recordId: 'scheduler-preclock-record', purpose: 'preclock',
          schedulerExecutionId: 'scheduler-preclock', gcpProjectId: 'arkova-rig-b1',
          workerRevision: 'arkova-worker-rig-b1-00001', path: '/jobs/check-confirmations',
          trigger: 'global-flush', statusCode: 200,
          firedAt: '2026-07-13T11:59:00.000Z', completedAt: '2026-07-13T11:59:01.000Z',
        },
        {
          recordId: 'scheduler-drain-record', purpose: 'drain',
          schedulerExecutionId: 'scheduler-live-1', gcpProjectId: 'arkova-rig-b1',
          workerRevision: 'arkova-worker-rig-b1-00001', path: '/jobs/org-queue-scheduler',
          trigger: 'org-scheduler', statusCode: 200,
          firedAt: '2026-07-13T12:00:05.000Z', completedAt: '2026-07-13T12:00:20.000Z',
        },
      ],
    }),
    workerLogs: JSON.stringify({
      ...common('cloud-logging', 'export-worker-logs'),
      records: [
        {
          recordId: 'log-trigger', insertId: 'insert-trigger', traceId: 'trace-live-1',
          event: 'trigger-fired', schedulerExecutionId: 'scheduler-live-1', batchId: 'batch-live-1',
          trigger: 'org-scheduler', fingerprint: null, orgId: null, decision: null, reason: null,
          referenceId: null, requiredAmount: null, balanceBefore: null, balanceAfter: null,
          occurredAt: '2026-07-13T12:00:06.000Z',
        },
        {
          recordId: 'log-gate-healthy', insertId: 'insert-gate-healthy', traceId: 'trace-live-1',
          event: 'credit-gate', schedulerExecutionId: 'scheduler-live-1', batchId: 'batch-live-1',
          trigger: 'org-scheduler', fingerprint: FP_DRAINED, orgId: 'org-healthy',
          decision: 'not-required', reason: null, referenceId: null, requiredAmount: 0,
          balanceBefore: null, balanceAfter: null, occurredAt: '2026-07-13T12:00:07.000Z',
        },
        {
          recordId: 'log-gate-poison', insertId: 'insert-gate-poison', traceId: 'trace-live-1',
          event: 'credit-gate', schedulerExecutionId: 'scheduler-live-1', batchId: 'batch-live-1',
          trigger: 'org-scheduler', fingerprint: FP_POISON, orgId: 'org-poison',
          decision: 'denied', reason: 'insufficient_credits', referenceId: 'anchor-poison',
          requiredAmount: 1, balanceBefore: 0, balanceAfter: 0, occurredAt: '2026-07-13T12:00:08.000Z',
        },
      ],
    }),
    database: JSON.stringify({
      ...common('db-query-export', 'export-database'),
      projectRef: PROJECT_REF,
      queryId: 'repeatable-read-query-live-1',
      isolation: 'repeatable-read',
      executions: [{
        schedulerExecutionId: 'scheduler-live-1', armedTrigger: 'org-scheduler',
        faultWindowId: 'window-live-1', startedAt: '2026-07-13T12:00:05.000Z',
        completedAt: '2026-07-13T12:00:20.000Z', pendingBefore: 2, pendingAfter: 1,
      }],
      passRows: [
        {
          fingerprint: FP_DRAINED, orgId: 'org-healthy', batchId: 'batch-live-1',
          schedulerExecutionId: 'scheduler-live-1', claimOrder: 1, status: 'SUBMITTED',
          chainTxId: TX_ID, merkleRoot: FP_DRAINED, creditDenialReason: null,
          queueCreditChargedAt: null, queueCreditDeniedAt: null,
        },
        {
          fingerprint: FP_POISON, orgId: 'org-poison', batchId: 'batch-live-1',
          schedulerExecutionId: 'scheduler-live-1', claimOrder: 2, status: 'PENDING',
          chainTxId: null, merkleRoot: null, creditDenialReason: 'insufficient_credits',
          queueCreditChargedAt: null, queueCreditDeniedAt: '2026-07-13T12:00:08.000Z',
        },
      ],
      transactions: [{
        txId: TX_ID, batchId: 'batch-live-1', merkleRoot: FP_DRAINED, signedBytesSha256: SIGNED_HASH,
      }],
      txLeaves: [{
        txId: TX_ID, batchId: 'batch-live-1', fingerprint: FP_DRAINED,
        orgId: 'org-healthy', merkleIndex: 0,
      }],
      proofs: [{
        txId: TX_ID, batchId: 'batch-live-1', fingerprint: FP_DRAINED,
        orgId: 'org-healthy', merkleIndex: 0, merkleRoot: FP_DRAINED,
        leafCount: 1, proofPath: [],
      }],
      creditLedgerEvents: [],
      orgBalances: [
        { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-healthy', before: 10, after: 10 },
        { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-poison', before: 0, after: 0 },
      ],
      ledgerDeltas: [
        { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-healthy', delta: 0 },
        { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-poison', delta: 0 },
      ],
    }),
    signet: JSON.stringify({
      ...common('signet-rpc', 'export-signet'),
      records: [{
        recordId: 'signet-record-1', rpcRequestId: 'rpc-request-1', rpcMethod: 'getrawtransaction',
        txId: TX_ID, batchId: 'batch-live-1', merkleRoot: FP_DRAINED,
        rawTxSha256: SIGNED_HASH, nodeId: 'signet-rig-b1', network: 'signet', state: 'mempool',
        observedAt: '2026-07-13T12:00:12.000Z',
      }],
    }),
    cloudRun: JSON.stringify({
      ...common('cloud-run-lifecycle', 'export-cloud-run'),
      gcpProjectId: 'arkova-rig-b1', workerService: 'arkova-worker-rig-b1',
      workerRevision: 'arkova-worker-rig-b1-00001', region: 'us-central1',
      records: [
        { recordId: 'cloud-run-start', workerId: 'worker-live-1', event: 'started', occurredAt: '2026-07-13T12:00:00.000Z' },
        { recordId: 'cloud-run-stop', workerId: 'worker-live-1', event: 'stopped', occurredAt: '2026-07-15T12:30:00.000Z' },
      ],
    }),
    supervisor: JSON.stringify({
      ...common('supervisor-records', 'export-supervisor'),
      cleanMirror: {
        attestationId: 'clean-mirror-rig-b1', result: 'pass', projectRef: PROJECT_REF,
        gitBaseSha: BASE_SHA, gitHeadSha: HEAD_SHA, observedAt: '2026-07-13T11:58:00.000Z',
      },
      lease: {
        leaseId: 'lease-rig-b1', state: 'active', holder: 'lane1-rig-operator',
        acquiredAt: '2026-07-13T11:57:00.000Z', expiresAt: '2026-07-15T13:00:00.000Z',
      },
      runnerId: 'runner-rig-b1', supervisor: 'cloud-run-supervisor', mode: 'log-and-continue',
      records: [
        { recordId: 'runner-start', event: 'started', occurredAt: '2026-07-13T11:59:59.000Z' },
        { recordId: 'runner-heartbeat-1', event: 'heartbeat', occurredAt: '2026-07-13T12:00:00.000Z' },
        { recordId: 'runner-heartbeat-2', event: 'heartbeat', occurredAt: '2026-07-15T12:29:59.000Z' },
        { recordId: 'runner-stop', event: 'stopped', occurredAt: '2026-07-15T12:30:01.000Z' },
      ],
    }),
  };
}

function digests(raw: RawCaptureTextSet): RawCaptureDigests {
  return {
    scheduler: sha256(raw.scheduler), workerLogs: sha256(raw.workerLogs), database: sha256(raw.database),
    signet: sha256(raw.signet), cloudRun: sha256(raw.cloudRun), supervisor: sha256(raw.supervisor),
  };
}

describe('deriveAndAssertLiveEvidence — independent strict raw-source replay', () => {
  it('derives a valid rig verdict and binds every exact raw digest', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    const actualDigests = digests(raw);
    const result = deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared, actualDigests));
    expect(result).toMatchObject({
      declarationSha256: declared.contentSha256,
      gitBaseSha: BASE_SHA,
      gitHeadSha: HEAD_SHA,
      imageDigest: IMAGE_DIGEST,
      workerUptimeMs: SOAK_REQUIRED_UPTIME_MINUTES * 60_000,
      requiredWorkerUptimeMs: SOAK_REQUIRED_UPTIME_MINUTES * 60_000,
      windows: [{ drainedLeaves: 1, poisonLeaves: 1 }],
      sourceDigests: actualDigests,
    });
    expect(result.sourceExportIds).toHaveLength(6);
  });

  it('rejects caller-controlled floor fields in the immutable declaration', () => {
    expect(() => immutable({ ...declarationValue(), requiredFloorMinutes: 1 })).toThrow(/unrecognized/i);
  });

  it('rejects missing, wrong-type, and unknown raw keys', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    const scheduler = JSON.parse(raw.scheduler) as Record<string, unknown>;
    delete scheduler.exportId;
    raw.scheduler = JSON.stringify(scheduler);
    expect(() => parseRawCaptureSet(raw, declared, digests(raw))).toThrow(/exportId|required/i);

    const wrongType = rawCaptures(declared);
    const db = JSON.parse(wrongType.database) as Record<string, unknown>;
    db.queryId = 42;
    wrongType.database = JSON.stringify(db);
    expect(() => parseRawCaptureSet(wrongType, declared, digests(wrongType))).toThrow(/queryId|string/i);

    const unknown = rawCaptures(declared);
    const signet = JSON.parse(unknown.signet) as Record<string, unknown>;
    signet.invented = true;
    unknown.signet = JSON.stringify(signet);
    expect(() => parseRawCaptureSet(unknown, declared, digests(unknown))).toThrow(/unrecognized/i);
  });

  it('rejects cross-source head and duplicate source IDs', () => {
    const declared = immutable();
    const wrongHead = rawCaptures(declared);
    const signet = JSON.parse(wrongHead.signet) as Record<string, unknown>;
    signet.gitHeadSha = 'e'.repeat(40);
    wrongHead.signet = JSON.stringify(signet);
    expect(() => deriveAndAssertLiveEvidence(
      declared,
      parseRawCaptureSet(wrongHead, declared, digests(wrongHead)),
    )).toThrow(/cross-head/);

    const duplicates = rawCaptures(declared);
    const supervisor = JSON.parse(duplicates.supervisor) as Record<string, unknown>;
    supervisor.exportId = 'export-signet';
    duplicates.supervisor = JSON.stringify(supervisor);
    expect(() => deriveAndAssertLiveEvidence(
      declared,
      parseRawCaptureSet(duplicates, declared, digests(duplicates)),
    )).toThrow(/duplicate identities/);
  });

  it('rejects duplicate raw record IDs, undeclared rows, and inconsistent timestamps', () => {
    const declared = immutable();
    const duplicate = rawCaptures(declared);
    const signet = JSON.parse(duplicate.signet) as { records: Array<Record<string, unknown>> };
    signet.records.push({ ...signet.records[0]! });
    duplicate.signet = JSON.stringify(signet);
    expect(() => deriveAndAssertLiveEvidence(
      declared,
      parseRawCaptureSet(duplicate, declared, digests(duplicate)),
    )).toThrow(/exactly one RPC result|duplicate|exact closed set/i);

    const undeclared = rawCaptures(declared);
    const db = JSON.parse(undeclared.database) as { ledgerDeltas: Array<Record<string, unknown>> };
    db.ledgerDeltas.push({ schedulerExecutionId: 'scheduler-invented', orgId: 'org-x', delta: 0 });
    undeclared.database = JSON.stringify(db);
    expect(() => deriveAndAssertLiveEvidence(
      declared,
      parseRawCaptureSet(undeclared, declared, digests(undeclared)),
    )).toThrow(/undeclared or missing drain execution/);

    const chronology = rawCaptures(declared);
    const scheduler = JSON.parse(chronology.scheduler) as { records: Array<{ firedAt: string; completedAt: string }> };
    scheduler.records[0]!.completedAt = '2026-07-13T11:58:59.000Z';
    chronology.scheduler = JSON.stringify(scheduler);
    expect(() => deriveAndAssertLiveEvidence(
      declared,
      parseRawCaptureSet(chronology, declared, digests(chronology)),
    )).toThrow(/invalid chronology/);
  });

  it('rejects even a one-millisecond short worker-uptime clock', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    const cloudRun = JSON.parse(raw.cloudRun) as { records: Array<{ occurredAt: string }> };
    cloudRun.records[1]!.occurredAt = '2026-07-15T12:29:59.999Z';
    raw.cloudRun = JSON.stringify(cloudRun);
    expect(() => deriveAndAssertLiveEvidence(
      declared,
      parseRawCaptureSet(raw, declared, digests(raw)),
    )).toThrow(/fixed 48h floor plus 30-minute overshoot/);
  });
});
