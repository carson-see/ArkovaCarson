/** Strict founder/CTO START_B1 action authority and canonical request bytes. */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';

import { z } from 'zod';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';

const PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAE+Ir2My5+bBwU73QkL73F7fiRteZ0V5yIAe41fD6MdU=\n-----END PUBLIC KEY-----\n';

export const B1_START_APPROVAL_SIGNATURE_DOMAIN =
  'arkova:s33:rig-b1-start:v1\n';

const WORKER_SERVICE = 'arkova-worker-s33-rig-b1-staging';
const LEDGER_BASE_URI = 'gs://arkova1-s33-immutable-authority-ledger/s33/rig-b1';
const WORKER_IMAGE_REPOSITORY =
  'us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker';
const JOB_SUFFIXES = [
  'batch-anchors',
  'batch-anchors-forced-flush',
  'check-confirmations',
  'org-queue-scheduler',
  'populate-confirmation-proofs',
  'recover-broadcasts',
] as const;
const SCHEDULER_JOB_RESOURCES = JOB_SUFFIXES.map((suffix) => (
  `projects/arkova1/locations/us-central1/jobs/${WORKER_SERVICE}-${suffix}`
)) as [string, string, string, string, string, string];

export const B1_START_AUTHORITY_CONTRACT = Object.freeze({
  schemaVersion: 1,
  keyId: 'arkova.s33.b1-evidence.ed25519.v1',
  keyFingerprint: '8b7fbc51c74828dab2e1a3ca6f0c15069575bae8e4e190eaf3b165daea50d5c6',
  approverIdentity: 'arkova.s33.approver.founder-cto.v1',
  verifierIdentity: 'arkova.s33.verifier.public-ed25519.v1',
  purpose: 'START_B1',
  maxActionTtlMs: 10 * 60_000,
  maxRunWindowMs: 7 * 24 * 60 * 60_000,
  requiredWorkerUptimeMin: 2_880,
  requiredWallMin: 2_910,
  heartbeatIntervalMaxSeconds: 240,
  invocationLeaseMaxSeconds: 600,
  rigName: 's33-rig-b1',
  workerService: WORKER_SERVICE,
  workerRuntimeServiceAccount: 's33-rig-b1-runtime@arkova1.iam.gserviceaccount.com',
  schedulerOidcServiceAccount: 's33-rig-b1-cron@arkova1.iam.gserviceaccount.com',
  schedulerCadence: '*/5 * * * *',
  schedulerJobResources: Object.freeze([...SCHEDULER_JOB_RESOURCES]),
  ledgerBaseUri: LEDGER_BASE_URI,
} as const);

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);
const timestamp = z.string().datetime({ offset: true });
const numericGeneration = z.string().regex(/^[1-9][0-9]*$/u);
const signatureBase64 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/u);
const pinnedWorkerImage = z.string().regex(new RegExp(
  `^${WORKER_IMAGE_REPOSITORY.replaceAll('.', '[.]')}@sha256:[0-9a-f]{64}$`,
  'u',
));

const lockedReferenceSchema = z.object({
  objectUri: z.string().min(1).max(1_024),
  generation: numericGeneration,
  sha256,
}).strict();

