/** Strict, short-lived founder/CTO authority for the one funded PREPARE_B1 probe. */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

import { z } from 'zod';

import { parseJsonRejectingDuplicateKeys } from './batch-drain-strict-json';
import { B1_SCHEDULER_START_CONTRACT } from './s33-b1-scheduler-start-driver';

const PUBLIC_KEY_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAE+Ir2My5+bBwU73QkL73F7fiRteZ0V5yIAe41fD6MdU=\n-----END PUBLIC KEY-----\n';

export const B1_PREPARATION_CONTRACT = Object.freeze({
  schemaVersion: 1,
  keyId: B1_SCHEDULER_START_CONTRACT.keyId,
  keyFingerprint: '8b7fbc51c74828dab2e1a3ca6f0c15069575bae8e4e190eaf3b165daea50d5c6',
  approverIdentity: 'arkova.s33.approver.founder-cto.v1',
  verifierIdentity: B1_SCHEDULER_START_CONTRACT.verifierIdentity,
  purpose: 'PREPARE_B1',
  maxAuthorityTtlMs: 10 * 60_000,
  maxInvocationLeaseSeconds: 600,
  maxFundedBroadcasts: 1,
} as const);

const boundedId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{2,127}$/u);
const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const gitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const signatureBase64 = z.string().regex(/^[A-Za-z0-9+/]{86}==$/u);

