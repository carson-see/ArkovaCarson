/**
 * Concrete authenticated observation path for the RIG-B1 start pre-clock.
 *
 * No operator-authored observation JSON is accepted. The adapter re-observes
 * the exact Cloud Run revision and all six PAUSED Scheduler jobs, queries the
 * fixed Bitcoin Core VM through gcloud SSH, proves the worker-only WIF with a
 * signed challenge, drives one bounded synthetic batch through the admitted
 * worker/project, and corroborates its tx plus the exact Core tip through
 * mempool.space Signet. Secret values remain process-memory-only.
 */

import { execFile } from 'node:child_process';
import {
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signDigest,
  timingSafeEqual,
  verify as verifyDigest,
} from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import {
  RIG_B1_REQUIRED_RPC_CAPABILITIES,
  buildRigB1ReadinessPlan,
  type RigB1PreClockObservation,
} from './batch-drain-chain-readiness';
import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import { rigB1SecretReferencesSchema } from './batch-drain-live-evidence';
import { planTreasuryPresplit, type TreasuryPresplitPlanInput } from './batch-drain-utxo-fanout';
import { resolveStagingApiBase } from './load-harness-env';
import {
  B1_SCHEDULER_START_CONTRACT,
  buildB1SchedulerStartPreclockArtifact,
  projectB1SchedulerStartAdmission,
  type B1LockedObject,
} from './s33-b1-scheduler-start-driver';
import {
  createProductionB1PreparationAuthorityVerifier,
  type B1PreparationAuthorityVerifier,
  type VerifiedB1PreparationAuthority,
} from './s33-b1-preparation-approval';
import {
  B1_GCLOUD_BINARY,
  b1CommandEnvironment,
  createB1SchedulerStartProductionAdapter,
} from './s33-b1-scheduler-start-production-adapter';
import {
  projectAdmissionV2ToPreClockIdentity,
  requirePreClockAdmissionIdentity,
} from './batch-drain-admission-adapter';
import {
  B1_TREASURY_CONTINUITY_CONTRACT,
  b1TreasuryContinuitySchema,
  projectB1TreasuryContinuity,
  verifyLocalB1TreasuryContinuityController,
  verifyB1TreasuryContinuityComposition,
  type VerifiedB1TreasuryContinuityComposition,
} from './s33-b1-treasury-continuity';
import {
  B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT,
  b1NoBroadcastPrepareRecoverySchema,
  createProductionB1NoBroadcastPrepareContainmentVerifier,
  type B1NoBroadcastPrepareRecovery,
  type VerifiedB1NoBroadcastPrepareContainment,
} from './s33-b1-no-broadcast-prepare-containment';

const VM = 'arkova-s33-rig-b1-bitcoin-core-signet';
const ZONE = 'us-central1-a';
const CONTAINER = 'arkova-rig-b1-bitcoin-core';
const MAX_BUFFER = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const TSX_CLI = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const HARNESS = join(process.cwd(), 'scripts/staging/batch-drain-harness.ts');
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export interface B1PreclockMutationAuthorization {
  readonly preparationId: string;
}

const PRECLOCK_AUTHORIZATIONS = new WeakMap<B1PreclockMutationAuthorization, Readonly<{
  admissionSha256: string;
  treasuryPlanSha256: string;
  authority: VerifiedB1PreparationAuthority;
  reverify: (now: Date) => VerifiedB1PreparationAuthority;
  confirmation: Readonly<{ provided: string; expected: string }>;
}>>();

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const numericVersion = z.string().regex(/^[1-9][0-9]*$/u);
const projectRef = z.string().regex(/^[a-z]{20}$/u);

const planInputSchema = z.object({
  planId: z.string().min(1),
  network: z.literal('signet'),
  treasuryAddress: z.string().regex(/^tb1[a-z0-9]{20,87}$/u),
  inputs: z.array(z.object({
    txId: sha256Hex,
    vout: z.number().int().nonnegative().safe(),
    valueSats: z.number().int().positive().safe(),
    confirmations: z.number().int().positive().safe(),
  }).strict()).min(1),
  outputCount: z.literal(32),
  feeSats: z.number().int().nonnegative().safe(),
  minOutputSats: z.number().int().positive().safe(),
}).strict();

const secretBindingSchema = z.object({
  secret: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,254}$/u),
  version: numericVersion,
}).strict();

const admissionSchema = z.object({
  sha: gitSha,
  image_digest: sha256,
  deployed_revision: z.string().min(1),
  tag_url: z.string().url(),
  supabase_project_ref: projectRef,
  cloud_run_service: z.literal(B1_SCHEDULER_START_CONTRACT.workerService),
  treasury_continuity: b1TreasuryContinuitySchema.optional(),
  no_broadcast_prepare_recovery: b1NoBroadcastPrepareRecoverySchema.optional(),
  infrastructure: z.object({
    authority: z.object({
      approvalId: z.string().min(1),
      approvalEnvelopeSha256: sha256,
      signedPayloadSha256: sha256,
      claim: z.object({
        objectUri: z.string().min(1),
        generation: numericVersion,
      }).passthrough(),
    }).passthrough(),
    nodeReadiness: z.object({
      blocks: z.number().int().nonnegative(),
      headers: z.number().int().nonnegative(),
      genesisHash: sha256Hex,
      txindexBestBlockHeight: z.number().int().nonnegative(),
      treasurySplitPlanDigest: sha256,
      splitTransactionId: sha256Hex,
      confirmedOutputCount: z.literal(32),
      confirmedTotalSats: z.number().int().positive().safe(),
    }).passthrough(),
    treasuryWatchOnly: z.object({
      address: z.string().regex(/^tb1[a-z0-9]{20,87}$/u),
      descriptor: z.string().min(1),
      splitTransactionId: sha256Hex,
      preSplitPlanDigest: sha256,
      expectedConfirmedOutputCount: z.literal(32),
      expectedTotalSats: z.number().int().positive().safe(),
    }).passthrough(),
    secretReferences: rigB1SecretReferencesSchema,
  }).passthrough(),
}).passthrough();

const provisionClaimSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.node-approval-claim/v1'),
  approvalId: z.string().min(1),
  envelopeSha256: sha256,
  signedPayloadSha256: sha256,
  sourceHeadSha: gitSha,
  sourceTreeSha: gitSha,
  corpusDigest: sha256,
  releaseCandidateId: z.string().min(1),
  soakId: z.string().min(1),
  leaseId: z.string().min(1),
}).passthrough();

const revisionSchema = z.object({
  sourceHeadSha: gitSha,
  imageDigest: sha256,
  runtimeServiceAccount: z.literal(B1_SCHEDULER_START_CONTRACT.workerRuntimeServiceAccount),
  serviceUrl: z.string().url(),
  fundedProbeUrl: z.string().url(),
  inProcessCronDisabled: z.literal(true),
  secrets: z.object({
    supabaseUrl: secretBindingSchema,
    supabaseServiceRole: secretBindingSchema,
    cron: secretBindingSchema,
    treasuryWif: secretBindingSchema,
  }).strict(),
}).strict();

export interface B1CoreLiveObservation {
  readonly chain: 'signet';
  readonly initialBlockDownload: false;
  readonly headers: number;
  readonly blocks: number;
  readonly bestBlockHash: string;
  readonly genesisHash: string;
  readonly txindexSynced: true;
  readonly txindexBestBlockHeight: number;
  readonly privateKeysEnabled: false;
  readonly descriptors: true;
  readonly descriptorImported: true;
  readonly rescanComplete: true;
  readonly confirmedUtxos: number;
  readonly confirmedTotalSats: number;
  readonly confirmedOutputs: readonly Readonly<{
    txId: string;
    vout: number;
    valueSats: number;
    confirmations: number;
  }>[];
  readonly unconfirmedUtxos: number;
  readonly minconfZeroMatchesMinconfOne: boolean;
  readonly confirmedOutpointValueExportSha256: string;
  readonly minimumConfirmations: number;
  readonly splitTransactionObserved: string;
  readonly capabilities: Readonly<Record<typeof RIG_B1_REQUIRED_RPC_CAPABILITIES[number], boolean>>;
  readonly observedAt: string;
}

export interface B1SignerChallengeObservation {
  readonly treasuryAddress: string;
  readonly signatureSha256: string;
  readonly verified: true;
  readonly observedAt: string;
}

export interface B1FundedProbeObservation {
  readonly txId: string;
  readonly evidenceSha256: string;
  readonly observedAt: string;
}

export interface B1MempoolObservation {
  readonly txId: string;
  readonly tipHeight: number;
  readonly tipHash: string;
  readonly spentOutpoints: readonly Readonly<{ txId: string; vout: number; address: string }>[];
  readonly observedAt: string;
}

export interface B1PreclockCollectorPort {
  now(): Date;
  verifyControllerIdentity?(
    verified: VerifiedB1TreasuryContinuityComposition,
  ): Promise<unknown>;
  verifyNoBroadcastPrepareContainment?(input: Readonly<{
    recovery: B1NoBroadcastPrepareRecovery;
    containment: B1LockedObject;
    intent: B1LockedObject;
    verificationTime: Date;
  }>): VerifiedB1NoBroadcastPrepareContainment;
  observeInvocationLeaseAbsent?(preparationId: string): Promise<boolean>;
  hasLockedObject(uri: string): Promise<boolean>;
  readLockedObject(uri: string, generation?: string): Promise<B1LockedObject>;
  persistLockedObject(uri: string, raw: string, retainUntilTime: string): Promise<void>;
  installInvocationLease(input: Readonly<{
    preparationId: string;
    expiresAt: string;
    authorityExpiresAt: string;
  }>): Promise<void>;
  removeInvocationLease(preparationId: string): Promise<void>;
  observeRevision(admission: z.infer<typeof admissionSchema>): Promise<z.infer<typeof revisionSchema>>;
  observeSchedulerJobs(): Promise<readonly {
    name: string;
    path: string;
    cadence: string;
    state: 'PAUSED' | 'ENABLED';
    observedAt: string;
  }[]>;
  observeCore(input: Readonly<{
    treasuryAddress: string;
    treasuryDescriptor: string;
    splitTransactionId: string;
  }>): Promise<B1CoreLiveObservation>;
  proveSigner(input: Readonly<{
    secret: { secretName: string; version: string };
    challengeSha256: string;
  }>): Promise<B1SignerChallengeObservation>;
  runFundedProbe(input: Readonly<{
    admission: z.infer<typeof admissionSchema>;
    revision: z.infer<typeof revisionSchema>;
    preparationId: string;
    idempotencyKey: string;
    maxFundedBroadcasts: 1;
  }>): Promise<B1FundedProbeObservation>;
  observeMempool(input: Readonly<{
    txId: string;
    coreTipHash: string;
    treasuryAddress: string;
    splitTransactionId: string;
  }>): Promise<B1MempoolObservation>;
}

