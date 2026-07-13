/**
 * Sprint 3.3 Lane-4 → Lane-3 batch-acceptance primitives.
 *
 * These functions deliberately separate measurable leakage evidence from the
 * policy that turns evidence into a reject verdict. The acceptance protocol
 * names lexical n=6..13 and embedding near-duplicate scans, but the binding
 * model/version and cutoffs are CTO inputs. There are therefore no threshold
 * defaults in this module. Sampling authenticates its policy artifact here;
 * lexical/embedding threshold calls accept explicit policy values but do not
 * themselves claim that the CTO has ratified those values.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import { canonicaliseJson } from '../../utils/canonical-json.js';

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

export interface SamplingPolicyPayload {
  artifactType: 'arkova-s33-sampling-policy';
  artifactVersion: '1.0.0';
  policyId: string;
  signerIdentity: string;
  signingKeyId: string;
  signedAtUtc: string;
  batchId: string;
  revision: number;
  manifestHashRepresentation: 'raw-file-sha256' | 'canonical-json-sha256';
  manifestSha256: string;
  prng: 'xorshift32-v1';
  saltCommitment: {
    algorithm: 'sha256';
    value: string;
    recordedAtUtc: string;
  };
}

export interface SamplingPolicyArtifact {
  payload: SamplingPolicyPayload;
  payloadDigestSha256: string;
  signature: {
    algorithm: 'Ed25519';
    value: string;
  };
  artifactDigestSha256: string;
}

export interface SamplingTrustRoot {
  signerIdentity: string;
  signingKeyId: string;
  publicKeyPem: string;
  publicKeyFingerprintSha256: string;
}

export interface SamplingReveal {
  salt: string;
  revealedAtUtc: string;
}

export interface SamplingVerificationContext {
  verifiedAtUtc: string;
  consumedPolicyArtifactDigests: readonly string[];
}

export interface ManifestSampleInput {
  manifestContent: string | Uint8Array;
  policyArtifact: SamplingPolicyArtifact;
  trustRoot: SamplingTrustRoot;
  reveal: SamplingReveal;
  verification: SamplingVerificationContext;
}

export interface ManifestSampleResult {
  sampleEntryIds: string[];
  manifest: {
    batchId: string;
    revision: number;
    entryCount: number;
  };
  evidence: {
    policyId: string;
    policyArtifactDigestSha256: string;
    policyPayloadDigestSha256: string;
    signerIdentity: string;
    signingKeyId: string;
    publicKeyFingerprintSha256: string;
    manifestHashRepresentation: SamplingPolicyPayload['manifestHashRepresentation'];
    manifestSha256: string;
    manifestEntryCount: number;
    commitmentRecordedAtUtc: string;
    signedAtUtc: string;
    revealedAtUtc: string;
    verifiedAtUtc: string;
    seedDigestSha256: string;
    prng: SamplingPolicyPayload['prng'];
    sampleSize: number;
    sampleRule: 'ceil(10%), minimum 5, capped at manifest entry count';
  };
}

function canonicalizeJson(value: unknown, path = '$'): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Manifest contains a non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalizeJson(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key], `${path}.${key}`)}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`Manifest contains a non-JSON value at ${path}`);
}

/** SHA-256 over a key-order-independent, JSON-only manifest representation. */
export function canonicalManifestHash(manifest: unknown): string {
  return createHash('sha256').update(canonicalizeJson(manifest), 'utf8').digest('hex');
}

function manifestBytes(content: string | Uint8Array): Buffer {
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (!(content instanceof Uint8Array)) {
    throw new Error('Manifest content must be raw UTF-8 text or bytes');
  }
  return Buffer.from(content);
}

/** SHA-256 over the exact producer-supplied manifest bytes. */
export function rawManifestHash(content: string | Uint8Array): string {
  return createHash('sha256').update(manifestBytes(content)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Manifest ${path} must be a non-empty string`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Manifest ${path} must be a positive safe integer; an empty batch is rejected`);
  }
  return value as number;
}

function parseCountMap(value: unknown, path: string): Map<string, number> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error(`Manifest ${path} must be a non-empty count object`);
  }
  const result = new Map<string, number>();
  for (const [key, count] of Object.entries(value)) {
    if (key.trim().length === 0 || !Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`Manifest ${path}.${key} must be a non-negative safe integer`);
    }
    result.set(key, count as number);
  }
  return result;
}

