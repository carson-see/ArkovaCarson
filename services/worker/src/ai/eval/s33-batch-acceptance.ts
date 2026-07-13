/**
 * Sprint 3.3 Lane-4 → Lane-3 batch acceptance.
 *
 * Public verdict boundaries consume authenticated source artifacts and
 * recompute evidence. No API accepts caller-supplied sample ids, consumed
 * arrays, or lexical metric matrices. CTO policy artifacts verify against a
 * configuration-owned Ed25519 trust root; production remains fail-closed until
 * the CTO supplies that root and the separately signed ceremony artifacts.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import { DurableAcceptanceLedger, type CeremonyEvent } from './s33-acceptance-ledger.js';

export interface TextRecord {
  id: string;
  text: string;
}

export interface BatchManifestEntry {
  id: string;
  domain: string;
  credentialType: string;
  normalizedInputSha256: string;
}

export interface ParsedBatchManifest {
  schemaVersion: 1;
  batchId: string;
  revision: number;
  entryCount: number;
  intendedSplit: string;
  entries: readonly BatchManifestEntry[];
  parsedJson: Record<string, unknown>;
}

export interface SamplingTrustRoot {
  signerIdentity: string;
  signingKeyId: string;
  publicKeyPem: string;
  publicKeyFingerprintSha256: string;
}

export interface SignedPolicyArtifact<P extends object> {
  payload: P;
  payloadDigestSha256: string;
  signature: { algorithm: 'Ed25519'; value: string };
  artifactDigestSha256: string;
}

interface SignedPayloadBase {
  artifactVersion: '1.0.0';
  signerIdentity: string;
  signingKeyId: string;
  signedAtUtc: string;
}

export interface SaltCommitmentPayload extends SignedPayloadBase {
  artifactType: 'arkova-s33-salt-commitment';
  commitmentId: string;
  saltCommitment: { algorithm: 'sha256'; value: string };
}

export interface ManifestFreezePayload extends SignedPayloadBase {
  artifactType: 'arkova-s33-manifest-freeze';
  freezeId: string;
  commitmentArtifactDigestSha256: string;
  batchId: string;
  revision: number;
  manifestHashRepresentation: 'raw-file-sha256' | 'canonical-json-sha256';
  manifestSha256: string;
  gitEvidence: {
    repositoryIdentity: string;
    freezeCommitSha: string;
    manifestPath: string;
  };
}

export interface SelectionPolicyPayload extends SignedPayloadBase {
  artifactType: 'arkova-s33-selection-policy';
  policyId: string;
  commitmentArtifactDigestSha256: string;
  freezeArtifactDigestSha256: string;
  batchId: string;
  revision: number;
  prng: 'xorshift32-v1';
  sampleRule: 'ceil(10%),minimum-5,capped-at-entry-count';
}

export interface SaltRevealRecord {
  schemaVersion: 1;
  revealId: string;
  commitmentArtifactDigestSha256: string;
  freezeArtifactDigestSha256: string;
  policyArtifactDigestSha256: string;
  salt: string;
  revealedAtUtc: string;
}

export interface LexicalNormalizationPolicy {
  unicodeForm: 'none' | 'NFC' | 'NFKC';
  caseFold: 'preserve' | 'lowercase';
  nonAlphanumeric: 'preserve' | 'space';
  whitespace: 'preserve' | 'collapse';
}

export interface LexicalLeakagePolicyPayload extends SignedPayloadBase {
  artifactType: 'arkova-s33-lexical-leakage-policy';
  policyId: string;
  metricAlgorithmVersion: 'token-set-ngram-v1';
  textArtifactHashRepresentation: 'raw-file-sha256' | 'canonical-json-sha256';
  heldoutArtifactId: string;
  heldoutArtifactSha256: string;
  corpusArtifactId: string;
  corpusArtifactSha256: string;
  normalization: LexicalNormalizationPolicy;
  allowedN: readonly number[];
  minimumSharedNgrams: number;
  minimumHeldoutContainment: number;
  combination: 'all' | 'any';
}

export interface LexicalLeakageMetric {
  heldoutId: string;
  corpusId: string;
  n: number;
  heldoutNgrams: number;
  corpusNgrams: number;
  sharedNgrams: number;
  heldoutContainment: number;
  jaccard: number;
}

interface OrchestratorConfiguration {
  trustRoot: SamplingTrustRoot;
  ledgerPath: string;
  repositoryRoot: string;
  repositoryIdentity: string;
  verificationCommitSha: string;
}

interface ProductionOrchestratorInput {
  ledgerPath: string;
  repositoryRoot: string;
  verificationCommitSha: string;
}

interface SampleSelectionInput {
  manifestContent: string | Uint8Array;
  commitmentArtifact: SignedPolicyArtifact<SaltCommitmentPayload>;
  freezeArtifact: SignedPolicyArtifact<ManifestFreezePayload>;
  policyArtifact: SignedPolicyArtifact<SelectionPolicyPayload>;
  reveal: SaltRevealRecord;
}

interface LexicalScanInput {
  heldoutArtifactContent: string | Uint8Array;
  corpusArtifactContent: string | Uint8Array;
  policyArtifact: SignedPolicyArtifact<LexicalLeakagePolicyPayload>;
}

export interface S33AcceptanceOrchestrator {
  recordSaltCommitment(artifact: SignedPolicyArtifact<SaltCommitmentPayload>): string;
  recordManifestFreeze(
    artifact: SignedPolicyArtifact<ManifestFreezePayload>,
    manifestContent: string | Uint8Array,
  ): string;
  recordSelectionPolicy(artifact: SignedPolicyArtifact<SelectionPolicyPayload>): string;
  recordSaltReveal(reveal: SaltRevealRecord): string;
  selectAndConsumeSample(input: SampleSelectionInput): ManifestSampleResult;
  scanAuthenticatedLexicalLeakage(input: LexicalScanInput): AuthenticatedLexicalScanResult;
}

export interface ManifestSampleResult {
  sampleEntryIds: string[];
  manifest: { batchId: string; revision: number; entryCount: number };
  evidence: {
    policyArtifactDigestSha256: string;
    commitmentArtifactDigestSha256: string;
    freezeArtifactDigestSha256: string;
    revealRecordDigestSha256: string;
    publicKeyFingerprintSha256: string;
    manifestSha256: string;
    manifestHashRepresentation: ManifestFreezePayload['manifestHashRepresentation'];
    manifestEntryCount: number;
    seedDigestSha256: string;
    sampleSize: number;
    sampleRule: SelectionPolicyPayload['sampleRule'];
    freezeCommitSha: string;
    verificationCommitSha: string;
    durableSequence: string[];
  };
}

export interface AuthenticatedLexicalScanResult {
  metrics: LexicalLeakageMetric[];
  hits: LexicalLeakageMetric[];
  evidence: {
    policyArtifactDigestSha256: string;
    publicKeyFingerprintSha256: string;
    heldoutArtifactId: string;
    heldoutArtifactSha256: string;
    heldoutEntryCount: number;
    corpusArtifactId: string;
    corpusArtifactSha256: string;
    corpusEntryCount: number;
    metricAlgorithmVersion: LexicalLeakagePolicyPayload['metricAlgorithmVersion'];
    metricCount: number;
  };
}

interface ParsedLexicalTextArtifact {
  schemaVersion: 1;
  algorithmVersion: 's33-lexical-text-artifact-v1';
  artifactId: string;
  role: 'heldout' | 'corpus';
  records: TextRecord[];
  parsedJson: Record<string, unknown>;
}

const REQUIRED_LEXICAL_N = [6, 7, 8, 9, 10, 11, 12, 13] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// CTO-controlled production descriptor. No key/fingerprint has been issued,
// so production construction intentionally fails before reading the fixed PEM.
const PRODUCTION_TRUST_DESCRIPTOR = Object.freeze({
  signerIdentity: null as string | null,
  signingKeyId: null as string | null,
  publicKeyFingerprintSha256: null as string | null,
  publicKeyPath: resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../config/s33-cto-policy-public-key.pem',
  ),
});

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function bytes(content: string | Uint8Array, label: string): Buffer {
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content instanceof Uint8Array) return Buffer.from(content);
  throw new Error(`${label} must be UTF-8 text or bytes`);
}

function parseJson(content: string | Uint8Array, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(content, label)));
  } catch (error) {
    throw new Error(`${label} could not be parsed as UTF-8 JSON`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${label} root must be a JSON object`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}; manifest-free and fail-closed`);
  if (missing.length > 0) throw new Error(`${label} is missing field(s): ${missing.join(', ')}`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
}

function assertIsoUtc(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !ISO_UTC_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid ISO-8601 UTC timestamp`);
  }
}

function assertUniqueIds(ids: readonly string[], label: string): void {
  if (ids.length === 0) throw new Error(`${label} is empty; acceptance fails closed`);
  if (ids.some((id) => id.trim().length === 0)) throw new Error(`${label} contains an empty id`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate ids`);
}

function canonicalizeJson(value: unknown, path = '$'): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`JSON contains a non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item, i) => canonicalizeJson(item, `${path}[${i}]`)).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalizeJson(value[key], `${path}.${key}`)}`
    )).join(',')}}`;
  }
  throw new Error(`JSON contains a non-JSON value at ${path}`);
}

export function canonicalManifestHash(manifest: unknown): string {
  return sha256(canonicalizeJson(manifest));
}

export function rawManifestHash(content: string | Uint8Array): string {
  return sha256(bytes(content, 'Artifact content'));
}

function parseCountMap(value: unknown, label: string): Map<string, number> {
  if (!isRecord(value) || Object.keys(value).length === 0) throw new Error(`${label} must be a non-empty object`);
  const result = new Map<string, number>();
  for (const [key, count] of Object.entries(value)) {
    if (key.length === 0 || !Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`${label}.${key} must be a non-negative safe integer`);
    }
    result.set(key, count as number);
  }
  return result;
}

function countBy(entries: readonly BatchManifestEntry[], key: 'domain' | 'credentialType'): Map<string, number> {
  const result = new Map<string, number>();
  for (const entry of entries) result.set(entry[key], (result.get(entry[key]) ?? 0) + 1);
  return result;
}

function assertCounts(declared: Map<string, number>, actual: Map<string, number>, label: string): void {
  if (declared.size !== actual.size || [...actual].some(([key, count]) => declared.get(key) !== count)) {
    throw new Error(`${label} does not reconcile with the complete entries universe`);
  }
}

export function parseBatchManifest(content: string | Uint8Array): ParsedBatchManifest {
  const parsed = parseJson(content, 'Manifest');
  if (parsed.schemaVersion !== 1) throw new Error('Manifest schemaVersion must be 1');
  const batchId = nonEmptyString(parsed.batchId, 'Manifest batchId');
  const revision = positiveInteger(parsed.revision, 'Manifest revision');
  const entryCount = positiveInteger(parsed.entryCount, 'Manifest entryCount');
  const intendedSplit = nonEmptyString(parsed.intendedSplit, 'Manifest intendedSplit');
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) throw new Error('Manifest entries universe is empty');
  const entries = parsed.entries.map((candidate, index): BatchManifestEntry => {
    if (!isRecord(candidate)) throw new Error(`Manifest entries[${index}] must be an object`);
    assertSha256(candidate.normalizedInputSha256, `Manifest entries[${index}].normalizedInputSha256`);
    return {
      id: nonEmptyString(candidate.id, `Manifest entries[${index}].id`),
      domain: nonEmptyString(candidate.domain, `Manifest entries[${index}].domain`),
      credentialType: nonEmptyString(candidate.credentialType, `Manifest entries[${index}].credentialType`),
      normalizedInputSha256: candidate.normalizedInputSha256,
    };
  });
  assertUniqueIds(entries.map(({ id }) => id), 'Manifest entries universe');
  if (entryCount !== entries.length) throw new Error('Manifest entryCount does not match entries length');
  if (!isRecord(parsed.counts)) throw new Error('Manifest counts must be an object');
  assertCounts(parseCountMap(parsed.counts.byDomain, 'Manifest counts.byDomain'), countBy(entries, 'domain'), 'Manifest counts.byDomain');
  assertCounts(
    parseCountMap(parsed.counts.byCredentialType, 'Manifest counts.byCredentialType'),
    countBy(entries, 'credentialType'),
    'Manifest counts.byCredentialType',
  );
  if (!isRecord(parsed.selfChecks) || Object.keys(parsed.selfChecks).length === 0) throw new Error('Manifest selfChecks must be non-empty');
  return { schemaVersion: 1, batchId, revision, entryCount, intendedSplit, entries, parsedJson: parsed };
}

function validateTrustRoot(trustRoot: SamplingTrustRoot): { publicKey: ReturnType<typeof createPublicKey>; fingerprint: string } {
  if (!isRecord(trustRoot)) throw new Error('CTO trust root must be an object');
  assertExactKeys(trustRoot as unknown as Record<string, unknown>, [
    'signerIdentity', 'signingKeyId', 'publicKeyPem', 'publicKeyFingerprintSha256',
  ], 'CTO trust root');
  nonEmptyString(trustRoot.signerIdentity, 'CTO trust-root signer identity');
  nonEmptyString(trustRoot.signingKeyId, 'CTO trust-root key id');
  assertSha256(trustRoot.publicKeyFingerprintSha256, 'CTO trust-root fingerprint');
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(trustRoot.publicKeyPem);
  } catch (error) {
    throw new Error('CTO trust-root public key is invalid', { cause: error });
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('CTO trust-root public key must be Ed25519');
  const fingerprint = sha256(publicKey.export({ type: 'spki', format: 'der' }));
  if (fingerprint !== trustRoot.publicKeyFingerprintSha256) throw new Error('CTO trust-root fingerprint does not match the public key');
  return { publicKey, fingerprint };
}

function verifyArtifact<P extends object>(
  artifact: SignedPolicyArtifact<P>,
  trustRoot: SamplingTrustRoot,
  validatePayload: (payload: Record<string, unknown>) => void,
): { digest: string; fingerprint: string } {
  if (!isRecord(artifact) || !isRecord(artifact.payload) || !isRecord(artifact.signature)) {
    throw new Error('Signed CTO policy artifact has an invalid envelope');
  }
  assertExactKeys(artifact, [
    'payload', 'payloadDigestSha256', 'signature', 'artifactDigestSha256',
  ], 'Signed CTO policy artifact envelope');
  assertExactKeys(artifact.signature, ['algorithm', 'value'], 'Signed CTO policy signature');
  validatePayload(artifact.payload);
  const payload = artifact.payload as Record<string, unknown>;
  if (payload.signerIdentity !== trustRoot.signerIdentity || payload.signingKeyId !== trustRoot.signingKeyId) {
    throw new Error('Policy signer does not match the configured CTO trust root');
  }
  assertSha256(artifact.payloadDigestSha256, 'Policy payload digest');
  const payloadDigest = sha256(canonicaliseJson(artifact.payload));
  if (payloadDigest !== artifact.payloadDigestSha256) throw new Error('Policy payload digest mismatch');
  if (artifact.signature.algorithm !== 'Ed25519'
    || typeof artifact.signature.value !== 'string'
    || !/^[A-Za-z0-9_-]{86}$/.test(artifact.signature.value)) {
    throw new Error('Policy signature must be a 64-byte Ed25519 base64url value');
  }
  assertSha256(artifact.artifactDigestSha256, 'Policy artifact digest');
  const artifactDigest = sha256(canonicaliseJson({
    payload: artifact.payload,
    payloadDigestSha256: artifact.payloadDigestSha256,
    signature: artifact.signature,
  }));
  if (artifactDigest !== artifact.artifactDigestSha256) throw new Error('Policy artifact digest mismatch');
  const { publicKey, fingerprint } = validateTrustRoot(trustRoot);
  const signedBytes = Buffer.from(canonicaliseJson({
    payload: artifact.payload,
    payloadDigestSha256: artifact.payloadDigestSha256,
  }), 'utf8');
  if (!verifySignature(null, signedBytes, publicKey, Buffer.from(artifact.signature.value, 'base64url'))) {
    throw new Error('CTO policy signature verification failed');
  }
  return { digest: artifactDigest, fingerprint };
}

const SIGNED_BASE_KEYS = ['artifactType', 'artifactVersion', 'signerIdentity', 'signingKeyId', 'signedAtUtc'] as const;

function validateSignedBase(payload: Record<string, unknown>, artifactType: string): void {
  if (payload.artifactType !== artifactType || payload.artifactVersion !== '1.0.0') throw new Error(`Invalid ${artifactType} version/type`);
  nonEmptyString(payload.signerIdentity, `${artifactType} signerIdentity`);
  nonEmptyString(payload.signingKeyId, `${artifactType} signingKeyId`);
  assertIsoUtc(payload.signedAtUtc, `${artifactType} signedAtUtc`);
}

function validateCommitmentPayload(payload: Record<string, unknown>): void {
  assertExactKeys(payload, [...SIGNED_BASE_KEYS, 'commitmentId', 'saltCommitment'], 'Salt commitment payload');
  validateSignedBase(payload, 'arkova-s33-salt-commitment');
  nonEmptyString(payload.commitmentId, 'Salt commitment id');
  if (!isRecord(payload.saltCommitment)) throw new Error('Salt commitment must be an object');
  assertExactKeys(payload.saltCommitment, ['algorithm', 'value'], 'Salt commitment');
  if (payload.saltCommitment.algorithm !== 'sha256') throw new Error('Salt commitment algorithm must be sha256');
  assertSha256(payload.saltCommitment.value, 'Salt commitment value');
}

function validateFreezePayload(payload: Record<string, unknown>): void {
  assertExactKeys(payload, [
    ...SIGNED_BASE_KEYS, 'freezeId', 'commitmentArtifactDigestSha256', 'batchId', 'revision',
    'manifestHashRepresentation', 'manifestSha256', 'gitEvidence',
  ], 'Manifest freeze payload');
  validateSignedBase(payload, 'arkova-s33-manifest-freeze');
  nonEmptyString(payload.freezeId, 'Manifest freeze id');
  assertSha256(payload.commitmentArtifactDigestSha256, 'Freeze commitment artifact digest');
  nonEmptyString(payload.batchId, 'Freeze batchId');
  positiveInteger(payload.revision, 'Freeze revision');
  if (!['raw-file-sha256', 'canonical-json-sha256'].includes(String(payload.manifestHashRepresentation))) {
    throw new Error('Freeze manifest hash representation is invalid');
  }
  assertSha256(payload.manifestSha256, 'Freeze manifest digest');
  if (!isRecord(payload.gitEvidence)) throw new Error('Freeze Git evidence must be an object');
  assertExactKeys(payload.gitEvidence, ['repositoryIdentity', 'freezeCommitSha', 'manifestPath'], 'Freeze Git evidence');
  nonEmptyString(payload.gitEvidence.repositoryIdentity, 'Freeze repository identity');
  if (typeof payload.gitEvidence.freezeCommitSha !== 'string' || !GIT_COMMIT_PATTERN.test(payload.gitEvidence.freezeCommitSha)) {
    throw new Error('Freeze Git commit must be an exact hexadecimal commit id');
  }
  const manifestPath = nonEmptyString(payload.gitEvidence.manifestPath, 'Freeze manifest path');
  if (isAbsolute(manifestPath) || manifestPath.includes(':') || manifestPath.split('/').includes('..')) {
    throw new Error('Freeze manifest path must be a safe repository-relative path');
  }
}

function validateSelectionPolicyPayload(payload: Record<string, unknown>): void {
  assertExactKeys(payload, [
    ...SIGNED_BASE_KEYS, 'policyId', 'commitmentArtifactDigestSha256', 'freezeArtifactDigestSha256',
    'batchId', 'revision', 'prng', 'sampleRule',
  ], 'Selection policy payload');
  validateSignedBase(payload, 'arkova-s33-selection-policy');
  nonEmptyString(payload.policyId, 'Selection policy id');
  assertSha256(payload.commitmentArtifactDigestSha256, 'Selection commitment artifact digest');
  assertSha256(payload.freezeArtifactDigestSha256, 'Selection freeze artifact digest');
  nonEmptyString(payload.batchId, 'Selection batchId');
  positiveInteger(payload.revision, 'Selection revision');
  if (payload.prng !== 'xorshift32-v1') throw new Error('Selection PRNG must be xorshift32-v1');
  if (payload.sampleRule !== 'ceil(10%),minimum-5,capped-at-entry-count') throw new Error('Selection sample rule is not the protocol-fixed floor');
}

function validateReveal(reveal: SaltRevealRecord): string {
  if (!isRecord(reveal)) throw new Error('Salt reveal must be an object');
  assertExactKeys(reveal, [
    'schemaVersion', 'revealId', 'commitmentArtifactDigestSha256', 'freezeArtifactDigestSha256',
    'policyArtifactDigestSha256', 'salt', 'revealedAtUtc',
  ], 'Salt reveal');
  if (reveal.schemaVersion !== 1) throw new Error('Salt reveal schemaVersion must be 1');
  nonEmptyString(reveal.revealId, 'Salt reveal id');
  assertSha256(reveal.commitmentArtifactDigestSha256, 'Reveal commitment digest');
  assertSha256(reveal.freezeArtifactDigestSha256, 'Reveal freeze digest');
  assertSha256(reveal.policyArtifactDigestSha256, 'Reveal policy digest');
  if (!/^[0-9a-f]{64}$/.test(reveal.salt)) throw new Error('Salt reveal must contain exactly 32 bytes of lowercase hex');
  assertIsoUtc(reveal.revealedAtUtc, 'Salt reveal timestamp');
  return sha256(canonicaliseJson(reveal));
}

function eventIndex(events: readonly CeremonyEvent[], kind: string, field: string, value: string): number {
  return events.findIndex((event) => event.kind === kind && event[field] === value);
}

function requireDurableSequence(
  events: readonly CeremonyEvent[],
  commitmentDigest: string,
  freezeDigest: string,
  policyDigest: string,
  revealDigest?: string,
): number[] {
  const commitment = eventIndex(events, 'salt-commitment-recorded', 'artifactDigestSha256', commitmentDigest);
  if (commitment < 0) throw new Error('Salt commitment is not durably recorded');
  const freeze = eventIndex(events, 'manifest-freeze-recorded', 'artifactDigestSha256', freezeDigest);
  if (freeze < 0) throw new Error('Manifest freeze is not durably recorded');
  const policy = eventIndex(events, 'selection-policy-recorded', 'artifactDigestSha256', policyDigest);
  if (policy < 0) throw new Error('Selection policy is not durably recorded');
  const reveal = revealDigest === undefined
    ? -1
    : eventIndex(events, 'salt-reveal-recorded', 'revealRecordDigestSha256', revealDigest);
  if (revealDigest !== undefined && reveal < 0) throw new Error('Salt reveal is not durably recorded');
  if (!(commitment < freeze && freeze < policy && (reveal < 0 || policy < reveal))) {
    throw new Error('Durable ceremony sequence must be commitment < freeze < policy < reveal < verification');
  }
  return [commitment, freeze, policy, reveal];
}

function hashManifest(content: string | Uint8Array, representation: ManifestFreezePayload['manifestHashRepresentation']): string {
  return representation === 'raw-file-sha256'
    ? rawManifestHash(content)
    : canonicalManifestHash(parseJson(content, 'Manifest'));
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

class AcceptanceOrchestrator implements S33AcceptanceOrchestrator {
  private readonly config: OrchestratorConfiguration;
  private readonly ledger: DurableAcceptanceLedger;
  private readonly publicKeyFingerprintSha256: string;

  constructor(config: OrchestratorConfiguration) {
    this.config = {
      ...config,
      repositoryRoot: realpathSync(config.repositoryRoot),
    };
    if (!GIT_COMMIT_PATTERN.test(config.verificationCommitSha)) throw new Error('Verification Git commit must be exact');
    this.publicKeyFingerprintSha256 = validateTrustRoot(config.trustRoot).fingerprint;
    this.ledger = new DurableAcceptanceLedger(config.ledgerPath);
  }

  recordSaltCommitment(artifact: SignedPolicyArtifact<SaltCommitmentPayload>): string {
    const { digest } = verifyArtifact(artifact, this.config.trustRoot, validateCommitmentPayload);
    this.ledger.append({
      kind: 'salt-commitment-recorded',
      artifactDigestSha256: digest,
      commitmentId: artifact.payload.commitmentId,
      saltCommitmentSha256: artifact.payload.saltCommitment.value,
      signedAtUtc: artifact.payload.signedAtUtc,
    }, (events) => {
      if (events.some((event) => event.kind === 'salt-commitment-recorded'
        && (event.artifactDigestSha256 === digest || event.commitmentId === artifact.payload.commitmentId))) {
        throw new Error('Salt commitment is already durably recorded');
      }
    });
    return digest;
  }

  recordManifestFreeze(
    artifact: SignedPolicyArtifact<ManifestFreezePayload>,
    manifestContent: string | Uint8Array,
  ): string {
    const { digest } = verifyArtifact(artifact, this.config.trustRoot, validateFreezePayload);
    const payload = artifact.payload;
    const manifest = parseBatchManifest(manifestContent);
    if (manifest.batchId !== payload.batchId || manifest.revision !== payload.revision) throw new Error('Freeze batch/revision does not match manifest');
    if (hashManifest(manifestContent, payload.manifestHashRepresentation) !== payload.manifestSha256) throw new Error('Freeze manifest hash mismatch');
    this.verifyGitFreeze(payload);
    this.ledger.append({
      kind: 'manifest-freeze-recorded',
      artifactDigestSha256: digest,
      commitmentArtifactDigestSha256: payload.commitmentArtifactDigestSha256,
      batchId: payload.batchId,
      revision: payload.revision,
      freezeCommitSha: payload.gitEvidence.freezeCommitSha,
    }, (events) => {
      const commitment = eventIndex(
        events,
        'salt-commitment-recorded',
        'artifactDigestSha256',
        payload.commitmentArtifactDigestSha256,
      );
      if (commitment < 0) throw new Error('Salt commitment must be durably recorded before manifest freeze');
      if (events.some((event) => event.kind === 'manifest-freeze-recorded'
        && event.artifactDigestSha256 === digest)) throw new Error('Manifest freeze is already recorded');
    });
    return digest;
  }

  recordSelectionPolicy(artifact: SignedPolicyArtifact<SelectionPolicyPayload>): string {
    const { digest } = verifyArtifact(artifact, this.config.trustRoot, validateSelectionPolicyPayload);
    const payload = artifact.payload;
    this.ledger.append({
      kind: 'selection-policy-recorded',
      artifactDigestSha256: digest,
      commitmentArtifactDigestSha256: payload.commitmentArtifactDigestSha256,
      freezeArtifactDigestSha256: payload.freezeArtifactDigestSha256,
      batchId: payload.batchId,
      revision: payload.revision,
    }, (events) => {
      requireDurableSequenceForPolicy(events, payload);
      if (events.some((event) => event.kind === 'selection-policy-recorded'
        && event.artifactDigestSha256 === digest)) throw new Error('Selection policy is already recorded');
    });
    return digest;
  }

  recordSaltReveal(reveal: SaltRevealRecord): string {
    const revealDigest = validateReveal(reveal);
    this.ledger.append({
      kind: 'salt-reveal-recorded',
      revealRecordDigestSha256: revealDigest,
      commitmentArtifactDigestSha256: reveal.commitmentArtifactDigestSha256,
      freezeArtifactDigestSha256: reveal.freezeArtifactDigestSha256,
      policyArtifactDigestSha256: reveal.policyArtifactDigestSha256,
      revealedAtUtc: reveal.revealedAtUtc,
    }, (events) => {
      requireDurableSequence(
        events,
        reveal.commitmentArtifactDigestSha256,
        reveal.freezeArtifactDigestSha256,
        reveal.policyArtifactDigestSha256,
      );
      const commitmentEvent = events.find((event) => event.kind === 'salt-commitment-recorded'
        && event.artifactDigestSha256 === reveal.commitmentArtifactDigestSha256);
      if (commitmentEvent?.saltCommitmentSha256 !== sha256(reveal.salt)) {
        throw new Error('Revealed salt does not match the durably recorded signed commitment');
      }
      if (events.some((event) => event.kind === 'salt-reveal-recorded'
        && (event.revealRecordDigestSha256 === revealDigest
          || event.commitmentArtifactDigestSha256 === reveal.commitmentArtifactDigestSha256))) {
        throw new Error('Salt commitment has already been revealed');
      }
    });
    return revealDigest;
  }

  selectAndConsumeSample(input: SampleSelectionInput): ManifestSampleResult {
    if (!isRecord(input)) throw new Error('Sample selection input must be an object');
    const unknown = Object.keys(input).filter((key) => ![
      'manifestContent', 'commitmentArtifact', 'freezeArtifact', 'policyArtifact', 'reveal',
    ].includes(key));
    if (unknown.length > 0) throw new Error(`Sample selection contains unknown caller controls: ${unknown.join(', ')}`);
    const commitment = verifyArtifact(input.commitmentArtifact, this.config.trustRoot, validateCommitmentPayload);
    const freeze = verifyArtifact(input.freezeArtifact, this.config.trustRoot, validateFreezePayload);
    const policy = verifyArtifact(input.policyArtifact, this.config.trustRoot, validateSelectionPolicyPayload);
    const revealDigest = validateReveal(input.reveal);
    const freezePayload = input.freezeArtifact.payload;
    const policyPayload = input.policyArtifact.payload;
    if (freezePayload.commitmentArtifactDigestSha256 !== commitment.digest
      || policyPayload.commitmentArtifactDigestSha256 !== commitment.digest
      || policyPayload.freezeArtifactDigestSha256 !== freeze.digest
      || input.reveal.commitmentArtifactDigestSha256 !== commitment.digest
      || input.reveal.freezeArtifactDigestSha256 !== freeze.digest
      || input.reveal.policyArtifactDigestSha256 !== policy.digest) {
      throw new Error('Ceremony artifact digest references do not form one authenticated chain');
    }
    if (sha256(input.reveal.salt) !== input.commitmentArtifact.payload.saltCommitment.value) throw new Error('Revealed salt does not match signed commitment');
    const manifest = parseBatchManifest(input.manifestContent);
    if (manifest.batchId !== freezePayload.batchId || manifest.revision !== freezePayload.revision
      || manifest.batchId !== policyPayload.batchId || manifest.revision !== policyPayload.revision) {
      throw new Error('Ceremony batch/revision does not match manifest');
    }
    const manifestHash = hashManifest(input.manifestContent, freezePayload.manifestHashRepresentation);
    if (manifestHash !== freezePayload.manifestSha256) throw new Error('Frozen manifest hash does not match actual content');
    this.verifyGitFreeze(freezePayload);

    const seedDigest = sha256(`${manifestHash}:${input.reveal.salt}`);
    const random = xorshift32(Number.parseInt(seedDigest.slice(0, 8), 16));
    const shuffled = manifest.entries.map(({ id }) => id).sort();
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    const sampleSize = Math.min(shuffled.length, Math.max(5, Math.ceil(shuffled.length * 0.1)));
    const sampleEntryIds = shuffled.slice(0, sampleSize);
    const uniqueKey = `${policy.digest}:${manifest.batchId}:${manifest.revision}`;
    const verifiedAtUtc = new Date().toISOString();
    const events = this.ledger.consume(uniqueKey, {
      kind: 'selection-consumed',
      policyArtifactDigestSha256: policy.digest,
      batchId: manifest.batchId,
      revision: manifest.revision,
      revealRecordDigestSha256: revealDigest,
      sampleEntryIdsSha256: sha256(canonicaliseJson(sampleEntryIds)),
      sampleSize,
      verifiedAtUtc,
    }, (prior) => {
      requireDurableSequence(prior, commitment.digest, freeze.digest, policy.digest, revealDigest);
      if (prior.some((event) => event.kind === 'selection-consumed'
        && event.policyArtifactDigestSha256 === policy.digest
        && event.batchId === manifest.batchId
        && event.revision === manifest.revision)) throw new Error('Selection ceremony already consumed');
    });
    return {
      sampleEntryIds,
      manifest: { batchId: manifest.batchId, revision: manifest.revision, entryCount: manifest.entryCount },
      evidence: {
        policyArtifactDigestSha256: policy.digest,
        commitmentArtifactDigestSha256: commitment.digest,
        freezeArtifactDigestSha256: freeze.digest,
        revealRecordDigestSha256: revealDigest,
        publicKeyFingerprintSha256: this.publicKeyFingerprintSha256,
        manifestSha256: manifestHash,
        manifestHashRepresentation: freezePayload.manifestHashRepresentation,
        manifestEntryCount: manifest.entryCount,
        seedDigestSha256: seedDigest,
        sampleSize,
        sampleRule: policyPayload.sampleRule,
        freezeCommitSha: freezePayload.gitEvidence.freezeCommitSha,
        verificationCommitSha: this.config.verificationCommitSha,
        durableSequence: events.map(({ kind }) => kind),
      },
    };
  }

  scanAuthenticatedLexicalLeakage(input: LexicalScanInput): AuthenticatedLexicalScanResult {
    if (!isRecord(input)) throw new Error('Lexical scan input must be an object');
    const unknown = Object.keys(input).filter((key) => ![
      'heldoutArtifactContent', 'corpusArtifactContent', 'policyArtifact',
    ].includes(key));
    if (unknown.length > 0) throw new Error(`Unknown precomputed lexical evidence is not accepted: ${unknown.join(', ')}`);
    const verified = verifyArtifact(input.policyArtifact, this.config.trustRoot, validateLexicalPolicyPayload);
    const policy = input.policyArtifact.payload;
    const heldout = parseLexicalTextArtifact(input.heldoutArtifactContent, 'heldout');
    const corpus = parseLexicalTextArtifact(input.corpusArtifactContent, 'corpus');
    const heldoutHash = hashTextArtifact(input.heldoutArtifactContent, heldout, policy.textArtifactHashRepresentation);
    const corpusHash = hashTextArtifact(input.corpusArtifactContent, corpus, policy.textArtifactHashRepresentation);
    if (heldout.artifactId !== policy.heldoutArtifactId || heldoutHash !== policy.heldoutArtifactSha256
      || corpus.artifactId !== policy.corpusArtifactId || corpusHash !== policy.corpusArtifactSha256) {
      throw new Error('Lexical text artifact id/hash does not match the authenticated policy binding');
    }
    const metrics = computeLexicalLeakageMetrics(heldout.records, corpus.records, policy.normalization);
    const hits = applyLexicalPolicy(metrics, policy);
    return {
      metrics,
      hits,
      evidence: {
        policyArtifactDigestSha256: verified.digest,
        publicKeyFingerprintSha256: verified.fingerprint,
        heldoutArtifactId: heldout.artifactId,
        heldoutArtifactSha256: heldoutHash,
        heldoutEntryCount: heldout.records.length,
        corpusArtifactId: corpus.artifactId,
        corpusArtifactSha256: corpusHash,
        corpusEntryCount: corpus.records.length,
        metricAlgorithmVersion: policy.metricAlgorithmVersion,
        metricCount: metrics.length,
      },
    };
  }

  private verifyGitFreeze(payload: ManifestFreezePayload): void {
    if (payload.gitEvidence.repositoryIdentity !== this.config.repositoryIdentity) throw new Error('Freeze repository identity mismatch');
    const commit = payload.gitEvidence.freezeCommitSha;
    try {
      execFileSync('git', ['-C', this.config.repositoryRoot, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' });
      execFileSync('git', [
        '-C', this.config.repositoryRoot, 'merge-base', '--is-ancestor', commit, this.config.verificationCommitSha,
      ], { stdio: 'ignore' });
    } catch (error) {
      throw new Error('Freeze Git commit is missing or is not an ancestor of verification commit', { cause: error });
    }
    let committedManifest: Buffer;
    try {
      committedManifest = execFileSync('git', [
        '-C', this.config.repositoryRoot, 'show', `${commit}:${payload.gitEvidence.manifestPath}`,
      ]);
    } catch (error) {
      throw new Error('Freeze Git commit does not contain the declared manifest path', { cause: error });
    }
    if (hashManifest(committedManifest, payload.manifestHashRepresentation) !== payload.manifestSha256) {
      throw new Error('Freeze Git blob does not match authenticated manifest hash');
    }
  }
}

function requireDurableSequenceForPolicy(events: readonly CeremonyEvent[], payload: SelectionPolicyPayload): void {
  const commitment = eventIndex(
    events, 'salt-commitment-recorded', 'artifactDigestSha256', payload.commitmentArtifactDigestSha256,
  );
  if (commitment < 0) throw new Error('Salt commitment must be durably recorded before selection policy');
  const freeze = eventIndex(events, 'manifest-freeze-recorded', 'artifactDigestSha256', payload.freezeArtifactDigestSha256);
  if (freeze < 0) throw new Error('Manifest freeze must be durably recorded before selection policy');
  if (!(commitment < freeze)) throw new Error('Durable commitment must precede manifest freeze');
  const freezeEvent = events[freeze];
  if (freezeEvent.commitmentArtifactDigestSha256 !== payload.commitmentArtifactDigestSha256
    || freezeEvent.batchId !== payload.batchId || freezeEvent.revision !== payload.revision) {
    throw new Error('Selection policy does not bind the recorded commitment/freeze batch revision');
  }
}

function validateLexicalNormalization(policy: unknown): asserts policy is LexicalNormalizationPolicy {
  if (!isRecord(policy)) throw new Error('Lexical normalization must be an object');
  assertExactKeys(policy, ['unicodeForm', 'caseFold', 'nonAlphanumeric', 'whitespace'], 'Lexical normalization');
  if (!['none', 'NFC', 'NFKC'].includes(String(policy.unicodeForm))
    || !['preserve', 'lowercase'].includes(String(policy.caseFold))
    || !['preserve', 'space'].includes(String(policy.nonAlphanumeric))
    || !['preserve', 'collapse'].includes(String(policy.whitespace))) {
    throw new Error('Lexical normalization values are invalid');
  }
}

function validateLexicalPolicyPayload(payload: Record<string, unknown>): void {
  assertExactKeys(payload, [
    ...SIGNED_BASE_KEYS, 'policyId', 'metricAlgorithmVersion', 'textArtifactHashRepresentation',
    'heldoutArtifactId', 'heldoutArtifactSha256', 'corpusArtifactId', 'corpusArtifactSha256',
    'normalization', 'allowedN', 'minimumSharedNgrams', 'minimumHeldoutContainment', 'combination',
  ], 'Lexical policy payload');
  validateSignedBase(payload, 'arkova-s33-lexical-leakage-policy');
  nonEmptyString(payload.policyId, 'Lexical policy id');
  if (payload.metricAlgorithmVersion !== 'token-set-ngram-v1') throw new Error('Lexical metric algorithm version is unsupported');
  if (!['raw-file-sha256', 'canonical-json-sha256'].includes(String(payload.textArtifactHashRepresentation))) {
    throw new Error('Lexical text artifact hash representation is invalid');
  }
  nonEmptyString(payload.heldoutArtifactId, 'Heldout artifact id');
  assertSha256(payload.heldoutArtifactSha256, 'Heldout artifact hash');
  nonEmptyString(payload.corpusArtifactId, 'Corpus artifact id');
  assertSha256(payload.corpusArtifactSha256, 'Corpus artifact hash');
  validateLexicalNormalization(payload.normalization);
  if (!Array.isArray(payload.allowedN)
    || payload.allowedN.length !== REQUIRED_LEXICAL_N.length
    || REQUIRED_LEXICAL_N.some((n) => !(payload.allowedN as unknown[]).includes(n))) {
    throw new Error('Lexical policy allowedN must be exactly n=6–13');
  }
  if (!Number.isSafeInteger(payload.minimumSharedNgrams) || (payload.minimumSharedNgrams as number) < 1) {
    throw new Error('Lexical minimum shared ngrams must be a positive integer');
  }
  if (!Number.isFinite(payload.minimumHeldoutContainment)
    || (payload.minimumHeldoutContainment as number) <= 0
    || (payload.minimumHeldoutContainment as number) > 1) {
    throw new Error('Lexical minimum containment must be in (0,1]');
  }
  if (payload.combination !== 'all' && payload.combination !== 'any') throw new Error('Lexical combination is invalid');
}

function parseLexicalTextArtifact(
  content: string | Uint8Array,
  expectedRole: 'heldout' | 'corpus',
): ParsedLexicalTextArtifact {
  const parsed = parseJson(content, `${expectedRole} lexical text artifact`);
  assertExactKeys(parsed, ['schemaVersion', 'algorithmVersion', 'artifactId', 'role', 'records'], `${expectedRole} text artifact`);
  if (parsed.schemaVersion !== 1 || parsed.algorithmVersion !== 's33-lexical-text-artifact-v1') {
    throw new Error(`${expectedRole} text artifact schema/algorithm version is invalid`);
  }
  const artifactId = nonEmptyString(parsed.artifactId, `${expectedRole} artifact id`);
  if (parsed.role !== expectedRole) throw new Error(`${expectedRole} text artifact role mismatch`);
  if (!Array.isArray(parsed.records) || parsed.records.length === 0) throw new Error(`${expectedRole} text artifact records are empty`);
  const records = parsed.records.map((candidate, index): TextRecord => {
    if (!isRecord(candidate)) throw new Error(`${expectedRole} records[${index}] must be an object`);
    assertExactKeys(candidate, ['id', 'text', 'contentSha256'], `${expectedRole} records[${index}]`);
    const id = nonEmptyString(candidate.id, `${expectedRole} records[${index}].id`);
    const text = nonEmptyString(candidate.text, `${expectedRole} records[${index}].text`);
    assertSha256(candidate.contentSha256, `${expectedRole} records[${index}].contentSha256`);
    if (sha256(text) !== candidate.contentSha256) throw new Error(`${expectedRole} record content hash mismatch`);
    return { id, text };
  });
  assertUniqueIds(records.map(({ id }) => id), `${expectedRole} text records`);
  return {
    schemaVersion: 1,
    algorithmVersion: 's33-lexical-text-artifact-v1',
    artifactId,
    role: expectedRole,
    records,
    parsedJson: parsed,
  };
}

function hashTextArtifact(
  content: string | Uint8Array,
  parsed: ParsedLexicalTextArtifact,
  representation: LexicalLeakagePolicyPayload['textArtifactHashRepresentation'],
): string {
  return representation === 'raw-file-sha256' ? rawManifestHash(content) : canonicalManifestHash(parsed.parsedJson);
}

function normalizeLeakageText(text: string, policy: LexicalNormalizationPolicy): string {
  let normalized = policy.unicodeForm === 'none' ? text : text.normalize(policy.unicodeForm);
  if (policy.caseFold === 'lowercase') normalized = normalized.toLowerCase();
  if (policy.nonAlphanumeric === 'space') normalized = normalized.replace(/[^\p{L}\p{N}]+/gu, ' ');
  if (policy.whitespace === 'collapse') normalized = normalized.replace(/\s+/gu, ' ');
  return normalized.trim();
}

function ngramSet(text: string, n: number, policy: LexicalNormalizationPolicy): Set<string> {
  const tokens = normalizeLeakageText(text, policy).split(/\s+/u).filter(Boolean);
  const ngrams = new Set<string>();
  for (let index = 0; index + n <= tokens.length; index += 1) ngrams.add(tokens.slice(index, index + n).join(' '));
  return ngrams;
}

function computeLexicalLeakageMetrics(
  heldout: readonly TextRecord[],
  corpus: readonly TextRecord[],
  normalization: LexicalNormalizationPolicy,
): LexicalLeakageMetric[] {
  const metrics: LexicalLeakageMetric[] = [];
  for (const heldoutRecord of heldout) {
    for (const corpusRecord of corpus) {
      for (const n of REQUIRED_LEXICAL_N) {
        const heldoutNgrams = ngramSet(heldoutRecord.text, n, normalization);
        const corpusNgrams = ngramSet(corpusRecord.text, n, normalization);
        let sharedNgrams = 0;
        for (const ngram of heldoutNgrams) if (corpusNgrams.has(ngram)) sharedNgrams += 1;
        const union = heldoutNgrams.size + corpusNgrams.size - sharedNgrams;
        metrics.push({
          heldoutId: heldoutRecord.id,
          corpusId: corpusRecord.id,
          n,
          heldoutNgrams: heldoutNgrams.size,
          corpusNgrams: corpusNgrams.size,
          sharedNgrams,
          heldoutContainment: heldoutNgrams.size === 0 ? 0 : sharedNgrams / heldoutNgrams.size,
          jaccard: union === 0 ? 0 : sharedNgrams / union,
        });
      }
    }
  }
  return metrics;
}

function applyLexicalPolicy(
  metrics: readonly LexicalLeakageMetric[],
  policy: LexicalLeakagePolicyPayload,
): LexicalLeakageMetric[] {
  return metrics.filter((metric) => {
    const checks = [
      metric.sharedNgrams >= policy.minimumSharedNgrams,
      metric.heldoutContainment >= policy.minimumHeldoutContainment,
    ];
    return policy.combination === 'all' ? checks.every(Boolean) : checks.some(Boolean);
  });
}

function loadProductionTrustRoot(): SamplingTrustRoot {
  const descriptor = PRODUCTION_TRUST_DESCRIPTOR;
  if (!descriptor.signerIdentity || !descriptor.signingKeyId || !descriptor.publicKeyFingerprintSha256) {
    throw new Error('S3.3 CTO trust root is not configured; production must fail closed');
  }
  return {
    signerIdentity: descriptor.signerIdentity,
    signingKeyId: descriptor.signingKeyId,
    publicKeyFingerprintSha256: descriptor.publicKeyFingerprintSha256,
    publicKeyPem: readFileSync(descriptor.publicKeyPath, 'utf8'),
  };
}

export function createProductionS33AcceptanceOrchestrator(
  input: ProductionOrchestratorInput,
): S33AcceptanceOrchestrator {
  return new AcceptanceOrchestrator({
    trustRoot: loadProductionTrustRoot(),
    ledgerPath: input.ledgerPath,
    repositoryRoot: input.repositoryRoot,
    repositoryIdentity: 'carson-see/ArkovaCarson',
    verificationCommitSha: input.verificationCommitSha,
  });
}

/** Test-only trust-root injection. Runtime callers cannot use this factory. */
export function createTestOnlyS33AcceptanceOrchestrator(
  input: OrchestratorConfiguration,
): S33AcceptanceOrchestrator {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test-only S3.3 trust-root injection is disabled outside NODE_ENV=test');
  return new AcceptanceOrchestrator(input);
}

