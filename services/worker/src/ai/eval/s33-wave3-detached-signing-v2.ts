/**
 * Sprint 3.3 Wave-3 detached release signing.
 *
 * This module can emit canonical unsigned requests, but it cannot sign. The
 * production trust policy is intentionally UNCONFIGURED until the CTO supplies
 * and independently confirms the public SPKI, fingerprint, and operator. Only
 * an ACTIVE reviewed policy may assemble or verify a signed acceptance.
 */

import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
  type KeyObject,
} from 'node:crypto';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import {
  buildS33Wave2AcceptancePayload,
  validateS33Wave2AcceptancePayload,
  type S33Wave2AcceptanceBindings,
  type S33Wave2AcceptancePayload,
  type S33Wave2AcceptancePayloadInput,
} from './s33-wave2-acceptance-envelope.js';

const SCHEMA_VERSION = 2 as const;
const SIGNATURE_ALGORITHM = 'Ed25519' as const;
const SIGNER_IDENTITY = 'arkova-s33-cto-release' as const;
const INITIAL_SIGNING_KEY_ID = 'arkova-s33-cto-release-2026q3-01' as const;
const DOMAIN_SEPARATOR = 'arkova:s33:detached-acceptance:v2\n' as const;
const ACTIVATION_MODE = 'reviewed-commit-and-cto-out-of-band-confirmation' as const;
const ROTATION_MODE = 'reviewed-hard-cutover-no-overlap' as const;
const REVOCATION_MODE = 'immediate-hold' as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{86}$/u;
const KEY_ID = /^arkova-s33-cto-release-\d{4}q[1-4]-\d{2}$/u;
const PUBLIC_SPKI_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/u;
const PLACEHOLDER = /^(?:n\/?a|none|null|pending|tbd|todo|unknown|placeholder)$/iu;

type JsonRecord = Record<string, unknown>;

export type S33DetachedSigningTrustStateV2 = 'UNCONFIGURED' | 'ACTIVE' | 'RETIRED' | 'REVOKED';

export interface S33DetachedSigningFingerprintConfirmationV2 {
  method: 'cto-out-of-band';
  confirmedBy: string;
  confirmedAtUtc: string;
}

export interface S33DetachedSigningTrustPolicyV2 {
  schemaVersion: 2;
  artifactType: 'arkova-s33-detached-signing-trust-policy';
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signerIdentity: typeof SIGNER_IDENTITY;
  signingKeyId: string;
  state: S33DetachedSigningTrustStateV2;
  activationMode: typeof ACTIVATION_MODE;
  rotationMode: typeof ROTATION_MODE;
  revocationMode: typeof REVOCATION_MODE;
  publicKeySpkiPem: string | null;
  publicKeyFingerprintSha256: string | null;
  authorizedOperator: string | null;
  fingerprintConfirmation: S33DetachedSigningFingerprintConfirmationV2 | null;
  activatedAtUtc: string | null;
  retiredAtUtc: string | null;
  revokedAtUtc: string | null;
  revocationReason: string | null;
}

export interface S33DetachedAcceptancePayloadV2 extends Omit<
  S33Wave2AcceptancePayload,
  'schemaVersion' | 'artifactType' | 'signerIdentity' | 'signingKeyId'
> {
  schemaVersion: 2;
  artifactType: 'arkova-s33-detached-batch-acceptance-payload';
  signerIdentity: typeof SIGNER_IDENTITY;
  signingKeyId: typeof INITIAL_SIGNING_KEY_ID;
}

export interface S33DetachedSigningRequestV2 {
  schemaVersion: 2;
  artifactType: 'arkova-s33-detached-signing-request';
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signerIdentity: typeof SIGNER_IDENTITY;
  signingKeyId: typeof INITIAL_SIGNING_KEY_ID;
  domainSeparator: typeof DOMAIN_SEPARATOR;
  payload: S33DetachedAcceptancePayloadV2;
  payloadCanonicalJson: string;
  payloadCanonicalSha256: string;
  signingBytesBase64Url: string;
  signingBytesSha256: string;
  requestDigestSha256: string;
}

