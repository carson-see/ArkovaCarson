/** One-successor authority for the contained c56 PREPARE that never reached Cloud Run. */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';

import { z } from 'zod';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';

const PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAE+Ir2My5+bBwU73QkL73F7fiRteZ0V5yIAe41fD6MdU=\n-----END PUBLIC KEY-----\n';
const DOMAIN = 'arkova:s33:rig-b1-no-broadcast-prepare-containment:v1\n';

export const B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT = Object.freeze({
  schemaVersion: 1,
  payloadSchemaVersion: 'arkova.s33.rig-b1.no-broadcast-prepare-containment/v1',
  recoverySchemaVersion: 'arkova.s33.rig-b1.no-broadcast-prepare-recovery/v1',
  keyId: 'arkova.s33.b1-evidence.ed25519.v1',
  keyFingerprint: '8b7fbc51c74828dab2e1a3ca6f0c15069575bae8e4e190eaf3b165daea50d5c6',
  approverIdentity: 'arkova.s33.approver.founder-cto.v1',
  purpose: 'AUTHORIZE_ONE_SUCCESSOR_PREPARE_B1_AFTER_PROVEN_NO_BROADCAST',
  signatureDomain: DOMAIN,
  sourceHeadSha: 'c56c7729687602b980e2b03454588683a8c20d9b',
  sourceTreeSha: '09f7d40d6b59b6afbe4979346e1d0d46f35ccd28',
  workerImageDigest: 'sha256:0162f4b840b12cd062eb43a2c05d4684bf5997e5f70297186c96a5aafc5ee105',
  revision: 'arkova-worker-s33-rig-b1-staging-b1hdr2-021254',
  workerService: 'arkova-worker-s33-rig-b1-staging',
  canonicalServiceUrl: 'https://arkova-worker-s33-rig-b1-staging-kvojbeutfa-uc.a.run.app',
  taggedServiceUrl:
    'https://train-s33-b1---arkova-worker-s33-rig-b1-staging-kvojbeutfa-uc.a.run.app',
  trafficTag: 'train-s33-b1',
  failedPreparationId: 'b1-prepare-c56c7729-20260717t034334z',
  failedPreparationIntentUri:
    'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/preparation-intents/b1-prepare-c56c7729-20260717t034334z.json',
  failedPreparationIntentGeneration: '1784259952526601',
  failedPreparationIntentSha256:
    'sha256:92331d257c78635d7d0c416196a1c0b2feb297e4795e90df42175006986f08e9',
  failedPreparationOutcomeUri:
    'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/preparation-outcomes/b1-prepare-c56c7729-20260717t034334z.json',
  fundedProbeRunId: 'b1-preclock-4bc03bc4217605106fec7e7da2429626',
  runOrgId: '62617463-682d-4472-8169-6e2d62312d70',
  supabaseProjectRef: 'lbqkhdwqpfncvocasmfp',
  treasuryPlanInputSha256:
    'sha256:1c952e7e6ee5d668f663eaec4fd62d5df83ee9f30778d57c07b3d03b1a8e4485',
  treasuryPlanDigest:
    'sha256:9808e07f3b2329488e5dc5f2658a2224937f3c950fd7322b9a5a227ff34fc034',
  confirmedOutputCount: 32,
  confirmedTotalSats: 169_482,
  confirmedOutpointValueExportSha256:
    'sha256:525e69d5cc98fd85a3c807ffe595779a0faa3327cc003c36048fae7fd0c51f03',
  confirmedOutpointValueSerialization:
    'JSON.stringify(inputs sorted by txId,vout as {txId,vout,valueSats}) plus one LF',
  minimumConfirmationsFloor: 12,
  cloudRunLogFilter:
    'resource.type="cloud_run_revision" AND resource.labels.service_name="arkova-worker-s33-rig-b1-staging" AND resource.labels.revision_name="arkova-worker-s33-rig-b1-staging-b1hdr2-021254"',
  cloudRunObservationStartedAt: '2026-07-17T03:43:00.000Z',
  cloudRunObservationEndedAt: '2026-07-17T03:48:30.000Z',
  cloudRunExportSha256:
    'sha256:37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570',
  supabaseZeroResidueObservedAt: '2026-07-17T04:05:28.450Z',
  supabaseZeroResidueExportSha256:
    'sha256:499bc08bea7826b5f58c857c88f9e8f5a10900bdfd031b8d4a84164a48943c24',
  coreUtxoExportSchemaVersion: 'arkova.s33.rig-b1.no-broadcast-core-utxo-export/v1',
  coreUtxoObservedStartedAt: '2026-07-17T04:08:06.786Z',
  coreUtxoObservedEndedAt: '2026-07-17T04:08:11.230Z',
  coreUtxoExportSha256:
    'sha256:80f75f9532676420142975440038c229265868456cec7132ca19309909160fe6',
  schedulerJobNames: Object.freeze([
    'arkova-worker-s33-rig-b1-staging-batch-anchors',
    'arkova-worker-s33-rig-b1-staging-check-confirmations',
    'arkova-worker-s33-rig-b1-staging-populate-confirmation-proofs',
    'arkova-worker-s33-rig-b1-staging-org-queue-scheduler',
    'arkova-worker-s33-rig-b1-staging-batch-anchors-forced-flush',
    'arkova-worker-s33-rig-b1-staging-recover-broadcasts',
  ]),
  successorPrepareCount: 1,
} as const);