export interface EmbeddingRecord {
  id: string;
  model: string;
  vector: readonly number[];
}

export interface EmbeddingLeakagePolicy {
  model: string;
  minimumCosineSimilarity: number;
}

export interface EmbeddingLeakageHit {
  heldoutId: string;
  corpusId: string;
  model: string;
  cosineSimilarity: number;
}

export interface EmbeddingBatchProvider {
  embed(records: readonly TextRecord[], model: string): Promise<readonly EmbeddingRecord[]>;
}

function validateEmbeddingPolicy(policy: EmbeddingLeakagePolicy): void {
  if (policy.model.trim().length === 0
    || !Number.isFinite(policy.minimumCosineSimilarity)
    || policy.minimumCosineSimilarity < 0
    || policy.minimumCosineSimilarity > 1) {
    throw new Error('Invalid embedding leakage policy; pinned model and cosine threshold are required');
  }
}

function validateTextRecords(records: readonly TextRecord[], label: string): void {
  assertUniqueIds(records.map(({ id }) => id), label);
  if (records.some(({ text }) => text.trim().length === 0)) throw new Error(`${label} contains empty text`);
}

function validateEmbeddingRecords(
  records: readonly EmbeddingRecord[],
  label: string,
  policy: EmbeddingLeakagePolicy,
): number {
  assertUniqueIds(records.map(({ id }) => id), label);
  const dimension = records[0].vector.length;
  if (dimension === 0) throw new Error(`${label} contains an empty vector`);
  for (const record of records) {
    if (record.model !== policy.model) throw new Error(`${label} model does not match pinned model`);
    if (record.vector.length !== dimension || record.vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`${label} contains a malformed vector`);
    }
    const magnitudeSquared = record.vector.reduce((sum, value) => sum + value * value, 0);
    if (!Number.isFinite(magnitudeSquared)) throw new Error(`${label} contains non-finite or overflowed vector arithmetic`);
    if (magnitudeSquared === 0) throw new Error(`${label} contains a zero-magnitude vector`);
  }
  return dimension;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
    if (!Number.isFinite(dot) || !Number.isFinite(leftNorm) || !Number.isFinite(rightNorm)) {
      throw new Error('Embedding cosine arithmetic overflowed or became non-finite');
    }
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  if (!Number.isFinite(denominator) || denominator <= 0) throw new Error('Embedding cosine denominator is non-finite');
  const similarity = dot / denominator;
  if (!Number.isFinite(similarity) || similarity < -1 || similarity > 1) throw new Error('Embedding cosine result is non-finite');
  return similarity;
}

