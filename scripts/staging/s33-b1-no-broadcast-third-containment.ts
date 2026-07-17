/** One-successor authority after the second authorized successor failed before its POST. */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

import { z } from 'zod';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import type { B1NoBroadcastPrepareLockedObject } from './s33-b1-no-broadcast-prepare-containment';
import {
  B1_NO_BROADCAST_SUCCESSOR_CONTAINMENT_CONTRACT as PRIOR,
  b1NoBroadcastSuccessorRecoverySchema,
  type B1NoBroadcastSuccessorRecovery,
} from './s33-b1-no-broadcast-successor-containment';

const PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAE+Ir2My5+bBwU73QkL73F7fiRteZ0V5yIAe41fD6MdU=\n-----END PUBLIC KEY-----\n';
const DOMAIN = 'arkova:s33:rig-b1-no-broadcast-third-prepare-containment:v1\n';

export const B1_NO_BROADCAST_THIRD_CONTAINMENT_CONTRACT = Object.freeze({
  schemaVersion: 1,
  payloadSchemaVersion: 'arkova.s33.rig-b1.no-broadcast-third-prepare-containment/v1',
  recoverySchemaVersion: 'arkova.s33.rig-b1.no-broadcast-third-prepare-recovery/v1',
  keyId: PRIOR.keyId,
  keyFingerprint: PRIOR.keyFingerprint,
  approverIdentity: PRIOR.approverIdentity,
  purpose: 'AUTHORIZE_ONE_SUCCESSOR_PREPARE_B1_AFTER_THIRD_PROVEN_NO_BROADCAST',
  signatureDomain: DOMAIN,
  sourceHeadSha: PRIOR.sourceHeadSha,
  sourceTreeSha: PRIOR.sourceTreeSha,
  workerImageDigest: PRIOR.workerImageDigest,
  revision: PRIOR.revision,
  workerService: PRIOR.workerService,
  canonicalServiceUrl: PRIOR.canonicalServiceUrl,
  taggedServiceUrl: PRIOR.taggedServiceUrl,
  trafficTag: PRIOR.trafficTag,
  failedPreparationId: 'b1-prepare-c56c7729-20260717t044423z',
  failedPreparationIntentUri:
    'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/preparation-intents/b1-prepare-c56c7729-20260717t044423z.json',
  failedPreparationIntentGeneration: '1784263656752579',
  failedPreparationIntentSha256:
    'sha256:3a77f83460aea2c7214f2ce4d8fe4accfcfe09354fc55c54a3eb1ccda27c41ba',
  failedPreparationOutcomeUri:
    'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1/preparation-outcomes/b1-prepare-c56c7729-20260717t044423z.json',
  fundedProbeRunId: 'b1-preclock-61d1cc9c784311b1bb94b68607578d3e',
  runOrgId: PRIOR.runOrgId,
  supabaseProjectRef: PRIOR.supabaseProjectRef,
  treasuryPlanInputSha256: PRIOR.treasuryPlanInputSha256,
  treasuryPlanDigest: PRIOR.treasuryPlanDigest,
  confirmedOutputCount: PRIOR.confirmedOutputCount,
  confirmedTotalSats: PRIOR.confirmedTotalSats,
  confirmedOutpointValueExportSha256: PRIOR.confirmedOutpointValueExportSha256,
  postLogFilter: `${PRIOR.cloudRunLogFilter} AND httpRequest.requestMethod="POST"`,
  postObservationStartedAt: '2026-07-17T04:47:00.000Z',
  postObservationEndedAt: '2026-07-17T04:48:10.000Z',
  postExportSha256: PRIOR.cloudRunExportSha256,
  healthUrl: `${PRIOR.taggedServiceUrl}/health`,
  healthObservedAt: '2026-07-17T04:47:29.713888Z',
  schedulerJobNames: PRIOR.schedulerJobNames,
  successorPrepareCount: 1,
} as const);

