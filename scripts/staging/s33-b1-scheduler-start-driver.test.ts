import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
import { calculateB1TreasuryContinuityCompositeIdentity } from './s33-b1-treasury-continuity';

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
const C56_HEAD = 'c56c7729687602b980e2b03454588683a8c20d9b';
const C56_TREE = '09f7d40d6b59b6afbe4979346e1d0d46f35ccd28';
const C56_IMAGE_DIGEST =
  'sha256:0162f4b840b12cd062eb43a2c05d4684bf5997e5f70297186c96a5aafc5ee105';
const C56_CORPUS = 'sha256:7d6ffd131230d13483d3f1bacdb170b3cfcc53a4383d59f6689e415c99e6089e';
const C56_APPROVAL = 'b1-provision-c56c7729-20260717t021606z';
const C56_SOAK = 'soak-s33-rig-b1-c56c7729';
const C56_LEASE = 'lease-s33-rig-b1-c56c7729';
const CONTROLLER_HEAD = 'd'.repeat(40);
const CONTROLLER_TREE = 'e'.repeat(40);
const CONTROLLER_FILES = `sha256:${'f'.repeat(64)}`;
const CONTINUITY_PRECLOCK_RAW = '{"preclock":"c56-continuity-fixture"}';

function digest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function fixtureText(name: string): string {
  return readFileSync(join(process.cwd(), 'scripts/fixtures', name), 'utf8').trimEnd();
}

interface ContinuityFixture {
  readonly admissionRaw: string;
  readonly treasuryPlanRaw: string;
  readonly claimRaw: string;
  readonly topologyRaw: string;
  readonly amendmentRaw: string;
  readonly compositeIdentitySha256: string;
  readonly nodeReadinessSha256: string;
  readonly serviceUrl: string;
  readonly claimUri: string;
  readonly topologyUri: string;
  readonly amendmentUri: string;
}

