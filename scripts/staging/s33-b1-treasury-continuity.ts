/** Exact one-time composition for the contained B1 funded-probe treasury delta. */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import { planTreasuryPresplit } from './batch-drain-utxo-fanout';

const PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAE+Ir2My5+bBwU73QkL73F7fiRteZ0V5yIAe41fD6MdU=\n-----END PUBLIC KEY-----\n';
const DOMAIN = 'arkova:s33:rig-b1-treasury-continuity-amendment:v1\n';
const FAILED_START_CONTAINMENT_DOMAIN = 'arkova:s33:rig-b1-failed-start-containment:v1\n';
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;

export const B1_TREASURY_CONTINUITY_CONTROLLER_FILES = Object.freeze([
  'scripts/staging/batch-drain-admission-adapter.ts',
  'scripts/staging/batch-drain-chain-readiness.ts',
  'scripts/staging/s33-b1-no-broadcast-prepare-containment.ts',
  'scripts/staging/s33-b1-no-broadcast-successor-containment.ts',
  'scripts/staging/s33-b1-preparation-approval.ts',
  'scripts/staging/s33-b1-scheduler-preclock-production-adapter.ts',
  'scripts/staging/s33-b1-scheduler-start-driver.ts',
  'scripts/staging/s33-b1-start-approval.ts',
  'scripts/staging/s33-b1-treasury-continuity.ts',
] as const);

export const B1_TREASURY_CONTINUITY_CONTRACT = Object.freeze({
  schemaVersion: 'arkova.s33.rig-b1.treasury-continuity-composition/v1',
  keyId: 'arkova.s33.b1-evidence.ed25519.v1',
  keyFingerprint: '8b7fbc51c74828dab2e1a3ca6f0c15069575bae8e4e190eaf3b165daea50d5c6',
  approverIdentity: 'arkova.s33.approver.founder-cto.v1',
  purpose: 'AUTHORIZE_POST_PROBE_B1_TREASURY_CONTINUITY',
  amendmentUri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/recovery-amendments/b1-treasury-continuity-c56c7729-20260717t022339z.json',
  amendmentGeneration: '1784255027455134',
  amendmentEnvelopeSha256: 'sha256:d046785a0157d7017d59f7a9cd3005644c2d5e3006b95a810fe4d6748240cca0',
  amendmentSignedPayloadSha256: 'sha256:2a2f2cb4dd647044fbdcc80a1a87283257f769fdeac50a62ec6b9de095173e02',
  originalHeadSha: 'c56c7729687602b980e2b03454588683a8c20d9b',
  originalTreeSha: '09f7d40d6b59b6afbe4979346e1d0d46f35ccd28',
  originalImageDigest: 'sha256:0162f4b840b12cd062eb43a2c05d4684bf5997e5f70297186c96a5aafc5ee105',
  originalRevision: 'arkova-worker-s33-rig-b1-staging-b1hdr2-021254',
  originalInfrastructureSha256: 'sha256:2faa6a3b5239404d0f80623a3aee0bf64ac3943ca7415650edbf1b89dcd7a67e',
  originalApprovalId: 'b1-provision-c56c7729-20260717t021606z',
  originalApprovalEnvelopeSha256: 'sha256:95810a191bf7fdcd976aeaaa3d17241a8fc3cdc1bc1f235fd2dc806c98430805',
  originalSignedPayloadSha256: 'sha256:06ef0449e975315ffbe3a6e8ba506150365c4784bf758ea6ecd12616a78185b6',
  originalClaimUri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/node-approval-claims/b1-provision-c56c7729-20260717t021606z.json',
  originalClaimGeneration: '1784254587600385',
  originalClaimSha256: 'sha256:2b24c08b9e924d2e649242c5c36ca27ec56c1aa742080e3ff1eee7ab1056875d',
  originalTopologyUri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/topology-ownership/b1-provision-c56c7729-20260717t021606z.json',
  originalTopologyGeneration: '1784254616684049',
  originalTopologySha256: 'sha256:d408b454bc0b5382d64c7e7de38bb0a21ede88b3b14487e84616d24955c456f7',
  originalNodeReadinessSha256: 'sha256:78536b8417f07465b0d9a2728acba0c7870eb69bf1e90654cd0e5a5581034af5',
  originalPlanDigest: 'sha256:ab70ac7cf0ef1b371258c86ee4d967fec199b156156fe214238440429df794d8',
  originalTotalSats: 169_639,
  currentPlanDigest: 'sha256:9808e07f3b2329488e5dc5f2658a2224937f3c950fd7322b9a5a227ff34fc034',
  currentPlanInputSha256: 'sha256:1c952e7e6ee5d668f663eaec4fd62d5df83ee9f30778d57c07b3d03b1a8e4485',
  currentTotalSats: 169_482,
  fundedProbeFeeSats: 157,
  deltaSats: -157,
  outputCount: 32,
  historicalCandidateHeadSha: '5dacccc888f97e8bb40f40e851547892f3d744ac',
  historicalPreparationId: 'b1-prepare-5dacccc8-20260717t014328z',
  historicalPreparationIntentUri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/preparation-intents/b1-prepare-5dacccc8-20260717t014328z.json',
  historicalPreparationIntentGeneration: '1784252663697634',
  historicalPreparationIntentSha256: 'sha256:6ca02ce15b86af0e125cd3923b4d94cd2817d45916e4b01a4db490a36828f9a7',
  historicalPreparationOutcomeUri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/preparation-outcomes/b1-prepare-5dacccc8-20260717t014328z.json',
  historicalPreparationOutcomeGeneration: '1784252687265846',
  historicalPreparationOutcomeSha256: 'sha256:8a91457edae6c3ee06d3d93d4f88a99833c2e8e6afb4e6e4d791550f6d1190ae',
  historicalPreclockArtifactSha256: 'sha256:0a8448679ccf900bb75823eb87c6aa6c284bc97e703921d83754cc5e6f923342',
  historicalFundedTransactionId: '4f56c2bd94b4205a83b3625d52fc35db3ef2a8937d178cd519145f3055ffe8f6',
  failedStartContainmentUri: 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/failed-start-containments/b1-start-5dacccc8-20260717t014842z.json',
  failedStartContainmentGeneration: '1784254293955696',
  failedStartContainmentSha256: 'sha256:4db25dcfaec89f739774ba93616aa179cd5c09b3df5e3c51c85016b44d73af37',
} as const);

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const generation = z.string().regex(/^[1-9][0-9]*$/u);
const timestamp = z.string().datetime({ offset: true });
const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);

