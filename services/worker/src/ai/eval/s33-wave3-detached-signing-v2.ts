/**
 * Sprint 3.3 Wave-3 detached release signing.
 *
 * This module can emit canonical unsigned requests, but it cannot sign. The
 * production trust-policy set contains only the founder/CTO-confirmed public
 * Ed25519 root. Private material remains external to the repository. Only an
 * ACTIVE reviewed policy may assemble or verify a signed acceptance.
 */

import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
  type KeyObject,
} from 'node:crypto';
import { canonicaliseJson } from '../../utils/canonical-json.js';

const SCHEMA_VERSION = 2 as const;
const SIGNATURE_ALGORITHM = 'Ed25519' as const;
const SIGNER_IDENTITY = 'arkova-s33-cto-release' as const;
const INITIAL_SIGNING_KEY_ID = 'arkova.s33.release-corpus.ed25519.v1' as const;
const RELEASE_CORPUS_PUBLIC_KEY_SPKI_PEM =
  '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAf7Oe/mYJSU3rBUsLb9ni3zIZgS7K0FWbM1E9xovU/R8=\n-----END PUBLIC KEY-----\n' as const;
const RELEASE_CORPUS_PUBLIC_KEY_FINGERPRINT_SHA256 =
  'b5f6445ae954ac1f29b504fdc890dedefda23beb6300f35d99cd2c9d2eeb9e59' as const;
const S33_PUBLIC_AUTHORITY_OPERATOR = 'arkova.s33.operator.key-custodian.v1' as const;
const S33_PUBLIC_AUTHORITY_APPROVER = 'arkova.s33.approver.founder-cto.v1' as const;
const S33_PUBLIC_AUTHORITY_ACTIVATED_AT_UTC = '2026-07-16T13:52:06Z' as const;
const S33_PUBLIC_AUTHORITY_GENESIS_ROSTER_ROOT_SHA256 =
  'sha256:bb4d0bb56523b6cdb9701cf786d7f2828a571bd6c7fc32a247d93a2041efc51f' as const;
const S33_PUBLIC_AUTHORITY_FOUNDER_COMMAND_RECEIPT =
  'codex-thread:019f65ca-fdfc-7652-bd86-7be6c7463d34:founder-provision-and-soak-command' as const;
const DOMAIN_SEPARATOR = 'arkova:s33:detached-acceptance:v2\n' as const;
const ACTIVATION_MODE = 'reviewed-commit-and-cto-out-of-band-confirmation' as const;
const ROTATION_MODE = 'reviewed-hard-cutover-no-overlap' as const;
const REVOCATION_MODE = 'immediate-hold' as const;
const REPOSITORY_IDENTITY = 'carson-see/ArkovaCarson' as const;
const COVERAGE_REGISTRY_PATH = 'docs/lane4/s33-wave2-top15-registry.json' as const;
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA256_URI = /^sha256:[0-9a-f]{64}$/u;
const SIGNATURE_BASE64URL = /^[A-Za-z0-9_-]{86}$/u;
const KEY_ID = /^arkova\.s33\.release-corpus\.ed25519\.v([1-9]\d*)$/u;
const PUBLIC_SPKI_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/u;
const PLACEHOLDER = /^(?:n\/?a|none|null|pending|tbd|todo|unknown|placeholder)$/iu;

type JsonRecord = Record<string, unknown>;

export type S33DetachedSigningTrustStateV2 = 'UNCONFIGURED' | 'ACTIVE' | 'RETIRED' | 'REVOKED';

export interface S33DetachedSigningFingerprintConfirmationV2 {
  method: 'cto-out-of-band';
  confirmedBy: string;
  confirmedAtUtc: string;
  genesisRosterRootSha256: string;
  authorityReceipt: string;
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

export interface S33DetachedSigningTrustPolicySetV2 {
  schemaVersion: 2;
  artifactType: 'arkova-s33-detached-signing-trust-policy-set';
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signerIdentity: typeof SIGNER_IDENTITY;
  rotationMode: typeof ROTATION_MODE;
  activeSigningKeyId: string | null;
  keys: readonly S33DetachedSigningTrustPolicyV2[];
}

export type S33DetachedAuthorshipMethodV2 = 'real-source' | 'independently-authored';

export interface S33DetachedAcceptedEntryInputV2 {
  id: string;
  registryTypeId: string;
  batchId: string;
  revision: number;
  credentialType: string;
  subType: string;
  normalizedInputSha256: string;
  groundTruthSha256: string;
  authorshipMethod: S33DetachedAuthorshipMethodV2;
  generatorDerived: false;
  trainingExposed: false;
  intendedSplit: 'held-out';
  productionValidSubstantiveFieldCount: number;
  edgeCase: boolean;
  sourceBlobSha: string;
}

export interface S33DetachedAcceptedEntryV2 extends S33DetachedAcceptedEntryInputV2 {
  entryCanonicalSha256: string;
}

export interface S33DetachedGitHubTransportActorV2 {
  login: string;
  databaseId: number;
  nodeId: string;
}

export interface S33DetachedGitHubTransportEvidenceV2 {
  id: number;
  nodeId: string | null;
  url: string;
  submittedAtUtc: string;
  actor: S33DetachedGitHubTransportActorV2;
}

export interface S33DetachedAcceptanceReviewerV2 {
  lane: 'Lane 3';
  transport: 'github-issue-comment' | 'github-formal-review';
  evidence: S33DetachedGitHubTransportEvidenceV2;
}

export interface S33DetachedAcceptanceProofV2 {
  machineValidationArtifactSha256: string;
  machineValidationFailureCount: 0;
  humanCrossReviewArtifactSha256: string;
  humanCrossReviewSampleSize: number;
  materialLabelDefectCount: 0;
  prodModelDiffArtifactSha256: string;
  exactLeakageArtifactSha256: string;
  exactLeakageHitCount: 0;
}

export interface S33DetachedAcceptancePayloadInputV2 {
  repositoryIdentity: typeof REPOSITORY_IDENTITY;
  pullRequestNumber: number;
  candidateBaseSha: string;
  candidateHeadSha: string;
  candidateTreeSha: string;
  batchId: string;
  revision: number;
  manifestPath: string;
  manifestRawSha256: string;
  manifestCanonicalSha256: string;
  sourceBlobSha: string;
  datasheetBlobSha: string;
  preflightArtifactDigestSha256: string;
  baseRegistryDigestSha256: string;
  resultingRegistryDigestSha256: string;
  coverageRegistryPath: typeof COVERAGE_REGISTRY_PATH;
  coverageRegistryRawSha256: string;
  coverageRegistryCanonicalSha256: string;
  signedAtUtc: string;
  reviewer: S33DetachedAcceptanceReviewerV2;
  proof: S33DetachedAcceptanceProofV2;
  acceptedEntries: S33DetachedAcceptedEntryInputV2[];
}

export interface S33DetachedAcceptancePayloadV2 {
  schemaVersion: 2;
  artifactType: 'arkova-s33-detached-batch-acceptance-payload';
  verdict: 'APPROVED_WHOLE_BATCH';
  signerIdentity: typeof SIGNER_IDENTITY;
  signingKeyId: string;
  repositoryIdentity: typeof REPOSITORY_IDENTITY;
  pullRequestNumber: number;
  candidateBaseSha: string;
  candidateHeadSha: string;
  candidateTreeSha: string;
  batchId: string;
  revision: number;
  manifestPath: string;
  manifestRawSha256: string;
  manifestCanonicalSha256: string;
  sourceBlobSha: string;
  datasheetBlobSha: string;
  preflightArtifactDigestSha256: string;
  baseRegistryDigestSha256: string;
  resultingRegistryDigestSha256: string;
  coverageRegistryPath: typeof COVERAGE_REGISTRY_PATH;
  coverageRegistryRawSha256: string;
  coverageRegistryCanonicalSha256: string;
  signedAtUtc: string;
  reviewer: S33DetachedAcceptanceReviewerV2;
  proof: S33DetachedAcceptanceProofV2;
  acceptedEntryCount: number;
  acceptedEntrySetCanonicalSha256: string;
  acceptedEntryOrderSha256: string;
  acceptedEntries: S33DetachedAcceptedEntryV2[];
}

/** Caller-recomputed bindings prevent a valid detached envelope from replay. */
export interface S33DetachedAcceptanceBindingsV2 {
  repositoryIdentity: typeof REPOSITORY_IDENTITY;
  pullRequestNumber: number;
  candidateBaseSha: string;
  candidateHeadSha: string;
  candidateTreeSha: string;
  batchId: string;
  revision: number;
  manifestPath: string;
  manifestRawSha256: string;
  manifestCanonicalSha256: string;
  sourceBlobSha: string;
  datasheetBlobSha: string;
  preflightArtifactDigestSha256: string;
  baseRegistryDigestSha256: string;
  resultingRegistryDigestSha256: string;
  coverageRegistryPath: typeof COVERAGE_REGISTRY_PATH;
  coverageRegistryRawSha256: string;
  coverageRegistryCanonicalSha256: string;
  acceptedEntryOrderSha256: string;
}

export interface S33DetachedSigningRequestV2 {
  schemaVersion: 2;
  artifactType: 'arkova-s33-detached-signing-request';
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signerIdentity: typeof SIGNER_IDENTITY;
  signingKeyId: string;
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
  signingKeyId: string;
  publicKeyFingerprintSha256: string;
  request: S33DetachedSigningRequestV2;
  signatureBase64Url: string;
  artifactDigestSha256: string;
}

export interface S33DetachedSigningAuthorityV2 {
  readonly signerIdentity: typeof SIGNER_IDENTITY;
  readonly signingKeyId: string;
  readonly publicKeyFingerprintSha256: string;
  readonly authorizedOperator: string;
  readonly activatedAtUtc: string;
}

export interface S33DetachedAcceptanceVerificationContextV2 {
  /** Trusted external time (for example GitHub Actions run_started_at). */
  readonly verifiedAtUtc: string;
}

export interface S33DetachedSigningTestHarnessV2 {
  readonly authority: S33DetachedSigningAuthorityV2;
  assemble(
    request: unknown,
    signatureBase64Url: string,
    context: S33DetachedAcceptanceVerificationContextV2,
  ): S33DetachedAcceptanceEnvelopeV2;
  verify(
    envelope: unknown,
    bindings: S33DetachedAcceptanceBindingsV2,
    context: S33DetachedAcceptanceVerificationContextV2,
  ): S33DetachedAcceptanceEnvelopeV2;
  audit(
    envelope: unknown,
    bindings: S33DetachedAcceptanceBindingsV2,
    context: S33DetachedHistoricalAuditContextV2,
  ): S33DetachedHistoricalAuditResultV2;
}

export interface S33DetachedHistoricalAuditContextV2 {
  evidenceState: 'UNMERGED' | 'MERGED';
  mergedAtUtc: string | null;
  auditedAtUtc: string;
}

export interface S33DetachedHistoricalAuditResultV2 {
  schemaVersion: 2;
  artifactType: 'arkova-s33-detached-historical-audit-result';
  acceptanceAuthority: false;
  cryptographicVerification: 'VERIFIED';
  disposition: 'HISTORICAL_AUDIT_VERIFIED' | 'CTO_HOLD' | 'REJECTED_NEW_ACCEPTANCE';
  signingKeyId: string;
  keyState: S33DetachedSigningTrustStateV2;
  keyStateEffectiveAtUtc: string;
  envelopeArtifactDigestSha256: string;
  signedAtUtc: string;
  mergedAtUtc: string | null;
  auditedAtUtc: string;
  reason: string;
}

export const S33_DETACHED_SIGNING_V2_CONSTANTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  signatureAlgorithm: SIGNATURE_ALGORITHM,
  signerIdentity: SIGNER_IDENTITY,
  initialSigningKeyId: INITIAL_SIGNING_KEY_ID,
  domainSeparator: DOMAIN_SEPARATOR,
  gateRegistryPath: 'docs/lane3/s33-wave3-v71-offline-gates.json' as const,
});