const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);
const timestamp = z.string().datetime({ offset: true });
const generation = z.string().regex(/^[1-9][0-9]*$/u);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const b1NoBroadcastPrepareRecoverySchema = z.object({
  schemaVersion: z.literal(
    B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.recoverySchemaVersion,
  ),
  containment: z.object({
    objectUri: z.string().min(1),
    generation,
    envelopeSha256: sha256,
    signedPayloadSha256: sha256,
  }).strict(),
  failedPreparation: z.object({
    preparationId: z.literal(
      B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationId,
    ),
    intent: z.object({
      objectUri: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationIntentUri,
      ),
      generation: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationIntentGeneration,
      ),
      sha256: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationIntentSha256,
      ),
    }).strict(),
    outcomeObjectUri: z.literal(
      B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationOutcomeUri,
    ),
    fundedProbeRunId: z.literal(
      B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.fundedProbeRunId,
    ),
  }).strict(),
  successorPreparationId: boundedId,
  successorPrepareCount: z.literal(1),
}).strict();

export type B1NoBroadcastPrepareRecovery = z.infer<typeof b1NoBroadcastPrepareRecoverySchema>;

const schedulerJobSchema = z.object({
  name: z.string().min(1),
  state: z.literal('PAUSED'),
  schedule: z.literal('*/5 * * * *'),
}).strict();