const lockedReferenceSchema = z.object({
  objectUri: z.string().min(1), generation, sha256,
}).strict();

export const b1TreasuryContinuitySchema = z.object({
  schemaVersion: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.schemaVersion),
  compositeIdentitySha256: sha256,
  originalProvision: z.object({
    approvalId: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalApprovalId),
    approvalEnvelopeSha256: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalApprovalEnvelopeSha256),
    signedPayloadSha256: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalSignedPayloadSha256),
    sourceHeadSha: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalHeadSha),
    sourceTreeSha: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalTreeSha),
    corpusDigest: sha256,
    releaseCandidateId: boundedId,
    soakId: boundedId,
    leaseId: boundedId,
    claim: z.object({
      objectUri: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalClaimUri),
      generation: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalClaimGeneration),
      sha256: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalClaimSha256),
    }).strict(),
    topology: z.object({
      objectUri: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalTopologyUri),
      generation: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalTopologyGeneration),
      sha256: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalTopologySha256),
    }).strict(),
  }).strict(),
  amendment: z.object({
    objectUri: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.amendmentUri),
    generation: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.amendmentGeneration),
    envelopeSha256: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.amendmentEnvelopeSha256),
    signedPayloadSha256: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.amendmentSignedPayloadSha256),
  }).strict(),
  originalTreasury: z.object({
    confirmedOutputCount: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.outputCount),
    confirmedTotalSats: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalTotalSats),
    planDigest: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalPlanDigest),
  }).strict(),
  currentTreasury: z.object({
    confirmedOutputCount: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.outputCount),
    confirmedTotalSats: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.currentTotalSats),
    planDigest: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.currentPlanDigest),
    planInputSha256: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.currentPlanInputSha256),
    deltaSats: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.deltaSats),
    fundedProbeFeeSats: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.fundedProbeFeeSats),
  }).strict(),
  controllerCandidate: z.object({
    sourceHeadSha: gitSha,
    sourceTreeSha: gitSha,
    relevantFilesSha256: sha256,
  }).strict(),
}).strict();

export type B1TreasuryContinuity = z.infer<typeof b1TreasuryContinuitySchema>;

export interface B1LockedContinuityObject {
  readonly uri: string;
  readonly generation: string;
  readonly raw: string;
  readonly retainUntilTime: string;
}

export interface B1TreasuryContinuityCompositionInput {
  readonly verificationTime: Date;
  readonly refreshedAdmissionRaw: string;
  readonly currentTreasuryPlanInputRaw: string;
  readonly originalClaim: B1LockedContinuityObject;
  readonly originalTopology: B1LockedContinuityObject;
  readonly amendment: B1LockedContinuityObject;
  readonly historicalPreparationIntent: B1LockedContinuityObject;
  readonly historicalPreparationOutcome: B1LockedContinuityObject;
  readonly failedStartContainment: B1LockedContinuityObject;
}

export interface VerifiedB1TreasuryContinuityComposition {
  readonly status: 'VERIFIED_B1_TREASURY_CONTINUITY';
  readonly compositeIdentitySha256: string;
  readonly normalizedAdmissionSha256: string;
  readonly originalConfirmedTotalSats: 169_639;
  readonly currentConfirmedTotalSats: 169_482;
  readonly deltaSats: -157;
  readonly controllerSourceHeadSha: string;
  readonly controllerSourceTreeSha: string;
  readonly controllerRelevantFilesSha256: string;
  readonly amendmentExpiresAt: string;
}

export interface B1TreasuryContinuityControllerSnapshot {
  readonly sourceHeadSha: string;
  readonly sourceTreeSha: string;
  readonly trackedWorktreeStatus: string;
  readonly trackedPaths: readonly string[];
  readonly relevantFiles: readonly Readonly<{
    path: string;
    raw: Uint8Array;
    matchesHeadBlob: boolean;
  }>[];
}

export interface VerifiedB1TreasuryContinuityController {
  readonly status: 'VERIFIED_B1_TREASURY_CONTINUITY_CONTROLLER';
  readonly sourceHeadSha: string;
  readonly sourceTreeSha: string;
  readonly relevantFilesSha256: string;
}

