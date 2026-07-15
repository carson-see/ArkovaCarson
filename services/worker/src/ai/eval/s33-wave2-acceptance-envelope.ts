/**
 * Authenticated whole-batch acceptance contract for Sprint 3.3 Wave 2.
 *
 * Lane 3 acceptance authority is a dedicated Ed25519 identity. GitHub reviews
 * and issue comments are durable transport evidence only: a login, review
 * state, or distinct account never grants acceptance authority. Production
 * remains deliberately fail-closed until the CTO commits the public SPKI and
 * fingerprint below; tests may inject a generated key only in NODE_ENV=test.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
  type KeyObject,
} from 'node:crypto';
import { canonicaliseJson } from '../../utils/canonical-json.js';

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE64URL_ED25519 = /^[A-Za-z0-9_-]{86}$/u;
const REPOSITORY = 'carson-see/ArkovaCarson' as const;
const SIGNER_IDENTITY = 'arkova-s33-wave2-cto-release' as const;
const COVERAGE_REGISTRY_PATH = 'docs/lane4/s33-wave2-top15-registry.json' as const;
const DOMAIN_SEPARATOR = 'arkova:s33-wave2:authenticated-batch-acceptance:v1\n';

type JsonRecord = Record<string, unknown>;

export type S33Wave2AuthorshipMethod = 'real-source' | 'independently-authored';

export interface S33Wave2AcceptedEntryInput {
  id: string;
  registryTypeId: string;
  batchId: string;
  revision: number;
  credentialType: string;
  subType: string;
  normalizedInputSha256: string;
  groundTruthSha256: string;
  authorshipMethod: S33Wave2AuthorshipMethod;
  generatorDerived: false;
  trainingExposed: false;
  intendedSplit: 'held-out';
  productionValidSubstantiveFieldCount: number;
  edgeCase: boolean;
  sourceBlobSha: string;
}

/** One signed, content-addressed entry. The fingerprint covers every other field. */
export interface S33Wave2AcceptedEntry extends S33Wave2AcceptedEntryInput {
  entryCanonicalSha256: string;
}

export interface S33Wave2GitHubTransportActor {
  login: string;
  databaseId: number;
  nodeId: string;
}

export interface S33Wave2GitHubTransportEvidence {
  id: number;
  nodeId: string | null;
  url: string;
  submittedAtUtc: string;
  actor: S33Wave2GitHubTransportActor;
}

export interface S33Wave2AcceptanceReviewer {
  lane: 'Lane 3';
  transport: 'github-issue-comment' | 'github-formal-review';
  evidence: S33Wave2GitHubTransportEvidence;
}

export interface S33Wave2AcceptanceProof {
  machineValidationArtifactSha256: string;
  machineValidationFailureCount: 0;
  humanCrossReviewArtifactSha256: string;
  humanCrossReviewSampleSize: number;
  materialLabelDefectCount: 0;
  prodModelDiffArtifactSha256: string;
  exactLeakageArtifactSha256: string;
  exactLeakageHitCount: 0;
}

export interface S33Wave2AcceptancePayloadInput {
  repositoryIdentity: typeof REPOSITORY;
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
  reviewer: S33Wave2AcceptanceReviewer;
  proof: S33Wave2AcceptanceProof;
  acceptedEntries: S33Wave2AcceptedEntryInput[];
}

export interface S33Wave2AcceptancePayload {
  schemaVersion: 1;
  artifactType: 'arkova-s33-wave2-batch-acceptance-payload';
  verdict: 'APPROVED_WHOLE_BATCH';
  signerIdentity: typeof SIGNER_IDENTITY;
  signingKeyId: typeof SIGNER_IDENTITY;
  repositoryIdentity: typeof REPOSITORY;
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
  reviewer: S33Wave2AcceptanceReviewer;
  proof: S33Wave2AcceptanceProof;
  acceptedEntryCount: number;
  acceptedEntrySetCanonicalSha256: string;
  acceptedEntryOrderSha256: string;
  acceptedEntries: S33Wave2AcceptedEntry[];
}

/** The immutable signed envelope consumed by Lane 4, CI, and trusted main. */
export interface S33Wave2AuthenticatedBatchAcceptance {
  schemaVersion: 1;
  artifactType: 'arkova-s33-wave2-authenticated-batch-acceptance';
  signatureAlgorithm: 'Ed25519';
  signerIdentity: typeof SIGNER_IDENTITY;
  signingKeyId: typeof SIGNER_IDENTITY;
  publicKeyFingerprintSha256: string;
  payload: S33Wave2AcceptancePayload;
  payloadCanonicalSha256: string;
  signatureBase64Url: string;
  artifactDigestSha256: string;
}