export const S33_DETACHED_ACCEPTANCE_PAYLOAD_V2_CONSTANTS = Object.freeze({
  repositoryIdentity: REPOSITORY_IDENTITY,
  coverageRegistryPath: COVERAGE_REGISTRY_PATH,
  signerIdentity: SIGNER_IDENTITY,
});

/**
 * Founder/CTO-confirmed production public root. This repository contains no
 * private key, signer, secret value, or environment-based authority override.
 */
export const S33_DETACHED_SIGNING_TRUST_POLICY_V2: S33DetachedSigningTrustPolicyV2 = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  artifactType: 'arkova-s33-detached-signing-trust-policy',
  signatureAlgorithm: SIGNATURE_ALGORITHM,
  signerIdentity: SIGNER_IDENTITY,
  signingKeyId: INITIAL_SIGNING_KEY_ID,
  state: 'ACTIVE',
  activationMode: ACTIVATION_MODE,
  rotationMode: ROTATION_MODE,
  revocationMode: REVOCATION_MODE,
  publicKeySpkiPem: RELEASE_CORPUS_PUBLIC_KEY_SPKI_PEM,
  publicKeyFingerprintSha256: RELEASE_CORPUS_PUBLIC_KEY_FINGERPRINT_SHA256,
  authorizedOperator: S33_PUBLIC_AUTHORITY_OPERATOR,
  fingerprintConfirmation: {
    method: 'cto-out-of-band',
    confirmedBy: S33_PUBLIC_AUTHORITY_APPROVER,
    confirmedAtUtc: S33_PUBLIC_AUTHORITY_ACTIVATED_AT_UTC,
    genesisRosterRootSha256: S33_PUBLIC_AUTHORITY_GENESIS_ROSTER_ROOT_SHA256,
    authorityReceipt: S33_PUBLIC_AUTHORITY_FOUNDER_COMMAND_RECEIPT,
  },
  activatedAtUtc: S33_PUBLIC_AUTHORITY_ACTIVATED_AT_UTC,
  retiredAtUtc: null,
  revokedAtUtc: null,
  revocationReason: null,
});

/** Production key ring: one active, code-bound public root and no private material. */
export const S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2: S33DetachedSigningTrustPolicySetV2 = deepFreeze({
  schemaVersion: SCHEMA_VERSION,
  artifactType: 'arkova-s33-detached-signing-trust-policy-set',
  signatureAlgorithm: SIGNATURE_ALGORITHM,
  signerIdentity: SIGNER_IDENTITY,
  rotationMode: ROTATION_MODE,
  activeSigningKeyId: INITIAL_SIGNING_KEY_ID,
  keys: [S33_DETACHED_SIGNING_TRUST_POLICY_V2],
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

function versionedSigningKeyId(value: unknown, label = 'S3.3 detached signing key id'): string {
  const parsed = nonEmpty(value, label);
  if (!KEY_ID.test(parsed)) throw new Error(`${label} is not versioned`);
  return parsed;
}

function signingKeyVersion(signingKeyId: string): number {
  const match = KEY_ID.exec(signingKeyId);
  if (!match) throw new Error('S3.3 detached signing key id is not versioned');
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) {
    throw new Error('S3.3 detached signing key id version exceeds the safe integer range');
  }
  return version;
}

function compareSigningKeyIds(leftSigningKeyId: string, rightSigningKeyId: string): number {
  const leftVersion = signingKeyVersion(leftSigningKeyId);
  const rightVersion = signingKeyVersion(rightSigningKeyId);
  if (leftVersion !== rightVersion) return leftVersion < rightVersion ? -1 : 1;
  return 0;
}

function assertStrictlyForwardSigningKeyId(
  previousSigningKeyId: string,
  nextSigningKeyId: string,
  transition: string,
): void {
  if (compareSigningKeyIds(nextSigningKeyId, previousSigningKeyId) > 0) return;
  throw new Error(
    `S3.3 detached ${transition} signing key id must advance strictly forward from ${previousSigningKeyId} to ${nextSigningKeyId}`,
  );
}

function maximumSigningKeyId(
  policies: readonly S33DetachedSigningTrustPolicyV2[],
): string {
  let maximum: string | null = null;
  for (const policy of policies) {
    if (maximum === null || compareSigningKeyIds(policy.signingKeyId, maximum) > 0) {
      maximum = policy.signingKeyId;
    }
  }
  if (maximum === null) throw new Error('S3.3 detached trust-policy ring has no versioned key');
  return maximum;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return nonEmpty(value, label);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
  return value;
}

function sha256Uri(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_URI.test(value)) {
    throw new Error(`${label} must be a lowercase sha256: URI`);
  }
  return value;
}

function nullableDigest(value: unknown, label: string): string | null {
  if (value === null) return null;
  return digest(value, label);
}