function strict<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  const parsed = schema.safeParse(parseJsonRejectingDuplicateKeys(raw, label));
  if (!parsed.success) throw new Error(`${label} failed strict validation.`);
  return parsed.data;
}

function totalPlanSats(input: TreasuryPresplitPlanInput): number {
  return input.inputs.reduce((sum, candidate) => sum + candidate.valueSats, 0) - input.feeSats;
}

function rawDigest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

export function b1ConfirmedOutpointValueExportSha256(outputs: readonly Readonly<{
  txId: string;
  vout: number;
  valueSats: number;
}>[]): string {
  const sorted = outputs.map(({ txId, vout, valueSats }) => ({ txId, vout, valueSats }))
    .sort((left, right) => left.txId.localeCompare(right.txId) || left.vout - right.vout);
  return rawDigest(`${JSON.stringify(sorted)}\n`);
}

export function b1PreparationFundedProbeRunId(input: Readonly<{
  preparationId: string;
  idempotencyKey: string;
}>): string {
  const preparationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u)
    .parse(input.preparationId);
  const idempotencyKey = sha256.parse(input.idempotencyKey);
  return `b1-preclock-${createHash('sha256')
    .update(`${preparationId}:${idempotencyKey}`)
    .digest('hex').slice(0, 32)}`;
}

export function projectB1FundedProbeRouting(input: Readonly<{
  serviceUrl: string;
  fundedProbeUrl: string;
}>): Readonly<{ identityAudience: string; apiBase: string }> {
  const identityAudience = z.string().url().parse(input.serviceUrl);
  const apiBase = resolveStagingApiBase({ STAGING_API_BASE: input.fundedProbeUrl });
  if (identityAudience === apiBase) {
    throw new Error('RIG-B1 funded probe must separate canonical OIDC audience from tagged API routing.');
  }
  return Object.freeze({ identityAudience, apiBase });
}

const preparationIntentSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.preparation-intent/v1'),
  status: z.literal('PREPARE_INTENT_LOCKED'),
  preparationId: z.string().min(1),
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
  releaseCandidateId: z.string().min(1),
  soakId: z.string().min(1),
  leaseId: z.string().min(1),
  idempotencyKey: sha256,
  maxFundedBroadcasts: z.literal(1),
  invocationLeaseMaxSeconds: z.literal(600),
  createdAt: z.string().datetime({ offset: true }),
  authorityExpiresAt: z.string().datetime({ offset: true }),
  continuityCompositeIdentitySha256: sha256.optional(),
  controllerSourceHeadSha: gitSha.optional(),
  controllerSourceTreeSha: gitSha.optional(),
  controllerRelevantFilesSha256: sha256.optional(),
}).strict();

const preparationOutcomeSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.preparation-outcome/v1'),
  status: z.literal('PRE_CLOCK_READY'),
  preparationId: z.string().min(1),
  intentSha256: sha256,
  admissionSha256: sha256,
  treasuryPlanSha256: sha256,
  idempotencyKey: sha256,
  fundedProbe: z.object({
    txId: sha256Hex,
    evidenceSha256: sha256,
    observedAt: z.string().datetime({ offset: true }),
  }).strict(),
  preclockArtifactSha256: sha256,
  preclockArtifactRaw: z.string().min(1).max(4 * 1024 * 1024),
  completedAt: z.string().datetime({ offset: true }),
  continuityCompositeIdentitySha256: sha256.optional(),
}).strict();

const replayedPreclockSchema = z.object({
  schemaVersion: z.literal('arkova.s33.rig-b1.scheduler-start-preclock/v1'),
  status: z.literal('PRE_CLOCK_READY'),
  admissionSha256: sha256,
  sourceHeadSha: gitSha,
  workerImageDigest: sha256,
  schedulerJobsPaused: z.literal(6),
  schedulerCadence: z.literal(B1_SCHEDULER_START_CONTRACT.cadence),
  continuityCompositeIdentitySha256: sha256.optional(),
}).passthrough();

const PREPARATION_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60_000;

function preparationObjectUris(preparationId: string): Readonly<{ intent: string; outcome: string }> {
  return Object.freeze({
    intent: `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/preparation-intents/${preparationId}.json`,
    outcome: `${B1_SCHEDULER_START_CONTRACT.ledgerBaseUri}/preparation-outcomes/${preparationId}.json`,
  });
}

function assertLockedReadback(
  object: B1LockedObject,
  expectedUri: string,
  expectedRaw: string,
  retainUntilTime: string,
): void {
  const observedRetention = Date.parse(object.retainUntilTime);
  const expectedRetention = Date.parse(retainUntilTime);
  if (object.uri !== expectedUri
    || !/^[1-9][0-9]*$/u.test(object.generation)
    || object.raw !== expectedRaw
    || !Number.isFinite(observedRetention)
    || !Number.isFinite(expectedRetention)
    || observedRetention < expectedRetention) {
    throw new Error('RIG-B1 PREPARE object is not an exact generation-zero Locked readback.');
  }
}

function assertSamePreparationAuthority(
  initial: VerifiedB1PreparationAuthority,
  current: VerifiedB1PreparationAuthority,
): void {
  if (JSON.stringify(current) !== JSON.stringify(initial)) {
    throw new Error('RIG-B1 PREPARE authority changed during pre-clock observation.');
  }
}

function assertPreparationIntentBindings(
  intent: z.infer<typeof preparationIntentSchema>,
  authority: VerifiedB1PreparationAuthority,
  admissionSha256: string,
  treasuryPlanSha256: string,
): void {
  const expectedIdempotencyKey = rawDigest(JSON.stringify({
    purpose: 'PREPARE_B1',
    preparationId: authority.preparationId,
    admissionSha256,
    treasuryPlanSha256,
  }));
  if (intent.preparationId !== authority.preparationId
    || intent.authorityEnvelopeSha256 !== authority.envelopeSha256
    || intent.authoritySignedPayloadSha256 !== authority.signedPayloadSha256
    || intent.provisionApprovalEnvelopeSha256 !== authority.provisionApprovalEnvelopeSha256
    || intent.provisionSignedPayloadSha256 !== authority.provisionSignedPayloadSha256
    || intent.admissionSha256 !== admissionSha256
    || intent.treasuryPlanSha256 !== treasuryPlanSha256
    || intent.sourceHeadSha !== authority.sourceHeadSha
    || intent.sourceTreeSha !== authority.sourceTreeSha
    || intent.workerImageDigest !== authority.workerImageDigest
    || intent.corpusDigest !== authority.corpusDigest
    || intent.releaseCandidateId !== authority.releaseCandidateId
    || intent.soakId !== authority.soakId
    || intent.leaseId !== authority.leaseId
    || intent.idempotencyKey !== expectedIdempotencyKey
    || intent.maxFundedBroadcasts !== authority.maxFundedBroadcasts
    || intent.invocationLeaseMaxSeconds !== authority.invocationLeaseMaxSeconds
    || intent.authorityExpiresAt !== authority.expiresAt
    || intent.continuityCompositeIdentitySha256
      !== authority.continuityCompositeIdentitySha256
    || intent.controllerSourceHeadSha !== authority.controllerSourceHeadSha
    || intent.controllerSourceTreeSha !== authority.controllerSourceTreeSha
    || intent.controllerRelevantFilesSha256 !== authority.controllerRelevantFilesSha256) {
    throw new Error('RIG-B1 immutable PREPARE intent differs from the complete signed authority bindings.');
  }
}

export function expectedB1PreclockPreparationConfirmation(input: Readonly<{
  preparationId: string;
  soakId: string;
  leaseId: string;
  admissionSha256: string;
  treasuryPlanSha256: string;
}>): string {
  return `PREPARE_B1:${input.preparationId}:${input.soakId}:${input.leaseId}:${input.admissionSha256}:${input.treasuryPlanSha256}`;
}