export interface S33Wave2AcceptanceTrustRoot {
  signerIdentity: typeof SIGNER_IDENTITY;
  signingKeyId: typeof SIGNER_IDENTITY;
  publicKeySpkiPem: string;
  publicKeyFingerprintSha256: string;
}

/** Caller-recomputed values that prevent a valid envelope from being replayed. */
export interface S33Wave2AcceptanceBindings {
  repositoryIdentity: typeof REPOSITORY;
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

export interface S33Wave2VerificationOptions {
  /** Test-only escape hatch. Production callers cannot provide a key. */
  testOnlyTrustRoot?: S33Wave2AcceptanceTrustRoot;
}

/**
 * CTO must replace this null with the reviewed public SPKI/fingerprint in a
 * dedicated commit. No environment variable or caller-supplied production key
 * is accepted, so absence is an intentional release stop.
 */
export const S33_WAVE2_CTO_RELEASE_TRUST_ROOT: S33Wave2AcceptanceTrustRoot | null = null;

export const S33_WAVE2_ACCEPTANCE_CONSTANTS = Object.freeze({
  repositoryIdentity: REPOSITORY,
  signerIdentity: SIGNER_IDENTITY,
  signingKeyId: SIGNER_IDENTITY,
  coverageRegistryPath: COVERAGE_REGISTRY_PATH,
});

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): Readonly<T> {
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

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, 'en'));
  const wanted = [...expected].sort((left, right) => left.localeCompare(right, 'en'));
  if (canonicaliseJson(actual) !== canonicaliseJson(wanted)) {
    throw new Error(`${label} keys must be exactly: ${wanted.join(', ')}`);
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function sha1(value: unknown, label: string): string {
  const result = nonEmpty(value, label);
  if (!SHA1.test(result)) throw new Error(`${label} must be a full lowercase SHA-1 Git object id`);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = nonEmpty(value, label);
  if (!SHA256.test(result)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function isoUtc(value: unknown, label: string): string {
  const result = nonEmpty(value, label);
  const date = new Date(result);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== result) {
    throw new Error(`${label} must be a canonical ISO-8601 UTC timestamp`);
  }
  return result;
}

function assertZero(value: unknown, label: string): void {
  if (value !== 0) throw new Error(`${label} must be zero`);
}

function canonicalDigest(value: unknown): string {
  return sha256(canonicaliseJson(value));
}

function validateEntryInput(
  value: unknown,
  batchId: string,
  revision: number,
  sourceBlobSha: string,
  label: string,
): S33Wave2AcceptedEntryInput {
  const entry = record(value, label);
  exactKeys(entry, [
    'id', 'registryTypeId', 'batchId', 'revision', 'credentialType', 'subType',
    'normalizedInputSha256', 'groundTruthSha256', 'authorshipMethod', 'generatorDerived',
    'trainingExposed', 'intendedSplit', 'productionValidSubstantiveFieldCount',
    'edgeCase', 'sourceBlobSha',
  ], label);
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
  if (subType.trim().toLowerCase() === 'other') throw new Error(`${label}.subType must be concrete`);
  if (entry.batchId !== batchId || entry.revision !== revision) {
    throw new Error(`${label} batch/revision does not match its signed whole batch`);
  }
  if (!['real-source', 'independently-authored'].includes(entry.authorshipMethod as string)) {
    throw new Error(`${label}.authorshipMethod is unauthorized`);
  }
  if (entry.generatorDerived !== false || entry.trainingExposed !== false || entry.intendedSplit !== 'held-out') {
    throw new Error(`${label} must be non-generated, training-unexposed, and held-out`);
  }
  const substantiveCount = positiveInteger(
    entry.productionValidSubstantiveFieldCount,
    `${label}.productionValidSubstantiveFieldCount`,
  );
  if (substantiveCount < 5) throw new Error(`${label} has fewer than five production-valid substantive fields`);
  if (typeof entry.edgeCase !== 'boolean') throw new Error(`${label}.edgeCase must be boolean`);
  const entrySourceBlobSha = sha1(entry.sourceBlobSha, `${label}.sourceBlobSha`);
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
    authorshipMethod: entry.authorshipMethod as S33Wave2AuthorshipMethod,
    generatorDerived: false,
    trainingExposed: false,
    intendedSplit: 'held-out',
    productionValidSubstantiveFieldCount: substantiveCount,
    edgeCase: entry.edgeCase,
    sourceBlobSha: entrySourceBlobSha,
  };
}

function buildEntry(
  value: unknown,
  batchId: string,
  revision: number,
  sourceBlobSha: string,
  label: string,
): S33Wave2AcceptedEntry {
  const input = validateEntryInput(value, batchId, revision, sourceBlobSha, label);
  return { ...input, entryCanonicalSha256: canonicalDigest(input) };
}

function validateAcceptedEntry(
  value: unknown,
  batchId: string,
  revision: number,
  sourceBlobSha: string,
  label: string,
): S33Wave2AcceptedEntry {
  const entry = record(value, label);
  exactKeys(entry, [
    'id', 'registryTypeId', 'batchId', 'revision', 'credentialType', 'subType',
    'normalizedInputSha256', 'groundTruthSha256', 'authorshipMethod', 'generatorDerived',
    'trainingExposed', 'intendedSplit', 'productionValidSubstantiveFieldCount',
    'edgeCase', 'sourceBlobSha', 'entryCanonicalSha256',
  ], label);
  const entryCanonicalSha256 = digest(entry.entryCanonicalSha256, `${label}.entryCanonicalSha256`);
  const input = validateEntryInput(
    Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'entryCanonicalSha256')),
    batchId,
    revision,
    sourceBlobSha,
    label,
  );
  if (canonicalDigest(input) !== entryCanonicalSha256) throw new Error(`${label} entry digest mismatch`);
  return { ...input, entryCanonicalSha256 };
}