const payloadSchema = z.object({
  schemaVersion: z.literal(
    B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.payloadSchemaVersion,
  ),
  containmentId: boundedId,
  authority: z.object({
    keyId: z.literal(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.keyId),
    keyFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    approverIdentity: z.literal(
      B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.approverIdentity,
    ),
    purpose: z.literal(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.purpose),
    signatureDomain: z.literal(DOMAIN),
  }).strict(),
  candidate: z.object({
    sourceHeadSha: z.literal(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.sourceHeadSha),
    sourceTreeSha: z.literal(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.sourceTreeSha),
    workerImageDigest: z.literal(
      B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.workerImageDigest,
    ),
    revision: z.literal(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.revision),
    workerService: z.literal(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.workerService),
    canonicalServiceUrl: z.literal(
      B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.canonicalServiceUrl,
    ),
    taggedServiceUrl: z.literal(
      B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.taggedServiceUrl,
    ),
    trafficTag: z.literal(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.trafficTag),
    trafficPercent: z.literal(100),
  }).strict(),
  failedPreparation: z.object({
    preparationId: z.literal(
      B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationId,
    ),
    intent: z.object({
      objectUri: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationIntentUri,
      ),
      generation: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationIntentGeneration,
      ),
      sha256: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationIntentSha256,
      ),
    }).strict(),
    outcome: z.object({
      objectUri: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationOutcomeUri,
      ),
      observedAbsent: z.literal(true),
      observedAbsentAt: timestamp,
    }).strict(),
    fundedProbeRunId: z.literal(
      B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.fundedProbeRunId,
    ),
    failureStage: z.literal('TAGGED_URL_VALIDATION_BEFORE_HTTP'),
  }).strict(),
  observations: z.object({
    observedAt: timestamp,
    cloudRun: z.object({
      requestCount: z.literal(0),
      filter: z.literal(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.cloudRunLogFilter),
      observationStartedAt: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.cloudRunObservationStartedAt,
      ),
      observationEndedAt: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.cloudRunObservationEndedAt,
      ),
      exportSha256: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.cloudRunExportSha256,
      ),
    }).strict(),
    treasury: z.object({
      planInputSha256: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.treasuryPlanInputSha256,
      ),
      planDigest: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.treasuryPlanDigest,
      ),
      confirmedOutputCount: z.literal(32),
      confirmedTotalSats: z.literal(169_482),
      confirmedOutpointValueExportSha256: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.confirmedOutpointValueExportSha256,
      ),
      confirmedOutpointValueSerialization: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.confirmedOutpointValueSerialization,
      ),
      minimumConfirmationsFloor: z.literal(12),
      unconfirmedOutputCount: z.literal(0),
      minconfZeroMatchesMinconfOne: z.literal(true),
      exportSchemaVersion: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.coreUtxoExportSchemaVersion,
      ),
      exportSha256: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.coreUtxoExportSha256,
      ),
      observedStartedAt: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.coreUtxoObservedStartedAt,
      ),
      observedEndedAt: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.coreUtxoObservedEndedAt,
      ),
      changed: z.literal(false),
    }).strict(),
    supabase: z.object({
      projectRef: z.literal(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.supabaseProjectRef),
      runOrgId: z.literal(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.runOrgId),
      anchors: z.literal(0),
      anchorProofs: z.literal(0),
      organizations: z.literal(0),
      orgCredits: z.literal(0),
      exportSha256: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.supabaseZeroResidueExportSha256,
      ),
      observedAt: z.literal(
        B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.supabaseZeroResidueObservedAt,
      ),
    }).strict(),
    invocationLeaseRemoved: z.literal(true),
    schedulerJobs: z.array(schedulerJobSchema).length(6),
    allSixSchedulersPaused: z.literal(true),
  }).strict(),
  authorization: z.object({
    successorPreparationId: boundedId,
    successorPrepareCount: z.literal(1),
  }).strict(),
  issuedAt: timestamp,
  expiresAt: timestamp,
  verdict: z.literal('NO_BROADCAST_PREPARE_CONTAINED_ONE_SUCCESSOR_AUTHORIZED'),
}).strict().superRefine((payload, context) => {
  if (payload.authorization.successorPreparationId
      === B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationId) {
    context.addIssue({
      code: 'custom', path: ['authorization', 'successorPreparationId'],
      message: 'Successor PREPARE must use a fresh preparation id.',
    });
  }
  if (Date.parse(payload.observations.cloudRun.observationStartedAt)
      > Date.parse(payload.observations.cloudRun.observationEndedAt)) {
    context.addIssue({
      code: 'custom', path: ['observations', 'cloudRun'],
      message: 'Cloud Run observation window is inverted.',
    });
  }
  const names = payload.observations.schedulerJobs.map(({ name }) => name);
  if (JSON.stringify(names)
      !== JSON.stringify(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.schedulerJobNames)) {
    context.addIssue({
      code: 'custom', path: ['observations', 'schedulerJobs'],
      message: 'Scheduler containment does not name the six exact B1 jobs in contract order.',
    });
  }
  const absenceAt = Date.parse(payload.failedPreparation.outcome.observedAbsentAt);
  const evidenceTimes = [
    Date.parse(payload.observations.cloudRun.observationEndedAt),
    Date.parse(payload.observations.treasury.observedEndedAt),
    Date.parse(payload.observations.supabase.observedAt),
  ];
  if (absenceAt < Date.parse(payload.observations.cloudRun.observationEndedAt)
    || Date.parse(payload.observations.observedAt) < Math.max(absenceAt, ...evidenceTimes)
    || Date.parse(payload.issuedAt) < Date.parse(payload.observations.observedAt)) {
    context.addIssue({
      code: 'custom', path: ['issuedAt'],
      message: 'Containment chronology precedes outcome absence or evidence observations.',
    });
  }
});

const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  envelopeId: boundedId,
  keyId: z.literal(B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.keyId),
  keyFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  signedPayloadRaw: z.string().min(1).max(64 * 1024),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
}).strict();

export type B1NoBroadcastPrepareContainmentPayload = z.infer<typeof payloadSchema>;

export interface B1NoBroadcastPrepareLockedObject {
  readonly uri: string;
  readonly generation: string;
  readonly raw: string;
  readonly retainUntilTime: string;
}

export interface VerifiedB1NoBroadcastPrepareContainment {
  readonly status: 'VERIFIED_NO_BROADCAST_PREPARE_CONTAINMENT';
  readonly recovery: B1NoBroadcastPrepareRecovery;
  readonly expiresAt: string;
}

interface VerifierConfig {
  readonly publicKeyPem: string;
  readonly keyFingerprint: string;
}

function digest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function derivedRunId(intentRaw: string): string {
  const intent = z.object({
    preparationId: z.literal(
      B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.failedPreparationId,
    ),
    idempotencyKey: sha256,
  }).passthrough().parse(parseJsonRejectingDuplicateKeys(
    intentRaw,
    'RIG-B1 contained PREPARE intent',
  ));
  return `b1-preclock-${createHash('sha256')
    .update(`${intent.preparationId}:${intent.idempotencyKey}`)
    .digest('hex').slice(0, 32)}`;
}