export interface S33DetachedAcceptanceEnvelopeV2 {
  schemaVersion: 2;
  artifactType: 'arkova-s33-detached-acceptance-envelope';
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signerIdentity: typeof SIGNER_IDENTITY;
  signingKeyId: typeof INITIAL_SIGNING_KEY_ID;
  publicKeyFingerprintSha256: string;
  request: S33DetachedSigningRequestV2;
  signatureBase64Url: string;
  artifactDigestSha256: string;
}

export interface S33DetachedSigningTestHarnessV2 {
  assemble(request: unknown, signatureBase64Url: string): S33DetachedAcceptanceEnvelopeV2;
  verify(
    envelope: unknown,
    bindings: S33Wave2AcceptanceBindings,
  ): S33DetachedAcceptanceEnvelopeV2;
}

export const S33_DETACHED_SIGNING_V2_CONSTANTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  signatureAlgorithm: SIGNATURE_ALGORITHM,
  signerIdentity: SIGNER_IDENTITY,
  initialSigningKeyId: INITIAL_SIGNING_KEY_ID,
  domainSeparator: DOMAIN_SEPARATOR,
  gateRegistryPath: 'docs/lane3/s33-wave3-v71-offline-gates.json' as const,
});

/**
 * No placeholder SPKI is permitted. This exact committed state cannot verify
 * or assemble a nonempty acceptance and reads no environment configuration.
 */
export const S33_DETACHED_SIGNING_TRUST_POLICY_V2: S33DetachedSigningTrustPolicyV2 = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  artifactType: 'arkova-s33-detached-signing-trust-policy',
  signatureAlgorithm: SIGNATURE_ALGORITHM,
  signerIdentity: SIGNER_IDENTITY,
  signingKeyId: INITIAL_SIGNING_KEY_ID,
  state: 'UNCONFIGURED',
  activationMode: ACTIVATION_MODE,
  rotationMode: ROTATION_MODE,
  revocationMode: REVOCATION_MODE,
  publicKeySpkiPem: null,
  publicKeyFingerprintSha256: null,
  authorizedOperator: null,
  fingerprintConfirmation: null,
  activatedAtUtc: null,
  retiredAtUtc: null,
  revokedAtUtc: null,
  revocationReason: null,
});

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalDigest(value: unknown): string {
  return sha256(canonicaliseJson(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  }
  return value;
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareUtf16CodeUnits);
  const wanted = [...expected].sort(compareUtf16CodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys are not the strict v2 schema`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be non-empty`);
  return value;
}

function nonPlaceholder(value: unknown, label: string): string {
  const parsed = nonEmpty(value, label);
  if (PLACEHOLDER.test(parsed.trim())) throw new Error(`${label} cannot be a placeholder`);
  return parsed;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return nonEmpty(value, label);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
  return value;
}

function nullableDigest(value: unknown, label: string): string | null {
  if (value === null) return null;
  return digest(value, label);
}

function isoUtc(value: unknown, label: string): string {
  const parsed = nonEmpty(value, label);
  const epoch = Date.parse(parsed);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== parsed) {
    throw new Error(`${label} must be canonical UTC ISO-8601`);
  }
  return parsed;
}

function nullableIsoUtc(value: unknown, label: string): string | null {
  if (value === null) return null;
  return isoUtc(value, label);
}

function assertAtOrAfter(later: string, earlier: string, label: string): void {
  if (Date.parse(later) < Date.parse(earlier)) throw new Error(`${label} is earlier than activation`);
}

function parseFingerprintConfirmation(
  value: unknown,
): S33DetachedSigningFingerprintConfirmationV2 | null {
  if (value === null) return null;
  const confirmation = record(value, 'S3.3 detached fingerprint confirmation');
  exactKeys(
    confirmation,
    ['method', 'confirmedBy', 'confirmedAtUtc'],
    'S3.3 detached fingerprint confirmation',
  );
  if (confirmation.method !== 'cto-out-of-band') {
    throw new Error('S3.3 detached fingerprint confirmation must be CTO out-of-band');
  }
  return deepFreeze({
    method: 'cto-out-of-band',
    confirmedBy: nonPlaceholder(confirmation.confirmedBy, 'S3.3 detached fingerprint confirmer'),
    confirmedAtUtc: isoUtc(confirmation.confirmedAtUtc, 'S3.3 detached fingerprint confirmation time'),
  });
}