function countBy(entries: readonly BatchManifestEntry[], field: 'domain' | 'credentialType'): Map<string, number> {
  const result = new Map<string, number>();
  for (const entry of entries) result.set(entry[field], (result.get(entry[field]) ?? 0) + 1);
  return result;
}

function assertCountMapMatches(
  declared: Map<string, number>,
  actual: Map<string, number>,
  path: string,
): void {
  if (declared.size !== actual.size
    || [...actual].some(([key, count]) => declared.get(key) !== count)) {
    throw new Error(`Manifest ${path} does not reconcile with the complete entries universe`);
  }
}

/** Parse and structurally reconcile the Lane-4 batch-manifest schema. */
export function parseBatchManifest(content: string | Uint8Array): ParsedBatchManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes(content)));
  } catch (error) {
    throw new Error('Manifest JSON could not be parsed as valid UTF-8', { cause: error });
  }
  if (!isRecord(parsed)) throw new Error('Manifest root must be a JSON object');
  if (parsed.schemaVersion !== 1) throw new Error('Manifest schemaVersion must be 1');
  const batchId = requiredNonEmptyString(parsed.batchId, 'batchId');
  const revision = requiredPositiveInteger(parsed.revision, 'revision');
  const intendedSplit = requiredNonEmptyString(parsed.intendedSplit, 'intendedSplit');
  const entryCount = requiredPositiveInteger(parsed.entryCount, 'entryCount');
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error('Manifest entries universe is empty; acceptance must fail closed');
  }

  const entries = parsed.entries.map((candidate, index): BatchManifestEntry => {
    if (!isRecord(candidate)) throw new Error(`Manifest entries[${index}] must be an object`);
    const normalizedInputSha256 = requiredNonEmptyString(
      candidate.normalizedInputSha256,
      `entries[${index}].normalizedInputSha256`,
    );
    if (!/^[0-9a-f]{64}$/.test(normalizedInputSha256)) {
      throw new Error(`Manifest entries[${index}].normalizedInputSha256 must be lowercase SHA-256`);
    }
    return {
      id: requiredNonEmptyString(candidate.id, `entries[${index}].id`),
      domain: requiredNonEmptyString(candidate.domain, `entries[${index}].domain`),
      credentialType: requiredNonEmptyString(candidate.credentialType, `entries[${index}].credentialType`),
      normalizedInputSha256,
    };
  });
  assertUniqueNonEmptyIds(entries.map(({ id }) => id), 'Manifest entries universe');
  if (entryCount !== entries.length) {
    throw new Error(`Manifest entryCount ${entryCount} does not match entries length ${entries.length}`);
  }
  if (!isRecord(parsed.counts)) throw new Error('Manifest counts must be an object');
  assertCountMapMatches(
    parseCountMap(parsed.counts.byDomain, 'counts.byDomain'),
    countBy(entries, 'domain'),
    'counts.byDomain',
  );
  assertCountMapMatches(
    parseCountMap(parsed.counts.byCredentialType, 'counts.byCredentialType'),
    countBy(entries, 'credentialType'),
    'counts.byCredentialType',
  );
  if (!isRecord(parsed.selfChecks) || Object.keys(parsed.selfChecks).length === 0) {
    throw new Error('Manifest selfChecks must be a non-empty object');
  }
  return {
    schemaVersion: 1,
    batchId,
    revision,
    entryCount,
    intendedSplit,
    entries,
    parsedJson: parsed,
  };
}

function assertUniqueNonEmptyIds(ids: readonly string[], label: string): void {
  if (ids.length === 0) throw new Error(`${label} is empty; acceptance must fail closed`);
  if (ids.some((id) => id.trim().length === 0)) throw new Error(`${label} contains an empty id`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate entry ids`);
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

function parseOrderingTimestamp(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be a valid timestamp`);
  return milliseconds;
}