function isoUtc(value: unknown, label: string): string {
  const parsed = nonEmpty(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(parsed)) {
    throw new Error(`${label} must be canonical UTC ISO-8601`);
  }
  const epoch = Date.parse(parsed);
  const normalized = Number.isFinite(epoch) ? new Date(epoch).toISOString() : '';
  const expected = parsed.includes('.') ? normalized : normalized.replace('.000Z', 'Z');
  if (!Number.isFinite(epoch) || expected !== parsed) {
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
    [
      'method', 'confirmedBy', 'confirmedAtUtc', 'genesisRosterRootSha256',
      'authorityReceipt',
    ],
    'S3.3 detached fingerprint confirmation',
  );
  if (confirmation.method !== 'cto-out-of-band') {
    throw new Error('S3.3 detached fingerprint confirmation must be CTO out-of-band');
  }
  return deepFreeze({
    method: 'cto-out-of-band',
    confirmedBy: nonPlaceholder(confirmation.confirmedBy, 'S3.3 detached fingerprint confirmer'),
    confirmedAtUtc: isoUtc(confirmation.confirmedAtUtc, 'S3.3 detached fingerprint confirmation time'),
    genesisRosterRootSha256: sha256Uri(
      confirmation.genesisRosterRootSha256,
      'S3.3 detached genesis roster root',
    ),
    authorityReceipt: nonPlaceholder(
      confirmation.authorityReceipt,
      'S3.3 detached founder authority receipt',
    ),
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
  const signingKeyId = versionedSigningKeyId(policy.signingKeyId);
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

interface S33ResolvedTrustPolicySetV2 {
  policySet: S33DetachedSigningTrustPolicySetV2;
  resolvedKeys: ReadonlyMap<string, ReturnType<typeof parseTrustPolicy>>;
}

function parseTrustPolicySet(value: unknown): S33ResolvedTrustPolicySetV2 {
  const candidate = record(value, 'S3.3 detached signing trust-policy set');
  exactKeys(candidate, [
    'schemaVersion', 'artifactType', 'signatureAlgorithm', 'signerIdentity',
    'rotationMode', 'activeSigningKeyId', 'keys',
  ], 'S3.3 detached signing trust-policy set');
  if (candidate.schemaVersion !== SCHEMA_VERSION
    || candidate.artifactType !== 'arkova-s33-detached-signing-trust-policy-set'
    || candidate.signatureAlgorithm !== SIGNATURE_ALGORITHM
    || candidate.signerIdentity !== SIGNER_IDENTITY
    || candidate.rotationMode !== ROTATION_MODE) {
    throw new Error('S3.3 detached trust-policy set identity/mode tuple is invalid');
  }
  if (!Array.isArray(candidate.keys) || candidate.keys.length === 0) {
    throw new Error('S3.3 detached trust-policy set requires at least one versioned key');
  }
  const resolved = candidate.keys.map((key) => parseTrustPolicy(key));
  const keyIds = resolved.map(({ policy }) => policy.signingKeyId);
  if (new Set(keyIds).size !== keyIds.length) {
    throw new Error('S3.3 detached trust-policy set contains a duplicate signing key id');
  }
  const sortedKeyIds = [...keyIds].sort(compareSigningKeyIds);
  if (keyIds.some((keyId, index) => keyId !== sortedKeyIds[index])) {
    throw new Error('S3.3 detached trust-policy set keys must be ordered by numeric versioned key id');
  }
  const activeSigningKeyId = candidate.activeSigningKeyId === null
    ? null
    : versionedSigningKeyId(candidate.activeSigningKeyId, 'S3.3 detached active signing key id');
  const active = resolved.filter(({ policy }) => policy.state === 'ACTIVE');
  if (active.length > 1) throw new Error('S3.3 detached trust-policy set permits only one ACTIVE key');
  if (activeSigningKeyId === null && active.length !== 0) {
    throw new Error('S3.3 detached trust-policy set has an ACTIVE key but no active key id');
  }
  if (activeSigningKeyId !== null
    && (active.length !== 1 || active[0].policy.signingKeyId !== activeSigningKeyId)) {
    throw new Error('S3.3 detached trust-policy set active key id/state mismatch');
  }
  const keys = resolved.map(({ policy }) => policy);
  const policySet = deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-signing-trust-policy-set' as const,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    rotationMode: ROTATION_MODE,
    activeSigningKeyId,
    keys,
  });
  return {
    policySet,
    resolvedKeys: new Map(resolved.map((key) => [key.policy.signingKeyId, key])),
  };
}

export function validateS33DetachedSigningTrustPolicySetV2(
  value: unknown,
): S33DetachedSigningTrustPolicySetV2 {
  return parseTrustPolicySet(value).policySet;
}

function changedPolicyIds(
  current: S33DetachedSigningTrustPolicySetV2,
  next: S33DetachedSigningTrustPolicySetV2,
): string[] {
  const nextById = new Map(next.keys.map((policy) => [policy.signingKeyId, policy]));
  return current.keys
    .filter((policy) => canonicaliseJson(policy) !== canonicaliseJson(nextById.get(policy.signingKeyId)))
    .map(({ signingKeyId }) => signingKeyId);
}

function assertOnlyChanged(changed: readonly string[], expected: string, label: string): void {
  if (changed.length !== 1 || changed[0] !== expected) {
    throw new Error(`S3.3 detached ${label} must change only key ${expected}`);
  }
}

function assertExistingPolicyTransitions(
  current: S33DetachedSigningTrustPolicySetV2,
  nextById: ReadonlyMap<string, S33DetachedSigningTrustPolicyV2>,
): void {
  for (const policy of current.keys) {
    const nextPolicy = nextById.get(policy.signingKeyId);
    if (!nextPolicy) throw new Error(`S3.3 detached trust-policy set removed key ${policy.signingKeyId}`);
    if (canonicaliseJson(policy) !== canonicaliseJson(nextPolicy)) {
      transitionS33DetachedSigningTrustPolicyV2(policy, nextPolicy);
    }
  }
}

function assertInitialActivation(
  added: readonly S33DetachedSigningTrustPolicyV2[],
  changed: readonly string[],
  nextActive: string,
): void {
  if (added.length > 1 || (added.length === 1 && added[0].signingKeyId !== nextActive)) {
    throw new Error('S3.3 detached initial activation may introduce only its ACTIVE key');
  }
  if (added.length === 0) assertOnlyChanged(changed, nextActive, 'initial activation');
  if (added.length === 1 && changed.length !== 0) {
    throw new Error('S3.3 detached initial activation cannot mutate an existing key');
  }
}

function terminalPolicyTime(policy: S33DetachedSigningTrustPolicyV2): string | null {
  if (policy.state === 'REVOKED') return policy.revokedAtUtc;
  if (policy.state === 'RETIRED') return policy.retiredAtUtc;
  return null;
}

function latestTerminalPolicy(
  policies: readonly S33DetachedSigningTrustPolicyV2[],
): S33DetachedSigningTrustPolicyV2 | null {
  let latest: S33DetachedSigningTrustPolicyV2 | null = null;
  for (const policy of policies) {
    const transitionAtUtc = terminalPolicyTime(policy);
    const latestAtUtc = latest === null ? null : terminalPolicyTime(latest);
    if (transitionAtUtc !== null
      && (latestAtUtc === null || Date.parse(transitionAtUtc) >= Date.parse(latestAtUtc))) {
      latest = policy;
    }
  }
  return latest;
}

function assertPostRevocationRecovery(
  current: S33DetachedSigningTrustPolicySetV2,
  nextById: ReadonlyMap<string, S33DetachedSigningTrustPolicyV2>,
  added: readonly S33DetachedSigningTrustPolicyV2[],
  changed: readonly string[],
  nextActive: string,
): void {
  const latestTerminal = latestTerminalPolicy(current.keys);
  if (latestTerminal?.state !== 'REVOKED' || latestTerminal.revokedAtUtc === null) {
    throw new Error('S3.3 detached RETIRED key recovery is forbidden; use an atomic A-to-B hard cutover');
  }
  assertInitialActivation(added, changed, nextActive);
  const newActive = nextById.get(nextActive)!;
  assertStrictlyForwardSigningKeyId(
    maximumSigningKeyId(current.keys),
    newActive.signingKeyId,
    'post-revocation recovery',
  );
  if (newActive.activatedAtUtc === null
    || Date.parse(newActive.activatedAtUtc) < Date.parse(latestTerminal.revokedAtUtc)) {
    throw new Error('S3.3 detached recovery key activation predates the latest revocation');
  }
}

function assertDeactivation(
  nextById: ReadonlyMap<string, S33DetachedSigningTrustPolicyV2>,
  added: readonly S33DetachedSigningTrustPolicyV2[],
  changed: readonly string[],
  currentActive: string,
): void {
  if (added.length !== 0) throw new Error('S3.3 detached deactivation cannot add a key');
  assertOnlyChanged(changed, currentActive, 'deactivation');
  const terminalState = nextById.get(currentActive)!.state;
  if (terminalState !== 'RETIRED' && terminalState !== 'REVOKED') {
    throw new Error('S3.3 detached deactivation must retire or revoke the ACTIVE key');
  }
}

function assertHardCutover(
  currentById: ReadonlyMap<string, S33DetachedSigningTrustPolicyV2>,
  nextById: ReadonlyMap<string, S33DetachedSigningTrustPolicyV2>,
  added: readonly S33DetachedSigningTrustPolicyV2[],
  changed: readonly string[],
  currentActive: string,
  nextActive: string,
): void {
  const oldActive = currentById.get(currentActive);
  const retiredOld = nextById.get(currentActive);
  const newActive = nextById.get(nextActive);
  if (!oldActive || !retiredOld || !newActive || added.length !== 1
    || added[0].signingKeyId !== nextActive) {
    throw new Error('S3.3 detached hard cutover must add exactly one new versioned ACTIVE key');
  }
  assertStrictlyForwardSigningKeyId(
    oldActive.signingKeyId,
    newActive.signingKeyId,
    'hard cutover',
  );
  assertOnlyChanged(changed, currentActive, 'hard cutover');
  if (oldActive.state !== 'ACTIVE' || retiredOld.state !== 'RETIRED' || newActive.state !== 'ACTIVE'
    || retiredOld.retiredAtUtc !== newActive.activatedAtUtc) {
    throw new Error('S3.3 detached hard cutover must retire A exactly when B activates');
  }
}

/** Validate atomic activation, no-gap retirement, revocation, and A-to-B cutover. */
export function transitionS33DetachedSigningTrustPolicySetV2(
  currentValue: unknown,
  nextValue: unknown,
): S33DetachedSigningTrustPolicySetV2 {
  const current = validateS33DetachedSigningTrustPolicySetV2(currentValue);
  const next = validateS33DetachedSigningTrustPolicySetV2(nextValue);
  const currentById = new Map(current.keys.map((policy) => [policy.signingKeyId, policy]));
  const nextById = new Map(next.keys.map((policy) => [policy.signingKeyId, policy]));
  assertExistingPolicyTransitions(current, nextById);
  const added = next.keys.filter((policy) => !currentById.has(policy.signingKeyId));
  const changed = changedPolicyIds(current, next);
  const currentActive = current.activeSigningKeyId;
  const nextActive = next.activeSigningKeyId;

  if (currentActive === nextActive) {
    if (added.length !== 0) throw new Error('S3.3 detached trust-policy set cannot add an inactive key');
    return next;
  }
  if (currentActive === null && nextActive !== null) {
    const priorTerminal = latestTerminalPolicy(current.keys);
    if (priorTerminal === null) assertInitialActivation(added, changed, nextActive);
    else assertPostRevocationRecovery(current, nextById, added, changed, nextActive);
    return next;
  }
  if (currentActive !== null && nextActive === null) {
    assertDeactivation(nextById, added, changed, currentActive);
    return next;
  }
  assertHardCutover(currentById, nextById, added, changed, currentActive!, nextActive!);
  return next;
}

function gitObjectIdSha1(value: unknown, label: string): string {
  const parsed = nonEmpty(value, label);
  if (!SHA1.test(parsed)) throw new Error(`${label} must be a full lowercase SHA-1 Git object id`);
  return parsed;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function assertZero(value: unknown, label: string): void {
  if (value !== 0) throw new Error(`${label} must be zero`);
}

const ACCEPTED_ENTRY_INPUT_KEYS = [
  'id', 'registryTypeId', 'batchId', 'revision', 'credentialType', 'subType',
  'normalizedInputSha256', 'groundTruthSha256', 'authorshipMethod', 'generatorDerived',
  'trainingExposed', 'intendedSplit', 'productionValidSubstantiveFieldCount',
  'edgeCase', 'sourceBlobSha',
] as const;

function validateDetachedAcceptedEntryInputV2(
  value: unknown,
  batchId: string,
  revision: number,
  sourceBlobSha: string,
  label: string,
): S33DetachedAcceptedEntryInputV2 {
  const entry = record(value, label);
  exactKeys(entry, ACCEPTED_ENTRY_INPUT_KEYS, label);
  const id = nonEmpty(entry.id, `${label}.id`);
  const registryTypeId = nonEmpty(entry.registryTypeId, `${label}.registryTypeId`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(registryTypeId)) {
    throw new Error(`${label}.registryTypeId must be a lowercase kebab-case policy id`);
  }
  const credentialType = nonEmpty(entry.credentialType, `${label}.credentialType`);
  if (!/^[A-Z][A-Z0-9_]*$/u.test(credentialType)) {
    throw new Error(`${label}.credentialType must be a canonical uppercase type`);
  }
  const subType = nonEmpty(entry.subType, `${label}.subType`);
  const frozenFallbackSubtype = subType === 'other' && credentialType === 'PUBLICATION';
  if (subType.trim().toLowerCase() === 'other' && !frozenFallbackSubtype) {
    throw new Error(`${label}.subType must be concrete unless the frozen v6 type uses its exact other fallback`);
  }
  if (entry.batchId !== batchId || entry.revision !== revision) {
    throw new Error(`${label} batch/revision does not match its signed whole batch`);
  }
  if (entry.authorshipMethod !== 'real-source' && entry.authorshipMethod !== 'independently-authored') {
    throw new Error(`${label}.authorshipMethod is unauthorized`);
  }
  if (entry.generatorDerived !== false || entry.trainingExposed !== false || entry.intendedSplit !== 'held-out') {
    throw new Error(`${label} must be non-generated, training-unexposed, and held-out`);
  }
  const substantiveCount = positiveSafeInteger(
    entry.productionValidSubstantiveFieldCount,
    `${label}.productionValidSubstantiveFieldCount`,
  );
  if (substantiveCount < 5) throw new Error(`${label} has fewer than five production-valid substantive fields`);
  if (typeof entry.edgeCase !== 'boolean') throw new Error(`${label}.edgeCase must be boolean`);
  const entrySourceBlobSha = gitObjectIdSha1(entry.sourceBlobSha, `${label}.sourceBlobSha`);
  if (entrySourceBlobSha !== sourceBlobSha) throw new Error(`${label}.sourceBlobSha is not the signed source blob`);
  return {
    id,
    registryTypeId,
    batchId,
    revision,
    credentialType,
    subType,
    normalizedInputSha256: digest(entry.normalizedInputSha256, `${label}.normalizedInputSha256`),
    groundTruthSha256: digest(entry.groundTruthSha256, `${label}.groundTruthSha256`),
    authorshipMethod: entry.authorshipMethod,
    generatorDerived: false,
    trainingExposed: false,
    intendedSplit: 'held-out',
    productionValidSubstantiveFieldCount: substantiveCount,
    edgeCase: entry.edgeCase,
    sourceBlobSha: entrySourceBlobSha,
  };
}

function buildDetachedAcceptedEntryV2(
  value: unknown,
  batchId: string,
  revision: number,
  sourceBlobSha: string,
  label: string,
): S33DetachedAcceptedEntryV2 {
  const input = validateDetachedAcceptedEntryInputV2(value, batchId, revision, sourceBlobSha, label);
  return { ...input, entryCanonicalSha256: canonicalDigest(input) };
}

function validateDetachedAcceptedEntryV2(
  value: unknown,
  batchId: string,
  revision: number,
  sourceBlobSha: string,
  label: string,
): S33DetachedAcceptedEntryV2 {
  const entry = record(value, label);
  exactKeys(entry, [...ACCEPTED_ENTRY_INPUT_KEYS, 'entryCanonicalSha256'], label);
  const entryCanonicalSha256 = digest(entry.entryCanonicalSha256, `${label}.entryCanonicalSha256`);
  const input = validateDetachedAcceptedEntryInputV2(
    Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'entryCanonicalSha256')),
    batchId,
    revision,
    sourceBlobSha,
    label,
  );
  if (canonicalDigest(input) !== entryCanonicalSha256) throw new Error(`${label} entry digest mismatch`);
  return { ...input, entryCanonicalSha256 };
}