const CONTRACT = B1_NO_BROADCAST_THIRD_CONTAINMENT_CONTRACT;
const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);
const timestamp = z.string().datetime({ offset: true });
const generation = z.string().regex(/^[1-9][0-9]*$/u);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const b1NoBroadcastThirdRecoverySchema = z.object({
  schemaVersion: z.literal(CONTRACT.recoverySchemaVersion),
  priorRecovery: b1NoBroadcastSuccessorRecoverySchema,
  containment: z.object({
    objectUri: z.string().min(1), generation, envelopeSha256: sha256, signedPayloadSha256: sha256,
  }).strict(),
  failedPreparation: z.object({
    preparationId: z.literal(CONTRACT.failedPreparationId),
    intent: z.object({
      objectUri: z.literal(CONTRACT.failedPreparationIntentUri),
      generation: z.literal(CONTRACT.failedPreparationIntentGeneration),
      sha256: z.literal(CONTRACT.failedPreparationIntentSha256),
    }).strict(),
    outcomeObjectUri: z.literal(CONTRACT.failedPreparationOutcomeUri),
    fundedProbeRunId: z.literal(CONTRACT.fundedProbeRunId),
  }).strict(),
  successorPreparationId: boundedId,
  successorPrepareCount: z.literal(1),
}).strict().superRefine((value, context) => {
  if (value.priorRecovery.successorPreparationId !== value.failedPreparation.preparationId) {
    context.addIssue({
      code: 'custom', path: ['priorRecovery', 'successorPreparationId'],
      message: 'Third containment must continue the exact second successor PREPARE chain.',
    });
  }
  if (value.successorPreparationId === value.failedPreparation.preparationId) {
    context.addIssue({
      code: 'custom', path: ['successorPreparationId'],
      message: 'Third containment successor PREPARE must use a fresh id.',
    });
  }
});

export type B1NoBroadcastThirdRecovery = z.infer<typeof b1NoBroadcastThirdRecoverySchema>;

const schedulerJobSchema = z.object({
  name: z.string().min(1), state: z.literal('PAUSED'), schedule: z.literal('*/5 * * * *'),
}).strict();

