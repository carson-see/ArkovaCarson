import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  B1_SCHEDULER_START_CONTRACT,
  expectedB1SchedulerStartConfirmation,
  runS33B1SchedulerStartDriver,
  type B1LockedObject,
  type B1SchedulerJobObservation,
  type B1SchedulerStartAdmission,
  type B1SchedulerStartPort,
  type B1SchedulerStartPreclock,
  type VerifiedB1StartApproval,
} from './s33-b1-scheduler-start-driver';

const NOW = '2026-07-16T20:00:00.000Z';
const ACTION_EXPIRES = '2026-07-16T20:10:00.000Z';
const RUN_HARD_STOP = '2026-07-20T20:00:00.000Z';
const HEAD = 'a'.repeat(40);
const TREE = 'c'.repeat(40);
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;
const IMAGE = `${B1_SCHEDULER_START_CONTRACT.workerImageRepository}@${IMAGE_DIGEST}`;
const CORPUS = `sha256:${'d'.repeat(64)}`;
const APPROVAL_ID = 'b1-provision-fixture-v1';
const START_ID = 'b1-start-fixture-v1';
const PREPARATION_ID = 'b1-prepare-fixture-v1';
const SOAK_ID = 'soak-s33-b1';
const LEASE_ID = 'lease-s33-b1';
const ADMISSION_RAW = '{"admission":"fixture"}';
const PRECLOCK_RAW = '{"preclock":"fixture"}';
const CRON_HEADER_SHA256 = digest('cron-secret');

function digest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function jobName(suffix: string): string {
  return `${B1_SCHEDULER_START_CONTRACT.workerService}-${suffix}`;
}

function admission(): B1SchedulerStartAdmission {
  return {
    admissionSha256: digest(ADMISSION_RAW),
    generatedAt: '2026-07-16T19:30:00.000Z',
    cleanMirrorVerifiedAt: '2026-07-16T19:25:00.000Z',
    rigName: B1_SCHEDULER_START_CONTRACT.rigName,
    soakId: SOAK_ID,
    leaseId: LEASE_ID,
    sourceHeadSha: HEAD,
    workerImage: IMAGE,
    workerImageDigest: IMAGE_DIGEST,
    gcpProjectId: B1_SCHEDULER_START_CONTRACT.gcpProjectId,
    gcpRegion: B1_SCHEDULER_START_CONTRACT.gcpRegion,
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    workerService: B1_SCHEDULER_START_CONTRACT.workerService,
    workerRevision: `${B1_SCHEDULER_START_CONTRACT.workerService}-00001`,
    schedulerOidcServiceAccount: B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount,
    cleanMirrorAttestationId: `sha256:${'e'.repeat(64)}`,
    requiredWorkerUptimeMin: 2_880,
    requiredWallMin: 2_910,
    approvalId: APPROVAL_ID,
    approvalEnvelopeSha256: `sha256:${'f'.repeat(64)}`,
    signedPayloadSha256: `sha256:${'1'.repeat(64)}`,
    approvalClaimUri: `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/node-approval-claims/${APPROVAL_ID}.json`,
    approvalClaimGeneration: '1',
    nodeReadinessSha256: `sha256:${'2'.repeat(64)}`,
    cronSecretName: 'arkova-s33-rig-b1-cron',
    cronSecretVersion: '7',
    cronSecretResource: 'projects/arkova1/secrets/arkova-s33-rig-b1-cron/versions/7',
  };
}

function preclock(): B1SchedulerStartPreclock {
  return {
    status: 'PRE_CLOCK_READY',
    preclockSha256: digest(PRECLOCK_RAW),
    admissionSha256: digest(ADMISSION_RAW),
    sourceHeadSha: HEAD,
    workerImageDigest: IMAGE_DIGEST,
    cleanMirrorAttestationId: `sha256:${'e'.repeat(64)}`,
    nodeReadinessSha256: `sha256:${'2'.repeat(64)}`,
    observedAt: '2026-07-16T19:55:00.000Z',
    schedulerJobsPaused: 6,
    schedulerCadence: B1_SCHEDULER_START_CONTRACT.cadence,
  };
}