function validateDetachedTransportActorV2(value: unknown): S33DetachedGitHubTransportActorV2 {
  const actor = record(value, 'S3.3 detached GitHub transport actor');
  exactKeys(actor, ['login', 'databaseId', 'nodeId'], 'S3.3 detached GitHub transport actor');
  return {
    login: nonEmpty(actor.login, 'S3.3 detached GitHub transport actor login'),
    databaseId: positiveSafeInteger(actor.databaseId, 'S3.3 detached GitHub transport actor database id'),
    nodeId: nonEmpty(actor.nodeId, 'S3.3 detached GitHub transport actor node id'),
  };
}

function validateDetachedTransportUrlV2(
  url: string,
  transport: S33DetachedAcceptanceReviewerV2['transport'],
  pullRequestNumber: number,
  evidenceId: number,
): void {
  const prefix = `https://github.com/${REPOSITORY_IDENTITY}/pull/${pullRequestNumber}`;
  const expectedAnchor = transport === 'github-issue-comment'
    ? `#issuecomment-${evidenceId}`
    : `#pullrequestreview-${evidenceId}`;
  if (url !== `${prefix}${expectedAnchor}`) {
    throw new Error('S3.3 detached GitHub transport URL does not match its PR, kind, and stable id');
  }
}

function validateDetachedReviewerV2(
  value: unknown,
  pullRequestNumber: number,
): S33DetachedAcceptanceReviewerV2 {
  const reviewer = record(value, 'S3.3 detached acceptance reviewer');
  exactKeys(reviewer, ['lane', 'transport', 'evidence'], 'S3.3 detached acceptance reviewer');
  if (reviewer.lane !== 'Lane 3'
    || (reviewer.transport !== 'github-issue-comment' && reviewer.transport !== 'github-formal-review')) {
    throw new Error('S3.3 detached acceptance authority must be Lane 3 over an allowed GitHub transport');
  }
  const transport = reviewer.transport;
  const evidence = record(reviewer.evidence, 'S3.3 detached GitHub transport evidence');
  exactKeys(
    evidence,
    ['id', 'nodeId', 'url', 'submittedAtUtc', 'actor'],
    'S3.3 detached GitHub transport evidence',
  );
  const id = positiveSafeInteger(evidence.id, 'S3.3 detached GitHub transport evidence id');
  const nodeId = evidence.nodeId === null
    ? null
    : nonEmpty(evidence.nodeId, 'S3.3 detached GitHub transport evidence node id');
  const url = nonEmpty(evidence.url, 'S3.3 detached GitHub transport evidence URL');
  validateDetachedTransportUrlV2(url, transport, pullRequestNumber, id);
  return {
    lane: 'Lane 3',
    transport,
    evidence: {
      id,
      nodeId,
      url,
      submittedAtUtc: isoUtc(evidence.submittedAtUtc, 'S3.3 detached GitHub transport submittedAtUtc'),
      actor: validateDetachedTransportActorV2(evidence.actor),
    },
  };
}