function validateTransportActor(value: unknown): S33Wave2GitHubTransportActor {
  const actor = record(value, 'Wave-2 GitHub transport actor');
  exactKeys(actor, ['login', 'databaseId', 'nodeId'], 'Wave-2 GitHub transport actor');
  return {
    login: nonEmpty(actor.login, 'Wave-2 GitHub transport actor login'),
    databaseId: positiveInteger(actor.databaseId, 'Wave-2 GitHub transport actor database id'),
    nodeId: nonEmpty(actor.nodeId, 'Wave-2 GitHub transport actor node id'),
  };
}

function validateTransportUrl(
  url: string,
  transport: S33Wave2AcceptanceReviewer['transport'],
  pullRequestNumber: number,
  evidenceId: number,
): void {
  const prefix = `https://github.com/${REPOSITORY}/pull/${pullRequestNumber}`;
  const expectedAnchor = transport === 'github-issue-comment'
    ? `#issuecomment-${evidenceId}`
    : `#pullrequestreview-${evidenceId}`;
  if (url !== `${prefix}${expectedAnchor}`) {
    throw new Error('Wave-2 GitHub transport URL does not match its PR, kind, and stable id');
  }
}

function validateReviewer(value: unknown, pullRequestNumber: number): S33Wave2AcceptanceReviewer {
  const reviewer = record(value, 'Wave-2 acceptance reviewer');
  exactKeys(reviewer, ['lane', 'transport', 'evidence'], 'Wave-2 acceptance reviewer');
  if (reviewer.lane !== 'Lane 3'
    || !['github-issue-comment', 'github-formal-review'].includes(reviewer.transport as string)) {
    throw new Error('Wave-2 acceptance authority must be Lane 3 over an allowed GitHub transport');
  }
  const transport = reviewer.transport as S33Wave2AcceptanceReviewer['transport'];
  const evidence = record(reviewer.evidence, 'Wave-2 GitHub transport evidence');
  exactKeys(evidence, ['id', 'nodeId', 'url', 'submittedAtUtc', 'actor'], 'Wave-2 GitHub transport evidence');
  const id = positiveInteger(evidence.id, 'Wave-2 GitHub transport evidence id');
  const nodeId = evidence.nodeId === null
    ? null
    : nonEmpty(evidence.nodeId, 'Wave-2 GitHub transport evidence node id');
  const url = nonEmpty(evidence.url, 'Wave-2 GitHub transport evidence URL');
  validateTransportUrl(url, transport, pullRequestNumber, id);
  return {
    lane: 'Lane 3',
    transport,
    evidence: {
      id,
      nodeId,
      url,
      submittedAtUtc: isoUtc(evidence.submittedAtUtc, 'Wave-2 GitHub transport submittedAtUtc'),
      actor: validateTransportActor(evidence.actor),
    },
  };
}