function validateSamplingPayload(payload: SamplingPolicyPayload | undefined): asserts payload is SamplingPolicyPayload {
  if (!payload
    || payload.artifactType !== 'arkova-s33-sampling-policy'
    || payload.artifactVersion !== '1.0.0'
    || typeof payload.policyId !== 'string'
    || payload.policyId.trim().length === 0
    || typeof payload.signerIdentity !== 'string'
    || payload.signerIdentity.trim().length === 0
    || typeof payload.signingKeyId !== 'string'
    || payload.signingKeyId.trim().length === 0
    || typeof payload.batchId !== 'string'
    || payload.batchId.trim().length === 0
    || !Number.isSafeInteger(payload.revision)
    || payload.revision < 1
    || !['raw-file-sha256', 'canonical-json-sha256'].includes(payload.manifestHashRepresentation)
    || !/^[0-9a-f]{64}$/.test(payload.manifestSha256)
    || payload.prng !== 'xorshift32-v1'
    || payload.saltCommitment?.algorithm !== 'sha256'
    || !/^[0-9a-f]{64}$/.test(payload.saltCommitment.value)) {
    throw new Error('Invalid CTO sampling policy artifact payload');
  }
  parseOrderingTimestamp(payload.signedAtUtc, 'Policy signedAtUtc');
  parseOrderingTimestamp(payload.saltCommitment.recordedAtUtc, 'Salt commitment recordedAtUtc');
}

function verifySamplingArtifact(
  artifact: SamplingPolicyArtifact | undefined,
  trustRoot: SamplingTrustRoot | undefined,
): { artifactDigest: string; publicKeyFingerprint: string } {
  if (!artifact || !isRecord(artifact) || !isRecord(artifact.signature)) {
    throw new Error('A signed CTO sampling policy artifact is required');
  }
  if (!trustRoot || !isRecord(trustRoot)) {
    throw new Error('A pinned CTO sampling trust root is required');
  }
  validateSamplingPayload(artifact.payload);
  if (!/^[0-9a-f]{64}$/.test(artifact.payloadDigestSha256)) {
    throw new Error('Sampling policy payload digest is malformed');
  }
  const actualPayloadDigest = createHash('sha256')
    .update(canonicaliseJson(artifact.payload), 'utf8')
    .digest('hex');
  if (actualPayloadDigest !== artifact.payloadDigestSha256) {
    throw new Error('Sampling policy payload digest does not match the immutable payload');
  }
  if (artifact.signature.algorithm !== 'Ed25519'
    || typeof artifact.signature.value !== 'string'
    || !/^[A-Za-z0-9_-]{86}$/.test(artifact.signature.value)) {
    throw new Error('Sampling policy signature must be a 64-byte Ed25519 base64url value');
  }
  if (!/^[0-9a-f]{64}$/.test(artifact.artifactDigestSha256)) {
    throw new Error('Sampling policy artifact digest is malformed');
  }
  const actualArtifactDigest = createHash('sha256').update(canonicaliseJson({
    payload: artifact.payload,
    payloadDigestSha256: artifact.payloadDigestSha256,
    signature: artifact.signature,
  }), 'utf8').digest('hex');
  if (actualArtifactDigest !== artifact.artifactDigestSha256) {
    throw new Error('Sampling policy artifact digest mismatch; payload or signature changed');
  }
  if (artifact.payload.signerIdentity !== trustRoot.signerIdentity
    || artifact.payload.signingKeyId !== trustRoot.signingKeyId) {
    throw new Error('Sampling policy signer does not match the pinned CTO trust root');
  }
  if (!/^[0-9a-f]{64}$/.test(trustRoot.publicKeyFingerprintSha256)) {
    throw new Error('Pinned CTO public-key fingerprint is malformed');
  }
  let publicKey;
  try {
    publicKey = createPublicKey(trustRoot.publicKeyPem);
  } catch (error) {
    throw new Error('Pinned CTO trust-root public key is invalid', { cause: error });
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Pinned CTO trust-root public key must be Ed25519');
  }
  const publicKeyFingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  if (publicKeyFingerprint !== trustRoot.publicKeyFingerprintSha256) {
    throw new Error('Pinned CTO public-key fingerprint does not match the supplied key');
  }
  const signedBytes = Buffer.from(canonicaliseJson({
    payload: artifact.payload,
    payloadDigestSha256: artifact.payloadDigestSha256,
  }), 'utf8');
  const signature = Buffer.from(artifact.signature.value, 'base64url');
  if (!verifySignature(null, signedBytes, publicKey, signature)) {
    throw new Error('CTO sampling policy signature verification failed');
  }
  return {
    artifactDigest: actualArtifactDigest,
    publicKeyFingerprint,
  };
}