function approval(): VerifiedB1StartApproval {
  return {
    status: 'VERIFIED',
    keyId: B1_SCHEDULER_START_CONTRACT.keyId,
    verifierIdentity: B1_SCHEDULER_START_CONTRACT.verifierIdentity,
    envelopeSha256: `sha256:${'8'.repeat(64)}`,
    signedPayloadSha256: `sha256:${'9'.repeat(64)}`,
    startId: START_ID,
    purpose: B1_SCHEDULER_START_CONTRACT.authorityPurpose,
    sourceHeadSha: HEAD,
    sourceTreeSha: TREE,
    workerImage: IMAGE,
    workerImageDigest: IMAGE_DIGEST,
    corpusDigest: CORPUS,
    releaseCandidateId: 's33-final-rc',
    rigName: B1_SCHEDULER_START_CONTRACT.rigName,
    soakId: SOAK_ID,
    leaseId: LEASE_ID,
    workerService: B1_SCHEDULER_START_CONTRACT.workerService,
    workerRuntimeServiceAccount: B1_SCHEDULER_START_CONTRACT.workerRuntimeServiceAccount,
    schedulerOidcServiceAccount: B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount,
    schedulerJobNames: B1_SCHEDULER_START_CONTRACT.jobs.map(({ suffix }) => jobName(suffix)),
    provisionApprovalId: APPROVAL_ID,
    provisionApprovalEnvelopeSha256: admission().approvalEnvelopeSha256,
    provisionSignedPayloadSha256: admission().signedPayloadSha256,
    provisionAdmissionSha256: admission().admissionSha256,
    approvalClaim: {
      objectUri: admission().approvalClaimUri,
      generation: '1',
      sha256: digest(claimRaw()),
    },
    topologyOwnership: {
      objectUri: `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/topology-ownership/${APPROVAL_ID}.json`,
      generation: '2',
      sha256: digest(topologyRaw()),
    },
    preparationId: PREPARATION_ID,
    preparationApprovalEnvelopeSha256: `sha256:${'3'.repeat(64)}`,
    preparationSignedPayloadSha256: `sha256:${'4'.repeat(64)}`,
    preparationIntent: {
      objectUri: `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/preparation-intents/${PREPARATION_ID}.json`,
      generation: '5',
      sha256: digest(preparationIntentRaw()),
    },
    preparationOutcome: {
      objectUri: `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/preparation-outcomes/${PREPARATION_ID}.json`,
      generation: '6',
      sha256: digest(preparationOutcomeRaw()),
    },
    preclockArtifactSha256: digest(PRECLOCK_RAW),
    actionExpiresAt: ACTION_EXPIRES,
    runHardStopAt: RUN_HARD_STOP,
  };
}

function observation(
  spec: typeof B1_SCHEDULER_START_CONTRACT.jobs[number],
  state: 'PAUSED' | 'ENABLED',
): B1SchedulerJobObservation {
  return {
    name: jobName(spec.suffix),
    resourceName:
      `projects/arkova1/locations/us-central1/jobs/${jobName(spec.suffix)}`,
    state,
    path: spec.path,
    uri: `https://arkova-worker-s33-rig-b1-staging.example.run.app${spec.path}`,
    schedule: B1_SCHEDULER_START_CONTRACT.cadence,
    timeZone: spec.timeZone,
    attemptDeadline: spec.attemptDeadline,
    retry: { ...B1_SCHEDULER_START_CONTRACT.retry },
    httpMethod: 'POST',
    oidcServiceAccountEmail: B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount,
    oidcAudience: 'https://arkova-worker-s33-rig-b1-staging.example.run.app',
    cronHeaderPresent: true,
    cronHeaderSha256: CRON_HEADER_SHA256,
    observedAt: NOW,
  };
}

function locked(uri: string, raw: string, generation = '1'): B1LockedObject {
  return { uri, generation, retainUntilTime: RUN_HARD_STOP, raw };
}

function topologyRaw(): string {
  const admitted = admission();
  return JSON.stringify({
    schemaVersion: 'arkova.s33.rig-b1.topology-ownership/v1',
    approvalId: APPROVAL_ID,
    envelopeSha256: admitted.approvalEnvelopeSha256,
    signedPayloadSha256: admitted.signedPayloadSha256,
    sourceHeadSha: HEAD,
    sourceTreeSha: TREE,
    corpusDigest: CORPUS,
    releaseCandidateId: 's33-final-rc',
    rigId: 'RIG-B1',
    rigName: B1_SCHEDULER_START_CONTRACT.rigName,
    soakId: SOAK_ID,
    leaseId: LEASE_ID,
    gcpProjectId: 'arkova1',
    gcpRegion: 'us-central1',
    supabaseProjectRef: admitted.supabaseProjectRef,
    supabaseProjectName: 'arkova-soak-s33-rig-b1',
    workerService: admitted.workerService,
    workerRuntimeServiceAccount: B1_SCHEDULER_START_CONTRACT.workerRuntimeServiceAccount,
    schedulerOidcServiceAccount: admitted.schedulerOidcServiceAccount,
    cloudRunServiceUrl: 'https://arkova-worker-s33-rig-b1-staging.example.run.app',
    schedulerJobNames: B1_SCHEDULER_START_CONTRACT.jobs.map(({ suffix }) => jobName(suffix)),
    nodeReadinessSha256: admitted.nodeReadinessSha256,
    approvalClaim: {
      objectUri: admitted.approvalClaimUri,
      generation: admitted.approvalClaimGeneration,
    },
  });
}

