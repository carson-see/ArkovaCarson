import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RawCaptureDigests, RawCaptureTextSet, RunDeclaration } from './batch-drain-live-evidence';
import {
  B1_SCHEDULER_START_CONTRACT,
  type B1SchedulerJobObservation,
  type B1SchedulerStartReceipt,
} from './s33-b1-scheduler-start-driver';
import {
  runS33B1SoakSupervisor,
  type B1FinalizedSoakEvidence,
  type B1SoakSupervisorPort,
  type B1SupervisorContext,
  type B1SupervisorHeartbeatObservation,
  type B1SupervisorJournalRecord,
} from './s33-b1-soak-supervisor';

const MINUTE_MS = 60_000;
const START_MS = Date.parse('2026-07-16T20:00:00.000Z');
const HEAD = 'a'.repeat(40);
const IMAGE = `sha256:${'b'.repeat(64)}`;
const CRON = `sha256:${'c'.repeat(64)}`;
const BASE = '0'.repeat(40);
const FP = 'd'.repeat(64);
const POISON = '9'.repeat(64);
const TX = 'e'.repeat(64);
const SIGNED = 'f'.repeat(64);
const ANCHOR = '00000000-0000-4000-8000-000000000001';
const JOURNAL = '00000000-0000-4000-8000-000000000002';

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function iso(ms: number): string { return new Date(ms).toISOString(); }

function admissionRaw(): string {
  return readFileSync(
    join(process.cwd(), 'scripts/staging/fixtures/rig-b1-admission-v2.json'),
    'utf8',
  );
}

function admission(): Record<string, unknown> {
  return JSON.parse(admissionRaw()) as Record<string, unknown>;
}

function schedulerJobs(observedAt: string): B1SchedulerJobObservation[] {
  return B1_SCHEDULER_START_CONTRACT.jobs.map((spec) => {
    const name = `${B1_SCHEDULER_START_CONTRACT.workerService}-${spec.suffix}`;
    const serviceUrl = admission().tag_url as string;
    return {
      name,
      resourceName: `projects/arkova1/locations/us-central1/jobs/${name}`,
      state: 'ENABLED',
      path: spec.path,
      uri: `${serviceUrl}${spec.path}`,
      schedule: B1_SCHEDULER_START_CONTRACT.cadence,
      timeZone: spec.timeZone,
      attemptDeadline: spec.attemptDeadline,
      retry: {
        minBackoff: B1_SCHEDULER_START_CONTRACT.retry.minBackoff,
        maxBackoff: B1_SCHEDULER_START_CONTRACT.retry.maxBackoff,
        maxDoublings: B1_SCHEDULER_START_CONTRACT.retry.maxDoublings,
      },
      httpMethod: 'POST',
      oidcServiceAccountEmail: B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount,
      oidcAudience: serviceUrl,
      cronHeaderPresent: true,
      cronHeaderSha256: CRON,
      observedAt,
    };
  });
}

function receipt(rawAdmission = admissionRaw()): B1SchedulerStartReceipt {
  const value = JSON.parse(rawAdmission) as Record<string, unknown>;
  return {
    schemaVersion: B1_SCHEDULER_START_CONTRACT.schemaVersion,
    status: 'COUNTED_START',
    activationId: 'start-b1-test-001',
    authority: {
      actionExpiresAt: iso(START_MS + 5 * MINUTE_MS),
      runHardStopAt: iso(START_MS + 3_000 * MINUTE_MS),
    },
    candidate: { sourceHeadSha: HEAD, workerImageDigest: IMAGE },
    run: {
      rigId: 'RIG-B1',
      rigName: 's33-rig-b1',
      soakId: value.soak_id,
      leaseId: value.lease_id,
      requiredWorkerUptimeMin: 2_880,
      requiredWallMin: 2_910,
      startedAt: iso(START_MS - MINUTE_MS),
    },
    evidence: { admissionSha256: `sha256:${sha256(rawAdmission)}` },
    scheduler: {
      projectId: 'arkova1',
      location: 'us-central1',
      serviceUrl: value.tag_url as string,
      cadence: B1_SCHEDULER_START_CONTRACT.cadence,
      jobs: schedulerJobs(iso(START_MS - MINUTE_MS)),
    },
  };
}