/**
 * Select the protocol-fixed Lane-3 cross-review sample from the complete entry
 * universe parsed out of the actual manifest bytes. A pinned CTO Ed25519 trust
 * root and an authenticated salt commitment are mandatory; there is no
 * predictable or unsigned mode.
 */
export function selectManifestSeededSample(input: ManifestSampleInput): ManifestSampleResult {
  if (!input || !isRecord(input)) throw new Error('Manifest sampling input is required');
  const manifest = parseBatchManifest(input.manifestContent);
  const { artifactDigest, publicKeyFingerprint } = verifySamplingArtifact(
    input.policyArtifact,
    input.trustRoot,
  );
  const policy = input.policyArtifact.payload;
  if (!input.verification || !Array.isArray(input.verification.consumedPolicyArtifactDigests)) {
    throw new Error('A consumed-policy artifact ledger is required for replay protection');
  }
  if (input.verification.consumedPolicyArtifactDigests.includes(artifactDigest)) {
    throw new Error('Sampling policy artifact has already been consumed; replay rejected');
  }
  if (policy.batchId !== manifest.batchId || policy.revision !== manifest.revision) {
    throw new Error('Sampling policy batch/revision does not match the manifest');
  }
  const actualManifestHash = policy.manifestHashRepresentation === 'raw-file-sha256'
    ? rawManifestHash(input.manifestContent)
    : canonicalManifestHash(manifest.parsedJson);
  if (actualManifestHash !== policy.manifestSha256) {
    throw new Error('Declared manifest hash does not match the actual manifest content');
  }
  if (!input.reveal || !/^[0-9a-f]{64}$/.test(input.reveal.salt)) {
    throw new Error('Sampling salt reveal must contain exactly 32 bytes of lowercase hex');
  }
  const actualCommitment = createHash('sha256').update(input.reveal.salt, 'utf8').digest('hex');
  if (actualCommitment !== policy.saltCommitment.value) {
    throw new Error('Revealed Lane-3 sampling salt does not match its authenticated commitment');
  }
  const commitmentAt = parseOrderingTimestamp(
    policy.saltCommitment.recordedAtUtc,
    'Salt commitment recordedAtUtc',
  );
  const signedAt = parseOrderingTimestamp(policy.signedAtUtc, 'Policy signedAtUtc');
  const revealedAt = parseOrderingTimestamp(input.reveal.revealedAtUtc, 'Salt reveal revealedAtUtc');
  const verifiedAt = parseOrderingTimestamp(input.verification.verifiedAtUtc, 'Verification verifiedAtUtc');
  if (!(commitmentAt <= signedAt && signedAt < revealedAt && revealedAt <= verifiedAt)) {
    throw new Error('Invalid ordering: commitment and signed policy must exist before reveal, then verification');
  }

  const seedDigest = createHash('sha256')
    .update(`${actualManifestHash}:${input.reveal.salt}`, 'utf8')
    .digest('hex');
  const random = xorshift32(Number.parseInt(seedDigest.slice(0, 8), 16));
  const shuffled = manifest.entries.map(({ id }) => id).sort();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  const sampleSize = Math.min(shuffled.length, Math.max(5, Math.ceil(shuffled.length * 0.1)));
  return {
    sampleEntryIds: shuffled.slice(0, sampleSize),
    manifest: {
      batchId: manifest.batchId,
      revision: manifest.revision,
      entryCount: manifest.entryCount,
    },
    evidence: {
      policyId: policy.policyId,
      policyArtifactDigestSha256: artifactDigest,
      policyPayloadDigestSha256: input.policyArtifact.payloadDigestSha256,
      signerIdentity: policy.signerIdentity,
      signingKeyId: policy.signingKeyId,
      publicKeyFingerprintSha256: publicKeyFingerprint,
      manifestHashRepresentation: policy.manifestHashRepresentation,
      manifestSha256: actualManifestHash,
      manifestEntryCount: manifest.entryCount,
      commitmentRecordedAtUtc: policy.saltCommitment.recordedAtUtc,
      signedAtUtc: policy.signedAtUtc,
      revealedAtUtc: input.reveal.revealedAtUtc,
      verifiedAtUtc: input.verification.verifiedAtUtc,
      seedDigestSha256: seedDigest,
      prng: policy.prng,
      sampleSize,
      sampleRule: 'ceil(10%), minimum 5, capped at manifest entry count',
    },
  };
}