/** Canonical bytes for the founder/CTO containment signature. */
export function buildB1NoBroadcastPrepareContainmentSignedPayload(
  input: B1NoBroadcastPrepareContainmentPayload,
): string {
  return JSON.stringify(payloadSchema.parse(input));
}

class B1NoBroadcastPrepareContainmentVerifier {
  private readonly publicKey;

  constructor(private readonly config: VerifierConfig) {
    this.publicKey = createPublicKey(config.publicKeyPem);
    const fingerprint = createHash('sha256')
      .update(this.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    if (this.publicKey.asymmetricKeyType !== 'ed25519'
      || fingerprint !== config.keyFingerprint) {
      throw new Error('RIG-B1 no-broadcast containment trust root is invalid.');
    }
  }

  verify(input: Readonly<{
    recovery: B1NoBroadcastPrepareRecovery;
    containment: B1NoBroadcastPrepareLockedObject;
    intent: B1NoBroadcastPrepareLockedObject;
    verificationTime: Date;
  }>): VerifiedB1NoBroadcastPrepareContainment {
    const recovery = b1NoBroadcastPrepareRecoverySchema.parse(input.recovery);
    if (input.containment.uri !== recovery.containment.objectUri
      || input.containment.generation !== recovery.containment.generation
      || digest(input.containment.raw) !== recovery.containment.envelopeSha256
      || input.intent.uri !== recovery.failedPreparation.intent.objectUri
      || input.intent.generation !== recovery.failedPreparation.intent.generation
      || digest(input.intent.raw) !== recovery.failedPreparation.intent.sha256
      || derivedRunId(input.intent.raw) !== recovery.failedPreparation.fundedProbeRunId) {
      throw new Error('RIG-B1 no-broadcast containment immutable references differ.');
    }
    const envelope = envelopeSchema.parse(parseJsonRejectingDuplicateKeys(
      input.containment.raw,
      'RIG-B1 no-broadcast PREPARE containment envelope',
    ));
    const signature = Buffer.from(envelope.signature, 'base64');
    if (envelope.keyFingerprint !== this.config.keyFingerprint
      || signature.length !== 64
      || !verifySignature(
        null,
        Buffer.from(`${DOMAIN}${envelope.signedPayloadRaw}`),
        this.publicKey,
        signature,
      )
      || digest(envelope.signedPayloadRaw) !== recovery.containment.signedPayloadSha256) {
      throw new Error('RIG-B1 no-broadcast containment signature or digest is invalid.');
    }
    const payload = payloadSchema.parse(parseJsonRejectingDuplicateKeys(
      envelope.signedPayloadRaw,
      'RIG-B1 no-broadcast PREPARE containment payload',
    ));
    const now = input.verificationTime.getTime();
    if (payload.authority.keyFingerprint !== this.config.keyFingerprint
      || envelope.envelopeId !== payload.containmentId
      || payload.authorization.successorPreparationId !== recovery.successorPreparationId
      || payload.authorization.successorPrepareCount !== recovery.successorPrepareCount
      || !Number.isFinite(now)
      || Date.parse(payload.issuedAt) >= Date.parse(payload.expiresAt)
      || now < Date.parse(payload.issuedAt)
      || now >= Date.parse(payload.expiresAt)
      || Date.parse(input.containment.retainUntilTime) < Date.parse(payload.expiresAt)
      || Date.parse(input.intent.retainUntilTime) < Date.parse(payload.expiresAt)) {
      throw new Error('RIG-B1 no-broadcast containment identity, chronology, or retention differs.');
    }
    return Object.freeze({
      status: 'VERIFIED_NO_BROADCAST_PREPARE_CONTAINMENT' as const,
      recovery,
      expiresAt: payload.expiresAt,
    });
  }
}

export function createProductionB1NoBroadcastPrepareContainmentVerifier():
B1NoBroadcastPrepareContainmentVerifier {
  return new B1NoBroadcastPrepareContainmentVerifier({
    publicKeyPem: PUBLIC_KEY_PEM,
    keyFingerprint: B1_NO_BROADCAST_PREPARE_CONTAINMENT_CONTRACT.keyFingerprint,
  });
}

/** Test-only trust-root injection. */
export function createB1NoBroadcastPrepareContainmentVerifierForTest(
  config: VerifierConfig,
): B1NoBroadcastPrepareContainmentVerifier {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Injected RIG-B1 no-broadcast containment trust roots are test-only.');
  }
  return new B1NoBroadcastPrepareContainmentVerifier(config);
}