const VERIFIED_COMPOSITIONS = new WeakSet<object>();

const admissionProjectionSchema = z.object({
  schema_version: z.literal(2),
  sha: gitSha,
  image_digest: sha256,
  deployed_revision: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalRevision),
  soak_id: boundedId,
  lease_id: boundedId,
  treasury_continuity: b1TreasuryContinuitySchema,
  infrastructure: z.object({
    authority: z.object({
      approvalId: boundedId,
      approvalEnvelopeSha256: sha256,
      signedPayloadSha256: sha256,
      claim: z.object({ objectUri: z.string(), generation }).passthrough(),
    }).passthrough(),
    nodeReadiness: z.object({
      treasurySplitPlanDigest: sha256,
      confirmedOutputCount: z.number().int().positive(),
      confirmedTotalSats: z.number().int().positive(),
    }).passthrough(),
    treasuryWatchOnly: z.object({
      preSplitPlanDigest: sha256,
      expectedConfirmedOutputCount: z.number().int().positive(),
      expectedTotalSats: z.number().int().positive(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const claimSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.node-approval-claim/v1'),
  approvalId: boundedId,
  envelopeSha256: sha256,
  signedPayloadSha256: sha256,
  sourceHeadSha: gitSha,
  sourceTreeSha: gitSha,
  corpusDigest: sha256,
  releaseCandidateId: boundedId,
  soakId: boundedId,
  leaseId: boundedId,
}).passthrough();

const topologySchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.topology-ownership/v1'),
  approvalId: boundedId,
  envelopeSha256: sha256,
  signedPayloadSha256: sha256,
  sourceHeadSha: gitSha,
  sourceTreeSha: gitSha,
  corpusDigest: sha256,
  releaseCandidateId: boundedId,
  soakId: boundedId,
  leaseId: boundedId,
  nodeReadinessSha256: sha256,
  nodeReadiness: z.object({
    treasurySplitPlanDigest: sha256,
    confirmedOutputCount: z.number().int().positive(),
    confirmedTotalSats: z.number().int().positive(),
  }).passthrough(),
  approvalClaim: z.object({ objectUri: z.string(), generation }).strict(),
}).passthrough();

const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  envelopeId: boundedId,
  keyId: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.keyId),
  keyFingerprint: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.keyFingerprint),
  signedPayloadRaw: z.string().min(1).max(64 * 1024),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
}).strict();

const amendmentPayloadSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.treasury-continuity-amendment/v1'),
  amendmentId: boundedId,
  authority: z.object({
    keyId: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.keyId),
    keyFingerprint: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.keyFingerprint),
    approverIdentity: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.approverIdentity),
    purpose: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.purpose),
    signatureDomain: z.literal(DOMAIN),
  }).strict(),
  historicalProbe: z.object({
    candidateHeadSha: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.historicalCandidateHeadSha),
    preparationId: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationId),
    preparationIntent: lockedReferenceSchema,
    preparationOutcome: lockedReferenceSchema,
    preclockArtifactSha256: z.literal(
      B1_TREASURY_CONTINUITY_CONTRACT.historicalPreclockArtifactSha256,
    ),
    fundedTransaction: z.object({
      txId: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.historicalFundedTransactionId),
      acceptedAt: timestamp,
      feeSats: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.fundedProbeFeeSats),
      confirmed: z.literal(true),
      changeOutput: z.object({
        vout: z.number().int().nonnegative(),
        address: z.string().min(1),
        valueSats: z.number().int().positive(),
      }).strict(),
    }).passthrough(),
    failedStartContainment: lockedReferenceSchema,
  }).passthrough(),
  continuityObservation: z.object({
    confirmedUtxoCount: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.outputCount),
    confirmedTotalSats: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.currentTotalSats),
    priorConfirmedTotalSats: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalTotalSats),
    deltaSats: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.deltaSats),
    allValueDeltaAccountedForByConfirmedProbeFee: z.literal(true),
  }).passthrough(),
  continuityPlan: z.object({
    rawSha256: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.currentPlanInputSha256),
    planDigest: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.currentPlanDigest),
    inputCount: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.outputCount),
    outputCount: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.outputCount),
    totalSats: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.currentTotalSats),
  }).passthrough(),
  scope: z.object({
    rigName: z.literal('s33-rig-b1'),
    sourceHeadSha: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalHeadSha),
    sourceTreeSha: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalTreeSha),
    workerImageDigest: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.originalImageDigest),
    databaseOrMigrationChanged: z.literal(false),
    secretVersionChanged: z.literal(false),
    schedulerTopologyChanged: z.literal(false),
    g1OrRigRMutationAuthorized: z.literal(false),
    productionMutationAuthorized: z.literal(false),
  }).strict(),
  assertions: z.object({
    historicalProbeEvidencePreserved: z.literal(true),
    failedStartEvidencePreserved: z.literal(true),
    noSecondPrepareIntentCreatedAtAmendmentTime: z.literal(true),
    noUnaccountedTreasuryValueLoss: z.literal(true),
    allSixSchedulersRemainPaused: z.literal(true),
    noSecretValuesIncluded: z.literal(true),
  }).strict(),
  issuedAt: timestamp,
  expiresAt: timestamp,
  verdict: z.literal('AUTHORIZED_POST_PROBE_TREASURY_CONTINUITY'),
}).passthrough();

const historicalPreparationIntentSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.preparation-intent/v1'),
  status: z.literal('PREPARE_INTENT_LOCKED'),
  preparationId: boundedId,
  authorityEnvelopeSha256: sha256,
  authoritySignedPayloadSha256: sha256,
  provisionApprovalEnvelopeSha256: sha256,
  provisionSignedPayloadSha256: sha256,
  admissionSha256: sha256,
  treasuryPlanSha256: sha256,
  sourceHeadSha: gitSha,
  sourceTreeSha: gitSha,
  workerImageDigest: sha256,
  corpusDigest: sha256,
  releaseCandidateId: boundedId,
  soakId: boundedId,
  leaseId: boundedId,
  idempotencyKey: sha256,
  maxFundedBroadcasts: z.literal(1),
  invocationLeaseMaxSeconds: z.literal(600),
  createdAt: timestamp,
  authorityExpiresAt: timestamp,
}).strict();

const historicalPreparationOutcomeSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.preparation-outcome/v1'),
  status: z.literal('PRE_CLOCK_READY'),
  preparationId: boundedId,
  intentSha256: sha256,
  admissionSha256: sha256,
  treasuryPlanSha256: sha256,
  idempotencyKey: sha256,
  fundedProbe: z.object({
    txId: z.string().regex(/^[0-9a-f]{64}$/u),
    evidenceSha256: sha256,
    observedAt: timestamp,
  }).strict(),
  preclockArtifactSha256: sha256,
  preclockArtifactRaw: z.string().min(1).max(4 * 1024 * 1024),
  completedAt: timestamp,
}).strict();

const historicalPreclockSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.scheduler-start-preclock/v1'),
  status: z.literal('PRE_CLOCK_READY'),
  admissionSha256: sha256,
  sourceHeadSha: gitSha,
  workerImageDigest: sha256,
  sourceEvidence: z.object({
    readinessObservation: z.object({
      fundedBroadcast: z.object({
        network: z.literal('signet'),
        txId: z.string().regex(/^[0-9a-f]{64}$/u),
        accepted: z.literal(true),
        observedAt: timestamp,
      }).passthrough(),
      mempoolCorroboration: z.object({
        txId: z.string().regex(/^[0-9a-f]{64}$/u),
        txOutcome: z.literal('found'),
        observedAt: timestamp,
      }).passthrough(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const failedStartContainmentPayloadSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.failed-start-containment/v1'),
  containmentId: boundedId,
  authority: z.object({
    keyId: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.keyId),
    keyFingerprint: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.keyFingerprint),
    approverIdentity: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.approverIdentity),
    purpose: z.literal('CONTAIN_FAILED_B1_START'),
    signatureDomain: z.literal(FAILED_START_CONTAINMENT_DOMAIN),
  }).strict(),
  failedStart: z.object({
    activationId: boundedId,
    countedReceiptStartedAt: timestamp,
    candidate: z.object({
      sourceHeadSha: z.literal(B1_TREASURY_CONTINUITY_CONTRACT.historicalCandidateHeadSha),
      sourceTreeSha: gitSha,
      workerImageDigest: sha256,
      revision: z.string().min(1),
      serviceUrl: z.string().url(),
    }).strict(),
    firstSchedulerFireWindow: z.object({
      allSixHttp503: z.literal(true),
      requests: z.array(z.object({ status: z.literal(503) }).passthrough()).length(6),
    }).passthrough(),
    supervisor: z.object({
      processRunning: z.literal(false),
      firstHeartbeatPresent: z.literal(false),
      firstJournalPresent: z.literal(false),
    }).passthrough(),
  }).passthrough(),
  containment: z.object({
    observedAt: timestamp,
    schedulerJobs: z.array(z.object({
      state: z.literal('PAUSED'),
      schedule: z.literal('*/5 * * * *'),
    }).passthrough()).length(6),
    exactJobCount: z.literal(6),
    allSixPaused: z.literal(true),
    schedulerInvocationLeaseRemoved: z.literal(true),
    productionAndOtherRigMutationAuthorized: z.literal(false),
  }).passthrough(),
  assertions: z.object({
    invalidReceiptPreserved: z.literal(true),
    noHealthyClockClaimed: z.literal(true),
    noSupervisorProcessRunning: z.literal(true),
    noHeartbeatOrJournalClaimed: z.literal(true),
    allSixJobsPaused: z.literal(true),
    invocationLeaseRemoved: z.literal(true),
    noSecretValuesIncluded: z.literal(true),
  }).strict(),
  verdict: z.literal('INVALID_START_CONTAINED_NO_HEALTHY_CLOCK'),
}).passthrough();

function digest(raw: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

export function calculateB1TreasuryContinuityRelevantFilesSha256(
  files: readonly Readonly<{ path: string; raw: Uint8Array }>[],
): string {
  const expectedPaths = [...B1_TREASURY_CONTINUITY_CONTROLLER_FILES];
  const observedPaths = files.map(({ path }) => path);
  if (!isDeepStrictEqual(observedPaths, expectedPaths)) {
    throw new Error('RIG-B1 controller relevant-file set or order differs from the frozen contract.');
  }
  return digest(JSON.stringify(files.map(({ path, raw }) => ({
    path,
    sha256: digest(raw),
  }))));
}

function parse<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  return schema.parse(parseJsonRejectingDuplicateKeys(raw, label));
}