function exactBase64Url(value: unknown, label: string): string {
  const parsed = nonEmpty(value, label);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(parsed, 'base64url');
  } catch (error) {
    throw new Error(`${label} is not base64url`, { cause: error });
  }
  if (bytes.toString('base64url') !== parsed) throw new Error(`${label} is not canonical base64url`);
  return parsed;
}

function signatureBase64Url(value: unknown): string {
  const parsed = exactBase64Url(value, 'S3.3 detached Ed25519 signature');
  if (!SIGNATURE_BASE64URL.test(parsed) || Buffer.from(parsed, 'base64url').length !== 64) {
    throw new Error('S3.3 detached signature must be exactly 64-byte Ed25519 base64url');
  }
  return parsed;
}

function configuredPublicKey(
  publicKeySpkiPem: string,
  publicKeyFingerprintSha256: string,
): KeyObject {
  if (!PUBLIC_SPKI_PEM.test(publicKeySpkiPem.trim())) {
    throw new Error('S3.3 detached trust-policy key must be public SPKI PEM');
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(publicKeySpkiPem);
  } catch (error) {
    throw new Error('S3.3 detached trust-policy SPKI PEM is invalid', { cause: error });
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('S3.3 detached trust-policy key must be Ed25519');
  }
  if (sha256(publicKey.export({ type: 'spki', format: 'der' })) !== publicKeyFingerprintSha256) {
    throw new Error('S3.3 detached trust-policy fingerprint does not match its public SPKI');
  }
  return publicKey;
}

type S33TrustPolicyMaterialV2 = Pick<
  S33DetachedSigningTrustPolicyV2,
  | 'publicKeySpkiPem'
  | 'publicKeyFingerprintSha256'
  | 'authorizedOperator'
  | 'fingerprintConfirmation'
  | 'activatedAtUtc'
  | 'retiredAtUtc'
  | 'revokedAtUtc'
  | 'revocationReason'
>;

interface S33ConfiguredTrustPolicyMaterialV2 extends S33TrustPolicyMaterialV2 {
  publicKeySpkiPem: string;
  publicKeyFingerprintSha256: string;
  authorizedOperator: string;
  fingerprintConfirmation: S33DetachedSigningFingerprintConfirmationV2;
  activatedAtUtc: string;
}

function assertTrustPolicyIdentity(policy: JsonRecord): void {
  if (policy.schemaVersion !== SCHEMA_VERSION
    || policy.artifactType !== 'arkova-s33-detached-signing-trust-policy'
    || policy.signatureAlgorithm !== SIGNATURE_ALGORITHM
    || policy.signerIdentity !== SIGNER_IDENTITY
    || policy.activationMode !== ACTIVATION_MODE
    || policy.rotationMode !== ROTATION_MODE
    || policy.revocationMode !== REVOCATION_MODE) {
    throw new Error('S3.3 detached trust-policy identity/mode tuple is invalid');
  }
}

function trustPolicyState(value: unknown): S33DetachedSigningTrustStateV2 {
  switch (value) {
    case 'UNCONFIGURED':
    case 'ACTIVE':
    case 'RETIRED':
    case 'REVOKED':
      return value;
    default:
      throw new Error('S3.3 detached trust-policy state is invalid');
  }
}

function parseTrustPolicyMaterial(policy: JsonRecord): S33TrustPolicyMaterialV2 {
  return {
    publicKeySpkiPem: nullableString(policy.publicKeySpkiPem, 'S3.3 detached public SPKI'),
    publicKeyFingerprintSha256: nullableDigest(
      policy.publicKeyFingerprintSha256,
      'S3.3 detached public-key fingerprint',
    ),
    authorizedOperator: policy.authorizedOperator === null
      ? null
      : nonPlaceholder(policy.authorizedOperator, 'S3.3 detached authorized operator'),
    fingerprintConfirmation: parseFingerprintConfirmation(policy.fingerprintConfirmation),
    activatedAtUtc: nullableIsoUtc(policy.activatedAtUtc, 'S3.3 detached activation time'),
    retiredAtUtc: nullableIsoUtc(policy.retiredAtUtc, 'S3.3 detached retirement time'),
    revokedAtUtc: nullableIsoUtc(policy.revokedAtUtc, 'S3.3 detached revocation time'),
    revocationReason: policy.revocationReason === null
      ? null
      : nonPlaceholder(policy.revocationReason, 'S3.3 detached revocation reason'),
  };
}