function claimRaw(): string {
  const admitted = admission();
  return JSON.stringify({
    schemaVersion: 'arkova.s33.rig-b1.node-approval-claim/v1',
    approvalId: APPROVAL_ID,
    envelopeSha256: admitted.approvalEnvelopeSha256,
    signedPayloadSha256: admitted.signedPayloadSha256,
    sourceHeadSha: HEAD,
    sourceTreeSha: TREE,
    corpusDigest: CORPUS,
    releaseCandidateId: 's33-final-rc',
    soakId: SOAK_ID,
    leaseId: LEASE_ID,
    spendCapUsd: 200,
    claimedAt: '2026-07-16T19:00:00.000Z',
  });
}

function preparationIntentRaw(): string {
  const admitted = admission();
  return JSON.stringify({
    schemaVersion: 'arkova.s33.rig-b1.preparation-intent/v1',
    status: 'PREPARE_INTENT_LOCKED',
    preparationId: PREPARATION_ID,
    authorityEnvelopeSha256: `sha256:${'3'.repeat(64)}`,
    authoritySignedPayloadSha256: `sha256:${'4'.repeat(64)}`,
    provisionApprovalEnvelopeSha256: admitted.approvalEnvelopeSha256,
    provisionSignedPayloadSha256: admitted.signedPayloadSha256,
    admissionSha256: admitted.admissionSha256,
    sourceHeadSha: HEAD,
    sourceTreeSha: TREE,
    workerImageDigest: IMAGE_DIGEST,
    corpusDigest: CORPUS,
    releaseCandidateId: 's33-final-rc',
    soakId: SOAK_ID,
    leaseId: LEASE_ID,
    maxFundedBroadcasts: 1,
    invocationLeaseMaxSeconds: 600,
    authorityExpiresAt: '2026-07-16T19:59:00.000Z',
  });
}

function preparationOutcomeRaw(): string {
  return JSON.stringify({
    schemaVersion: 'arkova.s33.rig-b1.preparation-outcome/v1',
    status: 'PRE_CLOCK_READY',
    preparationId: PREPARATION_ID,
    intentSha256: digest(preparationIntentRaw()),
    admissionSha256: admission().admissionSha256,
    preclockArtifactSha256: digest(PRECLOCK_RAW),
    preclockArtifactRaw: PRECLOCK_RAW,
    completedAt: '2026-07-16T19:58:00.000Z',
  });
}

class FakePort implements B1SchedulerStartPort {
  readonly operations: string[] = [];
  readonly states = new Map<string, 'PAUSED' | 'ENABLED'>(
    B1_SCHEDULER_START_CONTRACT.jobs.map((spec) => [jobName(spec.suffix), 'PAUSED' as const]),
  );
  readonly persisted = new Map<string, { uri: string; raw: string; retainUntilTime: string }>();
  receiptExists = false;
  activationExists = false;
  resumeFailureAt = 0;
  observeEnabledAsPaused = false;
  receiptFailure = false;
  nowSequence: string[] = [];
  private resumeCount = 0;

  now(): Date { return new Date(this.nowSequence.shift() ?? NOW); }
  projectAdmission(): B1SchedulerStartAdmission { return admission(); }
  verifyPreclock(): B1SchedulerStartPreclock { return preclock(); }
  verifySignedApproval(): VerifiedB1StartApproval { return approval(); }

  async hasStartReceipt(uri: string): Promise<boolean> {
    if (uri.includes('/scheduler-start-receipts/')) return this.receiptExists;
    if (uri.includes('/scheduler-activation-intents/')) return this.activationExists;
    return false;
  }

  async readLockedObject(uri: string): Promise<B1LockedObject> {
    if (uri.includes('/node-approval-claims/')) return locked(uri, claimRaw());
    if (uri.includes('/topology-ownership/')) return locked(uri, topologyRaw(), '2');
    if (uri.includes('/preparation-intents/')) return locked(uri, preparationIntentRaw(), '5');
    if (uri.includes('/preparation-outcomes/')) return locked(uri, preparationOutcomeRaw(), '6');
    const persisted = this.persisted.get(uri);
    if (persisted !== undefined) {
      return locked(uri, persisted.raw, uri.includes('/activation-intents/') ? '3' : '4');
    }
    throw new Error(`missing locked object ${uri}`);
  }