function assertLocked(
  object: B1LockedContinuityObject | undefined,
  expected: Readonly<{ uri: string; generation: string; sha256: string }>,
  retainThrough: string,
  label: string,
): asserts object is B1LockedContinuityObject {
  if (object === undefined
    || object.uri !== expected.uri
    || object.generation !== expected.generation
    || digest(object.raw) !== expected.sha256
    || !Number.isFinite(Date.parse(object.retainUntilTime))
    || Date.parse(object.retainUntilTime) < Date.parse(retainThrough)) {
    throw new Error(`RIG-B1 ${label} locked reference, digest, generation, or retention differs.`);
  }
}

function normalizedAdmissionDigest(raw: string): string {
  const parsed = parseJsonRejectingDuplicateKeys(raw, 'RIG-B1 refreshed continuity admission') as Record<string, unknown>;
  const cloned = structuredClone(parsed) as {
    treasury_continuity?: { compositeIdentitySha256?: string };
  };
  if (cloned.treasury_continuity === undefined) {
    throw new Error('RIG-B1 refreshed admission is missing the treasury-continuity composition.');
  }
  cloned.treasury_continuity.compositeIdentitySha256 = ZERO_DIGEST;
  return digest(JSON.stringify(cloned));
}

function inspectComposition(input: B1TreasuryContinuityCompositionInput): Readonly<{
  admission: z.infer<typeof admissionProjectionSchema>;
  amendmentExpiresAt: string;
  normalizedAdmissionSha256: string;
  compositeIdentitySha256: string;
}> {
  const rawAdmission = parseJsonRejectingDuplicateKeys(
    input.refreshedAdmissionRaw,
    'RIG-B1 refreshed continuity admission',
  ) as Record<string, unknown>;
  const admission = admissionProjectionSchema.parse(rawAdmission);
  const continuity = admission.treasury_continuity;
  if (rawAdmission.infrastructure === null
    || typeof rawAdmission.infrastructure !== 'object'
    || Array.isArray(rawAdmission.infrastructure)
    || digest(JSON.stringify(rawAdmission.infrastructure))
      !== B1_TREASURY_CONTINUITY_CONTRACT.originalInfrastructureSha256) {
    throw new Error('RIG-B1 refreshed admission full original infrastructure digest differs.');
  }

  const envelope = parse(envelopeSchema, input.amendment?.raw ?? '', 'RIG-B1 treasury-continuity amendment');
  if (digest(input.amendment.raw) !== B1_TREASURY_CONTINUITY_CONTRACT.amendmentEnvelopeSha256
    || digest(envelope.signedPayloadRaw) !== B1_TREASURY_CONTINUITY_CONTRACT.amendmentSignedPayloadSha256
    || envelope.envelopeId !== JSON.parse(envelope.signedPayloadRaw).amendmentId) {
    throw new Error('RIG-B1 treasury-continuity amendment digest or identity differs.');
  }
  const publicKey = createPublicKey(PUBLIC_KEY_PEM);
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  if (publicKey.asymmetricKeyType !== 'ed25519'
    || fingerprint !== B1_TREASURY_CONTINUITY_CONTRACT.keyFingerprint
    || !verifySignature(
      null,
      Buffer.from(`${DOMAIN}${envelope.signedPayloadRaw}`),
      publicKey,
      Buffer.from(envelope.signature, 'base64'),
    )) {
    throw new Error('RIG-B1 treasury-continuity amendment signature or trust root is invalid.');
  }
  const payload = parse(
    amendmentPayloadSchema,
    envelope.signedPayloadRaw,
    'RIG-B1 treasury-continuity signed payload',
  );
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!(input.verificationTime instanceof Date)) {
    throw new Error('RIG-B1 treasury-continuity verification time is invalid.');
  }
  const verificationTime = input.verificationTime.getTime();
  if (!Number.isFinite(verificationTime)
    || issuedAt >= expiresAt
    || verificationTime < issuedAt
    || verificationTime >= expiresAt) {
    throw new Error(
      'RIG-B1 treasury-continuity amendment chronology is invalid, not yet valid, or expired.',
    );
  }

  assertLocked(input.amendment, {
    uri: continuity.amendment.objectUri,
    generation: continuity.amendment.generation,
    sha256: continuity.amendment.envelopeSha256,
  }, payload.expiresAt, 'treasury-continuity amendment');
  assertLocked(input.originalClaim, {
    uri: B1_TREASURY_CONTINUITY_CONTRACT.originalClaimUri,
    generation: B1_TREASURY_CONTINUITY_CONTRACT.originalClaimGeneration,
    sha256: B1_TREASURY_CONTINUITY_CONTRACT.originalClaimSha256,
  }, payload.expiresAt, 'original provision claim');
  assertLocked(input.originalTopology, {
    uri: B1_TREASURY_CONTINUITY_CONTRACT.originalTopologyUri,
    generation: B1_TREASURY_CONTINUITY_CONTRACT.originalTopologyGeneration,
    sha256: B1_TREASURY_CONTINUITY_CONTRACT.originalTopologySha256,
  }, payload.expiresAt, 'original topology');

  const historical = payload.historicalProbe;
  assertLocked(input.historicalPreparationIntent, {
    uri: historical.preparationIntent.objectUri,
    generation: historical.preparationIntent.generation,
    sha256: historical.preparationIntent.sha256,
  }, payload.expiresAt, 'historical PREPARE intent');
  assertLocked(input.historicalPreparationOutcome, {
    uri: historical.preparationOutcome.objectUri,
    generation: historical.preparationOutcome.generation,
    sha256: historical.preparationOutcome.sha256,
  }, payload.expiresAt, 'historical PREPARE outcome');
  assertLocked(input.failedStartContainment, {
    uri: historical.failedStartContainment.objectUri,
    generation: historical.failedStartContainment.generation,
    sha256: historical.failedStartContainment.sha256,
  }, payload.expiresAt, 'failed START containment');

  const historicalIntent = parse(
    historicalPreparationIntentSchema,
    input.historicalPreparationIntent.raw,
    'RIG-B1 historical PREPARE intent',
  );
  const historicalOutcome = parse(
    historicalPreparationOutcomeSchema,
    input.historicalPreparationOutcome.raw,
    'RIG-B1 historical PREPARE outcome',
  );
  const historicalPreclock = parse(
    historicalPreclockSchema,
    historicalOutcome.preclockArtifactRaw,
    'RIG-B1 historical pre-clock artifact',
  );
  const containmentEnvelope = parse(
    envelopeSchema,
    input.failedStartContainment.raw,
    'RIG-B1 failed START containment',
  );
  if (!verifySignature(
    null,
    Buffer.from(`${FAILED_START_CONTAINMENT_DOMAIN}${containmentEnvelope.signedPayloadRaw}`),
    publicKey,
    Buffer.from(containmentEnvelope.signature, 'base64'),
  )) {
    throw new Error('RIG-B1 failed START containment signature is invalid.');
  }
  const containment = parse(
    failedStartContainmentPayloadSchema,
    containmentEnvelope.signedPayloadRaw,
    'RIG-B1 failed START containment signed payload',
  );
  if (containmentEnvelope.envelopeId !== containment.containmentId
    || historicalIntent.preparationId !== historical.preparationId
    || historicalIntent.sourceHeadSha !== historical.candidateHeadSha
    || historicalOutcome.preparationId !== historical.preparationId
    || historicalOutcome.intentSha256 !== digest(input.historicalPreparationIntent.raw)
    || historicalOutcome.admissionSha256 !== historicalIntent.admissionSha256
    || historicalOutcome.treasuryPlanSha256 !== historicalIntent.treasuryPlanSha256
    || historicalOutcome.idempotencyKey !== historicalIntent.idempotencyKey
    || historicalOutcome.fundedProbe.txId !== historical.fundedTransaction.txId
    || historicalOutcome.fundedProbe.observedAt !== historical.fundedTransaction.acceptedAt
    || historicalOutcome.preclockArtifactSha256 !== historical.preclockArtifactSha256
    || digest(historicalOutcome.preclockArtifactRaw) !== historical.preclockArtifactSha256
    || historicalPreclock.admissionSha256 !== historicalIntent.admissionSha256
    || historicalPreclock.sourceHeadSha !== historical.candidateHeadSha
    || historicalPreclock.sourceEvidence.readinessObservation.fundedBroadcast.txId
      !== historical.fundedTransaction.txId
    || historicalPreclock.sourceEvidence.readinessObservation.fundedBroadcast.observedAt
      !== historical.fundedTransaction.acceptedAt
    || historicalPreclock.sourceEvidence.readinessObservation.mempoolCorroboration.txId
      !== historical.fundedTransaction.txId
    || containment.failedStart.candidate.sourceHeadSha !== historical.candidateHeadSha
    || Date.parse(historicalIntent.createdAt) > Date.parse(historical.fundedTransaction.acceptedAt)
    || Date.parse(historical.fundedTransaction.acceptedAt) > Date.parse(historicalOutcome.completedAt)
    || Date.parse(historicalOutcome.completedAt) > Date.parse(containment.failedStart.countedReceiptStartedAt)
    || Date.parse(containment.failedStart.countedReceiptStartedAt)
      > Date.parse(containment.containment.observedAt)) {
    throw new Error(
      'RIG-B1 historical PREPARE/outcome/pre-clock/funded transaction/containment chain differs.',
    );
  }

  const claim = parse(claimSchema, input.originalClaim.raw, 'RIG-B1 original provision claim');
  const topology = parse(topologySchema, input.originalTopology.raw, 'RIG-B1 original topology');
  const expectedOriginal = {
    approvalId: continuity.originalProvision.approvalId,
    envelopeSha256: continuity.originalProvision.approvalEnvelopeSha256,
    signedPayloadSha256: continuity.originalProvision.signedPayloadSha256,
    sourceHeadSha: continuity.originalProvision.sourceHeadSha,
    sourceTreeSha: continuity.originalProvision.sourceTreeSha,
    corpusDigest: continuity.originalProvision.corpusDigest,
    releaseCandidateId: continuity.originalProvision.releaseCandidateId,
    soakId: continuity.originalProvision.soakId,
    leaseId: continuity.originalProvision.leaseId,
  };
  for (const [field, expected] of Object.entries(expectedOriginal)) {
    if (claim[field as keyof typeof claim] !== expected
      || topology[field as keyof typeof topology] !== expected) {
      throw new Error(`RIG-B1 original claim/topology ${field} binding differs.`);
    }
  }
  if (topology.approvalClaim.objectUri !== B1_TREASURY_CONTINUITY_CONTRACT.originalClaimUri
    || topology.approvalClaim.generation !== B1_TREASURY_CONTINUITY_CONTRACT.originalClaimGeneration
    || topology.nodeReadinessSha256 !== B1_TREASURY_CONTINUITY_CONTRACT.originalNodeReadinessSha256
    || topology.nodeReadiness.treasurySplitPlanDigest !== continuity.originalTreasury.planDigest
    || topology.nodeReadiness.confirmedOutputCount !== continuity.originalTreasury.confirmedOutputCount
    || topology.nodeReadiness.confirmedTotalSats !== continuity.originalTreasury.confirmedTotalSats) {
    throw new Error('RIG-B1 original topology treasury/readiness binding differs.');
  }

  const currentPlan = parse(z.object({
    inputs: z.array(z.object({ valueSats: z.number().int().positive() }).passthrough()).length(32),
    outputCount: z.literal(32),
  }).passthrough(), input.currentTreasuryPlanInputRaw, 'RIG-B1 current treasury plan input');
  const planned = planTreasuryPresplit(JSON.parse(input.currentTreasuryPlanInputRaw));
  const currentTotal = currentPlan.inputs.reduce((total, candidate) => total + candidate.valueSats, 0);
  if (digest(input.currentTreasuryPlanInputRaw) !== continuity.currentTreasury.planInputSha256
    || planned.planDigest !== continuity.currentTreasury.planDigest
    || currentTotal !== continuity.currentTreasury.confirmedTotalSats
    || continuity.currentTreasury.confirmedTotalSats
      - continuity.originalTreasury.confirmedTotalSats !== continuity.currentTreasury.deltaSats
    || continuity.currentTreasury.deltaSats !== -continuity.currentTreasury.fundedProbeFeeSats) {
    throw new Error('RIG-B1 treasury continuity plan, total, delta, or funded-probe fee differs.');
  }

  if (admission.sha !== continuity.originalProvision.sourceHeadSha
    || admission.image_digest !== B1_TREASURY_CONTINUITY_CONTRACT.originalImageDigest
    || admission.deployed_revision !== B1_TREASURY_CONTINUITY_CONTRACT.originalRevision
    || admission.soak_id !== continuity.originalProvision.soakId
    || admission.lease_id !== continuity.originalProvision.leaseId
    || admission.infrastructure.authority.approvalId !== continuity.originalProvision.approvalId
    || admission.infrastructure.authority.approvalEnvelopeSha256
      !== continuity.originalProvision.approvalEnvelopeSha256
    || admission.infrastructure.authority.signedPayloadSha256
      !== continuity.originalProvision.signedPayloadSha256
    || admission.infrastructure.authority.claim.objectUri !== continuity.originalProvision.claim.objectUri
    || admission.infrastructure.authority.claim.generation !== continuity.originalProvision.claim.generation
    || admission.infrastructure.nodeReadiness.treasurySplitPlanDigest !== continuity.originalTreasury.planDigest
    || admission.infrastructure.nodeReadiness.confirmedOutputCount
      !== continuity.originalTreasury.confirmedOutputCount
    || admission.infrastructure.nodeReadiness.confirmedTotalSats
      !== continuity.originalTreasury.confirmedTotalSats
    || admission.infrastructure.treasuryWatchOnly.preSplitPlanDigest !== continuity.originalTreasury.planDigest
    || admission.infrastructure.treasuryWatchOnly.expectedConfirmedOutputCount
      !== continuity.originalTreasury.confirmedOutputCount
    || admission.infrastructure.treasuryWatchOnly.expectedTotalSats
      !== continuity.originalTreasury.confirmedTotalSats) {
    throw new Error('RIG-B1 refreshed admission differs from the exact continuity composition.');
  }

  const normalizedAdmissionSha256 = normalizedAdmissionDigest(input.refreshedAdmissionRaw);
  const compositeIdentitySha256 = digest(JSON.stringify({
    schemaVersion: B1_TREASURY_CONTINUITY_CONTRACT.schemaVersion,
    normalizedAdmissionSha256,
    originalProvision: continuity.originalProvision,
    amendment: continuity.amendment,
    originalTreasury: continuity.originalTreasury,
    currentTreasury: continuity.currentTreasury,
    runtimeCandidate: {
      sourceHeadSha: B1_TREASURY_CONTINUITY_CONTRACT.originalHeadSha,
      sourceTreeSha: B1_TREASURY_CONTINUITY_CONTRACT.originalTreeSha,
      workerImageDigest: B1_TREASURY_CONTINUITY_CONTRACT.originalImageDigest,
      workerRevision: B1_TREASURY_CONTINUITY_CONTRACT.originalRevision,
    },
    controllerCandidate: continuity.controllerCandidate,
    amendmentSignedPayloadSha256: digest(envelope.signedPayloadRaw),
  }));
  return Object.freeze({ admission, amendmentExpiresAt: payload.expiresAt,
    normalizedAdmissionSha256, compositeIdentitySha256 });
}