const payloadSchema = z.object({
  schemaVersion: z.literal(B1_START_AUTHORITY_CONTRACT.schemaVersion),
  startId: boundedId,
  authority: z.object({
    keyId: z.literal(B1_START_AUTHORITY_CONTRACT.keyId),
    approverIdentity: z.literal(B1_START_AUTHORITY_CONTRACT.approverIdentity),
    purpose: z.literal(B1_START_AUTHORITY_CONTRACT.purpose),
  }).strict(),
  candidate: z.object({
    sourceHeadSha: gitSha,
    sourceTreeSha: gitSha,
    workerImage: pinnedWorkerImage,
    workerImageDigest: sha256,
    corpusDigest: sha256,
    releaseCandidateId: boundedId,
  }).strict(),
  prerequisites: z.object({
    provision: z.object({
      approvalId: boundedId,
      approvalEnvelopeSha256: sha256,
      signedPayloadSha256: sha256,
      admissionSha256: sha256,
      approvalClaim: lockedReferenceSchema,
      topologyOwnership: lockedReferenceSchema,
    }).strict(),
    preparation: z.object({
      preparationId: boundedId,
      approvalEnvelopeSha256: sha256,
      signedPayloadSha256: sha256,
      intent: lockedReferenceSchema,
      outcome: lockedReferenceSchema,
      preclockArtifactSha256: sha256,
    }).strict(),
  }).strict(),
  run: z.object({
    rigName: z.literal(B1_START_AUTHORITY_CONTRACT.rigName),
    soakId: boundedId,
    leaseId: boundedId,
    workerService: z.literal(B1_START_AUTHORITY_CONTRACT.workerService),
    workerRuntimeServiceAccount: z.literal(
      B1_START_AUTHORITY_CONTRACT.workerRuntimeServiceAccount,
    ),
    schedulerOidcServiceAccount: z.literal(
      B1_START_AUTHORITY_CONTRACT.schedulerOidcServiceAccount,
    ),
    schedulerJobResources: z.tuple(SCHEDULER_JOB_RESOURCES.map((resource) => (
      z.literal(resource)
    )) as [
      z.ZodLiteral<string>, z.ZodLiteral<string>, z.ZodLiteral<string>,
      z.ZodLiteral<string>, z.ZodLiteral<string>, z.ZodLiteral<string>,
    ]),
    schedulerCadence: z.literal(B1_START_AUTHORITY_CONTRACT.schedulerCadence),
    requiredWorkerUptimeMin: z.literal(B1_START_AUTHORITY_CONTRACT.requiredWorkerUptimeMin),
    requiredWallMin: z.literal(B1_START_AUTHORITY_CONTRACT.requiredWallMin),
    heartbeatIntervalMaxSeconds: z.literal(
      B1_START_AUTHORITY_CONTRACT.heartbeatIntervalMaxSeconds,
    ),
    invocationLeaseMaxSeconds: z.literal(
      B1_START_AUTHORITY_CONTRACT.invocationLeaseMaxSeconds,
    ),
    runHardStopAt: timestamp,
  }).strict(),
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict().superRefine((payload, context) => {
  if (!payload.candidate.workerImage.endsWith(`@${payload.candidate.workerImageDigest}`)) {
    context.addIssue({
      code: 'custom',
      path: ['candidate', 'workerImageDigest'],
      message: 'START_B1 worker image does not bind its exact digest.',
    });
  }
  const claimUri = `${LEDGER_BASE_URI}/node-approval-claims/${payload.prerequisites.provision.approvalId}.json`;
  const topologyUri = `${LEDGER_BASE_URI}/topology-ownership/${payload.prerequisites.provision.approvalId}.json`;
  const intentUri = `${LEDGER_BASE_URI}/preparation-intents/${payload.prerequisites.preparation.preparationId}.json`;
  const outcomeUri = `${LEDGER_BASE_URI}/preparation-outcomes/${payload.prerequisites.preparation.preparationId}.json`;
  const exactReferences = [
    [payload.prerequisites.provision.approvalClaim.objectUri, claimUri, ['prerequisites', 'provision', 'approvalClaim', 'objectUri']],
    [payload.prerequisites.provision.topologyOwnership.objectUri, topologyUri, ['prerequisites', 'provision', 'topologyOwnership', 'objectUri']],
    [payload.prerequisites.preparation.intent.objectUri, intentUri, ['prerequisites', 'preparation', 'intent', 'objectUri']],
    [payload.prerequisites.preparation.outcome.objectUri, outcomeUri, ['prerequisites', 'preparation', 'outcome', 'objectUri']],
  ] as const;
  for (const [observed, expected, path] of exactReferences) {
    if (observed !== expected) {
      context.addIssue({ code: 'custom', path: [...path], message: 'START_B1 Locked reference URI is not exact.' });
    }
  }
});

const envelopeSchema = z.object({
  schemaVersion: z.literal(B1_START_AUTHORITY_CONTRACT.schemaVersion),
  envelopeId: boundedId,
  keyId: z.literal(B1_START_AUTHORITY_CONTRACT.keyId),
  keyFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  signedPayloadRaw: z.string().min(1).max(64 * 1_024),
  signature: signatureBase64,
}).strict();

export type B1StartAuthorityPayload = z.infer<typeof payloadSchema>;

export interface VerifiedB1StartAuthority extends B1StartAuthorityPayload {
  readonly status: 'VERIFIED';
  readonly verifierIdentity: typeof B1_START_AUTHORITY_CONTRACT.verifierIdentity;
  readonly envelopeSha256: string;
  readonly signedPayloadSha256: string;
}

export interface B1StartAuthorityVerifier {
  verify(raw: string, now: Date): VerifiedB1StartAuthority;
}

interface VerifierConfig {
  readonly publicKeyPem: string;
  readonly keyFingerprint: string;
}

function digest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

/** Canonical unsigned request bytes. The signer signs domain || these exact bytes. */
export function buildB1StartAuthoritySignedPayload(input: B1StartAuthorityPayload): string {
  return JSON.stringify(payloadSchema.parse(input));
}

/** Strict parser shared by request generation and verification. */
export function parseB1StartAuthoritySignedPayload(raw: string): B1StartAuthorityPayload {
  return Object.freeze(payloadSchema.parse(parseJsonRejectingDuplicateKeys(
    raw,
    'RIG-B1 START unsigned request payload',
  )));
}

class Ed25519B1StartAuthorityVerifier implements B1StartAuthorityVerifier {
  private readonly publicKey;

  constructor(private readonly config: VerifierConfig) {
    this.publicKey = createPublicKey(config.publicKeyPem);
    if (this.publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('RIG-B1 START authority trust root must be Ed25519.');
    }
    const fingerprint = createHash('sha256')
      .update(this.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    if (fingerprint !== config.keyFingerprint) {
      throw new Error('RIG-B1 START authority trust-root fingerprint is invalid.');
    }
  }

  verify(raw: string, now: Date): VerifiedB1StartAuthority {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('RIG-B1 START authority verification time is invalid.');
    }
    const envelope = envelopeSchema.parse(
      parseJsonRejectingDuplicateKeys(raw, 'RIG-B1 START authority envelope'),
    );
    if (envelope.keyFingerprint !== this.config.keyFingerprint) {
      throw new Error('RIG-B1 START authority envelope names an untrusted fingerprint.');
    }
    const signature = Buffer.from(envelope.signature, 'base64');
    const signedBytes = Buffer.concat([
      Buffer.from(B1_START_APPROVAL_SIGNATURE_DOMAIN),
      Buffer.from(envelope.signedPayloadRaw),
    ]);
    if (signature.length !== 64
      || !verifySignature(null, signedBytes, this.publicKey, signature)) {
      throw new Error('RIG-B1 START authority Ed25519 signature is invalid.');
    }
    const payload = parseB1StartAuthoritySignedPayload(envelope.signedPayloadRaw);
    if (envelope.envelopeId !== payload.startId) {
      throw new Error('RIG-B1 START envelope id differs from the signed start id.');
    }
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    const runHardStopAt = Date.parse(payload.run.runHardStopAt);
    const minimumWallMs = B1_START_AUTHORITY_CONTRACT.requiredWallMin * 60_000;
    if (issuedAt >= expiresAt
      || expiresAt - issuedAt > B1_START_AUTHORITY_CONTRACT.maxActionTtlMs
      || issuedAt > now.getTime() + 60_000
      || now.getTime() >= expiresAt) {
      throw new Error('RIG-B1 START action authority is expired, future-dated, or exceeds ten minutes.');
    }
    if (runHardStopAt < expiresAt + minimumWallMs
      || runHardStopAt > issuedAt + B1_START_AUTHORITY_CONTRACT.maxRunWindowMs
      || runHardStopAt < now.getTime() + minimumWallMs) {
      throw new Error('RIG-B1 START hard stop does not cover the full wall or exceeds seven days.');
    }
    return Object.freeze({
      ...payload,
      status: 'VERIFIED' as const,
      verifierIdentity: B1_START_AUTHORITY_CONTRACT.verifierIdentity,
      envelopeSha256: digest(raw),
      signedPayloadSha256: digest(envelope.signedPayloadRaw),
    });
  }
}

export function createProductionB1StartAuthorityVerifier(): B1StartAuthorityVerifier {
  return new Ed25519B1StartAuthorityVerifier({
    publicKeyPem: PUBLIC_KEY_PEM,
    keyFingerprint: B1_START_AUTHORITY_CONTRACT.keyFingerprint,
  });
}

/** Test-only trust-root injection. */
export function createB1StartAuthorityVerifierForTest(
  config: VerifierConfig,
): B1StartAuthorityVerifier {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Injected RIG-B1 START authority trust roots are test-only.');
  }
  return new Ed25519B1StartAuthorityVerifier(config);
}