function context(): B1SupervisorContext {
  const raw = admissionRaw();
  return {
    admissionRaw: raw,
    provisionApprovalArtifactPath: '/tmp/provision-approval.json',
    receipt: receipt(raw),
  };
}

function rawDigests(raw: RawCaptureTextSet): RawCaptureDigests {
  return {
    scheduler: sha256(raw.scheduler),
    workerLogs: sha256(raw.workerLogs),
    database: sha256(raw.database),
    signet: sha256(raw.signet),
    cloudRun: sha256(raw.cloudRun),
    supervisor: sha256(raw.supervisor),
  };
}

function finalizedEvidence(soakStartedAt: string, soakEndedAt: string): B1FinalizedSoakEvidence {
  const value = admission() as {
    infrastructure: RunDeclaration['infrastructure'];
    tag_url: string;
    supabase_project_ref: string;
    soak_id: string;
    lease_id: string;
    clean_mirror_attestation_id: string;
    deployed_revision: string;
  };
  const startMs = Date.parse(soakStartedAt);
  const endMs = Date.parse(soakEndedAt);
  const declaration: RunDeclaration = {
    schemaVersion: 1,
    declarationId: 'decl-b1-supervisor-test',
    gitBaseSha: BASE,
    gitHeadSha: HEAD,
    imageDigest: IMAGE,
    rigId: 'RIG-B1',
    gcpProjectId: 'arkova1',
    projectRef: value.supabase_project_ref,
    soakId: value.soak_id,
    leaseId: value.lease_id,
    cleanMirrorAttestationId: value.clean_mirror_attestation_id,
    workerService: B1_SCHEDULER_START_CONTRACT.workerService,
    workerRevision: value.deployed_revision,
    region: 'us-central1',
    infrastructure: structuredClone(value.infrastructure),
    soakStartedAt,
    soakEndedAt,
    recoveries: [],
    windows: [{
      scenarioId: 'supervisor-test-window',
      kind: 'poison-isolation',
      armedTrigger: 'org-scheduler',
      expectedInitialPending: 2,
      expectedFinalPending: 1,
      passes: [{
        outcome: 'broadcast',
        batchId: 'batch-supervisor-test',
        armedTrigger: 'org-scheduler',
        schedulerExecutionId: 'scheduler-supervisor-test',
        faultWindow: {
          id: 'fault-supervisor-test',
          startsAt: iso(startMs + MINUTE_MS),
          endsAt: iso(startMs + 3 * MINUTE_MS),
        },
        claims: [{ fingerprint: FP, orgId: 'org-supervisor-test' }],
      }, {
        outcome: 'no-broadcast',
        outcomeId: 'denial-supervisor-test',
        armedTrigger: 'org-scheduler',
        schedulerExecutionId: 'scheduler-supervisor-test',
        faultWindow: {
          id: 'fault-supervisor-test',
          startsAt: iso(startMs + MINUTE_MS),
          endsAt: iso(startMs + 3 * MINUTE_MS),
        },
        claims: [{ fingerprint: POISON, orgId: 'org-poison-test' }],
        deniedGate: {
          fingerprint: POISON,
          orgId: 'org-poison-test',
          decision: 'denied',
          reason: 'insufficient_credits',
          referenceId: 'anchor-poison',
          requiredAmount: 1,
          balanceBefore: 0,
          balanceAfter: 0,
        },
      }],
    }],
  };
  const declarationSha256 = sha256(JSON.stringify(declaration));
  const generatedAt = iso(endMs + MINUTE_MS);
  const common = (source: string, exportId: string) => ({
    schemaVersion: 1,
    source,
    exportId,
    declarationSha256,
    rigId: 'RIG-B1',
    soakId: value.soak_id,
    gitHeadSha: HEAD,
    imageDigest: IMAGE,
    generatedAt,
  });
  const heartbeatTimes = Array.from(
    { length: Math.floor((endMs - startMs) / (5 * MINUTE_MS)) + 1 },
    (_, index) => iso(startMs + index * 5 * MINUTE_MS),
  );
  const raw: RawCaptureTextSet = {
    scheduler: JSON.stringify({
      ...common('cloud-scheduler', 'scheduler-export'),
      records: [{
        recordId: 'scheduler-preclock', purpose: 'preclock',
        schedulerExecutionId: 'scheduler-preclock-test', correlatedDrainExecutionId: null,
        faultWindowId: null, gcpProjectId: 'arkova1',
        workerRevision: value.deployed_revision, workerId: value.deployed_revision,
        path: '/jobs/check-confirmations', trigger: 'global-flush', statusCode: 200,
        firedAt: iso(startMs - 90_000), completedAt: iso(startMs - MINUTE_MS),
      }, {
        recordId: 'scheduler-record', purpose: 'drain',
        schedulerExecutionId: 'scheduler-supervisor-test', correlatedDrainExecutionId: null,
        faultWindowId: 'fault-supervisor-test', gcpProjectId: 'arkova1',
        workerRevision: value.deployed_revision, workerId: value.deployed_revision,
        path: '/jobs/org-queue-scheduler', trigger: 'org-scheduler', statusCode: 200,
        firedAt: iso(startMs + MINUTE_MS), completedAt: iso(startMs + 3 * MINUTE_MS),
      }],
    }),
    workerLogs: JSON.stringify({
      ...common('cloud-logging', 'worker-export'),
      records: [{
        recordId: 'worker-record', insertId: 'insert-1', traceId: 'trace-1',
        workerId: value.deployed_revision, event: 'trigger-fired',
        schedulerExecutionId: 'scheduler-supervisor-test', batchId: 'batch-supervisor-test',
        trigger: 'org-scheduler', fingerprint: null, orgId: null, decision: null,
        reason: null, referenceId: null, requiredAmount: null,
        balanceBefore: null, balanceAfter: null, occurredAt: iso(startMs + MINUTE_MS),
      }, {
        recordId: 'worker-gate-record', insertId: 'insert-2', traceId: 'trace-1',
        workerId: value.deployed_revision, event: 'credit-gate',
        schedulerExecutionId: 'scheduler-supervisor-test', batchId: 'batch-supervisor-test',
        trigger: 'org-scheduler', fingerprint: FP, orgId: 'org-supervisor-test',
        decision: 'not-required', reason: null, referenceId: null, requiredAmount: 0,
        balanceBefore: null, balanceAfter: null, occurredAt: iso(startMs + 90_000),
      }, {
        recordId: 'worker-poison-record', insertId: 'insert-3', traceId: 'trace-1',
        workerId: value.deployed_revision, event: 'credit-gate',
        schedulerExecutionId: 'scheduler-supervisor-test', batchId: null,
        trigger: 'org-scheduler', fingerprint: POISON, orgId: 'org-poison-test',
        decision: 'denied', reason: 'insufficient_credits', referenceId: 'anchor-poison', requiredAmount: 1,
        balanceBefore: 0, balanceAfter: 0, occurredAt: iso(startMs + 130_000),
      }],
    }),
    database: JSON.stringify({
      ...common('db-query-export', 'database-export'),
      projectRef: value.supabase_project_ref,
      queryId: 'query-supervisor-test', isolation: 'repeatable-read',
      executions: [{
        schedulerExecutionId: 'scheduler-supervisor-test', batchId: 'batch-supervisor-test',
        armedTrigger: 'org-scheduler',
        faultWindowId: 'fault-supervisor-test', workerId: value.deployed_revision,
        startedAt: iso(startMs + MINUTE_MS), completedAt: iso(startMs + 2 * MINUTE_MS),
        pendingBefore: 2, pendingAfter: 1,
      }],
      deniedOutcomes: [{
        outcomeId: 'denial-supervisor-test',
        schedulerExecutionId: 'scheduler-supervisor-test',
        faultWindowId: 'fault-supervisor-test',
        workerId: value.deployed_revision,
        fingerprint: POISON,
        orgId: 'org-poison-test',
        batchId: null,
        status: 'PENDING',
        chainTxId: null,
        merkleRoot: null,
        creditDenialReason: 'insufficient_credits',
        queueCreditChargedAt: null,
        queueCreditDeniedAt: iso(startMs + 130_000),
        pendingBefore: 1,
        pendingAfter: 1,
        startedAt: iso(startMs + 125_000),
        completedAt: iso(startMs + 150_000),
      }],
      passRows: [{
        fingerprint: FP, orgId: 'org-supervisor-test', batchId: 'batch-supervisor-test',
        schedulerExecutionId: 'scheduler-supervisor-test', claimOrder: 1, status: 'SUBMITTED',
        chainTxId: TX, merkleRoot: FP, creditDenialReason: null,
        queueCreditChargedAt: null, queueCreditDeniedAt: null,
      }],
      transactions: [{ txId: TX, batchId: 'batch-supervisor-test', merkleRoot: FP, signedBytesSha256: SIGNED }],
      journalRows: [{
        journalId: JOURNAL, batchId: 'batch-supervisor-test', txId: TX,
        fingerprintRoot: FP, anchorIds: [ANCHOR], leafOrder: [{ anchorId: ANCHOR, fingerprint: FP }],
        signedAt: iso(startMs + MINUTE_MS), recoveryStatus: 'PERSISTED', holdReason: null,
        heldAt: null, resolvedAt: iso(startMs + 2 * MINUTE_MS),
        createdAt: iso(startMs + MINUTE_MS), updatedAt: iso(startMs + 2 * MINUTE_MS),
      }],
      txLeaves: [{
        txId: TX, batchId: 'batch-supervisor-test', anchorId: ANCHOR,
        fingerprint: FP, orgId: 'org-supervisor-test', merkleIndex: 0,
      }],
      proofs: [{
        txId: TX, batchId: 'batch-supervisor-test', anchorId: ANCHOR,
        fingerprint: FP, orgId: 'org-supervisor-test', merkleIndex: 0,
        merkleRoot: FP, leafCount: 1, proofPath: [],
      }],
      creditLedgerEvents: [],
      orgBalances: [
        { schedulerExecutionId: 'scheduler-supervisor-test', orgId: 'org-supervisor-test', before: 1, after: 1 },
        { schedulerExecutionId: 'scheduler-supervisor-test', orgId: 'org-poison-test', before: 0, after: 0 },
      ],
      ledgerDeltas: [
        { schedulerExecutionId: 'scheduler-supervisor-test', orgId: 'org-supervisor-test', delta: 0 },
        { schedulerExecutionId: 'scheduler-supervisor-test', orgId: 'org-poison-test', delta: 0 },
      ],
    }),
    signet: JSON.stringify({
      ...common('signet-rpc', 'signet-export'),
      records: [{
        recordId: 'signet-record', rpcRequestId: 'rpc-1', rpcMethod: 'getrawtransaction',
        schedulerExecutionId: 'scheduler-supervisor-test', workerId: value.deployed_revision,
        txId: TX, batchId: 'batch-supervisor-test', merkleRoot: FP, rawTxSha256: SIGNED,
        nodeId: 'rig-b1-signet', network: 'signet', state: 'mempool', observedAt: iso(startMs + 2 * MINUTE_MS),
      }],
    }),
    cloudRun: JSON.stringify({
      ...common('cloud-run-lifecycle', 'cloud-run-export'),
      gcpProjectId: 'arkova1', workerService: B1_SCHEDULER_START_CONTRACT.workerService,
      workerRevision: value.deployed_revision, region: 'us-central1',
      records: [
        { recordId: 'worker-start', workerId: value.deployed_revision, event: 'started', occurredAt: iso(startMs - 2 * MINUTE_MS) },
        ...heartbeatTimes.map((occurredAt, index) => ({
          recordId: `worker-heartbeat-${index}`, workerId: value.deployed_revision,
          event: 'heartbeat', occurredAt,
        })),
        { recordId: 'worker-stop', workerId: value.deployed_revision, event: 'stopped', occurredAt: soakEndedAt },
      ],
    }),
    supervisor: JSON.stringify({
      ...common('supervisor-records', 'supervisor-export'),
      cleanMirror: {
        attestationId: value.clean_mirror_attestation_id, result: 'pass',
        projectRef: value.supabase_project_ref, gitBaseSha: BASE, gitHeadSha: HEAD,
        observedAt: iso(startMs - 2 * MINUTE_MS),
      },
      lease: {
        leaseId: value.lease_id, state: 'active', holder: 'b1-supervisor',
        acquiredAt: iso(startMs - 3 * MINUTE_MS), expiresAt: iso(endMs + 10 * MINUTE_MS),
      },
      runnerId: 'b1-runner', supervisor: 'foreground-controller', mode: 'log-and-continue',
      records: [
        { recordId: 'runner-start', event: 'started', occurredAt: soakStartedAt },
        ...heartbeatTimes.map((occurredAt, index) => ({
          recordId: `runner-heartbeat-${index}`, event: 'heartbeat', occurredAt,
        })),
        { recordId: 'runner-stop', event: 'stopped', occurredAt: soakEndedAt },
      ],
    }),
  };
  return { declaration, declarationSha256, raw, rawCaptureDigests: rawDigests(raw) };
}