export function calculateB1TreasuryContinuityCompositeIdentity(
  input: B1TreasuryContinuityCompositionInput,
): string {
  return inspectComposition(input).compositeIdentitySha256;
}

export function verifyB1TreasuryContinuityComposition(
  input: B1TreasuryContinuityCompositionInput,
): VerifiedB1TreasuryContinuityComposition {
  const inspected = inspectComposition(input);
  const continuity = inspected.admission.treasury_continuity;
  if (continuity.compositeIdentitySha256 !== inspected.compositeIdentitySha256) {
    throw new Error('RIG-B1 treasury-continuity composite identity differs from refreshed admission.');
  }
  const verified = Object.freeze({
    status: 'VERIFIED_B1_TREASURY_CONTINUITY' as const,
    compositeIdentitySha256: inspected.compositeIdentitySha256,
    normalizedAdmissionSha256: inspected.normalizedAdmissionSha256,
    originalConfirmedTotalSats: B1_TREASURY_CONTINUITY_CONTRACT.originalTotalSats,
    currentConfirmedTotalSats: B1_TREASURY_CONTINUITY_CONTRACT.currentTotalSats,
    deltaSats: B1_TREASURY_CONTINUITY_CONTRACT.deltaSats,
    controllerSourceHeadSha: continuity.controllerCandidate.sourceHeadSha,
    controllerSourceTreeSha: continuity.controllerCandidate.sourceTreeSha,
    controllerRelevantFilesSha256: continuity.controllerCandidate.relevantFilesSha256,
    amendmentExpiresAt: inspected.amendmentExpiresAt,
  });
  VERIFIED_COMPOSITIONS.add(verified);
  return verified;
}