function minimumHumanCrossReviewSampleV2(acceptedEntryCount: number): number {
  return Math.min(
    acceptedEntryCount,
    Math.max(5, Math.ceil(acceptedEntryCount * 0.1)),
  );
}

function validateDetachedProofV2(
  value: unknown,
  acceptedEntryCount: number,
): S33DetachedAcceptanceProofV2 {
  const proof = record(value, 'S3.3 detached acceptance proof');
  exactKeys(proof, [
    'machineValidationArtifactSha256', 'machineValidationFailureCount',
    'humanCrossReviewArtifactSha256', 'humanCrossReviewSampleSize',
    'materialLabelDefectCount', 'prodModelDiffArtifactSha256',
    'exactLeakageArtifactSha256', 'exactLeakageHitCount',
  ], 'S3.3 detached acceptance proof');
  assertZero(proof.machineValidationFailureCount, 'S3.3 detached machine validation failure count');
  assertZero(proof.materialLabelDefectCount, 'S3.3 detached material label defect count');
  assertZero(proof.exactLeakageHitCount, 'S3.3 detached exact leakage hit count');
  const sampleSize = positiveSafeInteger(
    proof.humanCrossReviewSampleSize,
    'S3.3 detached human cross-review sample size',
  );
  const minimumSample = minimumHumanCrossReviewSampleV2(acceptedEntryCount);
  if (sampleSize < minimumSample || sampleSize > acceptedEntryCount) {
    throw new Error(
      `S3.3 detached human cross-review sample must be ${minimumSample}-${acceptedEntryCount} rows`,
    );
  }
  return {
    machineValidationArtifactSha256: digest(
      proof.machineValidationArtifactSha256,
      'S3.3 detached machine validation artifact digest',
    ),
    machineValidationFailureCount: 0,
    humanCrossReviewArtifactSha256: digest(
      proof.humanCrossReviewArtifactSha256,
      'S3.3 detached human cross-review artifact digest',
    ),
    humanCrossReviewSampleSize: sampleSize,
    materialLabelDefectCount: 0,
    prodModelDiffArtifactSha256: digest(
      proof.prodModelDiffArtifactSha256,
      'S3.3 detached prod-model-diff artifact digest',
    ),
    exactLeakageArtifactSha256: digest(
      proof.exactLeakageArtifactSha256,
      'S3.3 detached exact leakage artifact digest',
    ),
    exactLeakageHitCount: 0,
  };
}

function assertUniqueDetachedAcceptedEntriesV2(
  entries: readonly S33DetachedAcceptedEntryV2[],
): void {
  const unique = (selector: (entry: S33DetachedAcceptedEntryV2) => string): boolean => (
    new Set(entries.map(selector)).size === entries.length
  );
  if (!unique(({ id }) => id)) throw new Error('S3.3 detached acceptance contains duplicate entry ids');
  if (!unique(({ normalizedInputSha256 }) => normalizedInputSha256)) {
    throw new Error('S3.3 detached acceptance contains duplicate normalized input fingerprints');
  }
  if (!unique(({ entryCanonicalSha256 }) => entryCanonicalSha256)) {
    throw new Error('S3.3 detached acceptance contains duplicate entry canonical fingerprints');
  }
}

export function computeS33DetachedAcceptedEntryOrderSha256V2(
  entryIds: readonly string[],
): string {
  if (entryIds.length === 0 || entryIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('S3.3 detached accepted entry order requires non-empty ids');
  }
  return canonicalDigest(entryIds);
}

function computeDetachedAcceptedEntrySetSha256V2(
  entries: readonly S33DetachedAcceptedEntryV2[],
): string {
  const sortedIds = entries.map(({ id }) => id).sort(compareUtf16CodeUnits);
  return canonicalDigest(sortedIds);
}

const DETACHED_PAYLOAD_KEYS = [
  'schemaVersion', 'artifactType', 'verdict', 'signerIdentity', 'signingKeyId',
  'repositoryIdentity', 'pullRequestNumber', 'candidateBaseSha', 'candidateHeadSha',
  'candidateTreeSha', 'batchId', 'revision', 'manifestPath', 'manifestRawSha256',
  'manifestCanonicalSha256', 'sourceBlobSha', 'datasheetBlobSha',
  'preflightArtifactDigestSha256', 'baseRegistryDigestSha256',
  'resultingRegistryDigestSha256', 'coverageRegistryPath',
  'coverageRegistryRawSha256', 'coverageRegistryCanonicalSha256', 'signedAtUtc',
  'reviewer', 'proof', 'acceptedEntryCount', 'acceptedEntrySetCanonicalSha256',
  'acceptedEntryOrderSha256', 'acceptedEntries',
] as const;