function authorizeFromVerifiedPreparation(
  admissionRaw: string,
  treasuryPlanInputRaw: string,
  verified: VerifiedB1PreparationAuthority,
  confirmation: string,
  reverify: (now: Date) => VerifiedB1PreparationAuthority,
): B1PreclockMutationAuthorization {
  const admission = projectB1SchedulerStartAdmission(admissionRaw);
  const collectorAdmission = strict(admissionSchema, admissionRaw, 'RIG-B1 PREPARE admission');
  const continuity = projectB1TreasuryContinuity(admissionRaw);
  const admissionSha256 = rawDigest(admissionRaw);
  const treasuryPlanSha256 = rawDigest(treasuryPlanInputRaw);
  const expected = expectedB1PreclockPreparationConfirmation({
    preparationId: verified.preparationId,
    soakId: verified.soakId,
    leaseId: verified.leaseId,
    admissionSha256,
    treasuryPlanSha256,
  });
  if (confirmation !== expected) {
    throw new Error(`RIG-B1 funded pre-clock requires exact CTO preparation confirmation ${expected}.`);
  }
  if (verified.admissionSha256 !== admissionSha256
    || verified.treasuryPlanSha256 !== treasuryPlanSha256
    || verified.sourceHeadSha !== admission.sourceHeadSha
    || verified.workerImageDigest !== admission.workerImageDigest
    || verified.rigName !== admission.rigName
    || verified.soakId !== admission.soakId
    || verified.leaseId !== admission.leaseId
    || verified.workerService !== B1_SCHEDULER_START_CONTRACT.workerService
    || verified.schedulerOidcServiceAccount !== B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount
    || verified.provisionApprovalEnvelopeSha256 !== admission.approvalEnvelopeSha256
    || verified.provisionSignedPayloadSha256 !== admission.signedPayloadSha256
    || (continuity === undefined
      ? verified.continuityCompositeIdentitySha256 !== undefined
        || verified.controllerSourceHeadSha !== undefined
        || verified.controllerSourceTreeSha !== undefined
        || verified.controllerRelevantFilesSha256 !== undefined
      : verified.continuityCompositeIdentitySha256 !== continuity.compositeIdentitySha256
        || verified.controllerSourceHeadSha !== continuity.controllerCandidate.sourceHeadSha
        || verified.controllerSourceTreeSha !== continuity.controllerCandidate.sourceTreeSha
        || verified.controllerRelevantFilesSha256
          !== continuity.controllerCandidate.relevantFilesSha256)
    || JSON.stringify(verified.noBroadcastPrepareRecovery)
      !== JSON.stringify(collectorAdmission.no_broadcast_prepare_recovery)) {
    throw new Error('RIG-B1 signed PREPARE authority does not bind the exact admission/plan/provision authority.');
  }
  const handle = Object.freeze<B1PreclockMutationAuthorization>({ preparationId: verified.preparationId });
  PRECLOCK_AUTHORIZATIONS.set(handle, Object.freeze({
    admissionSha256,
    treasuryPlanSha256,
    authority: verified,
    reverify,
    confirmation: Object.freeze({ provided: confirmation, expected }),
  }));
  return handle;
}

export function authorizeB1PreclockMutation(
  admissionRaw: string,
  treasuryPlanInputRaw: string,
  preparationAuthorityRaw: string,
  ctoPreparationConfirmation: string,
  now = new Date(),
): B1PreclockMutationAuthorization {
  const verifier = createProductionB1PreparationAuthorityVerifier();
  return authorizeFromVerifiedPreparation(
    admissionRaw,
    treasuryPlanInputRaw,
    verifier.verify(preparationAuthorityRaw, now),
    ctoPreparationConfirmation,
    (observedNow) => verifier.verify(preparationAuthorityRaw, observedNow),
  );
}

/** Test-only signed authority verifier seam. */
export function authorizeB1PreclockMutationWithVerifierForTest(
  admissionRaw: string,
  treasuryPlanInputRaw: string,
  preparationAuthorityRaw: string,
  ctoPreparationConfirmation: string,
  verifier: B1PreparationAuthorityVerifier,
  now: Date,
): B1PreclockMutationAuthorization {
  if (process.env.NODE_ENV !== 'test') throw new Error('Injected B1 PREPARE verifier is test-only.');
  return authorizeFromVerifiedPreparation(
    admissionRaw,
    treasuryPlanInputRaw,
    verifier.verify(preparationAuthorityRaw, now),
    ctoPreparationConfirmation,
    (observedNow) => verifier.verify(preparationAuthorityRaw, observedNow),
  );
}

/** Test-only provenance handle for collector unit tests; production verifies Ed25519. */
export function authorizeB1PreclockMutationForTest(
  admissionRaw: string,
  treasuryPlanInputRaw: string,
  overrides: Partial<VerifiedB1PreparationAuthority> = {},
): B1PreclockMutationAuthorization {
  if (process.env.NODE_ENV !== 'test') throw new Error('Injected B1 pre-clock authorization is test-only.');
  const admission = projectB1SchedulerStartAdmission(admissionRaw);
  const collectorAdmission = strict(admissionSchema, admissionRaw, 'RIG-B1 test PREPARE admission');
  const continuity = projectB1TreasuryContinuity(admissionRaw);
  const authority = Object.freeze<VerifiedB1PreparationAuthority>({
    status: 'VERIFIED',
    verifierIdentity: B1_SCHEDULER_START_CONTRACT.verifierIdentity,
    envelopeSha256: `sha256:${'1'.repeat(64)}`,
    signedPayloadSha256: `sha256:${'2'.repeat(64)}`,
    envelopeId: 'test-only-preclock',
    preparationId: 'test-only-preclock',
    admissionSha256: rawDigest(admissionRaw),
    treasuryPlanSha256: rawDigest(treasuryPlanInputRaw),
    sourceHeadSha: admission.sourceHeadSha,
    sourceTreeSha: 'c'.repeat(40),
    workerImageDigest: admission.workerImageDigest,
    corpusDigest: `sha256:${'d'.repeat(64)}`,
    releaseCandidateId: 's33-test-rc',
    provisionApprovalEnvelopeSha256: admission.approvalEnvelopeSha256,
    provisionSignedPayloadSha256: admission.signedPayloadSha256,
    rigName: admission.rigName,
    soakId: admission.soakId,
    leaseId: admission.leaseId,
    workerService: B1_SCHEDULER_START_CONTRACT.workerService,
    schedulerOidcServiceAccount: B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount,
    maxFundedBroadcasts: 1,
    invocationLeaseMaxSeconds: 600,
    issuedAt: '2026-07-16T19:50:00.000Z',
    expiresAt: '2026-07-16T20:00:00.000Z',
    ...(continuity === undefined ? {} : {
      continuityCompositeIdentitySha256: continuity.compositeIdentitySha256,
      controllerSourceHeadSha: continuity.controllerCandidate.sourceHeadSha,
      controllerSourceTreeSha: continuity.controllerCandidate.sourceTreeSha,
      controllerRelevantFilesSha256: continuity.controllerCandidate.relevantFilesSha256,
    }),
    ...(collectorAdmission.no_broadcast_prepare_recovery === undefined ? {} : {
      noBroadcastPrepareRecovery: collectorAdmission.no_broadcast_prepare_recovery,
    }),
    ...overrides,
  });
  const handle = Object.freeze<B1PreclockMutationAuthorization>({
    preparationId: authority.preparationId,
  });
  PRECLOCK_AUTHORIZATIONS.set(handle, Object.freeze({
    admissionSha256: rawDigest(admissionRaw),
    treasuryPlanSha256: rawDigest(treasuryPlanInputRaw),
    authority,
    reverify: (now) => {
      if (now.getTime() >= Date.parse(authority.expiresAt)) {
        throw new Error('RIG-B1 PREPARE authority expired before the funded mutation.');
      }
      return authority;
    },
    confirmation: Object.freeze({ provided: 'test-only', expected: 'test-only' }),
  }));
  return handle;
}

function decodeBase58(value: string): Buffer {
  if (value.length < 1 || value.length > 128) throw new Error('RIG-B1 WIF is not bounded Base58Check.');
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('RIG-B1 WIF contains a non-Base58 character.');
    decoded = decoded * 58n + BigInt(digit);
  }
  let hex = decoded.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const body = decoded === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  const leadingZeros = value.match(/^1*/u)?.[0].length ?? 0;
  return Buffer.concat([Buffer.alloc(leadingZeros), body]);
}

function decodeSignetWif(value: string): Buffer {
  const decoded = decodeBase58(value);
  if (decoded.length !== 38) throw new Error('RIG-B1 WIF must be one compressed Signet private key.');
  const payload = decoded.subarray(0, 34);
  const checksum = decoded.subarray(34);
  const expected = createHash('sha256').update(
    createHash('sha256').update(payload).digest(),
  ).digest().subarray(0, 4);
  if (!timingSafeEqual(checksum, expected) || payload[0] !== 0xef || payload[33] !== 0x01) {
    throw new Error('RIG-B1 WIF has an invalid Signet version, compression marker, or checksum.');
  }
  const privateKey = Buffer.from(payload.subarray(1, 33));
  if (privateKey.every((byte) => byte === 0)) throw new Error('RIG-B1 WIF contains an invalid private key.');
  return privateKey;
}

function bech32Polymod(values: readonly number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    generators.forEach((generator, index) => {
      if (((top >>> index) & 1) === 1) checksum ^= generator!;
    });
  }
  return checksum >>> 0;
}

function convertBits(bytes: Uint8Array): number[] {
  const result: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result.push((accumulator >>> bits) & 31);
    }
  }
  if (bits > 0) result.push((accumulator << (5 - bits)) & 31);
  return result;
}

function signetP2wpkhAddress(compressedPublicKey: Buffer): string {
  const program = createHash('ripemd160').update(
    createHash('sha256').update(compressedPublicKey).digest(),
  ).digest();
  const hrp = 'tb';
  const words = [0, ...convertBits(program)];
  const expanded = [3, 3, 0, ...hrp.split('').map((character) => character.charCodeAt(0) & 31)];
  const polymod = bech32Polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, index) => (polymod >>> (5 * (5 - index))) & 31);
  return `${hrp}1${[...words, ...checksum].map((word) => BECH32_ALPHABET[word]).join('')}`;
}

/** Root-runtime-only WIF challenge; never imports the worker package tree. */
export function proveB1WifChallenge(
  wif: string,
  challengeSha256: string,
): Readonly<{ treasuryAddress: string; signatureSha256: string; verified: true }> {
  const privateBytes = decodeSignetWif(wif);
  const challenge = Buffer.from(sha256Hex.parse(challengeSha256), 'hex');
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(privateBytes);
  const compressedPublicKey = ecdh.getPublicKey(undefined, 'compressed');
  const sec1Der = Buffer.concat([
    Buffer.from('302e0201010420', 'hex'),
    privateBytes,
    Buffer.from('a00706052b8104000a', 'hex'),
  ]);
  const key = createPrivateKey({ key: sec1Der, format: 'der', type: 'sec1' });
  const verifier = createPublicKey({
    key: key.export({ format: 'pem', type: 'sec1' }),
    format: 'pem',
  });
  const signature = signDigest('sha256', challenge, { key, dsaEncoding: 'ieee-p1363' });
  if (!verifyDigest('sha256', challenge, { key: verifier, dsaEncoding: 'ieee-p1363' }, signature)) {
    throw new Error('RIG-B1 secp256k1 challenge signature verification failed.');
  }
  return {
    treasuryAddress: signetP2wpkhAddress(compressedPublicKey),
    signatureSha256: createHash('sha256').update(signature).digest('hex'),
    verified: true,
  };
}