export interface LexicalMetricOptions {
  minN: number;
  maxN: number;
  normalization: LexicalNormalizationPolicy;
}

export interface LexicalNormalizationPolicy {
  unicodeForm: 'none' | 'NFC' | 'NFKC';
  caseFold: 'preserve' | 'lowercase';
  nonAlphanumeric: 'preserve' | 'space';
  whitespace: 'preserve' | 'collapse';
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

export interface LexicalLeakagePolicy {
  allowedN: readonly number[];
  minimumSharedNgrams: number;
  minimumHeldoutContainment: number;
  combination: 'all' | 'any';
}

export interface LexicalMetricUniverse {
  heldoutIds: readonly string[];
  corpusIds: readonly string[];
}

const REQUIRED_LEXICAL_N = [6, 7, 8, 9, 10, 11, 12, 13] as const;

function validateLexicalNormalizationPolicy(policy: LexicalNormalizationPolicy | undefined): void {
  if (!policy
    || !['none', 'NFC', 'NFKC'].includes(policy.unicodeForm)
    || !['preserve', 'lowercase'].includes(policy.caseFold)
    || !['preserve', 'space'].includes(policy.nonAlphanumeric)
    || !['preserve', 'collapse'].includes(policy.whitespace)) {
    throw new Error('Invalid lexical normalization policy; an explicit policy is required');
  }
}

/** Apply only the explicitly supplied normalization policy. */
export function normalizeLeakageText(text: string, policy: LexicalNormalizationPolicy): string {
  validateLexicalNormalizationPolicy(policy);
  let normalized = policy.unicodeForm === 'none' ? text : text.normalize(policy.unicodeForm);
  if (policy.caseFold === 'lowercase') normalized = normalized.toLowerCase();
  if (policy.nonAlphanumeric === 'space') normalized = normalized.replace(/[^\p{L}\p{N}]+/gu, ' ');
  if (policy.whitespace === 'collapse') normalized = normalized.replace(/\s+/gu, ' ');
  return normalized.trim();
}

function ngramSet(text: string, n: number, normalization: LexicalNormalizationPolicy): Set<string> {
  const tokens = normalizeLeakageText(text, normalization).split(/\s+/u).filter(Boolean);
  const result = new Set<string>();
  for (let index = 0; index + n <= tokens.length; index += 1) {
    result.add(tokens.slice(index, index + n).join(' '));
  }
  return result;
}

function validateTextRecords(records: readonly TextRecord[], label: string): void {
  assertUniqueNonEmptyIds(records.map((record) => record.id), label);
  if (records.some((record) => record.text.trim().length === 0)) {
    throw new Error(`${label} contains empty text`);
  }
}

/** Emit all pairwise n-gram evidence; this function never chooses a cutoff. */
export function computeLexicalLeakageMetrics(
  heldout: readonly TextRecord[],
  corpus: readonly TextRecord[],
  options: LexicalMetricOptions,
): LexicalLeakageMetric[] {
  validateLexicalNormalizationPolicy(options.normalization);
  validateTextRecords(heldout, 'Held-out set');
  validateTextRecords(corpus, 'Leakage corpus');
  if (options.minN !== 6 || options.maxN !== 13) {
    throw new Error('Lexical acceptance scans must emit the complete n=6–13 range');
  }

  const metrics: LexicalLeakageMetric[] = [];
  for (const heldoutRecord of heldout) {
    for (const corpusRecord of corpus) {
      for (let n = options.minN; n <= options.maxN; n += 1) {
        const heldoutNgrams = ngramSet(heldoutRecord.text, n, options.normalization);
        const corpusNgrams = ngramSet(corpusRecord.text, n, options.normalization);
        let sharedNgrams = 0;
        for (const ngram of heldoutNgrams) {
          if (corpusNgrams.has(ngram)) sharedNgrams += 1;
        }
        const unionSize = heldoutNgrams.size + corpusNgrams.size - sharedNgrams;
        metrics.push({
          heldoutId: heldoutRecord.id,
          corpusId: corpusRecord.id,
          n,
          heldoutNgrams: heldoutNgrams.size,
          corpusNgrams: corpusNgrams.size,
          sharedNgrams,
          heldoutContainment: heldoutNgrams.size === 0 ? 0 : sharedNgrams / heldoutNgrams.size,
          jaccard: unionSize === 0 ? 0 : sharedNgrams / unionSize,
        });
      }
    }
  }
  return metrics;
}

function validateLexicalPolicy(policy: LexicalLeakagePolicy): void {
  const allowed = new Set(policy?.allowedN);
  if (!policy
    || policy.allowedN.length !== REQUIRED_LEXICAL_N.length
    || allowed.size !== REQUIRED_LEXICAL_N.length
    || REQUIRED_LEXICAL_N.some((n) => !allowed.has(n))
    || !Number.isInteger(policy.minimumSharedNgrams)
    || policy.minimumSharedNgrams < 1
    || !(policy.minimumHeldoutContainment > 0 && policy.minimumHeldoutContainment <= 1)
    || (policy.combination !== 'all' && policy.combination !== 'any')) {
    throw new Error('Invalid lexical leakage policy; allowedN must be the complete n=6–13 range and thresholds explicit');
  }
}

function assertFiniteUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Lexical metric ${label} must be finite and within [0, 1]`);
  }
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12;
}

function validateLexicalMetric(
  metric: LexicalLeakageMetric,
  heldoutIds: Set<string>,
  corpusIds: Set<string>,
): string {
  if (!heldoutIds.has(metric.heldoutId) || !corpusIds.has(metric.corpusId)) {
    throw new Error('Lexical metric tuple is outside the declared heldout/corpus universe');
  }
  if (!REQUIRED_LEXICAL_N.includes(metric.n as typeof REQUIRED_LEXICAL_N[number])) {
    throw new Error('Lexical metric n must be in the complete n=6–13 range');
  }
  for (const [label, count] of [
    ['heldoutNgrams', metric.heldoutNgrams],
    ['corpusNgrams', metric.corpusNgrams],
    ['sharedNgrams', metric.sharedNgrams],
  ] as const) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Lexical metric ${label} must be a non-negative safe integer`);
    }
  }
  if (metric.sharedNgrams > metric.heldoutNgrams || metric.sharedNgrams > metric.corpusNgrams) {
    throw new Error('Lexical metric sharedNgrams exceeds an input n-gram count');
  }
  assertFiniteUnitInterval(metric.heldoutContainment, 'heldoutContainment');
  assertFiniteUnitInterval(metric.jaccard, 'jaccard');
  const expectedContainment = metric.heldoutNgrams === 0
    ? 0
    : metric.sharedNgrams / metric.heldoutNgrams;
  const union = metric.heldoutNgrams + metric.corpusNgrams - metric.sharedNgrams;
  const expectedJaccard = union === 0 ? 0 : metric.sharedNgrams / union;
  if (!nearlyEqual(metric.heldoutContainment, expectedContainment)
    || !nearlyEqual(metric.jaccard, expectedJaccard)) {
    throw new Error('Lexical metric contains fabricated or inconsistent derived ratios');
  }
  return `${metric.heldoutId}\u0000${metric.corpusId}\u0000${metric.n}`;
}