function validateProof(value: unknown, acceptedEntryCount: number): S33Wave2AcceptanceProof {
  const proof = record(value, 'Wave-2 acceptance proof');
  exactKeys(proof, [
    'machineValidationArtifactSha256', 'machineValidationFailureCount',
    'humanCrossReviewArtifactSha256', 'humanCrossReviewSampleSize',
    'materialLabelDefectCount', 'prodModelDiffArtifactSha256',
    'exactLeakageArtifactSha256', 'exactLeakageHitCount',
  ], 'Wave-2 acceptance proof');
  assertZero(proof.machineValidationFailureCount, 'Wave-2 machine validation failure count');
  assertZero(proof.materialLabelDefectCount, 'Wave-2 material label defect count');
  assertZero(proof.exactLeakageHitCount, 'Wave-2 exact leakage hit count');
  const sampleSize = positiveInteger(proof.humanCrossReviewSampleSize, 'Wave-2 human cross-review sample size');
  const minimumSample = Math.min(acceptedEntryCount, 5);
  if (sampleSize < minimumSample || sampleSize > acceptedEntryCount) {
    throw new Error(`Wave-2 human cross-review sample must be ${minimumSample}-${acceptedEntryCount} rows`);
  }
  return {
    machineValidationArtifactSha256: digest(
      proof.machineValidationArtifactSha256,
      'Wave-2 machine validation artifact digest',
    ),
    machineValidationFailureCount: 0,
    humanCrossReviewArtifactSha256: digest(
      proof.humanCrossReviewArtifactSha256,
      'Wave-2 human cross-review artifact digest',
    ),
    humanCrossReviewSampleSize: sampleSize,
    materialLabelDefectCount: 0,
    prodModelDiffArtifactSha256: digest(proof.prodModelDiffArtifactSha256, 'Wave-2 prod-model-diff artifact digest'),
    exactLeakageArtifactSha256: digest(proof.exactLeakageArtifactSha256, 'Wave-2 exact leakage artifact digest'),
    exactLeakageHitCount: 0,
  };
}

function assertUniqueEntries(entries: readonly S33Wave2AcceptedEntry[]): void {
  const unique = (selector: (entry: S33Wave2AcceptedEntry) => string): boolean => (
    new Set(entries.map(selector)).size === entries.length
  );
  if (!unique(({ id }) => id)) throw new Error('Wave-2 acceptance contains duplicate entry ids');
  if (!unique(({ normalizedInputSha256 }) => normalizedInputSha256)) {
    throw new Error('Wave-2 acceptance contains duplicate normalized input fingerprints');
  }
  if (!unique(({ entryCanonicalSha256 }) => entryCanonicalSha256)) {
    throw new Error('Wave-2 acceptance contains duplicate entry canonical fingerprints');
  }
}

export function computeS33Wave2AcceptedEntryOrderSha256(entryIds: readonly string[]): string {
  if (entryIds.length === 0 || entryIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('Wave-2 accepted entry order requires non-empty ids');
  }
  return canonicalDigest(entryIds);
}

function computeAcceptedEntrySetSha256(entries: readonly S33Wave2AcceptedEntry[]): string {
  const sortedIds = entries.map(({ id }) => id).sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  return canonicalDigest(sortedIds);
}