function assertCollectorBindings(
  admission: z.infer<typeof admissionSchema>,
  revision: z.infer<typeof revisionSchema>,
  input: TreasuryPresplitPlanInput,
): void {
  const treasury = admission.infrastructure.treasuryWatchOnly;
  const readiness = admission.infrastructure.nodeReadiness;
  const continuity = admission.treasury_continuity;
  const effectivePlanDigest = continuity?.currentTreasury.planDigest ?? treasury.preSplitPlanDigest;
  const effectiveTotalSats = continuity?.currentTreasury.confirmedTotalSats
    ?? treasury.expectedTotalSats;
  const effectiveOutputCount = continuity?.currentTreasury.confirmedOutputCount
    ?? treasury.expectedConfirmedOutputCount;
  const wif = admission.infrastructure.secretReferences.find(({ env }) => env === 'BITCOIN_TREASURY_WIF');
  if (revision.sourceHeadSha !== admission.sha
    || revision.imageDigest !== admission.image_digest
    || revision.serviceUrl !== admission.tag_url
    || (admission.no_broadcast_prepare_recovery !== undefined
      && revision.fundedProbeUrl
        !== B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.taggedServiceUrl)
    || !revision.inProcessCronDisabled) {
    throw new Error('RIG-B1 live Cloud Run revision differs from admission or leaves in-process cron enabled.');
  }
  if (wif === undefined || revision.secrets.treasuryWif.secret !== wif.secretName
    || revision.secrets.treasuryWif.version !== wif.version) {
    throw new Error('RIG-B1 live worker WIF binding differs from signed admission.');
  }
  const plan = planTreasuryPresplit(input);
  if (plan.planDigest !== effectivePlanDigest
    || input.treasuryAddress !== treasury.address
    || totalPlanSats(input) !== effectiveTotalSats
    || input.outputCount !== effectiveOutputCount
    || (continuity === undefined
      && (plan.planDigest !== readiness.treasurySplitPlanDigest
        || readiness.confirmedTotalSats !== treasury.expectedTotalSats))
    || readiness.splitTransactionId !== treasury.splitTransactionId) {
    throw new Error('RIG-B1 treasury plan differs from immutable node/admission bindings.');
  }
}

function assertExactLiveTreasuryPlan(
  input: TreasuryPresplitPlanInput,
  core: B1CoreLiveObservation,
): void {
  const compareOutpoint = (
    left: Readonly<{ txId: string; vout: number }>,
    right: Readonly<{ txId: string; vout: number }>,
  ): number => left.txId.localeCompare(right.txId) || left.vout - right.vout;
  const planned = input.inputs.map((candidate) => ({
    txId: candidate.txId,
    vout: candidate.vout,
    valueSats: candidate.valueSats,
    minimumConfirmations: candidate.confirmations,
  })).sort(compareOutpoint);
  const observed = core.confirmedOutputs.map((candidate) => ({ ...candidate }))
    .sort(compareOutpoint);
  if (observed.length !== planned.length || observed.some((candidate, index) => {
    const expected = planned[index];
    return expected === undefined
      || candidate.txId !== expected.txId
      || candidate.vout !== expected.vout
      || candidate.valueSats !== expected.valueSats
      || candidate.confirmations < expected.minimumConfirmations;
  })) {
    throw new Error(
      'RIG-B1 live confirmed treasury outpoint/value set or confirmation floor differs from the signed plan.',
    );
  }
}

function assertCollectorCoreBindings(
  admission: z.infer<typeof admissionSchema>,
  planInput: TreasuryPresplitPlanInput,
  core: B1CoreLiveObservation,
): void {
  const treasury = admission.infrastructure.treasuryWatchOnly;
  const node = admission.infrastructure.nodeReadiness;
  const expectedConfirmedOutputCount = admission.treasury_continuity
    ?.currentTreasury.confirmedOutputCount ?? treasury.expectedConfirmedOutputCount;
  const expectedConfirmedTotalSats = admission.treasury_continuity
    ?.currentTreasury.confirmedTotalSats ?? treasury.expectedTotalSats;
  if (core.blocks < node.blocks || core.headers < core.blocks
    || core.genesisHash !== node.genesisHash
    || core.txindexBestBlockHeight !== core.blocks
    || core.splitTransactionObserved !== treasury.splitTransactionId
    || core.confirmedUtxos !== expectedConfirmedOutputCount
    || core.confirmedTotalSats !== expectedConfirmedTotalSats
    || (admission.no_broadcast_prepare_recovery !== undefined
      && (core.unconfirmedUtxos !== 0
        || !core.minconfZeroMatchesMinconfOne
        || core.confirmedOutpointValueExportSha256
          !== B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.confirmedOutpointValueExportSha256
        || core.minimumConfirmations
          < B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.minimumConfirmationsFloor))
    || RIG_B1_REQUIRED_RPC_CAPABILITIES.some((method) => core.capabilities[method] !== true)) {
    throw new Error('RIG-B1 live Core/txindex/watch-only/capability observation differs from admission.');
  }
  assertExactLiveTreasuryPlan(planInput, core);
}

async function observeExactPausedScheduler(
  port: B1PreclockCollectorPort,
  expectedJobs: ReturnType<typeof buildRigB1ReadinessPlan>['schedulerJobs'],
): Promise<void> {
  const scheduler = await port.observeSchedulerJobs();
  if (scheduler.length !== expectedJobs.length) {
    throw new Error('RIG-B1 live Scheduler collector did not return all six jobs.');
  }
  expectedJobs.forEach((expected, index) => {
    const actual = scheduler[index];
    if (actual === undefined || actual.name !== expected.name || actual.path !== expected.path
      || actual.cadence !== expected.cadence || actual.state !== 'PAUSED') {
      throw new Error(`RIG-B1 live Scheduler job ${expected.name} is not exact and PAUSED.`);
    }
  });
}

async function containPreparation(
  port: B1PreclockCollectorPort,
  preparationId: string,
  expectedJobs: ReturnType<typeof buildRigB1ReadinessPlan>['schedulerJobs'],
): Promise<void> {
  const failures: unknown[] = [];
  try { await port.removeInvocationLease(preparationId); } catch (error) { failures.push(error); }
  try { await observeExactPausedScheduler(port, expectedJobs); } catch (error) { failures.push(error); }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'RIG-B1 PREPARE containment failed.');
  }
}