function validateCompleteLexicalMatrix(
  metrics: readonly LexicalLeakageMetric[],
  universe: LexicalMetricUniverse | undefined,
): void {
  if (!universe) throw new Error('A declared heldout/corpus metric universe is required');
  assertUniqueNonEmptyIds(universe.heldoutIds, 'Declared held-out metric universe');
  assertUniqueNonEmptyIds(universe.corpusIds, 'Declared corpus metric universe');
  if (metrics.length === 0) throw new Error('Lexical metric matrix is empty; complete evidence is required');
  const expectedCount = universe.heldoutIds.length * universe.corpusIds.length * REQUIRED_LEXICAL_N.length;
  if (metrics.length !== expectedCount) {
    throw new Error(`Lexical metric matrix is incomplete: expected ${expectedCount}, received ${metrics.length}`);
  }
  const heldoutIds = new Set(universe.heldoutIds);
  const corpusIds = new Set(universe.corpusIds);
  const tuples = new Set<string>();
  for (const metric of metrics) {
    const tuple = validateLexicalMetric(metric, heldoutIds, corpusIds);
    if (tuples.has(tuple)) throw new Error(`Lexical metric matrix contains duplicate tuple ${tuple}`);
    tuples.add(tuple);
  }
  for (const heldoutId of universe.heldoutIds) {
    for (const corpusId of universe.corpusIds) {
      for (const n of REQUIRED_LEXICAL_N) {
        if (!tuples.has(`${heldoutId}\u0000${corpusId}\u0000${n}`)) {
          throw new Error(`Lexical metric matrix is missing ${heldoutId} × ${corpusId} × n=${n}`);
        }
      }
    }
  }
}