/** Native strict v2 parser; it does not translate through the legacy-v1 contract. */
export function validateS33DetachedAcceptancePayloadV2(
  value: unknown,
): S33DetachedAcceptancePayloadV2 {
  const payload = record(value, 'S3.3 detached acceptance payload');
  exactKeys(payload, DETACHED_PAYLOAD_KEYS, 'S3.3 detached acceptance payload');
  if (payload.schemaVersion !== SCHEMA_VERSION
    || payload.artifactType !== 'arkova-s33-detached-batch-acceptance-payload'
    || payload.verdict !== 'APPROVED_WHOLE_BATCH'
    || payload.signerIdentity !== SIGNER_IDENTITY
    || payload.repositoryIdentity !== REPOSITORY_IDENTITY
    || payload.coverageRegistryPath !== COVERAGE_REGISTRY_PATH) {
    throw new Error('S3.3 detached payload identity/authority/verdict/policy tuple is invalid');
  }
  const signingKeyId = versionedSigningKeyId(
    payload.signingKeyId,
    'S3.3 detached payload signing key id',
  );
  const pullRequestNumber = positiveSafeInteger(
    payload.pullRequestNumber,
    'S3.3 detached pull request number',
  );
  const batchId = nonEmpty(payload.batchId, 'S3.3 detached batch id');
  const revision = positiveSafeInteger(payload.revision, 'S3.3 detached batch revision');
  const sourceBlobSha = gitObjectIdSha1(payload.sourceBlobSha, 'S3.3 detached source blob');
  const acceptedEntryCount = positiveSafeInteger(
    payload.acceptedEntryCount,
    'S3.3 detached accepted entry count',
  );
  if (acceptedEntryCount > 2_000 || !Array.isArray(payload.acceptedEntries)
    || payload.acceptedEntries.length !== acceptedEntryCount) {
    throw new Error('S3.3 detached acceptance count must bind one complete batch of at most 2,000 entries');
  }
  const acceptedEntries = payload.acceptedEntries.map((entry, index) => validateDetachedAcceptedEntryV2(
    entry,
    batchId,
    revision,
    sourceBlobSha,
    `S3.3 detached acceptedEntries[${index}]`,
  ));
  assertUniqueDetachedAcceptedEntriesV2(acceptedEntries);
  const acceptedEntryOrderSha256 = computeS33DetachedAcceptedEntryOrderSha256V2(
    acceptedEntries.map(({ id }) => id),
  );
  if (digest(payload.acceptedEntryOrderSha256, 'S3.3 detached accepted-entry order digest')
    !== acceptedEntryOrderSha256) {
    throw new Error('S3.3 detached accepted-entry order digest mismatch');
  }
  const acceptedEntrySetCanonicalSha256 = digest(
    payload.acceptedEntrySetCanonicalSha256,
    'S3.3 detached accepted-entry set digest',
  );
  if (acceptedEntrySetCanonicalSha256 !== computeDetachedAcceptedEntrySetSha256V2(acceptedEntries)) {
    throw new Error('S3.3 detached accepted-entry set digest mismatch');
  }
  const reviewer = validateDetachedReviewerV2(payload.reviewer, pullRequestNumber);
  const signedAtUtc = isoUtc(payload.signedAtUtc, 'S3.3 detached acceptance signedAtUtc');
  if (Date.parse(signedAtUtc) < Date.parse(reviewer.evidence.submittedAtUtc)) {
    throw new Error('S3.3 detached acceptance cannot be signed before its GitHub transport evidence');
  }
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-batch-acceptance-payload',
    verdict: 'APPROVED_WHOLE_BATCH',
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId,
    repositoryIdentity: REPOSITORY_IDENTITY,
    pullRequestNumber,
    candidateBaseSha: gitObjectIdSha1(payload.candidateBaseSha, 'S3.3 detached candidate base'),
    candidateHeadSha: gitObjectIdSha1(payload.candidateHeadSha, 'S3.3 detached candidate head'),
    candidateTreeSha: gitObjectIdSha1(payload.candidateTreeSha, 'S3.3 detached candidate tree'),
    batchId,
    revision,
    manifestPath: nonEmpty(payload.manifestPath, 'S3.3 detached manifest path'),
    manifestRawSha256: digest(payload.manifestRawSha256, 'S3.3 detached manifest raw digest'),
    manifestCanonicalSha256: digest(
      payload.manifestCanonicalSha256,
      'S3.3 detached manifest canonical digest',
    ),
    sourceBlobSha,
    datasheetBlobSha: gitObjectIdSha1(payload.datasheetBlobSha, 'S3.3 detached datasheet blob'),
    preflightArtifactDigestSha256: digest(
      payload.preflightArtifactDigestSha256,
      'S3.3 detached preflight digest',
    ),
    baseRegistryDigestSha256: digest(
      payload.baseRegistryDigestSha256,
      'S3.3 detached base registry digest',
    ),
    resultingRegistryDigestSha256: digest(
      payload.resultingRegistryDigestSha256,
      'S3.3 detached resulting registry digest',
    ),
    coverageRegistryPath: COVERAGE_REGISTRY_PATH,
    coverageRegistryRawSha256: digest(
      payload.coverageRegistryRawSha256,
      'S3.3 detached coverage registry raw digest',
    ),
    coverageRegistryCanonicalSha256: digest(
      payload.coverageRegistryCanonicalSha256,
      'S3.3 detached coverage registry canonical digest',
    ),
    signedAtUtc,
    reviewer,
    proof: validateDetachedProofV2(payload.proof, acceptedEntryCount),
    acceptedEntryCount,
    acceptedEntrySetCanonicalSha256,
    acceptedEntryOrderSha256,
    acceptedEntries,
  });
}

const DETACHED_PAYLOAD_INPUT_KEYS = [
  'repositoryIdentity', 'pullRequestNumber', 'candidateBaseSha', 'candidateHeadSha',
  'candidateTreeSha', 'batchId', 'revision', 'manifestPath', 'manifestRawSha256',
  'manifestCanonicalSha256', 'sourceBlobSha', 'datasheetBlobSha',
  'preflightArtifactDigestSha256', 'baseRegistryDigestSha256',
  'resultingRegistryDigestSha256', 'coverageRegistryPath',
  'coverageRegistryRawSha256', 'coverageRegistryCanonicalSha256', 'signedAtUtc',
  'reviewer', 'proof', 'acceptedEntries',
] as const;

/** Build the native unsigned v2 payload without accepting signing material. */
export function buildS33DetachedAcceptancePayloadV2(
  input: S33DetachedAcceptancePayloadInputV2,
  signingKeyIdValue: string = INITIAL_SIGNING_KEY_ID,
): S33DetachedAcceptancePayloadV2 {
  const candidate = record(input, 'S3.3 detached unsigned acceptance input');
  exactKeys(candidate, DETACHED_PAYLOAD_INPUT_KEYS, 'S3.3 detached unsigned acceptance input');
  if (!Array.isArray(input.acceptedEntries) || input.acceptedEntries.length === 0) {
    throw new Error('S3.3 detached unsigned acceptance requires a non-empty whole batch');
  }
  const signingKeyId = versionedSigningKeyId(
    signingKeyIdValue,
    'S3.3 detached unsigned payload signing key id',
  );
  const sourceBlobSha = gitObjectIdSha1(input.sourceBlobSha, 'S3.3 detached unsigned input source blob');
  const acceptedEntries = input.acceptedEntries.map((entry, index) => buildDetachedAcceptedEntryV2(
    entry,
    input.batchId,
    input.revision,
    sourceBlobSha,
    `S3.3 detached unsigned acceptedEntries[${index}]`,
  ));
  assertUniqueDetachedAcceptedEntriesV2(acceptedEntries);
  return validateS33DetachedAcceptancePayloadV2({
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-batch-acceptance-payload',
    verdict: 'APPROVED_WHOLE_BATCH',
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId,
    ...input,
    acceptedEntryCount: acceptedEntries.length,
    acceptedEntrySetCanonicalSha256: computeDetachedAcceptedEntrySetSha256V2(acceptedEntries),
    acceptedEntryOrderSha256: computeS33DetachedAcceptedEntryOrderSha256V2(
      acceptedEntries.map(({ id }) => id),
    ),
    acceptedEntries,
  });
}

function validateV2Payload(value: unknown): S33DetachedAcceptancePayloadV2 {
  return validateS33DetachedAcceptancePayloadV2(value);
}

function signingBytes(payload: S33DetachedAcceptancePayloadV2): Buffer {
  return Buffer.from(`${DOMAIN_SEPARATOR}${canonicaliseJson(payload)}`, 'utf8');
}

function requestWithoutDigest(
  request: Omit<S33DetachedSigningRequestV2, 'requestDigestSha256'>,
): Omit<S33DetachedSigningRequestV2, 'requestDigestSha256'> {
  return request;
}

