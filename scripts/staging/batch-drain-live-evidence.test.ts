import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  SOAK_WALL_FLOOR_MINUTES,
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
    recoveries: [],
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
  const declarationRaw = JSON.stringify(value);
  const declarationSha256 = sha256(declarationRaw);
  const captures = rawCapturesForDeclaration(declarationSha256);
  return trust(value, captures);
}

function trust(value: Record<string, unknown>, captures: RawCaptureTextSet): ImmutableRunDeclaration {
  const declarationRaw = JSON.stringify(value);
  const declarationSha256 = sha256(declarationRaw);
  const trustRootRaw = JSON.stringify({
    schemaVersion: 1,
    trustRootId: 'trust-root-rig-b1-r3',
    declarationRaw,
    declarationSha256,
    rawCaptureDigests: digests(captures),
  });
  return parseImmutableRunDeclaration(trustRootRaw, sha256(trustRootRaw));
}

function rawCaptures(declaration: ImmutableRunDeclaration): RawCaptureTextSet {
  return rawCapturesForDeclaration(declaration.contentSha256);
}

function rawCapturesForDeclaration(declarationSha256: string): RawCaptureTextSet {
  const common = (source: string, exportId: string) => ({
    schemaVersion: 1,
    source,
    exportId,
    declarationSha256,
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
          correlatedDrainExecutionId: null, faultWindowId: null,
          workerRevision: 'arkova-worker-rig-b1-00001', path: '/jobs/check-confirmations',
          workerId: 'worker-live-1',
          trigger: 'global-flush', statusCode: 200,
          firedAt: '2026-07-13T11:59:00.000Z', completedAt: '2026-07-13T11:59:01.000Z',
        },
        {
          recordId: 'scheduler-drain-record', purpose: 'drain',
          schedulerExecutionId: 'scheduler-live-1', gcpProjectId: 'arkova-rig-b1',
          correlatedDrainExecutionId: null, faultWindowId: 'window-live-1',
          workerRevision: 'arkova-worker-rig-b1-00001', path: '/jobs/org-queue-scheduler',
          workerId: 'worker-live-1',
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
          workerId: 'worker-live-1',
          event: 'trigger-fired', schedulerExecutionId: 'scheduler-live-1', batchId: 'batch-live-1',
          trigger: 'org-scheduler', fingerprint: null, orgId: null, decision: null, reason: null,
          referenceId: null, requiredAmount: null, balanceBefore: null, balanceAfter: null,
          occurredAt: '2026-07-13T12:00:06.000Z',
        },
        {
          recordId: 'log-gate-healthy', insertId: 'insert-gate-healthy', traceId: 'trace-live-1',
          workerId: 'worker-live-1',
          event: 'credit-gate', schedulerExecutionId: 'scheduler-live-1', batchId: 'batch-live-1',
          trigger: 'org-scheduler', fingerprint: FP_DRAINED, orgId: 'org-healthy',
          decision: 'not-required', reason: null, referenceId: null, requiredAmount: 0,
          balanceBefore: null, balanceAfter: null, occurredAt: '2026-07-13T12:00:07.000Z',
        },
        {
          recordId: 'log-gate-poison', insertId: 'insert-gate-poison', traceId: 'trace-live-1',
          workerId: 'worker-live-1',
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
        workerId: 'worker-live-1',
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
        schedulerExecutionId: 'scheduler-live-1', workerId: 'worker-live-1',
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
        { recordId: 'cloud-run-start', workerId: 'worker-live-1', event: 'started', occurredAt: '2026-07-13T11:58:00.000Z' },
        ...Array.from({ length: 583 }, (_, index) => ({
          recordId: `cloud-run-heartbeat-${index}`,
          workerId: 'worker-live-1',
          event: 'heartbeat',
          occurredAt: new Date(Date.parse('2026-07-13T12:00:00.000Z') + index * 5 * 60_000).toISOString(),
        })),
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
        ...Array.from({ length: 583 }, (_, index) => ({
          recordId: `runner-heartbeat-${index}`,
          event: 'heartbeat',
          occurredAt: new Date(Date.parse('2026-07-13T12:00:00.000Z') + index * 5 * 60_000).toISOString(),
        })),
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
    const result = deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared));
    expect(result).toMatchObject({
      declarationSha256: declared.contentSha256,
      gitBaseSha: BASE_SHA,
      gitHeadSha: HEAD_SHA,
      imageDigest: IMAGE_DIGEST,
      workerUptimeMs: SOAK_WALL_FLOOR_MINUTES * 60_000,
      requiredWorkerUptimeMs: SOAK_REQUIRED_UPTIME_MINUTES * 60_000,
      windows: [{ drainedLeaves: 1, poisonLeaves: 1 }],
      sourceDigests: actualDigests,
    });
    expect(result.sourceExportIds).toHaveLength(6);
  });

  it('rejects caller-controlled floor fields in the immutable declaration', () => {
    expect(() => immutable({ ...declarationValue(), requiredFloorMinutes: 1 })).toThrow(/unrecognized/i);
  });

  it('keeps the worker clock fixed at 48h while wall time is fixed at +30m', () => {
    expect(SOAK_REQUIRED_UPTIME_MINUTES).toBe(2_880);
    expect(SOAK_WALL_FLOOR_MINUTES).toBe(2_910);
  });

  it('rejects missing, wrong-type, and unknown raw keys', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    const scheduler = JSON.parse(raw.scheduler) as Record<string, unknown>;
    delete scheduler.exportId;
    raw.scheduler = JSON.stringify(scheduler);
    expect(() => parseRawCaptureSet(raw, declared)).toThrow(/exportId|required/i);

    const wrongType = rawCaptures(declared);
    const db = JSON.parse(wrongType.database) as Record<string, unknown>;
    db.queryId = 42;
    wrongType.database = JSON.stringify(db);
    expect(() => parseRawCaptureSet(wrongType, declared)).toThrow(/queryId|string/i);

    const unknown = rawCaptures(declared);
    const signet = JSON.parse(unknown.signet) as Record<string, unknown>;
    signet.invented = true;
    unknown.signet = JSON.stringify(signet);
    expect(() => parseRawCaptureSet(unknown, declared)).toThrow(/unrecognized/i);
  });

  it('rejects cross-source head and duplicate source IDs', () => {
    const declared = immutable();
    const wrongHead = rawCaptures(declared);
    const signet = JSON.parse(wrongHead.signet) as Record<string, unknown>;
    signet.gitHeadSha = 'e'.repeat(40);
    wrongHead.signet = JSON.stringify(signet);
    expect(() => deriveAndAssertLiveEvidence(
      trust(declarationValue(), wrongHead),
      parseRawCaptureSet(wrongHead, trust(declarationValue(), wrongHead)),
    )).toThrow(/cross-head/);

    const duplicates = rawCaptures(declared);
    const supervisor = JSON.parse(duplicates.supervisor) as Record<string, unknown>;
    supervisor.exportId = 'export-signet';
    duplicates.supervisor = JSON.stringify(supervisor);
    expect(() => deriveAndAssertLiveEvidence(
      trust(declarationValue(), duplicates),
      parseRawCaptureSet(duplicates, trust(declarationValue(), duplicates)),
    )).toThrow(/duplicate identities/);
  });

  it('rejects duplicate raw record IDs, undeclared rows, and inconsistent timestamps', () => {
    const declared = immutable();
    const duplicate = rawCaptures(declared);
    const signet = JSON.parse(duplicate.signet) as { records: Array<Record<string, unknown>> };
    signet.records.push({ ...signet.records[0]! });
    duplicate.signet = JSON.stringify(signet);
    expect(() => deriveAndAssertLiveEvidence(
      trust(declarationValue(), duplicate),
      parseRawCaptureSet(duplicate, trust(declarationValue(), duplicate)),
    )).toThrow(/exactly one RPC result|duplicate|exact closed set/i);

    const undeclared = rawCaptures(declared);
    const db = JSON.parse(undeclared.database) as { ledgerDeltas: Array<Record<string, unknown>> };
    db.ledgerDeltas.push({ schedulerExecutionId: 'scheduler-invented', orgId: 'org-x', delta: 0 });
    undeclared.database = JSON.stringify(db);
    expect(() => deriveAndAssertLiveEvidence(
      trust(declarationValue(), undeclared),
      parseRawCaptureSet(undeclared, trust(declarationValue(), undeclared)),
    )).toThrow(/undeclared or missing drain execution/);

    const chronology = rawCaptures(declared);
    const scheduler = JSON.parse(chronology.scheduler) as { records: Array<{ firedAt: string; completedAt: string }> };
    scheduler.records[0]!.completedAt = '2026-07-13T11:58:59.000Z';
    chronology.scheduler = JSON.stringify(scheduler);
    expect(() => deriveAndAssertLiveEvidence(
      trust(declarationValue(), chronology),
      parseRawCaptureSet(chronology, trust(declarationValue(), chronology)),
    )).toThrow(/invalid chronology/);
  });

  it('rejects even a one-millisecond short worker-uptime clock', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    const cloudRun = JSON.parse(raw.cloudRun) as { records: Array<{ event: string; occurredAt: string }> };
    const shortEnd = '2026-07-15T11:59:59.999Z';
    cloudRun.records = cloudRun.records.filter((record) => record.event !== 'heartbeat' || record.occurredAt <= shortEnd);
    cloudRun.records.find((record) => record.event === 'stopped')!.occurredAt = shortEnd;
    raw.cloudRun = JSON.stringify(cloudRun);
    expect(() => deriveAndAssertLiveEvidence(
      trust(declarationValue(), raw),
      parseRawCaptureSet(raw, trust(declarationValue(), raw)),
    )).toThrow(/fixed 48h worker-uptime floor/);
  });

  it('rejects tampering even when the caller recomputes the changed export digest', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    const signet = JSON.parse(raw.signet) as { records: Array<{ nodeId: string }> };
    signet.records[0]!.nodeId = 'caller-rewritten-node';
    raw.signet = JSON.stringify(signet);
    expect(digests(raw).signet).not.toBe(declared.rawCaptureDigests.signet);
    expect(() => parseRawCaptureSet(raw, declared)).toThrow(/trusted.*digest|content digest/i);
  });

  it('rejects pre-Scheduler signet acceptance even when independently committed', () => {
    const initial = immutable();
    const raw = rawCaptures(initial);
    const signet = JSON.parse(raw.signet) as { records: Array<{ observedAt: string }> };
    signet.records[0]!.observedAt = '2026-07-13T12:00:00.000Z';
    raw.signet = JSON.stringify(signet);
    const declared = trust(declarationValue(), raw);
    expect(() => deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared))).toThrow(
      /signet.*Scheduler execution|acceptance.*chronology/i,
    );
  });

  it('rejects every unconsumed or non-200 Scheduler recovery record', () => {
    const initial = immutable();
    const raw = rawCaptures(initial);
    const scheduler = JSON.parse(raw.scheduler) as { records: Array<Record<string, unknown>> };
    scheduler.records.push({
      recordId: 'unconsumed-recovery', purpose: 'recovery', schedulerExecutionId: 'unconsumed-recovery-execution',
      correlatedDrainExecutionId: 'scheduler-live-1', faultWindowId: 'window-live-1',
      gcpProjectId: 'arkova-rig-b1', workerRevision: 'arkova-worker-rig-b1-00001', workerId: 'worker-live-1',
      path: '/jobs/recover-broadcasts', trigger: 'global-flush', statusCode: 500,
      firedAt: '2026-07-13T12:02:00.000Z', completedAt: '2026-07-13T12:02:01.000Z',
    });
    raw.scheduler = JSON.stringify(scheduler);
    const declared = trust(declarationValue(), raw);
    expect(() => deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared))).toThrow(
      /undeclared recovery|recovery.*200/i,
    );
  });

  it('rejects a recovery that cross-pairs one drain with another pass fault window', () => {
    const value = declarationValue();
    const windows = value.windows as Array<Record<string, unknown>>;
    const firstPass = (windows[0]!.passes as Array<Record<string, unknown>>)[0]!;
    windows.push({
      ...windows[0],
      scenarioId: 'second-window',
      passes: [{
        ...firstPass,
        batchId: 'batch-live-2',
        schedulerExecutionId: 'scheduler-live-2',
        faultWindow: {
          id: 'window-live-2',
          startsAt: '2026-07-13T12:10:00.000Z',
          endsAt: '2026-07-13T12:15:00.000Z',
        },
        claims: [{ fingerprint: '9'.repeat(64), orgId: 'org-second' }],
      }],
    });
    value.recoveries = [{
      schedulerExecutionId: 'scheduler-recovery-cross-pair',
      correlatedDrainExecutionId: 'scheduler-live-1',
      faultWindowId: 'window-live-2',
    }];
    expect(() => immutable(value)).toThrow(/recovery.*same.*fault|exact drain.*fault/i);
  });

  it('rejects credit DB metadata outside its exact Scheduler execution', () => {
    const initial = immutable();
    const raw = rawCaptures(initial);
    const database = JSON.parse(raw.database) as { passRows: Array<{ queueCreditDeniedAt: string | null }> };
    database.passRows[1]!.queueCreditDeniedAt = '2026-07-15T12:00:00.000Z';
    raw.database = JSON.stringify(database);
    const declared = trust(declarationValue(), raw);
    expect(() => deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared))).toThrow(
      /credit.*outside.*Scheduler execution|queueCreditDeniedAt/i,
    );
  });

  it('accepts the serving worker starting before preclock but rejects sparse heartbeat proof', () => {
    const declared = immutable();
    const raw = rawCaptures(declared);
    expect(() => deriveAndAssertLiveEvidence(declared, parseRawCaptureSet(raw, declared))).not.toThrow();

    const cloudRun = JSON.parse(raw.cloudRun) as { records: Array<{ event: string }> };
    cloudRun.records = cloudRun.records.filter((record, index) => record.event !== 'heartbeat' || index < 3);
    raw.cloudRun = JSON.stringify(cloudRun);
    const sparse = trust(declarationValue(), raw);
    expect(() => deriveAndAssertLiveEvidence(sparse, parseRawCaptureSet(raw, sparse))).toThrow(/heartbeat.*gap|continuous/i);
  });
});