export function compareEmbeddingLeakage(
  heldout: readonly EmbeddingRecord[],
  corpus: readonly EmbeddingRecord[],
  policy: EmbeddingLeakagePolicy,
): EmbeddingLeakageHit[] {
  validateEmbeddingPolicy(policy);
  const heldoutDimension = validateEmbeddingRecords(heldout, 'Held-out embeddings', policy);
  const corpusDimension = validateEmbeddingRecords(corpus, 'Corpus embeddings', policy);
  if (heldoutDimension !== corpusDimension) throw new Error('Embedding vector dimensions do not match');
  const hits: EmbeddingLeakageHit[] = [];
  for (const heldoutRecord of heldout) {
    for (const corpusRecord of corpus) {
      const similarity = cosineSimilarity(heldoutRecord.vector, corpusRecord.vector);
      if (similarity >= policy.minimumCosineSimilarity) {
        hits.push({
          heldoutId: heldoutRecord.id,
          corpusId: corpusRecord.id,
          model: policy.model,
          cosineSimilarity: similarity,
        });
      }
    }
  }
  return hits;
}

function assertProviderOutput(
  requested: readonly TextRecord[],
  output: readonly EmbeddingRecord[],
  label: string,
): void {
  if (output.length !== requested.length) throw new Error(`${label} embedding output count did not match request count`);
  const expectedIds = new Set(requested.map(({ id }) => id));
  if (output.some(({ id }) => !expectedIds.has(id)) || new Set(output.map(({ id }) => id)).size !== output.length) {
    throw new Error(`${label} embedding output ids did not match the request`);
  }
}

export async function scanEmbeddingLeakage(
  heldout: readonly TextRecord[],
  corpus: readonly TextRecord[],
  provider: EmbeddingBatchProvider,
  policy: EmbeddingLeakagePolicy,
): Promise<EmbeddingLeakageHit[]> {
  validateEmbeddingPolicy(policy);
  validateTextRecords(heldout, 'Held-out set');
  validateTextRecords(corpus, 'Leakage corpus');
  const heldoutEmbeddings = await provider.embed(heldout, policy.model);
  const corpusEmbeddings = await provider.embed(corpus, policy.model);
  assertProviderOutput(heldout, heldoutEmbeddings, 'Held-out');
  assertProviderOutput(corpus, corpusEmbeddings, 'Corpus');
  return compareEmbeddingLeakage(heldoutEmbeddings, corpusEmbeddings, policy);
}