function assertUnconfiguredMaterial(material: S33TrustPolicyMaterialV2): void {
  if (Object.values(material).some((field) => field !== null)) {
    throw new Error('S3.3 UNCONFIGURED trust policy must keep all public/operator/time fields null');
  }
}

function assertConfiguredStateTimeline(
  state: Exclude<S33DetachedSigningTrustStateV2, 'UNCONFIGURED'>,
  material: S33ConfiguredTrustPolicyMaterialV2,
): void {
  const { activatedAtUtc, retiredAtUtc, revokedAtUtc, revocationReason } = material;
  if (state === 'ACTIVE' && (retiredAtUtc !== null || revokedAtUtc !== null || revocationReason !== null)) {
    throw new Error('S3.3 ACTIVE trust policy cannot carry retirement or revocation fields');
  }
  if (state === 'RETIRED') {
    if (retiredAtUtc === null || revokedAtUtc !== null || revocationReason !== null) {
      throw new Error('S3.3 RETIRED trust policy requires only a retirement time');
    }
    assertAtOrAfter(retiredAtUtc, activatedAtUtc, 'S3.3 detached retirement time');
  }
  if (state === 'REVOKED') {
    if (revokedAtUtc === null || revocationReason === null) {
      throw new Error('S3.3 REVOKED trust policy requires a time and non-placeholder reason');
    }
    assertAtOrAfter(revokedAtUtc, activatedAtUtc, 'S3.3 detached revocation time');
    if (retiredAtUtc !== null) {
      assertAtOrAfter(retiredAtUtc, activatedAtUtc, 'S3.3 detached retirement time');
      if (Date.parse(retiredAtUtc) > Date.parse(revokedAtUtc)) {
        throw new Error('S3.3 detached retirement cannot follow revocation');
      }
    }
  }
}

function configuredTrustPolicyMaterial(
  state: Exclude<S33DetachedSigningTrustStateV2, 'UNCONFIGURED'>,
  material: S33TrustPolicyMaterialV2,
): S33ConfiguredTrustPolicyMaterialV2 {
  const {
    publicKeySpkiPem,
    publicKeyFingerprintSha256,
    authorizedOperator,
    fingerprintConfirmation,
    activatedAtUtc,
  } = material;
  if (publicKeySpkiPem === null || publicKeyFingerprintSha256 === null
    || authorizedOperator === null || fingerprintConfirmation === null || activatedAtUtc === null) {
    throw new Error(
      `S3.3 ${state} trust policy requires SPKI, fingerprint, operator, confirmation, and activation`,
    );
  }
  if (Date.parse(fingerprintConfirmation.confirmedAtUtc) > Date.parse(activatedAtUtc)) {
    throw new Error('S3.3 detached fingerprint must be confirmed before policy activation');
  }
  const configured = {
    ...material,
    publicKeySpkiPem,
    publicKeyFingerprintSha256,
    authorizedOperator,
    fingerprintConfirmation,
    activatedAtUtc,
  };
  assertConfiguredStateTimeline(state, configured);
  return configured;
}

function normalizedTrustPolicy(
  signingKeyId: string,
  state: S33DetachedSigningTrustStateV2,
  material: S33TrustPolicyMaterialV2,
): S33DetachedSigningTrustPolicyV2 {
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-signing-trust-policy',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId,
    state,
    activationMode: ACTIVATION_MODE,
    rotationMode: ROTATION_MODE,
    revocationMode: REVOCATION_MODE,
    ...material,
  };
}