  async observeJob(spec: typeof B1_SCHEDULER_START_CONTRACT.jobs[number]): Promise<B1SchedulerJobObservation> {
    const name = jobName(spec.suffix);
    this.operations.push(`observe:${name}`);
    const stored = this.states.get(name) ?? 'PAUSED';
    const state = this.observeEnabledAsPaused && stored === 'ENABLED' ? 'PAUSED' : stored;
    return observation(spec, state);
  }

  async observeActivation() {
    this.operations.push('observe-activation');
    return {
      observedAt: NOW,
      workerRevision: `${B1_SCHEDULER_START_CONTRACT.workerService}-00001`,
      sourceHeadSha: HEAD,
      imageDigest: IMAGE_DIGEST,
      runtimeServiceAccount: B1_SCHEDULER_START_CONTRACT.workerRuntimeServiceAccount,
      serviceUrl: 'https://arkova-worker-s33-rig-b1-staging.example.run.app',
      healthStatusCode: 200 as const,
      healthStatus: 'healthy' as const,
      healthGitSha: HEAD,
    };
  }

  async readSecretSha256(): Promise<string> { return CRON_HEADER_SHA256; }

  async installInvocationLease(): Promise<void> {
    this.operations.push('install-invocation-lease');
  }

  async removeInvocationLease(): Promise<void> {
    this.operations.push('remove-invocation-lease');
  }

  async resumeJob(name: string): Promise<void> {
    this.resumeCount += 1;
    this.operations.push(`resume:${name}`);
    if (this.resumeFailureAt === this.resumeCount) throw new Error('injected resume failure');
    this.states.set(name, 'ENABLED');
  }

  async pauseJob(name: string): Promise<void> {
    this.operations.push(`pause:${name}`);
    this.states.set(name, 'PAUSED');
  }

  async persistStartReceipt(uri: string, raw: string, retainUntilTime: string): Promise<void> {
    this.operations.push(`persist:${uri}`);
    if (this.receiptFailure && uri.includes('/scheduler-start-receipts/')) {
      throw new Error('injected receipt failure');
    }
    this.persisted.set(uri, { uri, raw, retainUntilTime });
  }

  countedReceipt() {
    return [...this.persisted.values()].find(({ uri }) => uri.includes('/scheduler-start-receipts/'));
  }
}

function confirmation(): string {
  return expectedB1SchedulerStartConfirmation({
    startId: START_ID,
    soakId: SOAK_ID,
    leaseId: LEASE_ID,
    admissionSha256: digest(ADMISSION_RAW),
    preclockSha256: digest(PRECLOCK_RAW),
  });
}

async function start(port: FakePort, ctoConfirmation = confirmation()) {
  return runS33B1SchedulerStartDriver(
    ADMISSION_RAW,
    PRECLOCK_RAW,
    '{"signed":"approval"}',
    ctoConfirmation,
    port,
  );
}