class FakeSupervisorPort implements B1SoakSupervisorPort {
  nowMs = START_MS;
  sleepExtraMs = 0;
  heartbeatDrift = false;
  heartbeatDriftAt = 0;
  heartbeatCount = 0;
  renewalFailureAt = 0;
  scenarioFailure = false;
  neverSettlingScenario = false;
  invalidRaw = false;
  semanticCorruption = false;
  abortDuringSleep: (() => void) | undefined;
  cleanupFailures = new Set<'pause' | 'remove' | 'teardown'>();
  renewals = 0;
  readonly operations: string[] = [];
  readonly journal: B1SupervisorJournalRecord[] = [];
  readonly scenarioMaterial = Object.freeze({ genuine: 'lane4-test-material' });
  private settleScenario: (() => void) | undefined;

  now(): Date { return new Date(this.nowMs); }
  async sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    this.abortDuringSleep?.();
    this.abortDuringSleep = undefined;
    if (signal.aborted) throw signal.reason;
    this.nowMs += milliseconds + this.sleepExtraMs;
    this.sleepExtraMs = 0;
  }
  async createJournal(): Promise<void> { this.operations.push('create-journal'); }
  async appendJournal(record: B1SupervisorJournalRecord): Promise<void> {
    this.journal.push(record);
    this.operations.push(`journal:${record.event}`);
  }
  async observeHeartbeat(): Promise<B1SupervisorHeartbeatObservation> {
    this.heartbeatCount += 1;
    const raw = admission() as { deployed_revision: string; tag_url: string };
    return {
      observedAt: iso(this.nowMs),
      workerId: raw.deployed_revision,
      workerRevision: this.heartbeatDrift || this.heartbeatDriftAt === this.heartbeatCount
        ? 'drifted-revision'
        : raw.deployed_revision,
      sourceHeadSha: HEAD,
      imageDigest: IMAGE,
      runtimeServiceAccount: B1_SCHEDULER_START_CONTRACT.workerRuntimeServiceAccount,
      serviceUrl: raw.tag_url,
      healthStatusCode: 200,
      healthStatus: 'healthy',
      healthGitSha: HEAD,
      schedulerJobs: schedulerJobs(iso(this.nowMs)),
    };
  }
  async renewInvocationLease(): Promise<void> {
    this.renewals += 1;
    this.operations.push('renew-lease');
    if (this.renewalFailureAt === this.renewals) throw new Error('injected renewal failure');
  }
  async removeInvocationLease(): Promise<void> {
    this.operations.push('remove-lease');
    if (this.cleanupFailures.has('remove')) throw new Error('injected remove failure');
  }
  async executeLiveScenarios(input: Readonly<{ signal: AbortSignal }>): Promise<unknown> {
    this.operations.push('execute-scenarios');
    if (this.scenarioFailure) throw new Error('injected scenario failure');
    if (this.neverSettlingScenario) {
      return new Promise((resolve) => {
        this.settleScenario = () => {
          if (this.settleScenario === undefined) return;
          this.settleScenario = undefined;
          this.operations.push('scenario-aborted');
          resolve(this.scenarioMaterial);
        };
        input.signal.addEventListener('abort', this.settleScenario, { once: true });
      });
    }
    return this.scenarioMaterial;
  }
  async abortAndAwaitLiveScenarios(): Promise<void> {
    this.operations.push('abort-await-scenarios');
    this.settleScenario?.();
  }
  assertGenuineScenarioMaterial(input: Readonly<{ material: unknown }>): void {
    this.operations.push('assert-genuine-scenarios');
    if (input.material !== this.scenarioMaterial) throw new Error('not genuine Lane-4 material');
  }
  async finalizeEvidence(input: Readonly<{
    soakStartedAt: string;
    soakEndedAt: string;
  }>): Promise<B1FinalizedSoakEvidence> {
    this.operations.push('finalize-evidence');
    const evidence = finalizedEvidence(input.soakStartedAt, input.soakEndedAt);
    if (this.invalidRaw) return { ...evidence, raw: { ...evidence.raw, scheduler: '' } };
    if (this.semanticCorruption) {
      const scheduler = JSON.parse(evidence.raw.scheduler) as {
        records: Array<{ purpose: string; statusCode: number }>;
      };
      scheduler.records.find(({ purpose }) => purpose === 'drain')!.statusCode = 500;
      const raw = { ...evidence.raw, scheduler: JSON.stringify(scheduler) };
      return { ...evidence, raw, rawCaptureDigests: rawDigests(raw) };
    }
    return evidence;
  }
  async pauseAndVerifyAllSix(): Promise<void> {
    this.operations.push('pause-verify');
    if (this.cleanupFailures.has('pause')) throw new Error('injected pause failure');
  }
  async canonicalTeardown(): Promise<void> {
    this.operations.push('teardown');
    if (this.cleanupFailures.has('teardown')) throw new Error('injected teardown failure');
  }
}