function parseTrustPolicy(value: unknown): {
  policy: S33DetachedSigningTrustPolicyV2;
  publicKey: KeyObject | null;
} {
  const policy = record(value, 'S3.3 detached signing trust policy');
  exactKeys(policy, [
    'schemaVersion', 'artifactType', 'signatureAlgorithm', 'signerIdentity', 'signingKeyId',
    'state', 'activationMode', 'rotationMode', 'revocationMode', 'publicKeySpkiPem',
    'publicKeyFingerprintSha256', 'authorizedOperator', 'fingerprintConfirmation',
    'activatedAtUtc', 'retiredAtUtc', 'revokedAtUtc', 'revocationReason',
  ], 'S3.3 detached signing trust policy');
  assertTrustPolicyIdentity(policy);
  const signingKeyId = nonEmpty(policy.signingKeyId, 'S3.3 detached signing key id');
  if (!KEY_ID.test(signingKeyId)) throw new Error('S3.3 detached signing key id is not versioned');
  const state = trustPolicyState(policy.state);
  const material = parseTrustPolicyMaterial(policy);
  if (state === 'UNCONFIGURED') {
    assertUnconfiguredMaterial(material);
    return {
      policy: deepFreeze(normalizedTrustPolicy(signingKeyId, state, material)),
      publicKey: null,
    };
  }
  const configured = configuredTrustPolicyMaterial(state, material);
  return {
    policy: deepFreeze(normalizedTrustPolicy(signingKeyId, state, configured)),
    publicKey: configuredPublicKey(
      configured.publicKeySpkiPem,
      configured.publicKeyFingerprintSha256,
    ),
  };
}

export function validateS33DetachedSigningTrustPolicyV2(
  value: unknown,
): S33DetachedSigningTrustPolicyV2 {
  return parseTrustPolicy(value).policy;
}

/** Enforce the one-key activation/retirement/revocation state machine. */
export function transitionS33DetachedSigningTrustPolicyV2(
  currentValue: unknown,
  nextValue: unknown,
): S33DetachedSigningTrustPolicyV2 {
  const current = validateS33DetachedSigningTrustPolicyV2(currentValue);
  const next = validateS33DetachedSigningTrustPolicyV2(nextValue);
  for (const field of [
    'schemaVersion', 'artifactType', 'signatureAlgorithm', 'signerIdentity', 'signingKeyId',
    'activationMode', 'rotationMode', 'revocationMode',
  ] as const) {
    if (current[field] !== next[field]) throw new Error(`S3.3 trust-policy transition changed ${field}`);
  }
  const legal: Record<S33DetachedSigningTrustStateV2, readonly S33DetachedSigningTrustStateV2[]> = {
    UNCONFIGURED: ['ACTIVE'],
    ACTIVE: ['RETIRED', 'REVOKED'],
    RETIRED: ['REVOKED'],
    REVOKED: [],
  };
  if (!legal[current.state].includes(next.state)) {
    throw new Error(`S3.3 trust-policy transition ${current.state} -> ${next.state} is forbidden`);
  }
  if (current.state !== 'UNCONFIGURED') {
    for (const field of [
      'publicKeySpkiPem', 'publicKeyFingerprintSha256', 'authorizedOperator', 'activatedAtUtc',
    ] as const) {
      if (current[field] !== next[field]) throw new Error(`S3.3 trust-policy transition changed ${field}`);
    }
    if (canonicaliseJson(current.fingerprintConfirmation)
      !== canonicaliseJson(next.fingerprintConfirmation)) {
      throw new Error('S3.3 trust-policy transition changed fingerprintConfirmation');
    }
  }
  if (current.state === 'RETIRED' && current.retiredAtUtc !== next.retiredAtUtc) {
    throw new Error('S3.3 retired trust-policy transition changed retiredAtUtc');
  }
  return next;
}

function v2PayloadFromV1(payload: S33Wave2AcceptancePayload): S33DetachedAcceptancePayloadV2 {
  const minimumHumanSample = Math.min(
    payload.acceptedEntryCount,
    Math.max(5, Math.ceil(payload.acceptedEntryCount * 0.1)),
  );
  if (payload.proof.humanCrossReviewSampleSize < minimumHumanSample) {
    throw new Error(
      `S3.3 detached human cross-review sample must be ${minimumHumanSample}-${payload.acceptedEntryCount} rows`,
    );
  }
  return deepFreeze({
    ...payload,
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-batch-acceptance-payload',
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: INITIAL_SIGNING_KEY_ID,
  });
}