function signingRequestFromPayload(payloadValue: unknown): S33DetachedSigningRequestV2 {
  const payload = validateV2Payload(payloadValue);
  const payloadCanonicalJson = canonicaliseJson(payload);
  const bytes = signingBytes(payload);
  const withoutDigest = requestWithoutDigest({
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-signing-request',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: payload.signingKeyId,
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

/** Emit the exact bytes for CTO-controlled detached signing. */
export function emitS33DetachedSigningRequestV2(
  input: S33DetachedAcceptancePayloadInputV2,
  signingKeyIdValue: string = INITIAL_SIGNING_KEY_ID,
): S33DetachedSigningRequestV2 {
  const signingKeyId = versionedSigningKeyId(signingKeyIdValue);
  return signingRequestFromPayload(buildS33DetachedAcceptancePayloadV2(input, signingKeyId));
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
    || request.domainSeparator !== DOMAIN_SEPARATOR) {
    throw new Error('S3.3 detached signing-request identity/domain tuple is invalid');
  }
  const signingKeyId = versionedSigningKeyId(
    request.signingKeyId,
    'S3.3 detached request signing key id',
  );
  const payload = validateV2Payload(request.payload);
  if (payload.signingKeyId !== signingKeyId) {
    throw new Error('S3.3 detached signing-request key id does not match its payload');
  }
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
    signingKeyId,
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

type S33ActiveTrustPolicyV2 = {
  policy: S33DetachedSigningTrustPolicyV2;
  publicKey: KeyObject;
};

function requireActiveTrustPolicySet(
  resolvedSet: S33ResolvedTrustPolicySetV2,
): S33ActiveTrustPolicyV2 {
  const activeSigningKeyId = resolvedSet.policySet.activeSigningKeyId;
  const resolved = activeSigningKeyId === null
    ? undefined
    : resolvedSet.resolvedKeys.get(activeSigningKeyId);
  if (!resolved || resolved.policy.state !== 'ACTIVE' || resolved.publicKey === null) {
    const states = resolvedSet.policySet.keys.map(({ state }) => state).join(', ');
    throw new Error(
      `S3.3 detached trust-policy set has no configured ACTIVE key (${states}); acceptance fails closed`,
    );
  }
  return { policy: resolved.policy, publicKey: resolved.publicKey };
}

function signingAuthority(
  active: S33ActiveTrustPolicyV2,
): S33DetachedSigningAuthorityV2 {
  const { policy } = active;
  if (policy.publicKeyFingerprintSha256 === null
    || policy.authorizedOperator === null
    || policy.activatedAtUtc === null) {
    throw new Error('S3.3 detached ACTIVE trust policy is missing release-authority material');
  }
  return deepFreeze({
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: policy.signingKeyId,
    publicKeyFingerprintSha256: policy.publicKeyFingerprintSha256,
    authorizedOperator: policy.authorizedOperator,
    activatedAtUtc: policy.activatedAtUtc,
  });
}

/** Resolve the sole committed production public authority; invalid state fails closed. */
export function getS33DetachedSigningAuthorityV2(): S33DetachedSigningAuthorityV2 {
  return signingAuthority(
    requireActiveTrustPolicySet(parseTrustPolicySet(S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2)),
  );
}

/**
 * Rebind an unsigned in-flight request to the sole ACTIVE post-cutover key.
 * The returned bytes require a new CTO-controlled detached signature.
 */
export function regenerateS33DetachedSigningRequestForActiveKeyV2(
  requestValue: unknown,
  signedAtUtcValue: string,
  trustPolicySetValue: unknown,
): S33DetachedSigningRequestV2 {
  const request = validateSigningRequest(requestValue);
  const resolvedSet = parseTrustPolicySet(trustPolicySetValue);
  const active = requireActiveTrustPolicySet(resolvedSet).policy;
  const prior = resolvedSet.resolvedKeys.get(request.signingKeyId)?.policy;
  if (!prior || prior.state !== 'RETIRED' || prior.retiredAtUtc === null) {
    throw new Error('S3.3 detached regeneration requires the request key to be RETIRED');
  }
  if (request.signingKeyId === active.signingKeyId
    || active.activatedAtUtc === null
    || prior.retiredAtUtc !== active.activatedAtUtc) {
    throw new Error('S3.3 detached regeneration requires an exact A-to-B hard cutover');
  }
  const signedAtUtc = isoUtc(signedAtUtcValue, 'S3.3 detached regenerated signing time');
  if (Date.parse(signedAtUtc) < Date.parse(active.activatedAtUtc)) {
    throw new Error('S3.3 detached regenerated signing time precedes the active-key cutover');
  }
  return signingRequestFromPayload({
    ...request.payload,
    signingKeyId: active.signingKeyId,
    signedAtUtc,
  });
}

function assertRequestPolicy(
  request: S33DetachedSigningRequestV2,
  policy: S33DetachedSigningTrustPolicyV2,
  contextValue: S33DetachedAcceptanceVerificationContextV2,
): void {
  if (request.signerIdentity !== policy.signerIdentity || request.signingKeyId !== policy.signingKeyId) {
    throw new Error('S3.3 detached request does not match the ACTIVE trust-policy key identity');
  }
  if (policy.activatedAtUtc === null
    || Date.parse(request.payload.signedAtUtc) < Date.parse(policy.activatedAtUtc)) {
    throw new Error('S3.3 detached request predates the selected trust-policy key activation');
  }
  const context = record(contextValue, 'S3.3 detached trusted verification context');
  exactKeys(context, ['verifiedAtUtc'], 'S3.3 detached trusted verification context');
  const verifiedAtUtc = isoUtc(
    context.verifiedAtUtc,
    'S3.3 detached trusted verification time',
  );
  if (Date.parse(request.payload.signedAtUtc) > Date.parse(verifiedAtUtc)) {
    throw new Error('S3.3 detached request is future-dated relative to trusted verification time');
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
  context: S33DetachedAcceptanceVerificationContextV2,
): S33DetachedAcceptanceEnvelopeV2 {
  const request = validateSigningRequest(requestValue);
  const signature = signatureBase64Url(signatureValue);
  const { policy, publicKey } = trustPolicy;
  assertRequestPolicy(request, policy, context);
  verifySignature(request, signature, publicKey);
  const withoutDigest = envelopeWithoutDigest({
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-acceptance-envelope',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: policy.signingKeyId,
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
  context: S33DetachedAcceptanceVerificationContextV2,
): S33DetachedAcceptanceEnvelopeV2 {
  return assembleWithTrustPolicy(
    requestValue,
    signatureValue,
    requireActiveTrustPolicySet(parseTrustPolicySet(S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2)),
    context,
  );
}

const BINDING_KEYS = [
  'repositoryIdentity', 'pullRequestNumber', 'candidateBaseSha', 'candidateHeadSha',
  'candidateTreeSha', 'batchId', 'revision', 'manifestPath', 'manifestRawSha256',
  'manifestCanonicalSha256', 'sourceBlobSha', 'datasheetBlobSha',
  'preflightArtifactDigestSha256', 'baseRegistryDigestSha256',
  'resultingRegistryDigestSha256', 'coverageRegistryPath', 'coverageRegistryRawSha256',
  'coverageRegistryCanonicalSha256', 'acceptedEntryOrderSha256',
] as const satisfies readonly (keyof S33DetachedAcceptanceBindingsV2)[];

function assertPayloadBindings(
  payload: S33DetachedAcceptancePayloadV2,
  bindingsValue: S33DetachedAcceptanceBindingsV2,
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
  bindings: S33DetachedAcceptanceBindingsV2,
  trustPolicy: { policy: S33DetachedSigningTrustPolicyV2; publicKey: KeyObject },
  context: S33DetachedAcceptanceVerificationContextV2,
): S33DetachedAcceptanceEnvelopeV2 {
  const envelope = record(value, 'S3.3 detached acceptance envelope');
  exactKeys(envelope, [
    'schemaVersion', 'artifactType', 'signatureAlgorithm', 'signerIdentity', 'signingKeyId',
    'publicKeyFingerprintSha256', 'request', 'signatureBase64Url', 'artifactDigestSha256',
  ], 'S3.3 detached acceptance envelope');
  if (envelope.schemaVersion !== SCHEMA_VERSION
    || envelope.artifactType !== 'arkova-s33-detached-acceptance-envelope'
    || envelope.signatureAlgorithm !== SIGNATURE_ALGORITHM
    || envelope.signerIdentity !== SIGNER_IDENTITY) {
    throw new Error('S3.3 detached envelope identity/schema tuple is invalid');
  }
  const signingKeyId = versionedSigningKeyId(
    envelope.signingKeyId,
    'S3.3 detached envelope signing key id',
  );
  const request = validateSigningRequest(envelope.request);
  if (request.signingKeyId !== signingKeyId) {
    throw new Error('S3.3 detached envelope key id does not match its request');
  }
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
    signingKeyId,
    publicKeyFingerprintSha256,
    request,
    signatureBase64Url: signature,
  });
  const artifactDigestSha256 = digest(envelope.artifactDigestSha256, 'S3.3 detached envelope digest');
  if (canonicalDigest(withoutDigest) !== artifactDigestSha256) {
    throw new Error('S3.3 detached acceptance-envelope artifact digest mismatch');
  }
  const { policy, publicKey } = trustPolicy;
  assertRequestPolicy(request, policy, context);
  if (publicKeyFingerprintSha256 !== policy.publicKeyFingerprintSha256) {
    throw new Error('S3.3 detached envelope fingerprint does not match the selected CTO trust policy');
  }
  verifySignature(request, signature, publicKey);
  assertPayloadBindings(request.payload, bindings);
  return deepFreeze({ ...withoutDigest, artifactDigestSha256 });
}


export function verifyS33DetachedAcceptanceEnvelopeV2(
  value: unknown,
  bindings: S33DetachedAcceptanceBindingsV2,
  context: S33DetachedAcceptanceVerificationContextV2,
): S33DetachedAcceptanceEnvelopeV2 {
  return verifyWithTrustPolicy(
    value,
    bindings,
    requireActiveTrustPolicySet(parseTrustPolicySet(S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2)),
    context,
  );
}

function parseHistoricalAuditContext(value: unknown): S33DetachedHistoricalAuditContextV2 {
  const context = record(value, 'S3.3 detached historical audit context');
  exactKeys(
    context,
    ['evidenceState', 'mergedAtUtc', 'auditedAtUtc'],
    'S3.3 detached historical audit context',
  );
  if (context.evidenceState !== 'MERGED' && context.evidenceState !== 'UNMERGED') {
    throw new Error('S3.3 detached historical audit evidence state is invalid');
  }
  const auditedAtUtc = isoUtc(context.auditedAtUtc, 'S3.3 detached historical audit time');
  const mergedAtUtc = nullableIsoUtc(context.mergedAtUtc, 'S3.3 detached evidence merge time');
  if ((context.evidenceState === 'MERGED') !== (mergedAtUtc !== null)) {
    throw new Error('S3.3 detached historical audit merge state/time mismatch');
  }
  return deepFreeze({ evidenceState: context.evidenceState, mergedAtUtc, auditedAtUtc });
}

function assertHistoricalAuditTimeline(
  envelope: S33DetachedAcceptanceEnvelopeV2,
  policy: S33DetachedSigningTrustPolicyV2,
  context: S33DetachedHistoricalAuditContextV2,
): void {
  const signedAtUtc = envelope.request.payload.signedAtUtc;
  if (Date.parse(context.auditedAtUtc) < Date.parse(signedAtUtc)) {
    throw new Error('S3.3 detached historical audit predates the signed payload');
  }
  if (context.mergedAtUtc !== null) {
    if (Date.parse(context.mergedAtUtc) < Date.parse(signedAtUtc)) {
      throw new Error('S3.3 detached evidence merge predates the signed payload');
    }
    if (Date.parse(context.auditedAtUtc) < Date.parse(context.mergedAtUtc)) {
      throw new Error('S3.3 detached historical audit predates the evidence merge');
    }
  }
  const terminalAtUtc = policy.state === 'REVOKED' ? policy.revokedAtUtc : policy.retiredAtUtc;
  if (terminalAtUtc !== null && Date.parse(context.auditedAtUtc) < Date.parse(terminalAtUtc)) {
    throw new Error('S3.3 detached historical audit predates the key state transition');
  }
}

function historicalDisposition(
  envelope: S33DetachedAcceptanceEnvelopeV2,
  policy: S33DetachedSigningTrustPolicyV2,
  context: S33DetachedHistoricalAuditContextV2,
): Pick<S33DetachedHistoricalAuditResultV2, 'disposition' | 'reason'> {
  if (context.evidenceState === 'UNMERGED') {
    return {
      disposition: 'REJECTED_NEW_ACCEPTANCE',
      reason: `New or unmerged evidence is rejected under ${policy.state} key ${policy.signingKeyId}`,
    };
  }
  if (policy.state === 'REVOKED') {
    return {
      disposition: 'CTO_HOLD',
      reason: `CTO HOLD: signing key was revoked: ${policy.revocationReason!}`,
    };
  }
  if (policy.state === 'RETIRED') {
    const cutoverAtUtc = policy.retiredAtUtc!;
    if (Date.parse(envelope.request.payload.signedAtUtc) >= Date.parse(cutoverAtUtc)
      || Date.parse(context.mergedAtUtc!) >= Date.parse(cutoverAtUtc)) {
      return {
        disposition: 'CTO_HOLD',
        reason: 'CTO HOLD: evidence crossed the hard cutover and must be regenerated under the ACTIVE key',
      };
    }
    return {
      disposition: 'HISTORICAL_AUDIT_VERIFIED',
      reason: 'Historical signature verified before retirement; audit result grants no acceptance authority',
    };
  }
  return {
    disposition: 'HISTORICAL_AUDIT_VERIFIED',
    reason: 'Historical signature verified; audit result grants no acceptance authority',
  };
}

function policyStateEffectiveAtUtc(policy: S33DetachedSigningTrustPolicyV2): string {
  if (policy.state === 'REVOKED') return policy.revokedAtUtc!;
  if (policy.state === 'RETIRED') return policy.retiredAtUtc!;
  return policy.activatedAtUtc!;
}

function auditWithTrustPolicySet(
  value: unknown,
  bindings: S33DetachedAcceptanceBindingsV2,
  contextValue: S33DetachedHistoricalAuditContextV2,
  resolvedSet: S33ResolvedTrustPolicySetV2,
): S33DetachedHistoricalAuditResultV2 {
  const envelopeCandidate = record(value, 'S3.3 detached acceptance envelope');
  const signingKeyId = versionedSigningKeyId(
    envelopeCandidate.signingKeyId,
    'S3.3 detached historical envelope signing key id',
  );
  const resolved = resolvedSet.resolvedKeys.get(signingKeyId);
  if (!resolved || resolved.publicKey === null || resolved.policy.state === 'UNCONFIGURED') {
    throw new Error('S3.3 detached historical audit has no configured public root for the envelope key');
  }
  const context = parseHistoricalAuditContext(contextValue);
  const envelope = verifyWithTrustPolicy(value, bindings, {
    policy: resolved.policy,
    publicKey: resolved.publicKey,
  }, { verifiedAtUtc: context.auditedAtUtc });
  assertHistoricalAuditTimeline(envelope, resolved.policy, context);
  const { disposition, reason } = historicalDisposition(envelope, resolved.policy, context);
  const keyStateEffectiveAtUtc = policyStateEffectiveAtUtc(resolved.policy);
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'arkova-s33-detached-historical-audit-result',
    acceptanceAuthority: false,
    cryptographicVerification: 'VERIFIED',
    disposition,
    signingKeyId,
    keyState: resolved.policy.state,
    keyStateEffectiveAtUtc,
    envelopeArtifactDigestSha256: envelope.artifactDigestSha256,
    signedAtUtc: envelope.request.payload.signedAtUtc,
    mergedAtUtc: context.mergedAtUtc,
    auditedAtUtc: context.auditedAtUtc,
    reason,
  });
}

/** Verify retained public-root evidence for audit only; never grants acceptance authority. */
export function auditS33DetachedAcceptanceEnvelopeV2(
  value: unknown,
  bindings: S33DetachedAcceptanceBindingsV2,
  context: S33DetachedHistoricalAuditContextV2,
): S33DetachedHistoricalAuditResultV2 {
  return auditWithTrustPolicySet(
    value,
    bindings,
    context,
    parseTrustPolicySet(S33_DETACHED_SIGNING_TRUST_POLICY_SET_V2),
  );
}

/**
 * Ephemeral-key tests use a separate factory; production acceptance and audit
 * entry points expose no caller-supplied policy and resolve the committed ring.
 */
export function createS33DetachedSigningTestHarnessV2(
  trustPolicySetValue: unknown,
): S33DetachedSigningTestHarnessV2 {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('S3.3 detached test-only trust-policy harness is disabled');
  }
  const resolvedSet = parseTrustPolicySet(trustPolicySetValue);
  return Object.freeze({
    get authority(): S33DetachedSigningAuthorityV2 {
      return signingAuthority(requireActiveTrustPolicySet(resolvedSet));
    },
    assemble: (
      request: unknown,
      signature: string,
      context: S33DetachedAcceptanceVerificationContextV2,
    ): S33DetachedAcceptanceEnvelopeV2 => (
      assembleWithTrustPolicy(request, signature, requireActiveTrustPolicySet(resolvedSet), context)
    ),
    verify: (
      envelope: unknown,
      bindings: S33DetachedAcceptanceBindingsV2,
      context: S33DetachedAcceptanceVerificationContextV2,
    ): S33DetachedAcceptanceEnvelopeV2 => verifyWithTrustPolicy(
      envelope,
      bindings,
      requireActiveTrustPolicySet(resolvedSet),
      context,
    ),
    audit: (
      envelope: unknown,
      bindings: S33DetachedAcceptanceBindingsV2,
      context: S33DetachedHistoricalAuditContextV2,
    ): S33DetachedHistoricalAuditResultV2 => auditWithTrustPolicySet(
      envelope,
      bindings,
      context,
      resolvedSet,
    ),
  });
}