const payloadSchema = z.object({
  schemaVersion: z.literal(CONTRACT.payloadSchemaVersion),
  containmentId: boundedId,
  authority: z.object({
    keyId: z.literal(CONTRACT.keyId),
    keyFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    approverIdentity: z.literal(CONTRACT.approverIdentity),
    purpose: z.literal(CONTRACT.purpose),
    signatureDomain: z.literal(DOMAIN),
  }).strict(),
  priorRecovery: b1NoBroadcastSuccessorRecoverySchema,
  candidate: z.object({
    sourceHeadSha: z.literal(CONTRACT.sourceHeadSha),
    sourceTreeSha: z.literal(CONTRACT.sourceTreeSha),
    workerImageDigest: z.literal(CONTRACT.workerImageDigest),
    revision: z.literal(CONTRACT.revision),
    workerService: z.literal(CONTRACT.workerService),
    canonicalServiceUrl: z.literal(CONTRACT.canonicalServiceUrl),
    taggedServiceUrl: z.literal(CONTRACT.taggedServiceUrl),
    trafficTag: z.literal(CONTRACT.trafficTag),
    trafficPercent: z.literal(100),
  }).strict(),
  failedPreparation: z.object({
    preparationId: z.literal(CONTRACT.failedPreparationId),
    intent: z.object({
      objectUri: z.literal(CONTRACT.failedPreparationIntentUri),
      generation: z.literal(CONTRACT.failedPreparationIntentGeneration),
      sha256: z.literal(CONTRACT.failedPreparationIntentSha256),
    }).strict(),
    outcome: z.object({
      objectUri: z.literal(CONTRACT.failedPreparationOutcomeUri),
      observedAbsent: z.literal(true),
      observedAbsentAt: timestamp,
    }).strict(),
    fundedProbeRunId: z.literal(CONTRACT.fundedProbeRunId),
    failureStage: z.literal('EVIDENCE_PATH_ALLOWLIST_BEFORE_POST'),
  }).strict(),
  observations: z.object({
    observedAt: timestamp,
    cloudRunPost: z.object({
      requestCount: z.literal(0),
      filter: z.literal(CONTRACT.postLogFilter),
      observationStartedAt: z.literal(CONTRACT.postObservationStartedAt),
      observationEndedAt: z.literal(CONTRACT.postObservationEndedAt),
      exportSha256: z.literal(CONTRACT.postExportSha256),
    }).strict(),
    taggedHealthGet: z.object({
      requestMethod: z.literal('GET'),
      requestUrl: z.literal(CONTRACT.healthUrl),
      status: z.literal(200),
      observedAt: z.literal(CONTRACT.healthObservedAt),
    }).strict(),
    treasury: z.object({
      planInputSha256: z.literal(CONTRACT.treasuryPlanInputSha256),
      planDigest: z.literal(CONTRACT.treasuryPlanDigest),
      confirmedOutputCount: z.literal(CONTRACT.confirmedOutputCount),
      confirmedTotalSats: z.literal(CONTRACT.confirmedTotalSats),
      confirmedOutpointValueExportSha256: z.literal(
        CONTRACT.confirmedOutpointValueExportSha256,
      ),
      unconfirmedOutputCount: z.literal(0),
      changed: z.literal(false),
      observedAt: timestamp,
    }).strict(),
    supabase: z.object({
      projectRef: z.literal(CONTRACT.supabaseProjectRef),
      runOrgId: z.literal(CONTRACT.runOrgId),
      anchors: z.literal(0), anchorProofs: z.literal(0),
      organizations: z.literal(0), orgCredits: z.literal(0),
      observedAt: timestamp,
    }).strict(),
    invocationLeaseRemoved: z.literal(true),
    schedulerJobs: z.array(schedulerJobSchema).length(6),
    allSixSchedulersPaused: z.literal(true),
  }).strict(),
  authorization: z.object({
    successorPreparationId: boundedId, successorPrepareCount: z.literal(1),
  }).strict(),
  issuedAt: timestamp,
  expiresAt: timestamp,
  verdict: z.literal('THIRD_NO_BROADCAST_PREPARE_CONTAINED_ONE_SUCCESSOR_AUTHORIZED'),
}).strict().superRefine((payload, context) => {
  if (payload.priorRecovery.successorPreparationId !== CONTRACT.failedPreparationId) {
    context.addIssue({
      code: 'custom', path: ['priorRecovery', 'successorPreparationId'],
      message: 'Third containment does not continue the exact second successor PREPARE.',
    });
  }
  if (payload.authorization.successorPreparationId === CONTRACT.failedPreparationId) {
    context.addIssue({
      code: 'custom', path: ['authorization', 'successorPreparationId'],
      message: 'Third containment successor PREPARE must use a fresh id.',
    });
  }
  const names = payload.observations.schedulerJobs.map(({ name }) => name);
  if (JSON.stringify(names) !== JSON.stringify(CONTRACT.schedulerJobNames)) {
    context.addIssue({
      code: 'custom', path: ['observations', 'schedulerJobs'],
      message: 'Third containment must name the six exact PAUSED B1 jobs in contract order.',
    });
  }
  const evidenceCompleteAt = Math.max(
    Date.parse(payload.failedPreparation.outcome.observedAbsentAt),
    Date.parse(payload.observations.cloudRunPost.observationEndedAt),
    Date.parse(payload.observations.taggedHealthGet.observedAt),
    Date.parse(payload.observations.treasury.observedAt),
    Date.parse(payload.observations.supabase.observedAt),
  );
  if (Date.parse(payload.observations.observedAt) < evidenceCompleteAt
    || Date.parse(payload.issuedAt) < Date.parse(payload.observations.observedAt)
    || Date.parse(payload.issuedAt) >= Date.parse(payload.expiresAt)) {
    context.addIssue({
      code: 'custom', path: ['issuedAt'],
      message: 'Third containment chronology precedes its no-broadcast observations.',
    });
  }
});

const envelopeSchema = z.object({
  schemaVersion: z.literal(1), envelopeId: boundedId,
  keyId: z.literal(CONTRACT.keyId),
  keyFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  signedPayloadRaw: z.string().min(1).max(64 * 1024),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
}).strict();

export type B1NoBroadcastThirdContainmentPayload = z.infer<typeof payloadSchema>;

export interface VerifiedB1NoBroadcastThirdContainment {
  readonly status: 'VERIFIED_THIRD_NO_BROADCAST_PREPARE_CONTAINMENT';
  readonly recovery: B1NoBroadcastThirdRecovery;
  readonly expiresAt: string;
}

function digest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

function derivedRunId(intentRaw: string): string {
  const intent = z.object({
    preparationId: z.literal(CONTRACT.failedPreparationId), idempotencyKey: sha256,
  }).passthrough().parse(parseJsonRejectingDuplicateKeys(
    intentRaw, 'RIG-B1 third contained PREPARE intent',
  ));
  return `b1-preclock-${createHash('sha256')
    .update(`${intent.preparationId}:${intent.idempotencyKey}`).digest('hex').slice(0, 32)}`;
}

export function buildB1NoBroadcastThirdContainmentSignedPayload(
  input: B1NoBroadcastThirdContainmentPayload,
): string {
  return JSON.stringify(payloadSchema.parse(input));
}

class B1NoBroadcastThirdContainmentVerifier {
  private readonly publicKey;