function requireVerifiedComposition(
  verified: VerifiedB1TreasuryContinuityComposition,
): VerifiedB1TreasuryContinuityComposition {
  if (!VERIFIED_COMPOSITIONS.has(verified)) {
    throw new Error('RIG-B1 controller identity requires an opaque verified continuity composition.');
  }
  return verified;
}

export function verifyB1TreasuryContinuityControllerSnapshot(
  verifiedInput: VerifiedB1TreasuryContinuityComposition,
  snapshot: B1TreasuryContinuityControllerSnapshot,
): VerifiedB1TreasuryContinuityController {
  const verified = requireVerifiedComposition(verifiedInput);
  const trackedPaths = [...B1_TREASURY_CONTINUITY_CONTROLLER_FILES];
  if (snapshot.sourceHeadSha !== verified.controllerSourceHeadSha
    || snapshot.sourceTreeSha !== verified.controllerSourceTreeSha
    || snapshot.trackedWorktreeStatus !== ''
    || !isDeepStrictEqual(snapshot.trackedPaths, trackedPaths)
    || snapshot.relevantFiles.some(({ matchesHeadBlob }) => !matchesHeadBlob)) {
    throw new Error('RIG-B1 local controller HEAD, tree, tracked worktree, or committed file set differs.');
  }
  const relevantFilesSha256 = calculateB1TreasuryContinuityRelevantFilesSha256(
    snapshot.relevantFiles,
  );
  if (relevantFilesSha256 !== verified.controllerRelevantFilesSha256) {
    throw new Error('RIG-B1 local controller relevant-file byte digest differs.');
  }
  return Object.freeze({
    status: 'VERIFIED_B1_TREASURY_CONTINUITY_CONTROLLER' as const,
    sourceHeadSha: verified.controllerSourceHeadSha,
    sourceTreeSha: verified.controllerSourceTreeSha,
    relevantFilesSha256,
  });
}