describe('RIG-B1 foreground soak supervisor', () => {
  it('counts from first authenticated heartbeat and renews every heartbeat before ordered teardown', async () => {
    const port = new FakeSupervisorPort();
    const result = await runS33B1SoakSupervisor(context(), port);
    expect(result.status).toBe('RIG_B1_SOAK_COMPLETED');
    expect(result.wallMin).toBe(2_910);
    expect(result.workerUptimeMin).toBe(2_910);
    expect(port.renewals).toBe(port.journal.length);
    expect(port.journal[0]?.event).toBe('started');
    expect(port.journal.at(-1)?.event).toBe('stopped');
    expect(port.operations.slice(-3)).toEqual(['pause-verify', 'remove-lease', 'teardown']);
  });

  it('contains and tears down when any heartbeat gap exceeds five minutes', async () => {
    const port = new FakeSupervisorPort();
    port.sleepExtraMs = 2 * MINUTE_MS;
    await expect(runS33B1SoakSupervisor(context(), port)).rejects.toThrow(/gap exceeds five minutes/i);
    expect(port.operations.slice(-3)).toEqual(['pause-verify', 'remove-lease', 'teardown']);
  });

  it('contains immediately when exact revision/topology health drifts', async () => {
    const port = new FakeSupervisorPort();
    port.heartbeatDrift = true;
    await expect(runS33B1SoakSupervisor(context(), port)).rejects.toThrow(/revision|health drift/i);
    expect(port.renewals).toBe(0);
    expect(port.operations.slice(-3)).toEqual(['pause-verify', 'remove-lease', 'teardown']);
  });

  it('treats invocation-lease renewal failure as a containment event', async () => {
    const port = new FakeSupervisorPort();
    port.renewalFailureAt = 2;
    await expect(runS33B1SoakSupervisor(context(), port)).rejects.toThrow(/renewal failure/i);
    expect(port.operations.slice(-3)).toEqual(['pause-verify', 'remove-lease', 'teardown']);
  });

  it('rejects absent or failed Lane-4 scenario material before finalization', async () => {
    const port = new FakeSupervisorPort();
    port.scenarioFailure = true;
    await expect(runS33B1SoakSupervisor(context(), port)).rejects.toThrow(/scenario failure/i);
    expect(port.operations).not.toContain('finalize-evidence');
    expect(port.operations.slice(-3)).toEqual(['pause-verify', 'remove-lease', 'teardown']);
  });

  it('strictly rejects an empty raw capture and tears down', async () => {
    const port = new FakeSupervisorPort();
    port.invalidRaw = true;
    await expect(runS33B1SoakSupervisor(context(), port)).rejects.toThrow(/raw export|valid JSON|schema/i);
    expect(port.operations.slice(-3)).toEqual(['pause-verify', 'remove-lease', 'teardown']);
  });

  it('rejects schema-valid captures that fail Scheduler/DB semantic closure', async () => {
    const port = new FakeSupervisorPort();
    port.semanticCorruption = true;
    await expect(runS33B1SoakSupervisor(context(), port))
      .rejects.toThrow(/Scheduler raw record|trigger\/200|HTTP 200/i);
    expect(port.operations.slice(-3)).toEqual(['pause-verify', 'remove-lease', 'teardown']);
  });

  it('aborts and awaits an active scenario before any failure cleanup', async () => {
    const port = new FakeSupervisorPort();
    port.neverSettlingScenario = true;
    port.heartbeatDriftAt = 2;
    await expect(runS33B1SoakSupervisor(context(), port)).rejects.toThrow(/revision|health drift/i);
    expect(port.operations.indexOf('scenario-aborted')).toBeLessThan(port.operations.indexOf('pause-verify'));
    expect(port.operations.indexOf('abort-await-scenarios')).toBeLessThan(port.operations.indexOf('pause-verify'));
    expect(port.operations.slice(-3)).toEqual(['pause-verify', 'remove-lease', 'teardown']);
  });

  it('contains an external termination during an active scenario before pause, removal, and teardown', async () => {
    const port = new FakeSupervisorPort();
    const controller = new AbortController();
    port.neverSettlingScenario = true;
    port.abortDuringSleep = () => controller.abort(new Error('SIGTERM'));
    await expect(runS33B1SoakSupervisor(context(), port, controller.signal)).rejects.toThrow(/SIGTERM/i);
    expect(port.operations.indexOf('scenario-aborted')).toBeLessThan(port.operations.indexOf('pause-verify'));
    expect(port.operations.indexOf('abort-await-scenarios')).toBeLessThan(port.operations.indexOf('pause-verify'));
    expect(port.operations.slice(-3)).toEqual(['pause-verify', 'remove-lease', 'teardown']);
  });

  it('hard-stops and aborts a never-settling scenario instead of awaiting it unbounded', async () => {
    const port = new FakeSupervisorPort();
    port.neverSettlingScenario = true;
    const exactContext = context();
    (exactContext.receipt.authority as Record<string, unknown>).runHardStopAt =
      iso(START_MS + 2_915 * MINUTE_MS);
    await expect(runS33B1SoakSupervisor(exactContext, port)).rejects.toThrow(/hard stop/i);
    expect(port.operations).toContain('scenario-aborted');
    expect(port.operations.indexOf('scenario-aborted')).toBeLessThan(port.operations.indexOf('pause-verify'));
    expect(port.operations.slice(-3)).toEqual(['pause-verify', 'remove-lease', 'teardown']);
  });

  it('preserves primary plus pause, removal, and teardown failures', async () => {
    const port = new FakeSupervisorPort();
    port.heartbeatDrift = true;
    port.cleanupFailures = new Set(['pause', 'remove', 'teardown']);
    const failure = await runS33B1SoakSupervisor(context(), port).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(4);
    expect(port.operations.slice(-3)).toEqual(['pause-verify', 'remove-lease', 'teardown']);
  });
});