export async function collectB1SchedulerPreclockArtifact(
  admissionRaw: string,
  treasuryPlanInputRaw: string,
  authorization: B1PreclockMutationAuthorization,
  port: B1PreclockCollectorPort,
): Promise<string> {
  const authorized = PRECLOCK_AUTHORIZATIONS.get(authorization);
  if (authorized === undefined
    || authorized.admissionSha256 !== rawDigest(admissionRaw)
    || authorized.treasuryPlanSha256 !== rawDigest(treasuryPlanInputRaw)) {
    throw new Error('RIG-B1 funded pre-clock requires a distinct verified PREPARE_B1 authorization handle.');
  }
  const handle = projectAdmissionV2ToPreClockIdentity(admissionRaw);
  const admittedIdentity = requirePreClockAdmissionIdentity(handle);
  const admission = strict(admissionSchema, admissionRaw, 'RIG-B1 collector admission');
  const planInput = strict(planInputSchema, treasuryPlanInputRaw, 'RIG-B1 treasury plan input');
  const treasuryPlan = planTreasuryPresplit(planInput);
  const readinessPlan = buildRigB1ReadinessPlan(handle, { treasurySplitPlan: treasuryPlan });
  const preparationId = authorized.authority.preparationId;
  const uris = preparationObjectUris(preparationId);
  let verifiedContinuity: VerifiedB1TreasuryContinuityComposition | undefined;
  let continuityClaimObject: B1LockedObject | undefined;
  if (admission.treasury_continuity !== undefined) {
    const continuity = admission.treasury_continuity;
    const [
      claimObject,
      topologyObject,
      amendmentObject,
      historicalIntentObject,
      historicalOutcomeObject,
      failedStartContainmentObject,
    ] = await Promise.all([
      port.readLockedObject(
        continuity.originalProvision.claim.objectUri,
        continuity.originalProvision.claim.generation,
      ),
      port.readLockedObject(
        continuity.originalProvision.topology.objectUri,
        continuity.originalProvision.topology.generation,
      ),
      port.readLockedObject(continuity.amendment.objectUri, continuity.amendment.generation),
      port.readLockedObject(
        B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationIntentUri,
        B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationIntentGeneration,
      ),
      port.readLockedObject(
        B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationOutcomeUri,
        B1_TREASURY_CONTINUITY_CONTRACT.historicalPreparationOutcomeGeneration,
      ),
      port.readLockedObject(
        B1_TREASURY_CONTINUITY_CONTRACT.failedStartContainmentUri,
        B1_TREASURY_CONTINUITY_CONTRACT.failedStartContainmentGeneration,
      ),
    ]);
    verifiedContinuity = verifyB1TreasuryContinuityComposition({
      verificationTime: port.now(),
      refreshedAdmissionRaw: admissionRaw,
      currentTreasuryPlanInputRaw: treasuryPlanInputRaw,
      originalClaim: claimObject,
      originalTopology: topologyObject,
      amendment: amendmentObject,
      historicalPreparationIntent: historicalIntentObject,
      historicalPreparationOutcome: historicalOutcomeObject,
      failedStartContainment: failedStartContainmentObject,
    });
    continuityClaimObject = claimObject;
    if (verifiedContinuity.compositeIdentitySha256
        !== authorized.authority.continuityCompositeIdentitySha256
      || verifiedContinuity.controllerSourceHeadSha
        !== authorized.authority.controllerSourceHeadSha
      || verifiedContinuity.controllerSourceTreeSha
        !== authorized.authority.controllerSourceTreeSha
      || verifiedContinuity.controllerRelevantFilesSha256
        !== authorized.authority.controllerRelevantFilesSha256) {
      throw new Error('RIG-B1 verified treasury continuity differs from signed PREPARE controller bindings.');
    }
    if (port.verifyControllerIdentity === undefined) {
      await verifyLocalB1TreasuryContinuityController(verifiedContinuity);
    } else {
      await port.verifyControllerIdentity(verifiedContinuity);
    }
  }

  const priorIntentPresent = await port.hasLockedObject(
    B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationIntentUri,
  );
  if (priorIntentPresent) {
    const recovery = admission.no_broadcast_prepare_recovery;
    if (recovery === undefined
      || authorized.authority.noBroadcastPrepareRecovery === undefined
      || JSON.stringify(recovery)
        !== JSON.stringify(authorized.authority.noBroadcastPrepareRecovery)
      || recovery.successorPreparationId !== preparationId
      || verifiedContinuity === undefined) {
      throw new Error(
        'RIG-B1 successor PREPARE lacks the exact signed no-broadcast containment binding.',
      );
    }
    if (await port.hasLockedObject(recovery.failedPreparation.outcomeObjectUri)) {
      throw new Error('RIG-B1 contained PREPARE outcome now exists; no-broadcast authority is invalid.');
    }
    if (port.observeInvocationLeaseAbsent === undefined
      || !await port.observeInvocationLeaseAbsent(recovery.failedPreparation.preparationId)) {
      throw new Error('RIG-B1 contained PREPARE invocation lease is not observably absent.');
    }
    const [containedIntent, containmentObject] = await Promise.all([
      port.readLockedObject(
        recovery.failedPreparation.intent.objectUri,
        recovery.failedPreparation.intent.generation,
      ),
      port.readLockedObject(recovery.containment.objectUri, recovery.containment.generation),
    ]);
    if (port.verifyNoBroadcastPrepareContainment === undefined) {
      createProductionB1NoBroadcastPrepareContainmentVerifier().verify({
        recovery,
        containment: containmentObject,
        intent: containedIntent,
        verificationTime: port.now(),
      });
    } else {
      port.verifyNoBroadcastPrepareContainment({
        recovery,
        containment: containmentObject,
        intent: containedIntent,
        verificationTime: port.now(),
      });
    }
  } else if (admission.no_broadcast_prepare_recovery !== undefined
    || authorized.authority.noBroadcastPrepareRecovery !== undefined) {
    throw new Error('RIG-B1 no-broadcast recovery names a missing immutable PREPARE intent.');
  }

  if (await port.hasLockedObject(uris.outcome)) {
    if (!await port.hasLockedObject(uris.intent)) {
      throw new Error('RIG-B1 PREPARE outcome exists without its immutable intent.');
    }
    const [intentObject, outcomeObject] = await Promise.all([
      port.readLockedObject(uris.intent),
      port.readLockedObject(uris.outcome),
    ]);
    const intent = preparationIntentSchema.parse(
      parseJsonRejectingDuplicateKeys(intentObject.raw, 'RIG-B1 PREPARE replay intent'),
    );
    const outcome = preparationOutcomeSchema.parse(
      parseJsonRejectingDuplicateKeys(outcomeObject.raw, 'RIG-B1 PREPARE replay outcome'),
    );
    const replayRetention = new Date(
      Date.parse(authorized.authority.issuedAt) + PREPARATION_AUDIT_RETENTION_MS,
    ).toISOString();
    assertLockedReadback(intentObject, uris.intent, intentObject.raw, replayRetention);
    assertLockedReadback(outcomeObject, uris.outcome, outcomeObject.raw, replayRetention);
    assertPreparationIntentBindings(
      intent,
      authorized.authority,
      authorized.admissionSha256,
      authorized.treasuryPlanSha256,
    );
    const replayedPreclock = replayedPreclockSchema.parse(parseJsonRejectingDuplicateKeys(
      outcome.preclockArtifactRaw,
      'RIG-B1 PREPARE replay pre-clock artifact',
    ));
    if (outcome.preparationId !== preparationId
      || outcome.intentSha256 !== rawDigest(intentObject.raw)
      || outcome.admissionSha256 !== authorized.admissionSha256
      || outcome.treasuryPlanSha256 !== authorized.treasuryPlanSha256
      || outcome.idempotencyKey !== intent.idempotencyKey
      || outcome.preclockArtifactSha256 !== rawDigest(outcome.preclockArtifactRaw)
      || replayedPreclock.admissionSha256 !== authorized.admissionSha256
      || replayedPreclock.sourceHeadSha !== authorized.authority.sourceHeadSha
      || replayedPreclock.workerImageDigest !== authorized.authority.workerImageDigest
      || replayedPreclock.continuityCompositeIdentitySha256
        !== verifiedContinuity?.compositeIdentitySha256
      || outcome.continuityCompositeIdentitySha256
        !== verifiedContinuity?.compositeIdentitySha256) {
      throw new Error('RIG-B1 immutable PREPARE replay outcome differs from the authorized identity.');
    }
    await containPreparation(port, preparationId, readinessPlan.schedulerJobs);
    return outcome.preclockArtifactRaw;
  }
  if (await port.hasLockedObject(uris.intent)) {
    const ambiguous = new Error(
      'RIG-B1 PREPARE has an immutable intent without an outcome; refusing a second funded broadcast.',
    );
    try {
      await containPreparation(port, preparationId, readinessPlan.schedulerJobs);
    } catch (containmentError) {
      throw new AggregateError([ambiguous, containmentError], 'RIG-B1 ambiguous PREPARE containment failed.');
    }
    throw ambiguous;
  }

  // Long-running, non-mutating observations happen before consuming the
  // short-lived PREPARE action authority.
  const revision = await port.observeRevision(admission);
  assertCollectorBindings(admission, revision, planInput);
  await observeExactPausedScheduler(port, readinessPlan.schedulerJobs);

  const treasury = admission.infrastructure.treasuryWatchOnly;
  let core = await port.observeCore({
    treasuryAddress: treasury.address,
    treasuryDescriptor: treasury.descriptor,
    splitTransactionId: treasury.splitTransactionId,
  });
  assertCollectorCoreBindings(admission, planInput, core);

  const claimObject = continuityClaimObject ?? await port.readLockedObject(
    admission.infrastructure.authority.claim.objectUri,
    admission.infrastructure.authority.claim.generation,
  );
  if (claimObject.uri !== admission.infrastructure.authority.claim.objectUri
    || claimObject.generation !== admission.infrastructure.authority.claim.generation) {
    throw new Error('RIG-B1 provision approval claim readback differs from admission.');
  }
  const claim = provisionClaimSchema.parse(
    parseJsonRejectingDuplicateKeys(claimObject.raw, 'RIG-B1 provision approval claim'),
  );
  const authority = authorized.authority;
  if (claim.approvalId !== admission.infrastructure.authority.approvalId
    || claim.envelopeSha256 !== authority.provisionApprovalEnvelopeSha256
    || claim.signedPayloadSha256 !== authority.provisionSignedPayloadSha256
    || claim.sourceHeadSha !== authority.sourceHeadSha
    || claim.sourceTreeSha !== authority.sourceTreeSha
    || claim.corpusDigest !== authority.corpusDigest
    || claim.releaseCandidateId !== authority.releaseCandidateId
    || claim.soakId !== authority.soakId
    || claim.leaseId !== authority.leaseId) {
    throw new Error('RIG-B1 PREPARE authority differs from the immutable provision approval claim.');
  }

  const idempotencyKey = rawDigest(JSON.stringify({
    purpose: 'PREPARE_B1',
    preparationId,
    admissionSha256: authorized.admissionSha256,
    treasuryPlanSha256: authorized.treasuryPlanSha256,
  }));
  const wif = admission.infrastructure.secretReferences.find(({ env }) => env === 'BITCOIN_TREASURY_WIF')!;
  const signer = await port.proveSigner({
    secret: { secretName: wif.secretName, version: wif.version },
    challengeSha256: readinessPlan.signerChallengeSha256,
  });
  if (signer.treasuryAddress !== treasury.address || !signer.verified) {
    throw new Error('RIG-B1 worker-only signer challenge did not bind the signed treasury address.');
  }

  // Reobserve routing immediately before the funded mutation. Earlier Core and
  // signer probes may take minutes and may not leave a stale traffic assertion
  // as authority to broadcast.
  const preProbeRevision = await port.observeRevision(admission);
  assertCollectorBindings(admission, preProbeRevision, planInput);
  if (JSON.stringify(preProbeRevision) !== JSON.stringify(revision)) {
    throw new Error('RIG-B1 Cloud Run revision/routing changed during pre-clock collection.');
  }
  await observeExactPausedScheduler(port, readinessPlan.schedulerJobs);
  core = await port.observeCore({
    treasuryAddress: treasury.address,
    treasuryDescriptor: treasury.descriptor,
    splitTransactionId: treasury.splitTransactionId,
  });
  assertCollectorCoreBindings(admission, planInput, core);
  const mutationNow = port.now();
  assertSamePreparationAuthority(authority, authorized.reverify(mutationNow));
  if (authorized.confirmation.provided !== authorized.confirmation.expected) {
    throw new Error('RIG-B1 exact CTO PREPARE confirmation changed before mutation.');
  }
  const intentRaw = JSON.stringify(preparationIntentSchema.parse({
    schemaVersion: 'arkova.s33.rig-b1.preparation-intent/v1',
    status: 'PREPARE_INTENT_LOCKED',
    preparationId,
    authorityEnvelopeSha256: authority.envelopeSha256,
    authoritySignedPayloadSha256: authority.signedPayloadSha256,
    provisionApprovalEnvelopeSha256: authority.provisionApprovalEnvelopeSha256,
    provisionSignedPayloadSha256: authority.provisionSignedPayloadSha256,
    admissionSha256: authorized.admissionSha256,
    treasuryPlanSha256: authorized.treasuryPlanSha256,
    sourceHeadSha: authority.sourceHeadSha,
    sourceTreeSha: authority.sourceTreeSha,
    workerImageDigest: authority.workerImageDigest,
    corpusDigest: authority.corpusDigest,
    releaseCandidateId: authority.releaseCandidateId,
    soakId: authority.soakId,
    leaseId: authority.leaseId,
    idempotencyKey,
    maxFundedBroadcasts: authority.maxFundedBroadcasts,
    invocationLeaseMaxSeconds: authority.invocationLeaseMaxSeconds,
    createdAt: mutationNow.toISOString(),
    authorityExpiresAt: authority.expiresAt,
    ...(verifiedContinuity === undefined ? {} : {
      continuityCompositeIdentitySha256: verifiedContinuity.compositeIdentitySha256,
      controllerSourceHeadSha: verifiedContinuity.controllerSourceHeadSha,
      controllerSourceTreeSha: verifiedContinuity.controllerSourceTreeSha,
      controllerRelevantFilesSha256: verifiedContinuity.controllerRelevantFilesSha256,
    }),
  }));
  const retainUntilTime = new Date(
    Date.parse(authority.issuedAt) + PREPARATION_AUDIT_RETENTION_MS,
  ).toISOString();
  await port.persistLockedObject(uris.intent, intentRaw, retainUntilTime);
  assertLockedReadback(
    await port.readLockedObject(uris.intent),
    uris.intent,
    intentRaw,
    retainUntilTime,
  );

  try {
  const broadcastNow = port.now();
  assertSamePreparationAuthority(authority, authorized.reverify(broadcastNow));
  const invocationExpiry = new Date(Math.min(
    broadcastNow.getTime() + authority.invocationLeaseMaxSeconds * 1_000,
    Date.parse(authority.expiresAt),
  )).toISOString();
  await port.installInvocationLease({
    preparationId,
    expiresAt: invocationExpiry,
    authorityExpiresAt: authority.expiresAt,
  });
  let funded: B1FundedProbeObservation | undefined;
  let probeFailure: unknown;
  try {
    assertSamePreparationAuthority(authority, authorized.reverify(port.now()));
    funded = await port.runFundedProbe({
      admission,
      revision: preProbeRevision,
      preparationId,
      idempotencyKey,
      maxFundedBroadcasts: 1,
    });
  } catch (error) {
    probeFailure = error;
  }
  let removalFailure: unknown;
  try { await port.removeInvocationLease(preparationId); } catch (error) { removalFailure = error; }
  if (probeFailure !== undefined && removalFailure !== undefined) {
    throw new AggregateError([probeFailure, removalFailure], 'RIG-B1 funded PREPARE probe and lease removal failed.');
  }
  if (probeFailure !== undefined) throw probeFailure;
  if (removalFailure !== undefined) throw removalFailure;
  if (funded === undefined) throw new Error('RIG-B1 funded PREPARE probe produced no result.');
  await observeExactPausedScheduler(port, readinessPlan.schedulerJobs);
  const mempool = await port.observeMempool({
    txId: funded.txId,
    coreTipHash: core.bestBlockHash,
    treasuryAddress: treasury.address,
    splitTransactionId: treasury.splitTransactionId,
  });
  if (mempool.txId !== funded.txId || mempool.tipHash !== core.bestBlockHash
    || mempool.tipHeight !== core.blocks
    || !mempool.spentOutpoints.some((outpoint) => (
      outpoint.txId === treasury.splitTransactionId && outpoint.address === treasury.address
    ))) {
    throw new Error('RIG-B1 mempool.space did not corroborate the funded probe and exact Core tip.');
  }
  const observedAt = port.now().toISOString();
  const observation: RigB1PreClockObservation = {
    admissionSha256: readinessPlan.admissionSha256,
    gitHeadSha: admittedIdentity.gitHeadSha,
    imageDigest: admittedIdentity.imageDigest,
    cleanMirrorAttestationId: admittedIdentity.cleanMirrorAttestationId,
    secretVersions: readinessPlan.secretReferences.map((reference) => ({ ...reference })),
    schedulerPolicy: {
      ...readinessPlan.schedulerPolicy,
      productionCadenceMutationAttempted: false,
      productionTopologyMutationAttempted: false,
      cleanMirrorAdmissionComplete: true,
      evidencePhaseAuthorized: false,
      observedAt,
    },
    schedulerJobs: readinessPlan.schedulerJobs.map((job) => ({
      ...job,
      state: 'PAUSED',
      createdPaused: true,
      pausedThroughCleanMirror: true,
      enabledAt: null,
    })),
    getBlockchainInfo: {
      provider: 'bitcoin-core-signet-rpc', rpcMethod: 'getblockchaininfo',
      chain: core.chain, initialBlockDownload: core.initialBlockDownload,
      headers: core.headers, blocks: core.blocks, bestBlockHash: core.bestBlockHash,
      genesisHash: core.genesisHash, observedAt: core.observedAt,
    },
    txindex: {
      rpcMethod: 'getindexinfo', synced: core.txindexSynced,
      bestBlockHeight: core.txindexBestBlockHeight, observedAt: core.observedAt,
    },
    watchOnlyWallet: {
      walletName: 'arkova-watch-only', privateKeysEnabled: core.privateKeysEnabled,
      descriptors: core.descriptors, treasuryAddress: treasury.address,
      treasuryDescriptor: treasury.descriptor, descriptorImported: core.descriptorImported,
      rescanComplete: core.rescanComplete, confirmedUtxos: core.confirmedUtxos,
      confirmedTotalSats: core.confirmedTotalSats,
      minimumConfirmations: core.minimumConfirmations, observedAt: core.observedAt,
    },
    capabilityProbes: RIG_B1_REQUIRED_RPC_CAPABILITIES.map((rpcMethod) => ({
      rpcMethod, available: core.capabilities[rpcMethod], nonBroadcastProbe: true,
      observedAt: core.observedAt,
    })),
    signerReadiness: {
      algorithm: 'secp256k1', treasuryAddress: signer.treasuryAddress,
      challengeSha256: readinessPlan.signerChallengeSha256,
      signatureSha256: signer.signatureSha256, verified: signer.verified,
      observedAt: signer.observedAt,
    },
    treasurySplit: {
      planDigest: treasuryPlan.planDigest, treasuryAddress: treasury.address,
      confirmedUtxos: core.confirmedUtxos, minimumConfirmations: core.minimumConfirmations,
      observedAt: core.observedAt,
    },
    fundedBroadcast: {
      network: 'signet', txId: funded.txId, spentFromTreasuryAddress: treasury.address,
      accepted: true, observedAt: funded.observedAt,
    },
    mempoolCorroboration: {
      provider: 'mempool-space-signet', baseUrl: 'https://mempool.space/signet/api',
      tipHeight: mempool.tipHeight, tipHash: mempool.tipHash, txId: mempool.txId,
      txOutcome: 'found', observedAt: mempool.observedAt,
    },
    nodeCron: { mode: 'disabled', observedAt },
  };
  const preclockArtifactRaw = buildB1SchedulerStartPreclockArtifact(
    admissionRaw,
    treasuryPlanInputRaw,
    JSON.stringify(observation),
  );
  const outcomeRaw = JSON.stringify(preparationOutcomeSchema.parse({
    schemaVersion: 'arkova.s33.rig-b1.preparation-outcome/v1',
    status: 'PRE_CLOCK_READY',
    preparationId,
    intentSha256: rawDigest(intentRaw),
    admissionSha256: authorized.admissionSha256,
    treasuryPlanSha256: authorized.treasuryPlanSha256,
    idempotencyKey,
    fundedProbe: funded,
    preclockArtifactSha256: rawDigest(preclockArtifactRaw),
    preclockArtifactRaw,
    completedAt: port.now().toISOString(),
    ...(verifiedContinuity === undefined ? {} : {
      continuityCompositeIdentitySha256: verifiedContinuity.compositeIdentitySha256,
    }),
  }));
  await port.persistLockedObject(uris.outcome, outcomeRaw, retainUntilTime);
  assertLockedReadback(
    await port.readLockedObject(uris.outcome),
    uris.outcome,
    outcomeRaw,
    retainUntilTime,
  );
  return preclockArtifactRaw;
  } catch (primaryError) {
    try {
      await containPreparation(port, preparationId, readinessPlan.schedulerJobs);
    } catch (containmentError) {
      throw new AggregateError(
        [primaryError, containmentError],
        'RIG-B1 PREPARE failed and containment was incomplete.',
      );
    }
    throw primaryError;
  }
}