function validateV2Payload(value: unknown): S33DetachedAcceptancePayloadV2 {
  const payload = record(value, 'S3.3 detached acceptance payload');
  if (payload.schemaVersion !== SCHEMA_VERSION
    || payload.artifactType !== 'arkova-s33-detached-batch-acceptance-payload'
    || payload.signerIdentity !== SIGNER_IDENTITY
    || payload.signingKeyId !== INITIAL_SIGNING_KEY_ID) {
    throw new Error('S3.3 detached payload identity/schema tuple is invalid');
  }
  const normalizedV1 = validateS33Wave2AcceptancePayload({
    ...payload,
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-batch-acceptance-payload',
    signerIdentity: 'arkova-s33-wave2-cto-release',
    signingKeyId: 'arkova-s33-wave2-cto-release',
  });
  return v2PayloadFromV1(normalizedV1);
}

function signingBytes(payload: S33DetachedAcceptancePayloadV2): Buffer {
  return Buffer.from(`${DOMAIN_SEPARATOR}${canonicaliseJson(payload)}`, 'utf8');
}

function requestWithoutDigest(
  request: Omit<S33DetachedSigningRequestV2, 'requestDigestSha256'>,
): Omit<S33DetachedSigningRequestV2, 'requestDigestSha256'> {
  return request;
}

/** Emit the exact bytes for CTO-controlled detached signing. */
export function emitS33DetachedSigningRequestV2(
  input: S33Wave2AcceptancePayloadInput,
): S33DetachedSigningRequestV2 {
  const payload = v2PayloadFromV1(buildS33Wave2AcceptancePayload(input));
  const payloadCanonicalJson = canonicaliseJson(payload);
  const bytes = signingBytes(payload);
  const withoutDigest = requestWithoutDigest({
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-signing-request',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: INITIAL_SIGNING_KEY_ID,
    domainSeparator: DOMAIN_SEPARATOR,
    payload,
    payloadCanonicalJson,
    payloadCanonicalSha256: sha256(payloadCanonicalJson),
    signingBytesBase64Url: bytes.toString('base64url'),
    signingBytesSha256: sha256(bytes),
  });
  return deepFreeze({
    ...withoutDigest,
    requestDigestSha256: canonicalDigest(withoutDigest),
  });
}

function validateSigningRequest(value: unknown): S33DetachedSigningRequestV2 {
  const request = record(value, 'S3.3 detached signing request');
  exactKeys(request, [
    'schemaVersion', 'artifactType', 'signatureAlgorithm', 'signerIdentity', 'signingKeyId',
    'domainSeparator', 'payload', 'payloadCanonicalJson', 'payloadCanonicalSha256',
    'signingBytesBase64Url', 'signingBytesSha256', 'requestDigestSha256',
  ], 'S3.3 detached signing request');
  if (request.schemaVersion !== SCHEMA_VERSION
    || request.artifactType !== 'arkova-s33-detached-signing-request'
    || request.signatureAlgorithm !== SIGNATURE_ALGORITHM
    || request.signerIdentity !== SIGNER_IDENTITY
    || request.signingKeyId !== INITIAL_SIGNING_KEY_ID
    || request.domainSeparator !== DOMAIN_SEPARATOR) {
    throw new Error('S3.3 detached signing-request identity/domain tuple is invalid');
  }
  const payload = validateV2Payload(request.payload);
  const payloadCanonicalJson = nonEmpty(request.payloadCanonicalJson, 'S3.3 canonical payload JSON');
  if (payloadCanonicalJson !== canonicaliseJson(payload)) {
    throw new Error('S3.3 detached signing-request canonical payload mismatch');
  }
  const payloadCanonicalSha256 = digest(request.payloadCanonicalSha256, 'S3.3 payload canonical digest');
  if (sha256(payloadCanonicalJson) !== payloadCanonicalSha256) {
    throw new Error('S3.3 detached signing-request payload digest mismatch');
  }
  const expectedBytes = signingBytes(payload);
  const signingBytesBase64Url = exactBase64Url(request.signingBytesBase64Url, 'S3.3 detached signing bytes');
  if (!Buffer.from(signingBytesBase64Url, 'base64url').equals(expectedBytes)) {
    throw new Error('S3.3 detached signing-request bytes do not match its domain-separated payload');
  }
  const signingBytesSha256 = digest(request.signingBytesSha256, 'S3.3 detached signing-bytes digest');
  if (sha256(expectedBytes) !== signingBytesSha256) {
    throw new Error('S3.3 detached signing-request signing-bytes digest mismatch');
  }
  const withoutDigest = requestWithoutDigest({
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-signing-request',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: INITIAL_SIGNING_KEY_ID,
    domainSeparator: DOMAIN_SEPARATOR,
    payload,
    payloadCanonicalJson,
    payloadCanonicalSha256,
    signingBytesBase64Url,
    signingBytesSha256,
  });
  const requestDigestSha256 = digest(request.requestDigestSha256, 'S3.3 detached request digest');
  if (canonicalDigest(withoutDigest) !== requestDigestSha256) {
    throw new Error('S3.3 detached signing-request artifact digest mismatch');
  }
  return deepFreeze({ ...withoutDigest, requestDigestSha256 });
}