/** Apply an explicit policy only to a complete, internally consistent matrix. */
export function applyLexicalLeakagePolicy(
  metrics: readonly LexicalLeakageMetric[],
  policy: LexicalLeakagePolicy,
  universe: LexicalMetricUniverse,
): LexicalLeakageMetric[] {
  validateLexicalPolicy(policy);
  validateCompleteLexicalMatrix(metrics, universe);
  const allowedN = new Set(policy.allowedN);
  return metrics.filter((metric) => {
    if (!allowedN.has(metric.n)) return false;
    const checks = [
      metric.sharedNgrams >= policy.minimumSharedNgrams,
      metric.heldoutContainment >= policy.minimumHeldoutContainment,
    ];
    return policy.combination === 'all' ? checks.every(Boolean) : checks.some(Boolean);
  });
}

/** Compute and apply the complete matrix without trusting caller-supplied metrics. */
export function scanLexicalLeakage(
  heldout: readonly TextRecord[],
  corpus: readonly TextRecord[],
  normalization: LexicalNormalizationPolicy,
  policy: LexicalLeakagePolicy,
): { metrics: LexicalLeakageMetric[]; hits: LexicalLeakageMetric[] } {
  const metrics = computeLexicalLeakageMetrics(heldout, corpus, {
    minN: 6,
    maxN: 13,
    normalization,
  });
  const universe = {
    heldoutIds: heldout.map(({ id }) => id),
    corpusIds: corpus.map(({ id }) => id),
  };
  return {
    metrics,
    hits: applyLexicalLeakagePolicy(metrics, policy, universe),
  };
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

function validateEmbeddingRecords(
  records: readonly EmbeddingRecord[],
  label: string,
  policy: EmbeddingLeakagePolicy,
): number {
  assertUniqueNonEmptyIds(records.map((record) => record.id), label);
  const dimension = records[0].vector.length;
  if (dimension === 0) throw new Error(`${label} contains an empty vector`);
  for (const record of records) {
    if (record.model !== policy.model) {
      throw new Error(`${label} model ${record.model} does not match pinned model ${policy.model}`);
    }
    if (record.vector.length !== dimension || record.vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`${label} contains a malformed vector`);
    }
    const magnitudeSquared = record.vector.reduce((sum, value) => sum + value * value, 0);
    if (!Number.isFinite(magnitudeSquared)) {
      throw new Error(`${label} contains non-finite or overflowed vector arithmetic`);
    }
    if (magnitudeSquared === 0) throw new Error(`${label} contains a zero-magnitude vector`);
  }
  return dimension;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    magnitudeA += a[index] * a[index];
    magnitudeB += b[index] * b[index];
    if (!Number.isFinite(dot) || !Number.isFinite(magnitudeA) || !Number.isFinite(magnitudeB)) {
      throw new Error('Embedding cosine arithmetic overflowed or became non-finite');
    }
  }
  const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    throw new Error('Embedding cosine denominator is non-finite');
  }
  const similarity = dot / denominator;
  if (!Number.isFinite(similarity) || similarity < -1 || similarity > 1) {
    throw new Error('Embedding cosine result is non-finite or outside [-1, 1]');
  }
  return similarity;
}

/** Compare precomputed embeddings under an explicit model/version and cutoff. */
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
  if (output.length !== requested.length) {
    throw new Error(`${label} embedding output count ${output.length} did not match request count ${requested.length}`);
  }
  const expectedIds = new Set(requested.map((record) => record.id));
  if (output.some((record) => !expectedIds.has(record.id))
    || new Set(output.map((record) => record.id)).size !== output.length) {
    throw new Error(`${label} embedding output ids did not match the request`);
  }
}

/**
 * Generate both embedding sets through one pinned provider contract, then
 * compare them. Provider failures propagate and incomplete output throws.
 */
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