interface ProcessResult { readonly ok: boolean; readonly stdout: string; readonly stderr: string }

async function runProcess(
  binary: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(binary, [...args], {
      encoding: 'utf8', shell: false, maxBuffer: MAX_BUFFER,
      timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      env: options.env ?? b1CommandEnvironment(binary),
    }, (error, stdout, stderr) => resolve({ ok: error === null, stdout, stderr }));
  });
}

function requireProcess(result: ProcessResult, label: string): string {
  if (!result.ok) throw new Error(`${label} failed.`);
  return result.stdout;
}

function secretMapFromRevision(raw: string): z.infer<typeof revisionSchema>['secrets'] {
  const value = z.object({
    spec: z.object({ containers: z.array(z.object({
      env: z.array(z.object({
        name: z.string(),
        value: z.string().optional(),
        valueSource: z.object({ secretKeyRef: secretBindingSchema }).strict().optional(),
      }).strict()),
    }).passthrough()).length(1) }).passthrough(),
  }).passthrough().parse(parseJsonRejectingDuplicateKeys(raw, 'RIG-B1 revision'));
  const env = new Map(value.spec.containers[0]!.env.map((entry) => [entry.name, entry]));
  const binding = (name: string) => {
    const result = env.get(name)?.valueSource?.secretKeyRef;
    if (result === undefined) throw new Error(`RIG-B1 revision lacks exact ${name} secret binding.`);
    return result;
  };
  if (env.get('DISABLE_ALL_IN_PROCESS_CRON')?.value !== 'true') {
    throw new Error('RIG-B1 revision does not disable all in-process cron.');
  }
  return {
    supabaseUrl: binding('SUPABASE_URL'),
    supabaseServiceRole: binding('SUPABASE_SERVICE_ROLE_KEY'),
    cron: binding('CRON_SECRET'),
    treasuryWif: binding('BITCOIN_TREASURY_WIF'),
  };
}