function requireActiveTrustPolicy(value: unknown): {
  policy: S33DetachedSigningTrustPolicyV2;
  publicKey: KeyObject;
} {
  const resolved = parseTrustPolicy(value);
  if (resolved.policy.state !== 'ACTIVE' || resolved.publicKey === null) {
    throw new Error(`S3.3 detached trust policy is ${resolved.policy.state}; acceptance fails closed`);
  }
  return { policy: resolved.policy, publicKey: resolved.publicKey };
}

function assertRequestPolicy(
  request: S33DetachedSigningRequestV2,
  policy: S33DetachedSigningTrustPolicyV2,
): void {
  if (request.signerIdentity !== policy.signerIdentity || request.signingKeyId !== policy.signingKeyId) {
    throw new Error('S3.3 detached request does not match the active CTO signer/key identity');
  }
}

function verifySignature(
  request: S33DetachedSigningRequestV2,
  signature: string,
  publicKey: KeyObject,
): void {
  if (!verifyEd25519(
    null,
    Buffer.from(request.signingBytesBase64Url, 'base64url'),
    publicKey,
    Buffer.from(signature, 'base64url'),
  )) {
    throw new Error('S3.3 detached CTO release signature verification failed');
  }
}

function envelopeWithoutDigest(
  envelope: Omit<S33DetachedAcceptanceEnvelopeV2, 'artifactDigestSha256'>,
): Omit<S33DetachedAcceptanceEnvelopeV2, 'artifactDigestSha256'> {
  return envelope;
}

/** Assemble only after verifying the supplied detached signature. */
function assembleWithTrustPolicy(
  requestValue: unknown,
  signatureValue: string,
  trustPolicy: { policy: S33DetachedSigningTrustPolicyV2; publicKey: KeyObject },
): S33DetachedAcceptanceEnvelopeV2 {
  const request = validateSigningRequest(requestValue);
  const signature = signatureBase64Url(signatureValue);
  const { policy, publicKey } = trustPolicy;
  assertRequestPolicy(request, policy);
  verifySignature(request, signature, publicKey);
  const withoutDigest = envelopeWithoutDigest({
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-acceptance-envelope',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: INITIAL_SIGNING_KEY_ID,
    publicKeyFingerprintSha256: policy.publicKeyFingerprintSha256!,
    request,
    signatureBase64Url: signature,
  });
  return deepFreeze({
    ...withoutDigest,
    artifactDigestSha256: canonicalDigest(withoutDigest),
  });
}

export function assembleS33DetachedAcceptanceEnvelopeV2(
  requestValue: unknown,
  signatureValue: string,
): S33DetachedAcceptanceEnvelopeV2 {
  return assembleWithTrustPolicy(
    requestValue,
    signatureValue,
    requireActiveTrustPolicy(S33_DETACHED_SIGNING_TRUST_POLICY_V2),
  );
}

const BINDING_KEYS = [
  'repositoryIdentity', 'pullRequestNumber', 'candidateBaseSha', 'candidateHeadSha',
  'candidateTreeSha', 'batchId', 'revision', 'manifestPath', 'manifestRawSha256',
  'manifestCanonicalSha256', 'sourceBlobSha', 'datasheetBlobSha',
  'preflightArtifactDigestSha256', 'baseRegistryDigestSha256',
  'resultingRegistryDigestSha256', 'coverageRegistryPath', 'coverageRegistryRawSha256',
  'coverageRegistryCanonicalSha256', 'acceptedEntryOrderSha256',
] as const satisfies readonly (keyof S33Wave2AcceptanceBindings)[];