/** Strictly parse and normalize an unsigned Wave-2 acceptance payload. */
export function validateS33Wave2AcceptancePayload(value: unknown): S33Wave2AcceptancePayload {
  const payload = record(value, 'Wave-2 acceptance payload');
  exactKeys(payload, [
    'schemaVersion', 'artifactType', 'verdict', 'signerIdentity', 'signingKeyId',
    'repositoryIdentity', 'pullRequestNumber', 'candidateBaseSha', 'candidateHeadSha',
    'candidateTreeSha', 'batchId', 'revision', 'manifestPath', 'manifestRawSha256',
    'manifestCanonicalSha256', 'sourceBlobSha', 'datasheetBlobSha',
    'preflightArtifactDigestSha256', 'baseRegistryDigestSha256',
    'resultingRegistryDigestSha256', 'coverageRegistryPath',
    'coverageRegistryRawSha256', 'coverageRegistryCanonicalSha256', 'signedAtUtc',
    'reviewer', 'proof', 'acceptedEntryCount', 'acceptedEntrySetCanonicalSha256',
    'acceptedEntryOrderSha256', 'acceptedEntries',
  ], 'Wave-2 acceptance payload');
  if (payload.schemaVersion !== 1 || payload.artifactType !== 'arkova-s33-wave2-batch-acceptance-payload'
    || payload.verdict !== 'APPROVED_WHOLE_BATCH' || payload.signerIdentity !== SIGNER_IDENTITY
    || payload.signingKeyId !== SIGNER_IDENTITY || payload.repositoryIdentity !== REPOSITORY
    || payload.coverageRegistryPath !== COVERAGE_REGISTRY_PATH) {
    throw new Error('Wave-2 acceptance payload identity/authority/verdict/policy tuple is invalid');
  }
  const pullRequestNumber = positiveInteger(payload.pullRequestNumber, 'Wave-2 pull request number');
  const batchId = nonEmpty(payload.batchId, 'Wave-2 batch id');
  const revision = positiveInteger(payload.revision, 'Wave-2 batch revision');
  const sourceBlobSha = sha1(payload.sourceBlobSha, 'Wave-2 source blob');
  const acceptedEntryCount = positiveInteger(payload.acceptedEntryCount, 'Wave-2 accepted entry count');
  if (acceptedEntryCount > 2_000 || !Array.isArray(payload.acceptedEntries)
    || payload.acceptedEntries.length !== acceptedEntryCount) {
    throw new Error('Wave-2 acceptance count must bind one complete batch of at most 2,000 entries');
  }
  const acceptedEntries = payload.acceptedEntries.map((entry, index) => validateAcceptedEntry(
    entry,
    batchId,
    revision,
    sourceBlobSha,
    `Wave-2 acceptedEntries[${index}]`,
  ));
  assertUniqueEntries(acceptedEntries);
  const orderDigest = computeS33Wave2AcceptedEntryOrderSha256(acceptedEntries.map(({ id }) => id));
  if (digest(payload.acceptedEntryOrderSha256, 'Wave-2 accepted-entry order digest') !== orderDigest) {
    throw new Error('Wave-2 accepted-entry order digest mismatch');
  }
  if (digest(payload.acceptedEntrySetCanonicalSha256, 'Wave-2 accepted-entry set digest')
    !== computeAcceptedEntrySetSha256(acceptedEntries)) {
    throw new Error('Wave-2 accepted-entry set digest mismatch');
  }
  const reviewer = validateReviewer(payload.reviewer, pullRequestNumber);
  const signedAtUtc = isoUtc(payload.signedAtUtc, 'Wave-2 acceptance signedAtUtc');
  if (Date.parse(signedAtUtc) < Date.parse(reviewer.evidence.submittedAtUtc)) {
    throw new Error('Wave-2 acceptance cannot be signed before its GitHub transport evidence');
  }
  return {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-batch-acceptance-payload',
    verdict: 'APPROVED_WHOLE_BATCH',
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: SIGNER_IDENTITY,
    repositoryIdentity: REPOSITORY,
    pullRequestNumber,
    candidateBaseSha: sha1(payload.candidateBaseSha, 'Wave-2 candidate base'),
    candidateHeadSha: sha1(payload.candidateHeadSha, 'Wave-2 candidate head'),
    candidateTreeSha: sha1(payload.candidateTreeSha, 'Wave-2 candidate tree'),
    batchId,
    revision,
    manifestPath: nonEmpty(payload.manifestPath, 'Wave-2 manifest path'),
    manifestRawSha256: digest(payload.manifestRawSha256, 'Wave-2 manifest raw digest'),
    manifestCanonicalSha256: digest(payload.manifestCanonicalSha256, 'Wave-2 manifest canonical digest'),
    sourceBlobSha,
    datasheetBlobSha: sha1(payload.datasheetBlobSha, 'Wave-2 datasheet blob'),
    preflightArtifactDigestSha256: digest(payload.preflightArtifactDigestSha256, 'Wave-2 preflight digest'),
    baseRegistryDigestSha256: digest(payload.baseRegistryDigestSha256, 'Wave-2 base registry digest'),
    resultingRegistryDigestSha256: digest(payload.resultingRegistryDigestSha256, 'Wave-2 resulting registry digest'),
    coverageRegistryPath: COVERAGE_REGISTRY_PATH,
    coverageRegistryRawSha256: digest(payload.coverageRegistryRawSha256, 'Wave-2 coverage registry raw digest'),
    coverageRegistryCanonicalSha256: digest(
      payload.coverageRegistryCanonicalSha256,
      'Wave-2 coverage registry canonical digest',
    ),
    signedAtUtc,
    reviewer,
    proof: validateProof(payload.proof, acceptedEntryCount),
    acceptedEntryCount,
    acceptedEntrySetCanonicalSha256: payload.acceptedEntrySetCanonicalSha256 as string,
    acceptedEntryOrderSha256: orderDigest,
    acceptedEntries,
  };
}