const serviceRoutingSchema = z.object({
  status: z.object({
    url: z.string().url(),
    latestReadyRevisionName: z.string().min(1),
    traffic: z.array(z.object({
      revisionName: z.string().min(1),
      percent: z.number().int().min(0).max(100),
      tag: z.string().regex(/^train-[a-z0-9-]*[a-z0-9]$/u),
      url: z.string().url(),
    }).passthrough()).length(1),
  }).passthrough(),
}).passthrough();

/** Pure routing projection used by production and regression tests. */
export function requireExactB1ServiceRouting(
  raw: string,
  expected: Readonly<{
    revision: string;
    serviceUrl: string;
    fundedProbeUrl: string;
    trafficTag: string;
  }>,
): string {
  const service = serviceRoutingSchema.parse(
    parseJsonRejectingDuplicateKeys(raw, 'RIG-B1 Cloud Run service routing'),
  );
  const traffic = service.status.traffic[0]!;
  const admittedTaggedUrl = resolveStagingApiBase({ STAGING_API_BASE: expected.fundedProbeUrl });
  const canonical = new URL(service.status.url);
  const tagged = new URL(traffic.url);
  if (service.status.latestReadyRevisionName !== expected.revision
    || service.status.url !== expected.serviceUrl
    || traffic.revisionName !== expected.revision
    || traffic.percent !== 100
    || traffic.tag !== expected.trafficTag
    || traffic.url !== admittedTaggedUrl
    || tagged.hostname !== `${traffic.tag}---${canonical.hostname}`) {
    throw new Error('RIG-B1 Cloud Run service is not routing 100% to the exact admitted revision.');
  }
  return traffic.url;
}

class ProductionB1PreclockCollector implements B1PreclockCollectorPort {
  private readonly controller = createB1SchedulerStartProductionAdapter();

  now(): Date { return new Date(); }

  hasLockedObject(uri: string): Promise<boolean> {
    return this.controller.hasStartReceipt(uri);
  }

  readLockedObject(uri: string, generation?: string): Promise<B1LockedObject> {
    return this.controller.readLockedObject(uri, generation);
  }

  persistLockedObject(uri: string, raw: string, retainUntilTime: string): Promise<void> {
    return this.controller.persistStartReceipt(uri, raw, retainUntilTime);
  }

  installInvocationLease(input: Readonly<{
    preparationId: string;
    expiresAt: string;
    authorityExpiresAt: string;
  }>): Promise<void> {
    return this.controller.installInvocationLease({
      approvalId: input.preparationId,
      expiresAt: input.expiresAt,
      authorityExpiresAt: input.authorityExpiresAt,
    });
  }

  removeInvocationLease(preparationId: string): Promise<void> {
    return this.controller.removeInvocationLease(preparationId);
  }

  observeInvocationLeaseAbsent(preparationId: string): Promise<boolean> {
    if (this.controller.observeInvocationLeaseAbsent === undefined) {
      throw new Error('RIG-B1 production controller lacks read-only invocation-lease observation.');
    }
    return this.controller.observeInvocationLeaseAbsent(preparationId);
  }

  async observeRevision(admission: z.infer<typeof admissionSchema>): Promise<z.infer<typeof revisionSchema>> {
    const [raw, serviceRaw] = await Promise.all([
      runProcess(B1_GCLOUD_BINARY, [
        'run', 'revisions', 'describe', admission.deployed_revision,
        `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
        `--region=${B1_SCHEDULER_START_CONTRACT.gcpRegion}`, '--format=json',
      ]).then((result) => requireProcess(result, 'RIG-B1 Cloud Run revision observation')),
      runProcess(B1_GCLOUD_BINARY, [
        'run', 'services', 'describe', B1_SCHEDULER_START_CONTRACT.workerService,
        `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
        `--region=${B1_SCHEDULER_START_CONTRACT.gcpRegion}`, '--format=json',
      ]).then((result) => requireProcess(result, 'RIG-B1 Cloud Run service traffic observation')),
    ]);
    const parsed = z.object({
      metadata: z.object({ labels: z.record(z.string(), z.string()) }).passthrough(),
      spec: z.object({
        serviceAccountName: z.string(),
        containers: z.array(z.object({ image: z.string() }).passthrough()).length(1),
      }).passthrough(),
      status: z.object({ imageDigest: z.string() }).passthrough(),
    }).passthrough().parse(parseJsonRejectingDuplicateKeys(raw, 'RIG-B1 revision'));
    const digest = parsed.status.imageDigest.includes('@')
      ? parsed.status.imageDigest.slice(parsed.status.imageDigest.lastIndexOf('@') + 1)
      : parsed.status.imageDigest;
    return revisionSchema.parse({
      sourceHeadSha: parsed.metadata.labels['arkova-source-head'],
      imageDigest: digest,
      runtimeServiceAccount: parsed.spec.serviceAccountName,
      serviceUrl: admission.tag_url,
      fundedProbeUrl: requireExactB1ServiceRouting(serviceRaw, {
        revision: admission.deployed_revision,
        serviceUrl: admission.tag_url,
        fundedProbeUrl: B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.taggedServiceUrl,
        trafficTag: B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.trafficTag,
      }),
      inProcessCronDisabled: true,
      secrets: secretMapFromRevision(raw),
    });
  }

  async observeSchedulerJobs(): Promise<readonly {
    name: string; path: string; cadence: string; state: 'PAUSED' | 'ENABLED'; observedAt: string;
  }[]> {
    const scheduler = createB1SchedulerStartProductionAdapter();
    const observed = [];
    for (const spec of B1_SCHEDULER_START_CONTRACT.jobs) {
      const job = await scheduler.observeJob(spec);
      observed.push({
        name: job.name, path: job.path, cadence: job.schedule,
        state: job.state, observedAt: job.observedAt,
      });
    }
    return observed;
  }