function continuityFixture(): ContinuityFixture {
  const claimRaw = fixtureText('s33-b1-c56c-provision-claim.fixture.txt');
  const topologyRaw = fixtureText('s33-b1-c56c-topology-ownership.fixture.txt');
  const amendmentRaw = fixtureText('s33-b1-c56c-treasury-continuity-amendment.fixture.txt');
  const treasuryPlanRaw = fixtureText('s33-b1-post-probe-treasury-plan.fixture.txt');
  const topology = JSON.parse(topologyRaw) as {
    nodeReadiness: Record<string, unknown>;
    nodeReadinessSha256: string;
    cloudRunServiceUrl: string;
  };
  const claimUri =
    `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/node-approval-claims/${C56_APPROVAL}.json`;
  const topologyUri =
    `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/topology-ownership/${C56_APPROVAL}.json`;
  const amendmentUri =
    `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/recovery-amendments/b1-treasury-continuity-c56c7729-20260717t022339z.json`;
  const continuity = {
    schemaVersion: 'arkova.s33.rig-b1.treasury-continuity-composition/v1',
    compositeIdentitySha256: `sha256:${'0'.repeat(64)}`,
    originalProvision: {
      approvalId: C56_APPROVAL,
      approvalEnvelopeSha256: 'sha256:95810a191bf7fdcd976aeaaa3d17241a8fc3cdc1bc1f235fd2dc806c98430805',
      signedPayloadSha256: 'sha256:06ef0449e975315ffbe3a6e8ba506150365c4784bf758ea6ecd12616a78185b6',
      sourceHeadSha: C56_HEAD,
      sourceTreeSha: C56_TREE,
      corpusDigest: C56_CORPUS,
      releaseCandidateId: 's33-w3-b1-recovery-rc-c56c7729',
      soakId: C56_SOAK,
      leaseId: C56_LEASE,
      claim: {
        objectUri: claimUri,
        generation: '1784254587600385',
        sha256: 'sha256:2b24c08b9e924d2e649242c5c36ca27ec56c1aa742080e3ff1eee7ab1056875d',
      },
      topology: {
        objectUri: topologyUri,
        generation: '1784254616684049',
        sha256: 'sha256:d408b454bc0b5382d64c7e7de38bb0a21ede88b3b14487e84616d24955c456f7',
      },
    },
    amendment: {
      objectUri: amendmentUri,
      generation: '1784255027455134',
      envelopeSha256: 'sha256:d046785a0157d7017d59f7a9cd3005644c2d5e3006b95a810fe4d6748240cca0',
      signedPayloadSha256: 'sha256:2a2f2cb4dd647044fbdcc80a1a87283257f769fdeac50a62ec6b9de095173e02',
    },
    originalTreasury: {
      confirmedOutputCount: 32,
      confirmedTotalSats: 169_639,
      planDigest: 'sha256:ab70ac7cf0ef1b371258c86ee4d967fec199b156156fe214238440429df794d8',
    },
    currentTreasury: {
      confirmedOutputCount: 32,
      confirmedTotalSats: 169_482,
      planDigest: 'sha256:9808e07f3b2329488e5dc5f2658a2224937f3c950fd7322b9a5a227ff34fc034',
      planInputSha256: 'sha256:1c952e7e6ee5d668f663eaec4fd62d5df83ee9f30778d57c07b3d03b1a8e4485',
      deltaSats: -157,
      fundedProbeFeeSats: 157,
    },
    controllerCandidate: {
      sourceHeadSha: CONTROLLER_HEAD,
      sourceTreeSha: CONTROLLER_TREE,
      relevantFilesSha256: CONTROLLER_FILES,
    },
  };
  const admission = {
    schema_version: 2,
    sha: C56_HEAD,
    image_digest: C56_IMAGE_DIGEST,
    soak_id: C56_SOAK,
    lease_id: C56_LEASE,
    treasury_continuity: continuity,
    infrastructure: {
      authority: {
        approvalId: C56_APPROVAL,
        approvalEnvelopeSha256: continuity.originalProvision.approvalEnvelopeSha256,
        signedPayloadSha256: continuity.originalProvision.signedPayloadSha256,
        claim: { objectUri: claimUri, generation: '1784254587600385' },
      },
      nodeReadiness: topology.nodeReadiness,
      treasuryWatchOnly: {
        preSplitPlanDigest: continuity.originalTreasury.planDigest,
        expectedConfirmedOutputCount: 32,
        expectedTotalSats: 169_639,
      },
    },
  };
  continuity.compositeIdentitySha256 = calculateB1TreasuryContinuityCompositeIdentity({
    refreshedAdmissionRaw: JSON.stringify(admission),
    currentTreasuryPlanInputRaw: treasuryPlanRaw,
    originalClaim: {
      uri: claimUri,
      generation: continuity.originalProvision.claim.generation,
      raw: claimRaw,
      retainUntilTime: '2026-07-22T22:39:24Z',
    },
    originalTopology: {
      uri: topologyUri,
      generation: continuity.originalProvision.topology.generation,
      raw: topologyRaw,
      retainUntilTime: '2026-07-22T22:39:24Z',
    },
    amendment: {
      uri: amendmentUri,
      generation: continuity.amendment.generation,
      raw: amendmentRaw,
      retainUntilTime: '2026-07-22T22:39:24Z',
    },
  });
  return {
    admissionRaw: JSON.stringify(admission),
    treasuryPlanRaw,
    claimRaw,
    topologyRaw,
    amendmentRaw,
    compositeIdentitySha256: continuity.compositeIdentitySha256,
    nodeReadinessSha256: topology.nodeReadinessSha256,
    serviceUrl: topology.cloudRunServiceUrl,
    claimUri,
    topologyUri,
    amendmentUri,
  };
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

const CONTINUITY_PREPARATION_ID = 'b1-prepare-c56-continuity-test';
const CONTINUITY_START_ID = 'b1-start-c56-continuity-test';

function continuityAdmission(value: ContinuityFixture): B1SchedulerStartAdmission {
  return {
    admissionSha256: digest(value.admissionRaw),
    generatedAt: '2026-07-16T19:30:00.000Z',
    cleanMirrorVerifiedAt: '2026-07-16T19:25:00.000Z',
    rigName: B1_SCHEDULER_START_CONTRACT.rigName,
    soakId: C56_SOAK,
    leaseId: C56_LEASE,
    sourceHeadSha: C56_HEAD,
    workerImage: `${B1_SCHEDULER_START_CONTRACT.workerImageRepository}@${C56_IMAGE_DIGEST}`,
    workerImageDigest: C56_IMAGE_DIGEST,
    gcpProjectId: B1_SCHEDULER_START_CONTRACT.gcpProjectId,
    gcpRegion: B1_SCHEDULER_START_CONTRACT.gcpRegion,
    supabaseProjectRef: 'lbqkhdwqpfncvocasmfp',
    workerService: B1_SCHEDULER_START_CONTRACT.workerService,
    workerRevision: 'arkova-worker-s33-rig-b1-staging-b1hdr2-021254',
    schedulerOidcServiceAccount: B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount,
    cleanMirrorAttestationId: `sha256:${'e'.repeat(64)}`,
    requiredWorkerUptimeMin: 2_880,
    requiredWallMin: 2_910,
    approvalId: C56_APPROVAL,
    approvalEnvelopeSha256: 'sha256:95810a191bf7fdcd976aeaaa3d17241a8fc3cdc1bc1f235fd2dc806c98430805',
    signedPayloadSha256: 'sha256:06ef0449e975315ffbe3a6e8ba506150365c4784bf758ea6ecd12616a78185b6',
    approvalClaimUri: value.claimUri,
    approvalClaimGeneration: '1784254587600385',
    nodeReadinessSha256: value.nodeReadinessSha256,
    cronSecretName: 'arkova-s33-rig-b1-cron-secret',
    cronSecretVersion: '2',
    cronSecretResource: 'projects/arkova1/secrets/arkova-s33-rig-b1-cron-secret/versions/2',
    continuityCompositeIdentitySha256: value.compositeIdentitySha256,
    controllerSourceHeadSha: CONTROLLER_HEAD,
    controllerSourceTreeSha: CONTROLLER_TREE,
    controllerRelevantFilesSha256: CONTROLLER_FILES,
  };
}

function continuityPreclock(value: ContinuityFixture): B1SchedulerStartPreclock {
  return {
    status: 'PRE_CLOCK_READY',
    preclockSha256: digest(CONTINUITY_PRECLOCK_RAW),
    admissionSha256: digest(value.admissionRaw),
    sourceHeadSha: C56_HEAD,
    workerImageDigest: C56_IMAGE_DIGEST,
    cleanMirrorAttestationId: `sha256:${'e'.repeat(64)}`,
    nodeReadinessSha256: value.nodeReadinessSha256,
    observedAt: '2026-07-16T19:55:00.000Z',
    schedulerJobsPaused: 6,
    schedulerCadence: B1_SCHEDULER_START_CONTRACT.cadence,
    continuityCompositeIdentitySha256: value.compositeIdentitySha256,
    continuityTreasuryPlanInputRaw: value.treasuryPlanRaw,
  };
}

function continuityPreparationIntentRaw(value: ContinuityFixture): string {
  const admitted = continuityAdmission(value);
  return JSON.stringify({
    schemaVersion: 'arkova.s33.rig-b1.preparation-intent/v1',
    status: 'PREPARE_INTENT_LOCKED',
    preparationId: CONTINUITY_PREPARATION_ID,
    authorityEnvelopeSha256: `sha256:${'3'.repeat(64)}`,
    authoritySignedPayloadSha256: `sha256:${'4'.repeat(64)}`,
    provisionApprovalEnvelopeSha256: admitted.approvalEnvelopeSha256,
    provisionSignedPayloadSha256: admitted.signedPayloadSha256,
    admissionSha256: admitted.admissionSha256,
    sourceHeadSha: C56_HEAD,
    sourceTreeSha: C56_TREE,
    workerImageDigest: C56_IMAGE_DIGEST,
    corpusDigest: C56_CORPUS,
    releaseCandidateId: 's33-w3-b1-recovery-rc-c56c7729',
    soakId: C56_SOAK,
    leaseId: C56_LEASE,
    maxFundedBroadcasts: 1,
    invocationLeaseMaxSeconds: 600,
    authorityExpiresAt: '2026-07-16T19:59:00.000Z',
    continuityCompositeIdentitySha256: value.compositeIdentitySha256,
    controllerSourceHeadSha: CONTROLLER_HEAD,
    controllerSourceTreeSha: CONTROLLER_TREE,
    controllerRelevantFilesSha256: CONTROLLER_FILES,
  });
}

function continuityPreparationOutcomeRaw(value: ContinuityFixture): string {
  return JSON.stringify({
    schemaVersion: 'arkova.s33.rig-b1.preparation-outcome/v1',
    status: 'PRE_CLOCK_READY',
    preparationId: CONTINUITY_PREPARATION_ID,
    intentSha256: digest(continuityPreparationIntentRaw(value)),
    admissionSha256: digest(value.admissionRaw),
    preclockArtifactSha256: digest(CONTINUITY_PRECLOCK_RAW),
    preclockArtifactRaw: CONTINUITY_PRECLOCK_RAW,
    completedAt: '2026-07-16T19:58:00.000Z',
    continuityCompositeIdentitySha256: value.compositeIdentitySha256,
  });
}

function continuityApproval(value: ContinuityFixture): VerifiedB1StartApproval {
  const admitted = continuityAdmission(value);
  const intentRaw = continuityPreparationIntentRaw(value);
  const outcomeRaw = continuityPreparationOutcomeRaw(value);
  return {
    status: 'VERIFIED',
    keyId: B1_SCHEDULER_START_CONTRACT.keyId,
    verifierIdentity: B1_SCHEDULER_START_CONTRACT.verifierIdentity,
    envelopeSha256: `sha256:${'8'.repeat(64)}`,
    signedPayloadSha256: `sha256:${'9'.repeat(64)}`,
    startId: CONTINUITY_START_ID,
    purpose: B1_SCHEDULER_START_CONTRACT.authorityPurpose,
    sourceHeadSha: C56_HEAD,
    sourceTreeSha: C56_TREE,
    workerImage: admitted.workerImage,
    workerImageDigest: C56_IMAGE_DIGEST,
    corpusDigest: C56_CORPUS,
    releaseCandidateId: 's33-w3-b1-recovery-rc-c56c7729',
    rigName: B1_SCHEDULER_START_CONTRACT.rigName,
    soakId: C56_SOAK,
    leaseId: C56_LEASE,
    workerService: B1_SCHEDULER_START_CONTRACT.workerService,
    workerRuntimeServiceAccount: B1_SCHEDULER_START_CONTRACT.workerRuntimeServiceAccount,
    schedulerOidcServiceAccount: B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount,
    schedulerJobNames: B1_SCHEDULER_START_CONTRACT.jobs.map(({ suffix }) => jobName(suffix)),
    provisionApprovalId: C56_APPROVAL,
    provisionApprovalEnvelopeSha256: admitted.approvalEnvelopeSha256,
    provisionSignedPayloadSha256: admitted.signedPayloadSha256,
    provisionAdmissionSha256: admitted.admissionSha256,
    approvalClaim: {
      objectUri: value.claimUri,
      generation: '1784254587600385',
      sha256: digest(value.claimRaw),
    },
    topologyOwnership: {
      objectUri: value.topologyUri,
      generation: '1784254616684049',
      sha256: digest(value.topologyRaw),
    },
    preparationId: CONTINUITY_PREPARATION_ID,
    preparationApprovalEnvelopeSha256: `sha256:${'3'.repeat(64)}`,
    preparationSignedPayloadSha256: `sha256:${'4'.repeat(64)}`,
    preparationIntent: {
      objectUri:
        `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/preparation-intents/${CONTINUITY_PREPARATION_ID}.json`,
      generation: '5',
      sha256: digest(intentRaw),
    },
    preparationOutcome: {
      objectUri:
        `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/preparation-outcomes/${CONTINUITY_PREPARATION_ID}.json`,
      generation: '6',
      sha256: digest(outcomeRaw),
    },
    preclockArtifactSha256: digest(CONTINUITY_PRECLOCK_RAW),
    continuityCompositeIdentitySha256: value.compositeIdentitySha256,
    continuityAmendment: {
      objectUri: value.amendmentUri,
      generation: '1784255027455134',
      sha256: digest(value.amendmentRaw),
    },
    controllerSourceHeadSha: CONTROLLER_HEAD,
    controllerSourceTreeSha: CONTROLLER_TREE,
    controllerRelevantFilesSha256: CONTROLLER_FILES,
    actionExpiresAt: ACTION_EXPIRES,
    runHardStopAt: RUN_HARD_STOP,
  };
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

class ContinuityPort extends FakePort {
  readonly fixture = continuityFixture();
  controllerIdentityFailure = false;

  override projectAdmission = (): B1SchedulerStartAdmission => {
    return continuityAdmission(this.fixture);
  };

  override verifyPreclock = (): B1SchedulerStartPreclock => {
    return continuityPreclock(this.fixture);
  };

  override verifySignedApproval = (): VerifiedB1StartApproval => {
    return continuityApproval(this.fixture);
  };

  async verifyControllerIdentity(): Promise<void> {
    this.operations.push('verify-controller');
    if (this.controllerIdentityFailure) throw new Error('injected controller identity mismatch');
  }

  override async readLockedObject(uri: string): Promise<B1LockedObject> {
    const retainUntilTime = '2026-07-22T22:39:24Z';
    if (uri === this.fixture.claimUri) {
      return { uri, generation: '1784254587600385', retainUntilTime, raw: this.fixture.claimRaw };
    }
    if (uri === this.fixture.topologyUri) {
      return { uri, generation: '1784254616684049', retainUntilTime, raw: this.fixture.topologyRaw };
    }
    if (uri === this.fixture.amendmentUri) {
      return { uri, generation: '1784255027455134', retainUntilTime, raw: this.fixture.amendmentRaw };
    }
    if (uri.includes(`/preparation-intents/${CONTINUITY_PREPARATION_ID}.json`)) {
      return locked(uri, continuityPreparationIntentRaw(this.fixture), '5');
    }
    if (uri.includes(`/preparation-outcomes/${CONTINUITY_PREPARATION_ID}.json`)) {
      return locked(uri, continuityPreparationOutcomeRaw(this.fixture), '6');
    }
    return super.readLockedObject(uri);
  }

  override async observeJob(
    spec: typeof B1_SCHEDULER_START_CONTRACT.jobs[number],
  ): Promise<B1SchedulerJobObservation> {
    const observed = await super.observeJob(spec);
    return {
      ...observed,
      uri: `${this.fixture.serviceUrl}${spec.path}`,
      oidcAudience: this.fixture.serviceUrl,
    };
  }

  override async observeActivation() {
    this.operations.push('observe-activation');
    return {
      observedAt: NOW,
      workerRevision: 'arkova-worker-s33-rig-b1-staging-b1hdr2-021254',
      sourceHeadSha: C56_HEAD,
      imageDigest: C56_IMAGE_DIGEST,
      runtimeServiceAccount: B1_SCHEDULER_START_CONTRACT.workerRuntimeServiceAccount,
      serviceUrl: this.fixture.serviceUrl,
      healthStatusCode: 200 as const,
      healthStatus: 'healthy' as const,
      healthGitSha: C56_HEAD,
    };
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

function continuityConfirmation(port: ContinuityPort): string {
  return expectedB1SchedulerStartConfirmation({
    startId: CONTINUITY_START_ID,
    soakId: C56_SOAK,
    leaseId: C56_LEASE,
    admissionSha256: digest(port.fixture.admissionRaw),
    preclockSha256: digest(CONTINUITY_PRECLOCK_RAW),
  });
}

async function continuityStart(port: ContinuityPort) {
  return runS33B1SchedulerStartDriver(
    port.fixture.admissionRaw,
    CONTINUITY_PRECLOCK_RAW,
    '{"signed":"continuity-approval"}',
    continuityConfirmation(port),
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

  it('starts from original c56 topology plus effective continuity and records both identities', async () => {
    const port = new ContinuityPort();
    const result = await continuityStart(port);
    expect(result.receipt).toMatchObject({
      status: 'COUNTED_START',
      runtimeCandidate: {
        sourceHeadSha: C56_HEAD,
        sourceTreeSha: C56_TREE,
        workerImageDigest: C56_IMAGE_DIGEST,
        workerRevision: 'arkova-worker-s33-rig-b1-staging-b1hdr2-021254',
      },
      controller: {
        sourceHeadSha: CONTROLLER_HEAD,
        sourceTreeSha: CONTROLLER_TREE,
        relevantFilesSha256: CONTROLLER_FILES,
      },
      evidence: {
        continuity: {
          compositeIdentitySha256: port.fixture.compositeIdentitySha256,
          amendment: {
            objectUri: port.fixture.amendmentUri,
            generation: '1784255027455134',
            sha256: digest(port.fixture.amendmentRaw),
          },
        },
      },
    });
    expect(port.operations.indexOf('verify-controller'))
      .toBeLessThan(port.operations.findIndex((operation) => operation.startsWith('resume:')));
    expect(port.operations.filter((operation) => operation.startsWith('resume:'))).toHaveLength(6);
  });

  it('fails a continuity controller mismatch before any Scheduler resume', async () => {
    const port = new ContinuityPort();
    port.controllerIdentityFailure = true;
    await expect(continuityStart(port)).rejects.toThrow(/controller identity mismatch/i);
    expect(port.operations).toContain('verify-controller');
    expect(port.operations.filter((operation) => operation.startsWith('resume:'))).toHaveLength(0);
    expect(port.persisted.size).toBe(0);
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