function validateTrustRoot(trustRoot: unknown): { trustRoot: S33Wave2AcceptanceTrustRoot; publicKey: KeyObject } {
  const root = record(trustRoot, 'Wave-2 CTO release trust root');
  exactKeys(
    root,
    ['signerIdentity', 'signingKeyId', 'publicKeySpkiPem', 'publicKeyFingerprintSha256'],
    'Wave-2 CTO release trust root',
  );
  if (root.signerIdentity !== SIGNER_IDENTITY || root.signingKeyId !== SIGNER_IDENTITY) {
    throw new Error('Wave-2 trust root does not use the dedicated CTO release identity');
  }
  const fingerprint = digest(root.publicKeyFingerprintSha256, 'Wave-2 trust-root fingerprint');
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(nonEmpty(root.publicKeySpkiPem, 'Wave-2 trust-root SPKI PEM'));
  } catch (error) {
    throw new Error('Wave-2 trust-root SPKI PEM is invalid', { cause: error });
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Wave-2 trust-root key must be Ed25519');
  if (sha256(publicKey.export({ type: 'spki', format: 'der' })) !== fingerprint) {
    throw new Error('Wave-2 trust-root fingerprint does not match its public SPKI');
  }
  return {
    trustRoot: {
      signerIdentity: SIGNER_IDENTITY,
      signingKeyId: SIGNER_IDENTITY,
      publicKeySpkiPem: root.publicKeySpkiPem as string,
      publicKeyFingerprintSha256: fingerprint,
    },
    publicKey,
  };
}

function resolveTrustRoot(options: S33Wave2VerificationOptions | undefined): ReturnType<typeof validateTrustRoot> {
  if (options?.testOnlyTrustRoot !== undefined) {
    if (process.env.NODE_ENV !== 'test') throw new Error('Wave-2 test-only trust-root injection is disabled');
    return validateTrustRoot(options.testOnlyTrustRoot);
  }
  if (S33_WAVE2_CTO_RELEASE_TRUST_ROOT === null) {
    throw new Error('Wave-2 CTO release trust root is not configured; acceptance fails closed');
  }
  return validateTrustRoot(S33_WAVE2_CTO_RELEASE_TRUST_ROOT);
}

function validateBindings(value: unknown): S33Wave2AcceptanceBindings {
  const bindings = record(value, 'Wave-2 caller bindings');
  exactKeys(bindings, [
    'repositoryIdentity', 'pullRequestNumber', 'candidateBaseSha', 'candidateHeadSha',
    'candidateTreeSha', 'batchId', 'revision', 'manifestPath', 'manifestRawSha256',
    'manifestCanonicalSha256', 'sourceBlobSha', 'datasheetBlobSha',
    'preflightArtifactDigestSha256', 'baseRegistryDigestSha256',
    'resultingRegistryDigestSha256', 'coverageRegistryPath',
    'coverageRegistryRawSha256', 'coverageRegistryCanonicalSha256',
    'acceptedEntryOrderSha256',
  ], 'Wave-2 caller bindings');
  if (bindings.repositoryIdentity !== REPOSITORY || bindings.coverageRegistryPath !== COVERAGE_REGISTRY_PATH) {
    throw new Error('Wave-2 caller binding identity/policy path is invalid');
  }
  return {
    repositoryIdentity: REPOSITORY,
    pullRequestNumber: positiveInteger(bindings.pullRequestNumber, 'Wave-2 binding pull request number'),
    candidateBaseSha: sha1(bindings.candidateBaseSha, 'Wave-2 binding candidate base'),
    candidateHeadSha: sha1(bindings.candidateHeadSha, 'Wave-2 binding candidate head'),
    candidateTreeSha: sha1(bindings.candidateTreeSha, 'Wave-2 binding candidate tree'),
    batchId: nonEmpty(bindings.batchId, 'Wave-2 binding batch id'),
    revision: positiveInteger(bindings.revision, 'Wave-2 binding revision'),
    manifestPath: nonEmpty(bindings.manifestPath, 'Wave-2 binding manifest path'),
    manifestRawSha256: digest(bindings.manifestRawSha256, 'Wave-2 binding manifest raw digest'),
    manifestCanonicalSha256: digest(bindings.manifestCanonicalSha256, 'Wave-2 binding manifest canonical digest'),
    sourceBlobSha: sha1(bindings.sourceBlobSha, 'Wave-2 binding source blob'),
    datasheetBlobSha: sha1(bindings.datasheetBlobSha, 'Wave-2 binding datasheet blob'),
    preflightArtifactDigestSha256: digest(bindings.preflightArtifactDigestSha256, 'Wave-2 binding preflight digest'),
    baseRegistryDigestSha256: digest(bindings.baseRegistryDigestSha256, 'Wave-2 binding base registry digest'),
    resultingRegistryDigestSha256: digest(
      bindings.resultingRegistryDigestSha256,
      'Wave-2 binding resulting registry digest',
    ),
    coverageRegistryPath: COVERAGE_REGISTRY_PATH,
    coverageRegistryRawSha256: digest(
      bindings.coverageRegistryRawSha256,
      'Wave-2 binding coverage registry raw digest',
    ),
    coverageRegistryCanonicalSha256: digest(
      bindings.coverageRegistryCanonicalSha256,
      'Wave-2 binding coverage registry canonical digest',
    ),
    acceptedEntryOrderSha256: digest(bindings.acceptedEntryOrderSha256, 'Wave-2 binding accepted-entry order digest'),
  };
}