  private async bitcoinCli(args: readonly string[]): Promise<string> {
    const allowed = new Set([
      'getblockchaininfo', 'getblockhash', 'getindexinfo', 'getwalletinfo',
      'listdescriptors', 'listunspent', 'getrawtransaction', 'help',
    ]);
    const method = args.find((entry) => !entry.startsWith('-'));
    if (method === undefined || !allowed.has(method)
      || args.some((entry) => entry.startsWith('-') && entry !== '-rpcwallet=arkova-watch-only')) {
      throw new Error('Forbidden RIG-B1 Core probe.');
    }
    const command = ['/usr/bin/docker', 'exec', CONTAINER, 'bitcoin-cli', '-signet', ...args]
      .map((entry) => `'${entry.replace(/'/gu, "'\\''")}'`).join(' ');
    return requireProcess(await runProcess(B1_GCLOUD_BINARY, [
      'compute', 'ssh', VM, `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
      `--zone=${ZONE}`, '--quiet', `--command=${command}`,
    ]), `RIG-B1 Core probe ${method}`);
  }

  async observeCore(input: Readonly<{
    treasuryAddress: string; treasuryDescriptor: string; splitTransactionId: string;
  }>): Promise<B1CoreLiveObservation> {
    // Serialize probes so the collector never fans out a burst of SSH sessions
    // against the isolated Core VM.
    const chainRaw = await this.bitcoinCli(['getblockchaininfo']);
    const genesisRaw = await this.bitcoinCli(['getblockhash', '0']);
    const indexRaw = await this.bitcoinCli(['getindexinfo', 'txindex']);
    const walletRaw = await this.bitcoinCli(['-rpcwallet=arkova-watch-only', 'getwalletinfo']);
    const descriptorsRaw = await this.bitcoinCli(['-rpcwallet=arkova-watch-only', 'listdescriptors', 'false']);
    const unspentRaw = await this.bitcoinCli([
      '-rpcwallet=arkova-watch-only', 'listunspent', '1', '9999999',
      JSON.stringify([input.treasuryAddress]), 'true',
    ]);
    const unspentZeroRaw = await this.bitcoinCli([
      '-rpcwallet=arkova-watch-only', 'listunspent', '0', '9999999',
      JSON.stringify([input.treasuryAddress]), 'true',
    ]);
    const splitRaw = await this.bitcoinCli(['getrawtransaction', input.splitTransactionId, 'true']);
    const capabilities = {} as Record<typeof RIG_B1_REQUIRED_RPC_CAPABILITIES[number], boolean>;
    for (const method of RIG_B1_REQUIRED_RPC_CAPABILITIES) {
      capabilities[method] = (await this.bitcoinCli(['help', method])).trim().length > 0;
    }
    const chain = z.object({
      chain: z.literal('signet'), blocks: z.number().int().nonnegative(),
      headers: z.number().int().nonnegative(), bestblockhash: sha256Hex,
      initialblockdownload: z.literal(false),
    }).passthrough().parse(JSON.parse(chainRaw));
    const index = z.object({ txindex: z.object({
      synced: z.literal(true), best_block_height: z.number().int().nonnegative(),
    }).passthrough() }).passthrough().parse(JSON.parse(indexRaw));
    const wallet = z.object({
      private_keys_enabled: z.literal(false), descriptors: z.literal(true),
      scanning: z.literal(false),
    }).passthrough().parse(JSON.parse(walletRaw));
    const descriptors = z.object({
      descriptors: z.array(z.object({ desc: z.string() }).passthrough()),
    }).passthrough().parse(JSON.parse(descriptorsRaw));
    const unspent = z.array(z.object({
      txid: sha256Hex, vout: z.number().int().nonnegative(),
      address: z.string(), amount: z.number().nonnegative(),
      confirmations: z.number().int().positive(),
    }).passthrough()).parse(JSON.parse(unspentRaw));
    const unspentZero = z.array(z.object({
      txid: sha256Hex, vout: z.number().int().nonnegative(),
      address: z.string(), amount: z.number().nonnegative(),
      confirmations: z.number().int().nonnegative(),
    }).passthrough()).parse(JSON.parse(unspentZeroRaw));
    const split = z.object({ txid: sha256Hex }).passthrough().parse(JSON.parse(splitRaw));
    if (!descriptors.descriptors.some(({ desc }) => desc === input.treasuryDescriptor)) {
      throw new Error('RIG-B1 watch-only wallet lacks the admitted descriptor.');
    }
    if (unspent.length === 0) throw new Error('RIG-B1 watch-only wallet has no confirmed admitted UTXOs.');
    const confirmedOutputs = unspent.map((item) => ({
      txId: item.txid,
      vout: item.vout,
      valueSats: Math.round(item.amount * 100_000_000),
      confirmations: item.confirmations,
    }));
    const zeroOutputs = unspentZero.map((item) => ({
      txId: item.txid,
      vout: item.vout,
      valueSats: Math.round(item.amount * 100_000_000),
    }));
    const minconfZeroMatchesMinconfOne = b1ConfirmedOutpointValueExportSha256(zeroOutputs)
      === b1ConfirmedOutpointValueExportSha256(confirmedOutputs);
    return {
      chain: chain.chain, initialBlockDownload: chain.initialblockdownload,
      headers: chain.headers, blocks: chain.blocks, bestBlockHash: chain.bestblockhash,
      genesisHash: genesisRaw.trim().replace(/^"|"$/gu, ''),
      txindexSynced: index.txindex.synced,
      txindexBestBlockHeight: index.txindex.best_block_height,
      privateKeysEnabled: wallet.private_keys_enabled, descriptors: wallet.descriptors,
      descriptorImported: true,
      rescanComplete: true,
      confirmedUtxos: unspent.length,
      confirmedTotalSats: unspent.reduce((sum, item) => sum + Math.round(item.amount * 100_000_000), 0),
      confirmedOutputs,
      unconfirmedUtxos: unspentZero.length - unspent.length,
      minconfZeroMatchesMinconfOne,
      confirmedOutpointValueExportSha256:
        b1ConfirmedOutpointValueExportSha256(confirmedOutputs),
      minimumConfirmations: Math.min(...unspent.map(({ confirmations }) => confirmations)),
      splitTransactionObserved: split.txid,
      capabilities,
      observedAt: this.now().toISOString(),
    };
  }

  private async accessSecret(secret: { secretName: string; version: string }): Promise<string> {
    const value = requireProcess(await runProcess(B1_GCLOUD_BINARY, [
      'secrets', 'versions', 'access', secret.version, `--secret=${secret.secretName}`,
      `--project=${B1_SCHEDULER_START_CONTRACT.gcpProjectId}`,
    ]), `RIG-B1 exact secret access for ${secret.secretName}`).trim();
    if (value.length === 0) throw new Error(`RIG-B1 secret ${secret.secretName} is empty.`);
    return value;
  }

  async proveSigner(input: Readonly<{
    secret: { secretName: string; version: string }; challengeSha256: string;
  }>): Promise<B1SignerChallengeObservation> {
    const wif = await this.accessSecret(input.secret);
    const proof = proveB1WifChallenge(wif, input.challengeSha256);
    return {
      ...proof,
      observedAt: this.now().toISOString(),
    };
  }

  async runFundedProbe(input: Readonly<{
    admission: z.infer<typeof admissionSchema>;
    revision: z.infer<typeof revisionSchema>;
    preparationId: string;
    idempotencyKey: string;
    maxFundedBroadcasts: 1;
  }>): Promise<B1FundedProbeObservation> {
    const routing = projectB1FundedProbeRouting(input.revision);
    const [supabaseUrl, serviceRole, cron, identityToken] = await Promise.all([
      this.accessSecret({ secretName: input.revision.secrets.supabaseUrl.secret, version: input.revision.secrets.supabaseUrl.version }),
      this.accessSecret({ secretName: input.revision.secrets.supabaseServiceRole.secret, version: input.revision.secrets.supabaseServiceRole.version }),
      this.accessSecret({ secretName: input.revision.secrets.cron.secret, version: input.revision.secrets.cron.version }),
      runProcess(B1_GCLOUD_BINARY, [
        'auth', 'print-identity-token',
        `--impersonate-service-account=${B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount}`,
        `--audiences=${routing.identityAudience}`, '--include-email',
      ]).then((result) => requireProcess(result, 'RIG-B1 Scheduler OIDC token').trim()),
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'arkova-b1-preclock-'));
    const evidencePath = join(directory, 'funded-probe.json');
    if (input.maxFundedBroadcasts !== 1) {
      throw new Error('RIG-B1 PREPARE funded probe cap must be exactly one.');
    }
    const runId = b1PreparationFundedProbeRunId(input);
    const env = {
      ...process.env,
      STAGING_API_BASE: routing.apiBase,
      STAGING_CRON_SECRET: cron,
      STAGING_SUPABASE_URL: supabaseUrl,
      STAGING_SUPABASE_SERVICE_ROLE_KEY: serviceRole,
      STAGING_SUPABASE_PROJECT_REF: input.admission.supabase_project_ref,
      ALLOWED_STAGING_PROJECT_REFS: input.admission.supabase_project_ref,
      STAGING_GCP_IDENTITY: identityToken,
    };
    const invoke = (phase: string, extra: readonly string[] = []) => runProcess(
      process.execPath,
      [TSX_CLI, HARNESS, '--phase', phase, '--count', '1', '--run-id', runId, ...extra],
      { env, timeoutMs: COMMAND_TIMEOUT_MS },
    );
    let result: B1FundedProbeObservation | undefined;
    let primaryError: unknown;
    try {
      requireProcess(await invoke('seed'), 'RIG-B1 funded probe seed');
      requireProcess(await invoke('drain', ['--evidence-out', evidencePath]), 'RIG-B1 funded probe drain');
      requireProcess(await invoke('proofs'), 'RIG-B1 funded probe proof verification');
      const raw = await readFile(evidencePath, 'utf8');
      const evidence = z.object({
        phases: z.object({ drain: z.object({ proof: z.object({
          distinctTxIds: z.array(sha256Hex).length(1),
        }).passthrough() }).passthrough() }).passthrough(),
      }).passthrough().parse(parseJsonRejectingDuplicateKeys(raw, 'RIG-B1 funded probe evidence'));
      result = {
        txId: evidence.phases.drain.proof.distinctTxIds[0]!,
        evidenceSha256: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
        observedAt: this.now().toISOString(),
      };
    } catch (error) {
      primaryError = error;
    }
    const cleanup = await invoke('cleanup');
    await rm(directory, { recursive: true, force: true });
    const cleanupError = cleanup.ok ? undefined : new Error('RIG-B1 funded probe cleanup failed.');
    if (primaryError !== undefined && cleanupError !== undefined) {
      throw new AggregateError([primaryError, cleanupError], 'RIG-B1 funded probe and cleanup both failed.');
    }
    if (primaryError !== undefined) throw primaryError;
    if (cleanupError !== undefined) throw cleanupError;
    if (result === undefined) throw new Error('RIG-B1 funded probe produced no result.');
    return result;
  }

  async observeMempool(input: Readonly<{
    txId: string; coreTipHash: string; treasuryAddress: string; splitTransactionId: string;
  }>): Promise<B1MempoolObservation> {
    let transaction: Response | undefined;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      transaction = await fetch(`https://mempool.space/signet/api/tx/${input.txId}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (transaction.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    if (transaction === undefined || !transaction.ok) throw new Error('mempool.space did not observe the funded probe.');
    const tx = z.object({
      txid: sha256Hex,
      vin: z.array(z.object({
        txid: sha256Hex,
        vout: z.number().int().nonnegative(),
        prevout: z.object({ scriptpubkey_address: z.string() }).passthrough(),
      }).passthrough()).min(1),
    }).passthrough().parse(await transaction.json());
    const blockResponse = await fetch(`https://mempool.space/signet/api/block/${input.coreTipHash}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!blockResponse.ok) throw new Error('mempool.space did not observe the exact Core tip.');
    const block = z.object({ id: sha256Hex, height: z.number().int().nonnegative() })
      .passthrough().parse(await blockResponse.json());
    const spentOutpoints = tx.vin.map((inputRecord) => ({
      txId: inputRecord.txid,
      vout: inputRecord.vout,
      address: inputRecord.prevout.scriptpubkey_address,
    }));
    if (!spentOutpoints.some((outpoint) => (
      outpoint.txId === input.splitTransactionId && outpoint.address === input.treasuryAddress
    ))) {
      throw new Error('mempool.space funded probe does not spend the admitted treasury split.');
    }
    return {
      txId: tx.txid,
      tipHeight: block.height,
      tipHash: block.id,
      spentOutpoints,
      observedAt: this.now().toISOString(),
    };
  }
}

export function createB1PreclockProductionCollector(): B1PreclockCollectorPort {
  return new ProductionB1PreclockCollector();
}
