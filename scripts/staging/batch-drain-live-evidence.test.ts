import { describe, expect, it, vi } from 'vitest';

import {
  LIVE_EVIDENCE_ENABLE_VALUE,
  assertLiveEvidenceBundle,
  executeLiveEvidenceConsumer,
  type LiveEvidenceAdapter,
  type LiveEvidenceBundle,
  type LiveEvidenceRequest,
} from './batch-drain-live-evidence';

const HEAD_SHA = 'a'.repeat(40);
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const PROJECT_REF = 'abcdefghijklmnopqrst';
const FP_DRAINED = '1'.repeat(64);
const FP_POISON = '2'.repeat(64);
const TX_ID = 'c'.repeat(64);
const SIGNED_HASH = 'd'.repeat(64);

function request(): LiveEvidenceRequest {
  return {
    rigId: 'RIG-B1',
    projectRef: PROJECT_REF,
    soakId: 'soak-rig-b1-r3',
    headSha: HEAD_SHA,
    imageDigest: IMAGE_DIGEST,
    workerService: 'arkova-worker-rig-b1',
    workerRevision: 'arkova-worker-rig-b1-00001',
    region: 'us-central1',
    cleanMirrorAttestationId: 'clean-mirror-rig-b1',
    leaseId: 'lease-rig-b1',
    requiredFloorMinutes: 1,
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

function bundle(): LiveEvidenceBundle {
  return {
    identity: {
      rigId: 'RIG-B1',
      projectRef: PROJECT_REF,
      soakId: 'soak-rig-b1-r3',
      headSha: HEAD_SHA,
      imageDigest: IMAGE_DIGEST,
      workerService: 'arkova-worker-rig-b1',
      workerRevision: 'arkova-worker-rig-b1-00001',
      region: 'us-central1',
    },
    cleanMirror: {
      attestationId: 'clean-mirror-rig-b1',
      result: 'pass',
      projectRef: PROJECT_REF,
      headSha: HEAD_SHA,
      observedAt: '2026-07-13T11:58:00.000Z',
    },
    lease: {
      leaseId: 'lease-rig-b1',
      rigId: 'RIG-B1',
      projectRef: PROJECT_REF,
      soakId: 'soak-rig-b1-r3',
      state: 'active',
      holder: 'lane1-rig-operator',
      acquiredAt: '2026-07-13T11:57:00.000Z',
      expiresAt: '2026-07-13T13:00:00.000Z',
    },
    preclockSchedulerProbe: {
      schedulerExecutionId: 'scheduler-preclock-probe',
      source: 'cloud-scheduler',
      projectRef: PROJECT_REF,
      soakId: 'soak-rig-b1-r3',
      path: '/jobs/check-confirmations',
      trigger: 'global-flush',
      statusCode: 200,
      firedAt: '2026-07-13T11:59:00.000Z',
      completedAt: '2026-07-13T11:59:01.000Z',
    },
    schedulerFirings: [{
      schedulerExecutionId: 'scheduler-live-1',
      source: 'cloud-scheduler',
      projectRef: PROJECT_REF,
      soakId: 'soak-rig-b1-r3',
      path: '/jobs/org-queue-scheduler',
      trigger: 'org-scheduler',
      statusCode: 200,
      firedAt: '2026-07-13T12:00:05.000Z',
      completedAt: '2026-07-13T12:00:20.000Z',
    }],
    soak: {
      startedAt: '2026-07-13T12:00:00.000Z',
      endedAt: '2026-07-13T12:31:00.000Z',
      supervisedRunner: {
        runnerId: 'runner-rig-b1',
        supervisor: 'cloud-run-supervisor',
        mode: 'log-and-continue',
        startedAt: '2026-07-13T11:59:59.000Z',
        stoppedAt: '2026-07-13T12:31:01.000Z',
        heartbeatAt: ['2026-07-13T12:00:00.000Z', '2026-07-13T12:30:00.000Z'],
        runnerDeathEvents: [],
      },
      workerUptime: [{
        workerId: 'worker-rig-b1',
        source: 'cloud-run-audit-log',
        headSha: HEAD_SHA,
        imageDigest: IMAGE_DIGEST,
        startedAt: '2026-07-13T12:00:00.000Z',
        endedAt: '2026-07-13T12:31:00.000Z',
        uptimeMs: 31 * 60_000,
        logEntryIds: ['cloud-run-start', 'cloud-run-stop'],
      }],
      crashLoopEvents: [],
      endpointEvictionEvents: [],
    },
    windows: [{
      scenarioId: 'poison-window',
      observations: [{
        execution: {
          schedulerExecutionId: 'scheduler-live-1',
          armedTrigger: 'org-scheduler',
          faultWindowId: 'window-live-1',
          startedAt: '2026-07-13T12:00:05.000Z',
          completedAt: '2026-07-13T12:00:20.000Z',
        },
        triggerFirings: [{
          trigger: 'org-scheduler', schedulerExecutionId: 'scheduler-live-1',
          batchId: 'batch-live-1', firedAt: '2026-07-13T12:00:06.000Z',
        }],
        pendingBefore: 2,
        pendingAfter: 1,
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
          txId: TX_ID, batchId: 'batch-live-1', merkleRoot: FP_DRAINED,
          signedBytesSha256: SIGNED_HASH, network: 'signet', nodeId: 'signet-rig-b1',
          chainState: 'mempool', acceptedAt: '2026-07-13T12:00:12.000Z',
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
        creditGateEvents: [
          {
            eventId: 'gate-healthy', schedulerExecutionId: 'scheduler-live-1',
            fingerprint: FP_DRAINED, orgId: 'org-healthy', decision: 'not-required',
            reason: null, occurredAt: '2026-07-13T12:00:07.000Z',
          },
          {
            eventId: 'gate-poison', schedulerExecutionId: 'scheduler-live-1',
            fingerprint: FP_POISON, orgId: 'org-poison', decision: 'denied',
            reason: 'insufficient_credits', occurredAt: '2026-07-13T12:00:08.000Z',
          },
        ],
        creditLedgerEvents: [],
        orgBalances: [
          { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-healthy', before: 10, after: 10 },
          { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-poison', before: 0, after: 0 },
        ],
        ledgerDeltas: [
          { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-healthy', delta: 0 },
          { schedulerExecutionId: 'scheduler-live-1', orgId: 'org-poison', delta: 0 },
        ],
      }],
    }],
    sources: {
      schedulerExportId: 'scheduler-export',
      databaseQueryExportId: 'db-export',
      signetNodeExportId: 'signet-export',
      cloudRunAuditExportId: 'cloud-run-export',
      supervisorLogExportId: 'supervisor-export',
    },
    capturedAt: '2026-07-13T12:31:02.000Z',
  };
}

describe('executeLiveEvidenceConsumer — live execution is off by default', () => {
  it('does not invoke the adapter without the two-part operator gate', async () => {
    const collect = vi.fn();
    const adapter: LiveEvidenceAdapter = { collect };

    await expect(executeLiveEvidenceConsumer(request(), adapter, {})).resolves.toEqual({
      mode: 'disabled',
      reason: 'live evidence execution was not explicitly enabled',
    });
    expect(collect).not.toHaveBeenCalled();
  });

  it('validates a fully bound local capture only when both gates match', async () => {
    const collect = vi.fn(async () => bundle());
    const result = await executeLiveEvidenceConsumer(request(), { collect }, {
      ARKOVA_LIVE_EVIDENCE_EXECUTION: LIVE_EVIDENCE_ENABLE_VALUE,
      ARKOVA_LIVE_EVIDENCE_SOAK_ID: 'soak-rig-b1-r3',
    });
    expect(collect).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      mode: 'validated',
      rigId: 'RIG-B1',
      projectRef: PROJECT_REF,
      soakId: 'soak-rig-b1-r3',
      workerUptimeMs: 31 * 60_000,
      requiredUptimeMs: 31 * 60_000,
      schedulerFirings: 1,
      windows: [{ drainedLeaves: 1, poisonLeaves: 1 }],
    });
  });

  it('rejects wrong rig identity and a late pre-clock Scheduler probe', () => {
    const wrongIdentity = bundle();
    wrongIdentity.identity.headSha = 'e'.repeat(40);
    expect(() => assertLiveEvidenceBundle(request(), wrongIdentity)).toThrow(/mismatches requested headSha/);

    const lateProbe = bundle();
    lateProbe.preclockSchedulerProbe.completedAt = '2026-07-13T12:00:01.000Z';
    expect(() => assertLiveEvidenceBundle(request(), lateProbe)).toThrow(/before the soak clock starts/);
  });

  it('rejects direct HTTP evidence or an armed-trigger path mismatch', () => {
    const direct = bundle();
    direct.schedulerFirings[0]!.source = 'direct-http' as never;
    expect(() => assertLiveEvidenceBundle(request(), direct)).toThrow(/Cloud-Scheduler \/jobs\/\* HTTP 200/);

    const wrongPath = bundle();
    wrongPath.schedulerFirings[0]!.path = '/jobs/batch-anchors?force=true';
    expect(() => assertLiveEvidenceBundle(request(), wrongPath)).toThrow(/path does not match the armed trigger/);
  });

  it('enforces worker-uptime floor plus 30 minutes and voids crash loops', () => {
    const short = bundle();
    short.soak.workerUptime[0]!.endedAt = '2026-07-13T12:30:59.999Z';
    short.soak.workerUptime[0]!.uptimeMs -= 1;
    expect(() => assertLiveEvidenceBundle(request(), short)).toThrow(/overshoot.*30 minutes/);

    const crashLoop = bundle();
    crashLoop.soak.crashLoopEvents.push('worker-crash-loop-log-entry');
    expect(() => assertLiveEvidenceBundle(request(), crashLoop)).toThrow(/voids the soak clock/);
  });
});