const payloadSchema = z.object({
  schemaVersion: z.literal(B1_PREPARATION_CONTRACT.schemaVersion),
  preparationId: boundedId,
  authority: z.object({
    keyId: z.literal(B1_PREPARATION_CONTRACT.keyId),
    approverIdentity: z.literal(B1_PREPARATION_CONTRACT.approverIdentity),
    purpose: z.literal(B1_PREPARATION_CONTRACT.purpose),
  }).strict(),
  candidate: z.object({
    admissionSha256: sha256,
    treasuryPlanSha256: sha256,
    sourceHeadSha: gitSha,
    sourceTreeSha: gitSha,
    workerImageDigest: sha256,
    corpusDigest: sha256,
    releaseCandidateId: boundedId,
    provisionApprovalEnvelopeSha256: sha256,
    provisionSignedPayloadSha256: sha256,
    continuityCompositeIdentitySha256: sha256.optional(),
  }).strict(),
  controller: z.object({
    sourceHeadSha: gitSha,
    sourceTreeSha: gitSha,
    relevantFilesSha256: sha256,
  }).strict().optional(),
  run: z.object({
    rigName: z.literal(B1_SCHEDULER_START_CONTRACT.rigName),
    soakId: boundedId,
    leaseId: boundedId,
    workerService: z.literal(B1_SCHEDULER_START_CONTRACT.workerService),
    schedulerOidcServiceAccount: z.literal(B1_SCHEDULER_START_CONTRACT.schedulerOidcServiceAccount),
  }).strict(),
  limits: z.object({
    maxFundedBroadcasts: z.literal(B1_PREPARATION_CONTRACT.maxFundedBroadcasts),
    invocationLeaseMaxSeconds: z.literal(B1_PREPARATION_CONTRACT.maxInvocationLeaseSeconds),
  }).strict(),
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict().superRefine((payload, context) => {
  if ((payload.candidate.continuityCompositeIdentitySha256 === undefined)
    !== (payload.controller === undefined)) {
    context.addIssue({
      code: 'custom',
      path: ['controller'],
      message: 'RIG-B1 PREPARE continuity and controller bindings must be present together.',
    });
  }
});

const envelopeSchema = z.object({
  schemaVersion: z.literal(B1_PREPARATION_CONTRACT.schemaVersion),
  envelopeId: boundedId,
  keyId: z.literal(B1_PREPARATION_CONTRACT.keyId),
  keyFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  signedPayloadRaw: z.string().min(1).max(64 * 1024),
  signature: signatureBase64,
}).strict();

export interface VerifiedB1PreparationAuthority {
  readonly status: 'VERIFIED';
  readonly verifierIdentity: typeof B1_PREPARATION_CONTRACT.verifierIdentity;
  readonly envelopeSha256: string;
  readonly signedPayloadSha256: string;
  readonly envelopeId: string;
  readonly preparationId: string;
  readonly admissionSha256: string;
  readonly treasuryPlanSha256: string;
  readonly sourceHeadSha: string;
  readonly sourceTreeSha: string;
  readonly workerImageDigest: string;
  readonly corpusDigest: string;
  readonly releaseCandidateId: string;
  readonly provisionApprovalEnvelopeSha256: string;
  readonly provisionSignedPayloadSha256: string;
  readonly continuityCompositeIdentitySha256?: string;
  readonly controllerSourceHeadSha?: string;
  readonly controllerSourceTreeSha?: string;
  readonly controllerRelevantFilesSha256?: string;
  readonly rigName: string;
  readonly soakId: string;
  readonly leaseId: string;
  readonly workerService: string;
  readonly schedulerOidcServiceAccount: string;
  readonly maxFundedBroadcasts: 1;
  readonly invocationLeaseMaxSeconds: 600;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface B1PreparationAuthorityVerifier {
  verify(raw: string, now: Date): VerifiedB1PreparationAuthority;
}

interface VerifierConfig {
  readonly publicKeyPem: string;
  readonly keyFingerprint: string;
}

function digest(raw: string): string {
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

export type B1PreparationAuthorityPayload = z.infer<typeof payloadSchema>;

/** Canonical request packet builder; signing systems sign these exact bytes. */
export function buildB1PreparationAuthoritySignedPayload(
  input: B1PreparationAuthorityPayload,
): string {
  return JSON.stringify(payloadSchema.parse(input));
}

/** Strict parser shared by request generation and verification. */
export function parseB1PreparationAuthoritySignedPayload(
  raw: string,
): B1PreparationAuthorityPayload {
  return Object.freeze(payloadSchema.parse(parseJsonRejectingDuplicateKeys(
    raw,
    'RIG-B1 PREPARE unsigned request payload',
  )));
}

class Ed25519B1PreparationAuthorityVerifier implements B1PreparationAuthorityVerifier {
  private readonly publicKey;

  constructor(private readonly config: VerifierConfig) {
    this.publicKey = createPublicKey(config.publicKeyPem);
    if (this.publicKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('RIG-B1 PREPARE authority trust root must be Ed25519.');
    }
    const observedFingerprint = createHash('sha256')
      .update(this.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    if (observedFingerprint !== config.keyFingerprint) {
      throw new Error('RIG-B1 PREPARE authority trust-root fingerprint is invalid.');
    }
  }

  verify(raw: string, now: Date): VerifiedB1PreparationAuthority {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('RIG-B1 PREPARE authority verification time is invalid.');
    }
    const envelope = envelopeSchema.parse(
      parseJsonRejectingDuplicateKeys(raw, 'RIG-B1 PREPARE authority envelope'),
    );
    if (envelope.keyFingerprint !== this.config.keyFingerprint) {
      throw new Error('RIG-B1 PREPARE authority envelope names an untrusted fingerprint.');
    }
    const signature = Buffer.from(envelope.signature, 'base64');
    if (signature.length !== 64
      || !verifySignature(null, Buffer.from(envelope.signedPayloadRaw), this.publicKey, signature)) {
      throw new Error('RIG-B1 PREPARE authority Ed25519 signature is invalid.');
    }
    const payload = parseB1PreparationAuthoritySignedPayload(envelope.signedPayloadRaw);
    if (envelope.envelopeId !== payload.preparationId) {
      throw new Error('RIG-B1 PREPARE envelope id differs from the signed preparation id.');
    }
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    if (issuedAt >= expiresAt
      || expiresAt - issuedAt > B1_PREPARATION_CONTRACT.maxAuthorityTtlMs
      || issuedAt > now.getTime() + 60_000
      || now.getTime() >= expiresAt) {
      throw new Error('RIG-B1 PREPARE authority is expired, future-dated, or exceeds the ten-minute TTL.');
    }
    return Object.freeze({
      status: 'VERIFIED' as const,
      verifierIdentity: B1_PREPARATION_CONTRACT.verifierIdentity,
      envelopeSha256: digest(raw),
      signedPayloadSha256: digest(envelope.signedPayloadRaw),
      envelopeId: envelope.envelopeId,
      preparationId: payload.preparationId,
      admissionSha256: payload.candidate.admissionSha256,
      treasuryPlanSha256: payload.candidate.treasuryPlanSha256,
      sourceHeadSha: payload.candidate.sourceHeadSha,
      sourceTreeSha: payload.candidate.sourceTreeSha,
      workerImageDigest: payload.candidate.workerImageDigest,
      corpusDigest: payload.candidate.corpusDigest,
      releaseCandidateId: payload.candidate.releaseCandidateId,
      provisionApprovalEnvelopeSha256: payload.candidate.provisionApprovalEnvelopeSha256,
      provisionSignedPayloadSha256: payload.candidate.provisionSignedPayloadSha256,
      ...(payload.candidate.continuityCompositeIdentitySha256 === undefined
        ? {}
        : {
          continuityCompositeIdentitySha256: payload.candidate.continuityCompositeIdentitySha256,
          controllerSourceHeadSha: payload.controller!.sourceHeadSha,
          controllerSourceTreeSha: payload.controller!.sourceTreeSha,
          controllerRelevantFilesSha256: payload.controller!.relevantFilesSha256,
        }),
      rigName: payload.run.rigName,
      soakId: payload.run.soakId,
      leaseId: payload.run.leaseId,
      workerService: payload.run.workerService,
      schedulerOidcServiceAccount: payload.run.schedulerOidcServiceAccount,
      maxFundedBroadcasts: payload.limits.maxFundedBroadcasts,
      invocationLeaseMaxSeconds: payload.limits.invocationLeaseMaxSeconds,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    });
  }
}

export function createProductionB1PreparationAuthorityVerifier(): B1PreparationAuthorityVerifier {
  return new Ed25519B1PreparationAuthorityVerifier({
    publicKeyPem: PUBLIC_KEY_PEM,
    keyFingerprint: B1_PREPARATION_CONTRACT.keyFingerprint,
  });
}

/** Test-only trust-root injection. */
export function createB1PreparationAuthorityVerifierForTest(
  config: VerifierConfig,
): B1PreparationAuthorityVerifier {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Injected RIG-B1 PREPARE authority trust roots are test-only.');
  }
  return new Ed25519B1PreparationAuthorityVerifier(config);
}