describe('S3.3 RIG-B1 fail-closed Scheduler start', () => {
  it('counts start only after six exact PAUSED jobs resume, verify ENABLED, and locked receipt reloads', async () => {
    const port = new FakePort();
    const result = await start(port);

    expect(result.status).toBe('RIG_B1_SOAK_STARTED');
    expect(result.receipt.status).toBe('COUNTED_START');
    expect(result.receipt.scheduler.jobs).toHaveLength(6);
    expect(result.receipt.scheduler.jobs.every(({ state }) => state === 'ENABLED')).toBe(true);
    expect(port.operations.filter((entry) => entry.startsWith('resume:'))).toHaveLength(6);
    expect(port.operations.filter((entry) => entry.startsWith('pause:'))).toHaveLength(0);
    expect(port.countedReceipt()?.retainUntilTime).toBe(RUN_HARD_STOP);
    expect(port.operations.indexOf('install-invocation-lease')).toBeLessThan(
      port.operations.findIndex((entry) => entry.startsWith('resume:')),
    );
  });

  it('rejects a FORCE/provision bypass confirmation before Scheduler mutation', async () => {
    const port = new FakePort();
    await expect(start(port, 'FORCE_ACCELERATED_RIG_ONLY')).rejects.toThrow(/exact CTO confirmation/i);
    expect(port.operations).toEqual([]);
  });

  it('rejects replay before Scheduler mutation', async () => {
    const port = new FakePort();
    port.receiptExists = true;
    await expect(start(port)).rejects.toThrow(/replay|already exists/i);
    expect(port.operations).toEqual([]);
  });

  it('rejects authority that cannot cover the complete 2,910-minute wall', async () => {
    const port = new FakePort();
    port.verifySignedApproval = () => ({
      ...approval(),
      runHardStopAt: '2026-07-18T20:29:00.000Z',
    });
    await expect(start(port)).rejects.toThrow(/2,910|wall|hard stop/i);
    expect(port.operations).toEqual([]);
  });

  it('rechecks hard-stop capacity immediately before first resume after slow pre-start reads', async () => {
    const port = new FakePort();
    port.verifySignedApproval = () => ({
      ...approval(),
      runHardStopAt: '2026-07-18T20:35:00.000Z',
    });
    port.nowSequence = [NOW, '2026-07-16T20:06:00.000Z'];
    await expect(start(port)).rejects.toThrow(/hard stop|required wall/i);
    expect(port.operations.filter((entry) => entry.startsWith('resume:'))).toHaveLength(0);
    expect(port.operations.filter((entry) => entry.startsWith('pause:'))).toHaveLength(6);
    expect(port.countedReceipt()).toBeUndefined();
  });

  it('rechecks hard-stop capacity immediately before the Locked receipt', async () => {
    const port = new FakePort();
    port.verifySignedApproval = () => ({
      ...approval(),
      runHardStopAt: '2026-07-18T20:35:00.000Z',
    });
    port.nowSequence = [NOW, NOW, NOW, NOW, '2026-07-16T20:06:00.000Z'];
    await expect(start(port)).rejects.toThrow(/hard stop|required wall/i);
    expect(port.operations.filter((entry) => entry.startsWith('resume:'))).toHaveLength(6);
    expect(port.operations.filter((entry) => entry.startsWith('pause:'))).toHaveLength(6);
    expect(port.countedReceipt()).toBeUndefined();
  });

  it('contains activation when the short START action expires before resume', async () => {
    const port = new FakePort();
    port.nowSequence = [NOW, ACTION_EXPIRES];
    await expect(start(port)).rejects.toThrow(/action authority expired/i);
    expect(port.operations.filter((entry) => entry.startsWith('resume:'))).toHaveLength(0);
    expect(port.operations.filter((entry) => entry.startsWith('pause:'))).toHaveLength(6);
    expect(port.operations.at(-1)).toBe('remove-invocation-lease');
  });

  it('contains a partial resume failure by pausing and separately verifying all six', async () => {
    const port = new FakePort();
    port.resumeFailureAt = 3;
    await expect(start(port)).rejects.toThrow(/resume failure/i);
    expect(port.operations.filter((entry) => entry.startsWith('pause:'))).toHaveLength(6);
    expect(port.operations.slice(-7, -1).every((entry) => entry.startsWith('observe:'))).toBe(true);
    expect(port.operations.at(-1)).toBe('remove-invocation-lease');
    expect([...port.states.values()].every((state) => state === 'PAUSED')).toBe(true);
    expect(port.countedReceipt()).toBeUndefined();
  });

  it('contains ENABLED verification failure and emits no receipt', async () => {
    const port = new FakePort();
    port.observeEnabledAsPaused = true;
    await expect(start(port)).rejects.toThrow(/ENABLED|state/i);
    expect(port.operations.filter((entry) => entry.startsWith('pause:'))).toHaveLength(6);
    expect(port.countedReceipt()).toBeUndefined();
  });

  it('contains receipt persistence failure and emits no counted receipt', async () => {
    const port = new FakePort();
    port.receiptFailure = true;
    await expect(start(port)).rejects.toThrow(/receipt failure/i);
    expect(port.operations.filter((entry) => entry.startsWith('pause:'))).toHaveLength(6);
    expect(port.countedReceipt()).toBeUndefined();
  });

  it('contains a wrong or partial Scheduler topology before any resume', async () => {
    const port = new FakePort();
    const original = port.observeJob.bind(port);
    port.observeJob = async (spec) => {
      const value = await original(spec);
      return spec.suffix === 'recover-broadcasts' ? { ...value, path: '/jobs/wrong' } : value;
    };
    await expect(start(port)).rejects.toThrow(/binding|path|topology/i);
    expect(port.operations.filter((entry) => entry.startsWith('resume:'))).toHaveLength(0);
    expect(port.operations.filter((entry) => entry.startsWith('pause:'))).toHaveLength(6);
  });
});