function git(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(
            `RIG-B1 local controller Git inspection failed: ${stderr.trim() || error.message}`,
            { cause: error },
          ));
          return;
        }
        resolve(stdout.trimEnd());
      },
    );
  });
}

export async function verifyLocalB1TreasuryContinuityController(
  verified: VerifiedB1TreasuryContinuityComposition,
): Promise<VerifiedB1TreasuryContinuityController> {
  requireVerifiedComposition(verified);
  const [sourceHeadSha, sourceTreeSha, trackedWorktreeStatus, trackedPathsRaw] = await Promise.all([
    git(['rev-parse', '--verify', 'HEAD']),
    git(['rev-parse', '--verify', 'HEAD^{tree}']),
    git(['status', '--porcelain=v1', '--untracked-files=no']),
    git(['ls-files', '--error-unmatch', '--', ...B1_TREASURY_CONTINUITY_CONTROLLER_FILES]),
  ]);
  const relevantFiles = await Promise.all(B1_TREASURY_CONTINUITY_CONTROLLER_FILES.map(async (path) => {
    const [raw, headBlob, localBlob] = await Promise.all([
      readFile(path),
      git(['rev-parse', `HEAD:${path}`]),
      git(['hash-object', '--', path]),
    ]);
    return Object.freeze({ path, raw, matchesHeadBlob: headBlob === localBlob });
  }));
  return verifyB1TreasuryContinuityControllerSnapshot(verified, {
    sourceHeadSha,
    sourceTreeSha,
    trackedWorktreeStatus,
    trackedPaths: trackedPathsRaw.split('\n').filter((path) => path.length > 0),
    relevantFiles,
  });
}

export function projectB1TreasuryContinuity(raw: string): B1TreasuryContinuity | undefined {
  const parsed = parseJsonRejectingDuplicateKeys(raw, 'RIG-B1 admission continuity projection') as {
    treasury_continuity?: unknown;
  };
  if (parsed.treasury_continuity === undefined) return undefined;
  return Object.freeze(b1TreasuryContinuitySchema.parse(parsed.treasury_continuity));
}

export function sameB1TreasuryContinuity(
  left: B1TreasuryContinuity | undefined,
  right: B1TreasuryContinuity | undefined,
): boolean {
  return isDeepStrictEqual(left, right);
}