function assertPayloadBindings(
  payload: S33DetachedAcceptancePayloadV2,
  bindingsValue: S33Wave2AcceptanceBindings,
): void {
  const bindings = record(bindingsValue, 'S3.3 detached caller bindings');
  exactKeys(bindings, BINDING_KEYS, 'S3.3 detached caller bindings');
  for (const key of BINDING_KEYS) {
    if (payload[key] !== bindings[key]) {
      throw new Error(`S3.3 detached acceptance binding mismatch: ${key}`);
    }
  }
}

/** Verify strict schemas, request/envelope digests, signature, policy, and bindings. */
function verifyWithTrustPolicy(
  value: unknown,
  bindings: S33Wave2AcceptanceBindings,
  trustPolicy: { policy: S33DetachedSigningTrustPolicyV2; publicKey: KeyObject },
): S33DetachedAcceptanceEnvelopeV2 {
  const envelope = record(value, 'S3.3 detached acceptance envelope');
  exactKeys(envelope, [
    'schemaVersion', 'artifactType', 'signatureAlgorithm', 'signerIdentity', 'signingKeyId',
    'publicKeyFingerprintSha256', 'request', 'signatureBase64Url', 'artifactDigestSha256',
  ], 'S3.3 detached acceptance envelope');
  if (envelope.schemaVersion !== SCHEMA_VERSION
    || envelope.artifactType !== 'arkova-s33-detached-acceptance-envelope'
    || envelope.signatureAlgorithm !== SIGNATURE_ALGORITHM
    || envelope.signerIdentity !== SIGNER_IDENTITY
    || envelope.signingKeyId !== INITIAL_SIGNING_KEY_ID) {
    throw new Error('S3.3 detached envelope identity/schema tuple is invalid');
  }
  const request = validateSigningRequest(envelope.request);
  const publicKeyFingerprintSha256 = digest(
    envelope.publicKeyFingerprintSha256,
    'S3.3 detached envelope public-key fingerprint',
  );
  const signature = signatureBase64Url(envelope.signatureBase64Url);
  const withoutDigest = envelopeWithoutDigest({
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-acceptance-envelope',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: INITIAL_SIGNING_KEY_ID,
    publicKeyFingerprintSha256,
    request,
    signatureBase64Url: signature,
  });
  const artifactDigestSha256 = digest(envelope.artifactDigestSha256, 'S3.3 detached envelope digest');
  if (canonicalDigest(withoutDigest) !== artifactDigestSha256) {
    throw new Error('S3.3 detached acceptance-envelope artifact digest mismatch');
  }
  const { policy, publicKey } = trustPolicy;
  assertRequestPolicy(request, policy);
  if (publicKeyFingerprintSha256 !== policy.publicKeyFingerprintSha256) {
    throw new Error('S3.3 detached envelope fingerprint does not match the active CTO trust policy');
  }
  verifySignature(request, signature, publicKey);
  assertPayloadBindings(request.payload, bindings);
  return deepFreeze({ ...withoutDigest, artifactDigestSha256 });
}


export function verifyS33DetachedAcceptanceEnvelopeV2(
  value: unknown,
  bindings: S33Wave2AcceptanceBindings,
): S33DetachedAcceptanceEnvelopeV2 {
  return verifyWithTrustPolicy(
    value,
    bindings,
    requireActiveTrustPolicy(S33_DETACHED_SIGNING_TRUST_POLICY_V2),
  );
}

/**
 * Ephemeral-key tests use a separate factory; production entry points expose
 * no caller-supplied policy parameter and always resolve the committed root.
 */
export function createS33DetachedSigningTestHarnessV2(
  trustPolicyValue: unknown,
): S33DetachedSigningTestHarnessV2 {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('S3.3 detached test-only trust-policy harness is disabled');
  }
  const trustPolicy = requireActiveTrustPolicy(trustPolicyValue);
  return Object.freeze({
    assemble: (request: unknown, signature: string): S33DetachedAcceptanceEnvelopeV2 => (
      assembleWithTrustPolicy(request, signature, trustPolicy)
    ),
    verify: (
      envelope: unknown,
      bindings: S33Wave2AcceptanceBindings,
    ): S33DetachedAcceptanceEnvelopeV2 => verifyWithTrustPolicy(envelope, bindings, trustPolicy),
  });
}