  constructor(private readonly config: { readonly publicKeyPem: string; readonly keyFingerprint: string }) {
    this.publicKey = createPublicKey(config.publicKeyPem);
    const fingerprint = createHash('sha256')
      .update(this.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    if (this.publicKey.asymmetricKeyType !== 'ed25519' || fingerprint !== config.keyFingerprint) {
      throw new Error('RIG-B1 third no-broadcast containment trust root is invalid.');
    }
  }

  verify(input: Readonly<{
    recovery: B1NoBroadcastThirdRecovery;
    containment: B1NoBroadcastPrepareLockedObject;
    intent: B1NoBroadcastPrepareLockedObject;
    verificationTime: Date;
  }>): VerifiedB1NoBroadcastThirdContainment {
    const recovery = b1NoBroadcastThirdRecoverySchema.parse(input.recovery);
    if (input.containment.uri !== recovery.containment.objectUri
      || input.containment.generation !== recovery.containment.generation
      || digest(input.containment.raw) !== recovery.containment.envelopeSha256
      || input.intent.uri !== recovery.failedPreparation.intent.objectUri
      || input.intent.generation !== recovery.failedPreparation.intent.generation
      || digest(input.intent.raw) !== recovery.failedPreparation.intent.sha256
      || derivedRunId(input.intent.raw) !== recovery.failedPreparation.fundedProbeRunId) {
      throw new Error('RIG-B1 third no-broadcast containment immutable references differ.');
    }
    const envelope = envelopeSchema.parse(parseJsonRejectingDuplicateKeys(
      input.containment.raw, 'RIG-B1 third no-broadcast containment envelope',
    ));
    const signature = Buffer.from(envelope.signature, 'base64');
    if (envelope.keyFingerprint !== this.config.keyFingerprint
      || signature.length !== 64
      || !verifySignature(
        null, Buffer.from(`${DOMAIN}${envelope.signedPayloadRaw}`), this.publicKey, signature,
      )
      || digest(envelope.signedPayloadRaw) !== recovery.containment.signedPayloadSha256) {
      throw new Error('RIG-B1 third no-broadcast containment signature or digest is invalid.');
    }
    const payload = payloadSchema.parse(parseJsonRejectingDuplicateKeys(
      envelope.signedPayloadRaw, 'RIG-B1 third no-broadcast containment payload',
    ));
    const now = input.verificationTime.getTime();
    if (payload.authority.keyFingerprint !== this.config.keyFingerprint
      || envelope.envelopeId !== payload.containmentId
      || JSON.stringify(payload.priorRecovery) !== JSON.stringify(recovery.priorRecovery)
      || payload.authorization.successorPreparationId !== recovery.successorPreparationId
      || payload.authorization.successorPrepareCount !== recovery.successorPrepareCount
      || !Number.isFinite(now)
      || now < Date.parse(payload.issuedAt) || now >= Date.parse(payload.expiresAt)
      || Date.parse(input.containment.retainUntilTime) < Date.parse(payload.expiresAt)
      || Date.parse(input.intent.retainUntilTime) < Date.parse(payload.expiresAt)) {
      throw new Error('RIG-B1 third no-broadcast containment chain, chronology, or retention differs.');
    }
    return Object.freeze({
      status: 'VERIFIED_THIRD_NO_BROADCAST_PREPARE_CONTAINMENT' as const,
      recovery,
      expiresAt: payload.expiresAt,
    });
  }
}

export function createProductionB1NoBroadcastThirdContainmentVerifier():
B1NoBroadcastThirdContainmentVerifier {
  return new B1NoBroadcastThirdContainmentVerifier({
    publicKeyPem: PUBLIC_KEY_PEM, keyFingerprint: CONTRACT.keyFingerprint,
  });
}

export function createB1NoBroadcastThirdContainmentVerifierForTest(
  config: { readonly publicKeyPem: string; readonly keyFingerprint: string },
): B1NoBroadcastThirdContainmentVerifier {
  if (process.env.NODE_ENV !== 'test') throw new Error('Injected containment trust roots are test-only.');
  return new B1NoBroadcastThirdContainmentVerifier(config);
}

export function assertB1NoBroadcastSuccessorRecoveryChain(
  priorRecovery: B1NoBroadcastSuccessorRecovery,
  thirdRecovery: B1NoBroadcastThirdRecovery,
): void {
  if (JSON.stringify(priorRecovery) !== JSON.stringify(thirdRecovery.priorRecovery)) {
    throw new Error('RIG-B1 third no-broadcast recovery does not preserve the exact second chain.');
  }
}