function assertPayloadBindings(
  payload: S33Wave2AcceptancePayload,
  expected: S33Wave2AcceptanceBindings,
): void {
  for (const key of Object.keys(expected) as Array<keyof S33Wave2AcceptanceBindings>) {
    if (payload[key] !== expected[key]) throw new Error(`Wave-2 acceptance binding mismatch: ${key}`);
  }
}

function signingBytes(payload: S33Wave2AcceptancePayload): Buffer {
  return Buffer.from(`${DOMAIN_SEPARATOR}${canonicaliseJson(payload)}`, 'utf8');
}

function envelopeWithoutArtifactDigest(
  envelope: Omit<S33Wave2AuthenticatedBatchAcceptance, 'artifactDigestSha256'>,
): Omit<S33Wave2AuthenticatedBatchAcceptance, 'artifactDigestSha256'> {
  return envelope;
}

/** Verify signature, strict schema, per-entry fingerprints, and all caller-recomputed bindings. */
export function verifyS33Wave2AuthenticatedBatchAcceptance(
  value: unknown,
  bindings: S33Wave2AcceptanceBindings,
  options?: S33Wave2VerificationOptions,
): S33Wave2AuthenticatedBatchAcceptance {
  const envelope = record(value, 'Wave-2 authenticated acceptance envelope');
  exactKeys(envelope, [
    'schemaVersion', 'artifactType', 'signatureAlgorithm', 'signerIdentity',
    'signingKeyId', 'publicKeyFingerprintSha256', 'payload',
    'payloadCanonicalSha256', 'signatureBase64Url', 'artifactDigestSha256',
  ], 'Wave-2 authenticated acceptance envelope');
  if (envelope.schemaVersion !== 1
    || envelope.artifactType !== 'arkova-s33-wave2-authenticated-batch-acceptance'
    || envelope.signatureAlgorithm !== 'Ed25519' || envelope.signerIdentity !== SIGNER_IDENTITY
    || envelope.signingKeyId !== SIGNER_IDENTITY) {
    throw new Error('Wave-2 acceptance envelope identity/algorithm/authority tuple is invalid');
  }
  const payload = validateS33Wave2AcceptancePayload(envelope.payload);
  const payloadCanonicalSha256 = digest(envelope.payloadCanonicalSha256, 'Wave-2 payload canonical digest');
  if (canonicalDigest(payload) !== payloadCanonicalSha256) throw new Error('Wave-2 payload canonical digest mismatch');
  const signatureBase64Url = nonEmpty(envelope.signatureBase64Url, 'Wave-2 Ed25519 signature');
  if (!BASE64URL_ED25519.test(signatureBase64Url)) throw new Error('Wave-2 signature must be 64-byte Ed25519 base64url');
  const publicKeyFingerprintSha256 = digest(
    envelope.publicKeyFingerprintSha256,
    'Wave-2 envelope public-key fingerprint',
  );
  const withoutDigest = envelopeWithoutArtifactDigest({
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-authenticated-batch-acceptance',
    signatureAlgorithm: 'Ed25519',
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: SIGNER_IDENTITY,
    publicKeyFingerprintSha256,
    payload,
    payloadCanonicalSha256,
    signatureBase64Url,
  });
  const artifactDigestSha256 = digest(envelope.artifactDigestSha256, 'Wave-2 artifact digest');
  if (canonicalDigest(withoutDigest) !== artifactDigestSha256) throw new Error('Wave-2 artifact digest mismatch');
  const { trustRoot, publicKey } = resolveTrustRoot(options);
  if (publicKeyFingerprintSha256 !== trustRoot.publicKeyFingerprintSha256) {
    throw new Error('Wave-2 envelope fingerprint does not match the CTO trust root');
  }
  if (!verifyEd25519(null, signingBytes(payload), publicKey, Buffer.from(signatureBase64Url, 'base64url'))) {
    throw new Error('Wave-2 CTO release signature verification failed');
  }
  assertPayloadBindings(payload, validateBindings(bindings));
  return deepFreeze({ ...withoutDigest, artifactDigestSha256 }) as S33Wave2AuthenticatedBatchAcceptance;
}

function assertTestEnvironment(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Wave-2 test-only acceptance builder is disabled');
}

/**
 * Build a canonical unsigned payload. This function never accepts or handles
 * signing material; detached-signing tooling owns the separate authority step.
 */
export function buildS33Wave2AcceptancePayload(
  input: S33Wave2AcceptancePayloadInput,
): S33Wave2AcceptancePayload {
  const candidate = record(input, 'Wave-2 unsigned acceptance input');
  exactKeys(candidate, [
    'repositoryIdentity', 'pullRequestNumber', 'candidateBaseSha', 'candidateHeadSha',
    'candidateTreeSha', 'batchId', 'revision', 'manifestPath', 'manifestRawSha256',
    'manifestCanonicalSha256', 'sourceBlobSha', 'datasheetBlobSha',
    'preflightArtifactDigestSha256', 'baseRegistryDigestSha256',
    'resultingRegistryDigestSha256', 'coverageRegistryPath',
    'coverageRegistryRawSha256', 'coverageRegistryCanonicalSha256', 'signedAtUtc',
    'reviewer', 'proof', 'acceptedEntries',
  ], 'Wave-2 unsigned acceptance input');
  if (!Array.isArray(input.acceptedEntries) || input.acceptedEntries.length === 0) {
    throw new Error('Wave-2 unsigned acceptance requires a non-empty whole batch');
  }
  const sourceBlobSha = sha1(input.sourceBlobSha, 'Wave-2 unsigned input source blob');
  const acceptedEntries = input.acceptedEntries.map((entry, index) => buildEntry(
    entry,
    input.batchId,
    input.revision,
    sourceBlobSha,
    `Wave-2 unsigned acceptedEntries[${index}]`,
  ));
  assertUniqueEntries(acceptedEntries);
  return validateS33Wave2AcceptancePayload({
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-batch-acceptance-payload',
    verdict: 'APPROVED_WHOLE_BATCH',
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: SIGNER_IDENTITY,
    ...input,
    acceptedEntryCount: acceptedEntries.length,
    acceptedEntrySetCanonicalSha256: computeAcceptedEntrySetSha256(acceptedEntries),
    acceptedEntryOrderSha256: computeS33Wave2AcceptedEntryOrderSha256(acceptedEntries.map(({ id }) => id)),
    acceptedEntries,
  });
}

/** Generate a real envelope in tests without exposing any production signing path. */
export function buildAndSignS33Wave2AcceptanceForTest(
  input: S33Wave2AcceptancePayloadInput,
  privateKeyPkcs8Pem: string,
  trustRootValue: S33Wave2AcceptanceTrustRoot,
): S33Wave2AuthenticatedBatchAcceptance {
  assertTestEnvironment();
  const payload = buildS33Wave2AcceptancePayload(input);
  const { trustRoot } = validateTrustRoot(trustRootValue);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPkcs8Pem);
  } catch (error) {
    throw new Error('Wave-2 test private key is invalid', { cause: error });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Wave-2 test private key must be Ed25519');
  const payloadCanonicalSha256 = canonicalDigest(payload);
  const signatureBase64Url = signEd25519(null, signingBytes(payload), privateKey).toString('base64url');
  const withoutDigest = envelopeWithoutArtifactDigest({
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-authenticated-batch-acceptance',
    signatureAlgorithm: 'Ed25519',
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: SIGNER_IDENTITY,
    publicKeyFingerprintSha256: trustRoot.publicKeyFingerprintSha256,
    payload,
    payloadCanonicalSha256,
    signatureBase64Url,
  });
  const artifact = { ...withoutDigest, artifactDigestSha256: canonicalDigest(withoutDigest) };
  const expectedBindings: S33Wave2AcceptanceBindings = {
    repositoryIdentity: payload.repositoryIdentity,
    pullRequestNumber: payload.pullRequestNumber,
    candidateBaseSha: payload.candidateBaseSha,
    candidateHeadSha: payload.candidateHeadSha,
    candidateTreeSha: payload.candidateTreeSha,
    batchId: payload.batchId,
    revision: payload.revision,
    manifestPath: payload.manifestPath,
    manifestRawSha256: payload.manifestRawSha256,
    manifestCanonicalSha256: payload.manifestCanonicalSha256,
    sourceBlobSha: payload.sourceBlobSha,
    datasheetBlobSha: payload.datasheetBlobSha,
    preflightArtifactDigestSha256: payload.preflightArtifactDigestSha256,
    baseRegistryDigestSha256: payload.baseRegistryDigestSha256,
    resultingRegistryDigestSha256: payload.resultingRegistryDigestSha256,
    coverageRegistryPath: payload.coverageRegistryPath,
    coverageRegistryRawSha256: payload.coverageRegistryRawSha256,
    coverageRegistryCanonicalSha256: payload.coverageRegistryCanonicalSha256,
    acceptedEntryOrderSha256: payload.acceptedEntryOrderSha256,
  };
  return verifyS33Wave2AuthenticatedBatchAcceptance(artifact, expectedBindings, {
    testOnlyTrustRoot: trustRoot,
  });
}
