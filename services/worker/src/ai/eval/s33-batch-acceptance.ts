/**
 * Sprint 3.3 Lane-4 → Lane-3 batch acceptance.
 *
 * Public verdict boundaries consume authenticated source artifacts and
 * recompute evidence. No API accepts caller-supplied sample ids, consumed
 * arrays, or lexical metric matrices. CTO policy artifacts verify against a
 * configuration-owned Ed25519 trust root; production remains fail-closed until
 * the CTO supplies that root, an external monotonic consumption registry, and
 * the separately signed ceremony artifacts.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUint8Array } from 'node:util/types';
import { canonicaliseJson } from '../../utils/canonical-json.js';

type ArtifactContent = string | Uint8Array;

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
  commitmentArtifactCanonicalSha256: string;
  batchId: string;
  revision: number;
  manifestRawSha256: string;
  manifestCanonicalSha256: string;
  gitEvidence: {
    repositoryIdentity: string;
    freezeCommitSha: string;
    manifestPath: string;
  };
}

export interface SelectionPolicyPayload extends SignedPayloadBase {
  artifactType: 'arkova-s33-selection-policy';
  policyId: string;
  commitmentArtifactCanonicalSha256: string;
  freezeArtifactCanonicalSha256: string;
  batchId: string;
  revision: number;
  prng: 'xorshift32-v1';
  sampleRule: 'ceil(10%),minimum-5,capped-at-entry-count';
}

export interface SaltRevealRecord {
  schemaVersion: 1;
  revealId: string;
  commitmentArtifactCanonicalSha256: string;
  freezeArtifactCanonicalSha256: string;
  policyArtifactCanonicalSha256: string;
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
  heldoutArtifactId: string;
  heldoutArtifactRawSha256: string;
  heldoutArtifactCanonicalSha256: string;
  corpusArtifactId: string;
  corpusArtifactRawSha256: string;
  corpusArtifactCanonicalSha256: string;
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
  consumptionRegistry: ConsumptionRegistry;
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
  manifestContent: ArtifactContent;
  commitmentArtifactContent: ArtifactContent;
  freezeArtifactContent: ArtifactContent;
  policyArtifactContent: ArtifactContent;
  revealContent: ArtifactContent;
}

interface LexicalScanInput {
  heldoutArtifactContent: ArtifactContent;
  corpusArtifactContent: ArtifactContent;
  policyArtifactContent: ArtifactContent;
}

export interface ConsumptionRegistryRecord {
  uniqueKey: string;
  policyArtifactCanonicalSha256: string;
  batchId: string;
  revision: number;
  evidenceCanonicalSha256: string;
}

/**
 * Production trust port. Implementations must atomically create a key only if
 * absent and must never delete/reuse a created key. `false` means it existed.
 * No production implementation is supplied by this module.
 */
export interface ConsumptionRegistry {
  createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean>;
}

export interface S33AcceptanceOrchestrator {
  recordSaltCommitment(artifactContent: ArtifactContent): string;
  recordManifestFreeze(
    artifactContent: ArtifactContent,
    manifestContent: ArtifactContent,
  ): string;
  recordSelectionPolicy(artifactContent: ArtifactContent): string;
  recordSaltReveal(revealContent: ArtifactContent): string;
  selectAndConsumeSample(input: SampleSelectionInput): Promise<ManifestSampleResult>;
  scanAuthenticatedLexicalLeakage(input: LexicalScanInput): AuthenticatedLexicalScanResult;
}

export interface ManifestSampleResult {
  sampleEntryIds: string[];
  manifest: { batchId: string; revision: number; entryCount: number };
  evidence: {
    policyArtifactCanonicalSha256: string;
    policyArtifactRawSha256: string;
    commitmentArtifactCanonicalSha256: string;
    commitmentArtifactRawSha256: string;
    freezeArtifactCanonicalSha256: string;
    freezeArtifactRawSha256: string;
    revealCanonicalSha256: string;
    revealRawSha256: string;
    publicKeyFingerprintSha256: string;
    manifestRawSha256: string;
    manifestCanonicalSha256: string;
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
    policyArtifactCanonicalSha256: string;
    policyArtifactRawSha256: string;
    publicKeyFingerprintSha256: string;
    heldoutArtifactId: string;
    heldoutArtifactRawSha256: string;
    heldoutArtifactCanonicalSha256: string;
    heldoutEntryCount: number;
    corpusArtifactId: string;
    corpusArtifactRawSha256: string;
    corpusArtifactCanonicalSha256: string;
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
  rawSha256: string;
  canonicalSha256: string;
}

const REQUIRED_LEXICAL_N = [6, 7, 8, 9, 10, 11, 12, 13] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// CTO-controlled production descriptor. No key/fingerprint has been issued,
// so production construction intentionally fails before reading the fixed PEM.
const PRODUCTION_ACCEPTANCE_DESCRIPTOR = Object.freeze({
  signerIdentity: null as string | null,
  signingKeyId: null as string | null,
  publicKeyFingerprintSha256: null as string | null,
  consumptionRegistry: null as ConsumptionRegistry | null,
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
  if (isUint8Array(content)) return Buffer.from(content);
  throw new Error(`${label} must be UTF-8 text or bytes`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface StrictJsonDocument {
  parsed: Readonly<Record<string, unknown>>;
  rawSha256: string;
  canonicalSha256: string;
}

class StrictJsonParser {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly label: string,
  ) {}

  parseRoot(): Readonly<Record<string, unknown>> {
    const value = this.parseValue('$');
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail('unexpected trailing content');
    if (!isRecord(value)) this.fail('root must be a JSON object');
    return deepFreeze(value);
  }

  private parseValue(path: string): unknown {
    this.skipWhitespace();
    const token = this.text[this.index];
    if (token === '{') return this.parseObject(path);
    if (token === '[') return this.parseArray(path);
    if (token === '"') return this.parseString();
    if (token === '-' || (token >= '0' && token <= '9')) return this.parseNumber();
    if (this.text.startsWith('true', this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith('false', this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith('null', this.index)) {
      this.index += 4;
      return null;
    }
    this.fail('invalid JSON value');
  }

  private parseObject(path: string): Record<string, unknown> {
    this.index += 1;
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.fail('object key must be a JSON string');
      const key = this.parseString();
      if (keys.has(key)) this.fail(`duplicate JSON key "${key}" at ${path}`);
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        this.fail(`forbidden JSON key "${key}" at ${path}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') this.fail(`missing colon after key "${key}"`);
      this.index += 1;
      const value = this.parseValue(`${path}.${key}`);
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === '}') {
        this.index += 1;
        return result;
      }
      if (separator !== ',') this.fail('object entries must be comma-separated');
      this.index += 1;
    }
    this.fail('unterminated JSON object');
  }

  private parseArray(path: string): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      result.push(this.parseValue(`${path}[${result.length}]`));
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === ']') {
        this.index += 1;
        return result;
      }
      if (separator !== ',') this.fail('array entries must be comma-separated');
      this.index += 1;
    }
    this.fail('unterminated JSON array');
  }

  private parseString(): string {
    this.index += 1;
    let result = '';
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      this.index += 1;
      if (character === '"') return result;
      if (character === '\\') {
        const escape = this.text[this.index];
        this.index += 1;
        const simple: Record<string, string> = {
          '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
        };
        if (escape in simple) {
          result += simple[escape];
          continue;
        }
        if (escape !== 'u') this.fail('invalid JSON string escape');
        const hex = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid JSON Unicode escape');
        result += String.fromCharCode(Number.parseInt(hex, 16));
        this.index += 4;
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) this.fail('unescaped control character in JSON string');
      result += character;
    }
    this.fail('unterminated JSON string');
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    if (!match) this.fail('invalid JSON number');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail('JSON number is not finite');
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && /[\t\n\r ]/.test(this.text[this.index])) this.index += 1;
  }

  private fail(message: string): never {
    throw new Error(`${this.label} ${message} at byte/character ${this.index}`);
  }
}

function deepFreeze<T>(value: T): T {
  if ((Array.isArray(value) || isRecord(value)) && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseStrictJsonDocument(content: ArtifactContent, label: string): StrictJsonDocument {
  const raw = bytes(content, label);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch (error) {
    throw new Error(`${label} must contain valid UTF-8`, { cause: error });
  }
  const parsed = new StrictJsonParser(text, label).parseRoot();
  return deepFreeze({
    parsed,
    rawSha256: sha256(raw),
    canonicalSha256: sha256(canonicaliseJson(parsed)),
  });
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
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

export function canonicalManifestHash(content: ArtifactContent): string {
  return parseStrictJsonDocument(content, 'Artifact content').canonicalSha256;
}

export function rawManifestHash(content: ArtifactContent): string {
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

interface LoadedBatchManifest {
  manifest: ParsedBatchManifest;
  rawSha256: string;
  canonicalSha256: string;
}

function loadBatchManifest(content: ArtifactContent): LoadedBatchManifest {
  const document = parseStrictJsonDocument(content, 'Manifest');
  const parsed = document.parsed;
  assertExactKeys(parsed, [
    'schemaVersion', 'batchId', 'revision', 'entryCount', 'intendedSplit', 'counts', 'selfChecks', 'entries',
  ], 'Manifest');
  if (parsed.schemaVersion !== 1) throw new Error('Manifest schemaVersion must be 1');
  const batchId = nonEmptyString(parsed.batchId, 'Manifest batchId');
  const revision = positiveInteger(parsed.revision, 'Manifest revision');
  const entryCount = positiveInteger(parsed.entryCount, 'Manifest entryCount');
  const intendedSplit = nonEmptyString(parsed.intendedSplit, 'Manifest intendedSplit');
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) throw new Error('Manifest entries universe is empty');
  const entries = parsed.entries.map((candidate, index): BatchManifestEntry => {
    if (!isRecord(candidate)) throw new Error(`Manifest entries[${index}] must be an object`);
    assertExactKeys(candidate, [
      'id', 'domain', 'credentialType', 'normalizedInputSha256',
    ], `Manifest entries[${index}]`);
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
  assertExactKeys(parsed.counts, ['byDomain', 'byCredentialType'], 'Manifest counts');
  assertCounts(parseCountMap(parsed.counts.byDomain, 'Manifest counts.byDomain'), countBy(entries, 'domain'), 'Manifest counts.byDomain');
  assertCounts(
    parseCountMap(parsed.counts.byCredentialType, 'Manifest counts.byCredentialType'),
    countBy(entries, 'credentialType'),
    'Manifest counts.byCredentialType',
  );
  if (!isRecord(parsed.selfChecks)) throw new Error('Manifest selfChecks must be an object');
  assertExactKeys(parsed.selfChecks, ['structural'], 'Manifest selfChecks');
  if (!isRecord(parsed.selfChecks.structural)) throw new Error('Manifest selfChecks.structural must be an object');
  assertExactKeys(parsed.selfChecks.structural, ['status'], 'Manifest selfChecks.structural');
  if (parsed.selfChecks.structural.status !== 'PASS') throw new Error('Manifest structural self-check must PASS');
  const manifest = deepFreeze({
    schemaVersion: 1 as const,
    batchId,
    revision,
    entryCount,
    intendedSplit,
    entries,
    parsedJson: parsed as Record<string, unknown>,
  });
  return deepFreeze({
    manifest,
    rawSha256: document.rawSha256,
    canonicalSha256: document.canonicalSha256,
  });
}

export function parseBatchManifest(content: ArtifactContent): ParsedBatchManifest {
  return loadBatchManifest(content).manifest;
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

interface VerifiedArtifact<P extends object> {
  payload: Readonly<P>;
  canonicalSha256: string;
  rawSha256: string;
  fingerprint: string;
}

function verifyArtifactContent<P extends object>(
  artifactContent: ArtifactContent,
  trustRoot: SamplingTrustRoot,
  validatePayload: (payload: Record<string, unknown>) => void,
): VerifiedArtifact<P> {
  const document = parseStrictJsonDocument(artifactContent, 'Signed CTO policy artifact');
  const artifact = document.parsed;
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
  return deepFreeze({
    payload: artifact.payload as unknown as P,
    canonicalSha256: document.canonicalSha256,
    rawSha256: document.rawSha256,
    fingerprint,
  });
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
    ...SIGNED_BASE_KEYS, 'freezeId', 'commitmentArtifactCanonicalSha256', 'batchId', 'revision',
    'manifestRawSha256', 'manifestCanonicalSha256', 'gitEvidence',
  ], 'Manifest freeze payload');
  validateSignedBase(payload, 'arkova-s33-manifest-freeze');
  nonEmptyString(payload.freezeId, 'Manifest freeze id');
  assertSha256(payload.commitmentArtifactCanonicalSha256, 'Freeze commitment artifact canonical digest');
  nonEmptyString(payload.batchId, 'Freeze batchId');
  positiveInteger(payload.revision, 'Freeze revision');
  assertSha256(payload.manifestRawSha256, 'Freeze manifest raw digest');
  assertSha256(payload.manifestCanonicalSha256, 'Freeze manifest canonical digest');
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
    ...SIGNED_BASE_KEYS, 'policyId', 'commitmentArtifactCanonicalSha256', 'freezeArtifactCanonicalSha256',
    'batchId', 'revision', 'prng', 'sampleRule',
  ], 'Selection policy payload');
  validateSignedBase(payload, 'arkova-s33-selection-policy');
  nonEmptyString(payload.policyId, 'Selection policy id');
  assertSha256(payload.commitmentArtifactCanonicalSha256, 'Selection commitment artifact canonical digest');
  assertSha256(payload.freezeArtifactCanonicalSha256, 'Selection freeze artifact canonical digest');
  nonEmptyString(payload.batchId, 'Selection batchId');
  positiveInteger(payload.revision, 'Selection revision');
  if (payload.prng !== 'xorshift32-v1') throw new Error('Selection PRNG must be xorshift32-v1');
  if (payload.sampleRule !== 'ceil(10%),minimum-5,capped-at-entry-count') throw new Error('Selection sample rule is not the protocol-fixed floor');
}

interface VerifiedReveal {
  reveal: Readonly<SaltRevealRecord>;
  canonicalSha256: string;
  rawSha256: string;
}

function loadReveal(revealContent: ArtifactContent): VerifiedReveal {
  const document = parseStrictJsonDocument(revealContent, 'Salt reveal');
  const reveal = document.parsed;
  assertExactKeys(reveal, [
    'schemaVersion', 'revealId', 'commitmentArtifactCanonicalSha256', 'freezeArtifactCanonicalSha256',
    'policyArtifactCanonicalSha256', 'salt', 'revealedAtUtc',
  ], 'Salt reveal');
  if (reveal.schemaVersion !== 1) throw new Error('Salt reveal schemaVersion must be 1');
  nonEmptyString(reveal.revealId, 'Salt reveal id');
  assertSha256(reveal.commitmentArtifactCanonicalSha256, 'Reveal commitment canonical digest');
  assertSha256(reveal.freezeArtifactCanonicalSha256, 'Reveal freeze canonical digest');
  assertSha256(reveal.policyArtifactCanonicalSha256, 'Reveal policy canonical digest');
  if (typeof reveal.salt !== 'string' || !/^[0-9a-f]{64}$/.test(reveal.salt)) {
    throw new Error('Salt reveal must contain exactly 32 bytes of lowercase hex');
  }
  assertIsoUtc(reveal.revealedAtUtc, 'Salt reveal timestamp');
  return deepFreeze({
    reveal: reveal as unknown as SaltRevealRecord,
    canonicalSha256: document.canonicalSha256,
    rawSha256: document.rawSha256,
  });
}

interface CommitmentEvent {
  kind: 'salt-commitment-recorded';
  artifactCanonicalSha256: string;
  artifactRawSha256: string;
  commitmentId: string;
  saltCommitmentSha256: string;
}

interface FreezeEvent {
  kind: 'manifest-freeze-recorded';
  artifactCanonicalSha256: string;
  artifactRawSha256: string;
  commitmentArtifactCanonicalSha256: string;
  batchId: string;
  revision: number;
  manifestRawSha256: string;
  manifestCanonicalSha256: string;
  freezeCommitSha: string;
}

interface PolicyEvent {
  kind: 'selection-policy-recorded';
  artifactCanonicalSha256: string;
  artifactRawSha256: string;
  commitmentArtifactCanonicalSha256: string;
  freezeArtifactCanonicalSha256: string;
  batchId: string;
  revision: number;
}

interface RevealEvent {
  kind: 'salt-reveal-recorded';
  revealCanonicalSha256: string;
  revealRawSha256: string;
  commitmentArtifactCanonicalSha256: string;
  freezeArtifactCanonicalSha256: string;
  policyArtifactCanonicalSha256: string;
  revealedSaltSha256: string;
}

interface ConsumptionEvent {
  kind: 'selection-consumed';
  registryUniqueKey: string;
  commitmentArtifactRawSha256: string;
  freezeArtifactRawSha256: string;
  policyArtifactCanonicalSha256: string;
  policyArtifactRawSha256: string;
  revealRawSha256: string;
  batchId: string;
  revision: number;
  evidenceCanonicalSha256: string;
}

interface SelectionTranscriptReferences extends RevealEvent {
  commitmentArtifactRawSha256: string;
  freezeArtifactRawSha256: string;
  policyArtifactRawSha256: string;
}

type CeremonyEvent = CommitmentEvent | FreezeEvent | PolicyEvent | RevealEvent | ConsumptionEvent;

interface TranscriptRecord {
  sequence: number;
  previousRecordSha256: string | null;
  event: CeremonyEvent;
  recordSha256: string;
}

function validateTranscriptEvent(event: Record<string, unknown>, recordNumber: number): void {
  const label = `Acceptance transcript record ${recordNumber} event`;
  const keysByKind: Record<string, readonly string[]> = {
    'salt-commitment-recorded': [
      'kind', 'artifactCanonicalSha256', 'artifactRawSha256', 'commitmentId', 'saltCommitmentSha256',
    ],
    'manifest-freeze-recorded': [
      'kind', 'artifactCanonicalSha256', 'artifactRawSha256', 'commitmentArtifactCanonicalSha256',
      'batchId', 'revision', 'manifestRawSha256', 'manifestCanonicalSha256', 'freezeCommitSha',
    ],
    'selection-policy-recorded': [
      'kind', 'artifactCanonicalSha256', 'artifactRawSha256', 'commitmentArtifactCanonicalSha256',
      'freezeArtifactCanonicalSha256', 'batchId', 'revision',
    ],
    'salt-reveal-recorded': [
      'kind', 'revealCanonicalSha256', 'revealRawSha256', 'commitmentArtifactCanonicalSha256',
      'freezeArtifactCanonicalSha256', 'policyArtifactCanonicalSha256', 'revealedSaltSha256',
    ],
    'selection-consumed': [
      'kind', 'registryUniqueKey', 'commitmentArtifactRawSha256', 'freezeArtifactRawSha256',
      'policyArtifactCanonicalSha256', 'policyArtifactRawSha256', 'revealRawSha256',
      'batchId', 'revision', 'evidenceCanonicalSha256',
    ],
  };
  if (typeof event.kind !== 'string' || !(event.kind in keysByKind)) {
    throw new Error(`${label} kind is invalid`);
  }
  assertExactKeys(event, keysByKind[event.kind], label);
  for (const [key, value] of Object.entries(event)) {
    if (key.endsWith('Sha256')) assertSha256(value, `${label}.${key}`);
  }
}

/**
 * Local audit transcript only. Its hash chain detects corruption in the view
 * presented to this process, but it is not trusted for privileged rollback or
 * replay prevention. The external ConsumptionRegistry owns that decision.
 */
class AcceptanceAuditTranscript {
  private readonly transcriptPath: string;
  private readonly evidenceDirectory: string;
  private readonly lockPath: string;

  constructor(transcriptPath: string) {
    if (!isAbsolute(transcriptPath) || basename(transcriptPath).trim().length === 0) {
      throw new Error('Acceptance transcript path must be an absolute file path');
    }
    mkdirSync(dirname(transcriptPath), { recursive: true, mode: 0o700 });
    this.evidenceDirectory = realpathSync(dirname(transcriptPath));
    this.transcriptPath = join(this.evidenceDirectory, basename(transcriptPath));
    this.lockPath = `${this.transcriptPath}.lock`;
  }

  recordCommitment(event: CommitmentEvent): void {
    this.appendFixed(event, (events) => {
      if (events.some((prior) => prior.kind === 'salt-commitment-recorded'
        && (prior.artifactCanonicalSha256 === event.artifactCanonicalSha256
          || prior.commitmentId === event.commitmentId))) {
        throw new Error('Salt commitment is already durably recorded');
      }
    });
  }

  recordFreeze(event: FreezeEvent): void {
    this.appendFixed(event, (events) => {
      const commitment = events.findIndex((prior) => prior.kind === 'salt-commitment-recorded'
        && prior.artifactCanonicalSha256 === event.commitmentArtifactCanonicalSha256);
      if (commitment < 0) throw new Error('Salt commitment must be durably recorded before manifest freeze');
      if (events.some((prior) => prior.kind === 'manifest-freeze-recorded'
        && prior.artifactCanonicalSha256 === event.artifactCanonicalSha256)) {
        throw new Error('Manifest freeze is already recorded');
      }
    });
  }

  recordPolicy(event: PolicyEvent): void {
    this.appendFixed(event, (events) => {
      const commitment = events.findIndex((prior) => prior.kind === 'salt-commitment-recorded'
        && prior.artifactCanonicalSha256 === event.commitmentArtifactCanonicalSha256);
      const freeze = events.findIndex((prior) => prior.kind === 'manifest-freeze-recorded'
        && prior.artifactCanonicalSha256 === event.freezeArtifactCanonicalSha256);
      if (commitment < 0) throw new Error('Salt commitment must be durably recorded before selection policy');
      if (freeze < 0) throw new Error('Manifest freeze must be durably recorded before selection policy');
      if (commitment >= freeze) throw new Error('Durable commitment must precede manifest freeze');
      const freezeEvent = events[freeze];
      if (freezeEvent.kind !== 'manifest-freeze-recorded'
        || freezeEvent.commitmentArtifactCanonicalSha256 !== event.commitmentArtifactCanonicalSha256
        || freezeEvent.batchId !== event.batchId
        || freezeEvent.revision !== event.revision) {
        throw new Error('Selection policy does not bind the recorded commitment/freeze batch revision');
      }
      if (events.some((prior) => prior.kind === 'selection-policy-recorded'
        && prior.artifactCanonicalSha256 === event.artifactCanonicalSha256)) {
        throw new Error('Selection policy is already recorded');
      }
    });
  }

  recordReveal(event: RevealEvent): void {
    this.appendFixed(event, (events) => {
      const indices = this.sequenceIndices(events, event);
      const commitment = events[indices.commitment];
      if (commitment.kind !== 'salt-commitment-recorded'
        || commitment.saltCommitmentSha256 !== event.revealedSaltSha256) {
        throw new Error('Revealed salt does not match the durably recorded signed commitment');
      }
      if (events.some((prior) => prior.kind === 'salt-reveal-recorded'
        && prior.commitmentArtifactCanonicalSha256 === event.commitmentArtifactCanonicalSha256)) {
        throw new Error('Salt commitment has already been revealed');
      }
    });
  }

  verifySelectionInputs(references: SelectionTranscriptReferences): void {
    this.withExclusiveLock((records) => {
      this.validateSelectionInputs(records.map(({ event }) => event), references);
    });
  }

  recordConsumption(event: ConsumptionEvent, references: SelectionTranscriptReferences): string[] {
    return this.appendFixed(event, (events) => {
      this.validateSelectionInputs(events, references);
      if (events.some((prior) => prior.kind === 'selection-consumed'
        && prior.registryUniqueKey === event.registryUniqueKey)) {
        throw new Error('Selection registry key is already present in the audit transcript');
      }
    }).map(({ kind }) => kind);
  }

  private validateSelectionInputs(
    events: readonly CeremonyEvent[],
    references: SelectionTranscriptReferences,
  ): void {
    const indices = this.sequenceIndices(events, references);
    if (indices.reveal < 0) throw new Error('Salt reveal is not durably recorded');
    const commitment = events[indices.commitment];
    const freeze = events[indices.freeze];
    const policy = events[indices.policy];
    const reveal = events[indices.reveal];
    if (commitment.kind !== 'salt-commitment-recorded'
      || commitment.artifactRawSha256 !== references.commitmentArtifactRawSha256
      || freeze.kind !== 'manifest-freeze-recorded'
      || freeze.artifactRawSha256 !== references.freezeArtifactRawSha256
      || policy.kind !== 'selection-policy-recorded'
      || policy.artifactRawSha256 !== references.policyArtifactRawSha256
      || reveal.kind !== 'salt-reveal-recorded'
      || reveal.revealRawSha256 !== references.revealRawSha256) {
      throw new Error('Selection inputs do not match the raw artifact bytes durably recorded in the transcript');
    }
  }

  private sequenceIndices(events: readonly CeremonyEvent[], references: RevealEvent): {
    commitment: number;
    freeze: number;
    policy: number;
    reveal: number;
  } {
    const commitment = events.findIndex((event) => event.kind === 'salt-commitment-recorded'
      && (references.commitmentArtifactCanonicalSha256 === ''
        || event.artifactCanonicalSha256 === references.commitmentArtifactCanonicalSha256));
    const freeze = events.findIndex((event) => event.kind === 'manifest-freeze-recorded'
      && (references.freezeArtifactCanonicalSha256 === ''
        || event.artifactCanonicalSha256 === references.freezeArtifactCanonicalSha256));
    const policy = events.findIndex((event) => event.kind === 'selection-policy-recorded'
      && event.artifactCanonicalSha256 === references.policyArtifactCanonicalSha256);
    const reveal = events.findIndex((event) => event.kind === 'salt-reveal-recorded'
      && (references.revealCanonicalSha256 === ''
        || event.revealCanonicalSha256 === references.revealCanonicalSha256));
    if (commitment < 0) throw new Error('Salt commitment is not durably recorded');
    if (freeze < 0) throw new Error('Manifest freeze is not durably recorded');
    if (policy < 0) throw new Error('Selection policy is not durably recorded');
    if (!(commitment < freeze && freeze < policy && (reveal < 0 || policy < reveal))) {
      throw new Error('Durable ceremony sequence must be commitment < freeze < policy < reveal < verification');
    }
    return { commitment, freeze, policy, reveal };
  }

  private appendFixed(
    event: CeremonyEvent,
    validate: (events: readonly CeremonyEvent[]) => void,
  ): CeremonyEvent[] {
    return this.withExclusiveLock((records) => {
      const events = records.map(({ event: prior }) => prior);
      validate(events);
      const next = this.buildRecord(records, event);
      const fd = openSync(
        this.transcriptPath,
        constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        this.writeAll(fd, `${canonicaliseJson(next)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.syncDirectory();
      return [...events, event];
    });
  }

  private withExclusiveLock<T>(operation: (records: TranscriptRecord[]) => T): T {
    let lockFd: number;
    try {
      lockFd = openSync(
        this.lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (isRecord(error) && error.code === 'EEXIST') {
        throw new Error('Acceptance audit transcript is locked by another process', { cause: error });
      }
      throw error;
    }
    try {
      this.writeAll(lockFd, `${process.pid}\n`);
      fsyncSync(lockFd);
      return operation(this.readValidatedRecords());
    } finally {
      closeSync(lockFd);
      unlinkSync(this.lockPath);
      this.syncDirectory();
    }
  }

  private readValidatedRecords(): TranscriptRecord[] {
    if (!existsSync(this.transcriptPath)) return [];
    if (lstatSync(this.transcriptPath).isSymbolicLink()) {
      throw new Error('Acceptance audit transcript must not be a symbolic link');
    }
    const content = readFileSync(this.transcriptPath, 'utf8');
    if (content.length === 0) return [];
    if (!content.endsWith('\n')) throw new Error('Acceptance audit transcript hash chain is truncated');
    const records: TranscriptRecord[] = [];
    for (const [index, line] of content.trimEnd().split('\n').entries()) {
      const candidate = parseStrictJsonDocument(line, `Acceptance transcript record ${index + 1}`).parsed;
      assertExactKeys(candidate, [
        'sequence', 'previousRecordSha256', 'event', 'recordSha256',
      ], `Acceptance transcript record ${index + 1}`);
      if (candidate.sequence !== index + 1
        || !isRecord(candidate.event)
        || typeof candidate.event.kind !== 'string'
        || !SHA256_PATTERN.test(String(candidate.recordSha256))) {
        throw new Error(`Acceptance audit transcript record ${index + 1} has an invalid schema`);
      }
      validateTranscriptEvent(candidate.event, index + 1);
      const expectedPrevious = records.at(-1)?.recordSha256 ?? null;
      if (candidate.previousRecordSha256 !== expectedPrevious) {
        throw new Error(`Acceptance audit transcript predecessor mismatch at record ${index + 1}`);
      }
      const material = {
        sequence: candidate.sequence,
        previousRecordSha256: candidate.previousRecordSha256,
        event: candidate.event,
      };
      if (candidate.recordSha256 !== sha256(canonicaliseJson(material))) {
        throw new Error(`Acceptance audit transcript digest mismatch at record ${index + 1}`);
      }
      records.push(candidate as unknown as TranscriptRecord);
    }
    return records;
  }

  private buildRecord(records: readonly TranscriptRecord[], event: CeremonyEvent): TranscriptRecord {
    const material = {
      sequence: records.length + 1,
      previousRecordSha256: records.at(-1)?.recordSha256 ?? null,
      event,
    };
    return { ...material, recordSha256: sha256(canonicaliseJson(material)) };
  }

  private writeAll(fd: number, content: string): void {
    const buffer = Buffer.from(content, 'utf8');
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }

  private syncDirectory(): void {
    const fd = openSync(this.evidenceDirectory, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
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
  readonly #config: OrchestratorConfiguration;
  readonly #transcript: AcceptanceAuditTranscript;
  readonly #publicKeyFingerprintSha256: string;
  readonly #createConsumptionRecord: ConsumptionRegistry['createIfAbsent'];

  constructor(config: OrchestratorConfiguration) {
    const createIfAbsent = config.consumptionRegistry?.createIfAbsent;
    if (typeof createIfAbsent !== 'function') {
      throw new Error('Atomic monotonic consumption registry is required');
    }
    const trustRoot = deepFreeze({
      signerIdentity: config.trustRoot.signerIdentity,
      signingKeyId: config.trustRoot.signingKeyId,
      publicKeyPem: config.trustRoot.publicKeyPem,
      publicKeyFingerprintSha256: config.trustRoot.publicKeyFingerprintSha256,
    });
    this.#config = {
      ...config,
      trustRoot,
      repositoryRoot: realpathSync(config.repositoryRoot),
    };
    if (!GIT_COMMIT_PATTERN.test(config.verificationCommitSha)) throw new Error('Verification Git commit must be exact');
    this.#createConsumptionRecord = createIfAbsent.bind(config.consumptionRegistry);
    this.#publicKeyFingerprintSha256 = validateTrustRoot(trustRoot).fingerprint;
    this.#transcript = new AcceptanceAuditTranscript(config.ledgerPath);
  }

  recordSaltCommitment(artifactContent: ArtifactContent): string {
    const verified = verifyArtifactContent<SaltCommitmentPayload>(
      artifactContent,
      this.#config.trustRoot,
      validateCommitmentPayload,
    );
    this.#transcript.recordCommitment({
      kind: 'salt-commitment-recorded',
      artifactCanonicalSha256: verified.canonicalSha256,
      artifactRawSha256: verified.rawSha256,
      commitmentId: verified.payload.commitmentId,
      saltCommitmentSha256: verified.payload.saltCommitment.value,
    });
    return verified.canonicalSha256;
  }

  recordManifestFreeze(
    artifactContent: ArtifactContent,
    manifestContent: ArtifactContent,
  ): string {
    const verified = verifyArtifactContent<ManifestFreezePayload>(
      artifactContent,
      this.#config.trustRoot,
      validateFreezePayload,
    );
    const payload = verified.payload;
    const loadedManifest = loadBatchManifest(manifestContent);
    const manifest = loadedManifest.manifest;
    if (manifest.batchId !== payload.batchId || manifest.revision !== payload.revision) throw new Error('Freeze batch/revision does not match manifest');
    if (loadedManifest.rawSha256 !== payload.manifestRawSha256
      || loadedManifest.canonicalSha256 !== payload.manifestCanonicalSha256) {
      throw new Error('Freeze manifest raw/canonical hash mismatch');
    }
    this.verifyGitFreeze(payload);
    this.#transcript.recordFreeze({
      kind: 'manifest-freeze-recorded',
      artifactCanonicalSha256: verified.canonicalSha256,
      artifactRawSha256: verified.rawSha256,
      commitmentArtifactCanonicalSha256: payload.commitmentArtifactCanonicalSha256,
      batchId: payload.batchId,
      revision: payload.revision,
      manifestRawSha256: payload.manifestRawSha256,
      manifestCanonicalSha256: payload.manifestCanonicalSha256,
      freezeCommitSha: payload.gitEvidence.freezeCommitSha,
    });
    return verified.canonicalSha256;
  }

  recordSelectionPolicy(artifactContent: ArtifactContent): string {
    const verified = verifyArtifactContent<SelectionPolicyPayload>(
      artifactContent,
      this.#config.trustRoot,
      validateSelectionPolicyPayload,
    );
    const payload = verified.payload;
    this.#transcript.recordPolicy({
      kind: 'selection-policy-recorded',
      artifactCanonicalSha256: verified.canonicalSha256,
      artifactRawSha256: verified.rawSha256,
      commitmentArtifactCanonicalSha256: payload.commitmentArtifactCanonicalSha256,
      freezeArtifactCanonicalSha256: payload.freezeArtifactCanonicalSha256,
      batchId: payload.batchId,
      revision: payload.revision,
    });
    return verified.canonicalSha256;
  }

  recordSaltReveal(revealContent: ArtifactContent): string {
    const verified = loadReveal(revealContent);
    const reveal = verified.reveal;
    this.#transcript.recordReveal({
      kind: 'salt-reveal-recorded',
      revealCanonicalSha256: verified.canonicalSha256,
      revealRawSha256: verified.rawSha256,
      commitmentArtifactCanonicalSha256: reveal.commitmentArtifactCanonicalSha256,
      freezeArtifactCanonicalSha256: reveal.freezeArtifactCanonicalSha256,
      policyArtifactCanonicalSha256: reveal.policyArtifactCanonicalSha256,
      revealedSaltSha256: sha256(reveal.salt),
    });
    return verified.canonicalSha256;
  }

  async selectAndConsumeSample(input: SampleSelectionInput): Promise<ManifestSampleResult> {
    if (!isRecord(input)) throw new Error('Sample selection input must be an object');
    const unknown = Object.keys(input).filter((key) => ![
      'manifestContent', 'commitmentArtifactContent', 'freezeArtifactContent', 'policyArtifactContent',
      'revealContent',
    ].includes(key));
    if (unknown.length > 0) throw new Error(`Sample selection contains unknown caller controls: ${unknown.join(', ')}`);
    const commitment = verifyArtifactContent<SaltCommitmentPayload>(
      input.commitmentArtifactContent, this.#config.trustRoot, validateCommitmentPayload,
    );
    const freeze = verifyArtifactContent<ManifestFreezePayload>(
      input.freezeArtifactContent, this.#config.trustRoot, validateFreezePayload,
    );
    const policy = verifyArtifactContent<SelectionPolicyPayload>(
      input.policyArtifactContent, this.#config.trustRoot, validateSelectionPolicyPayload,
    );
    const verifiedReveal = loadReveal(input.revealContent);
    const reveal = verifiedReveal.reveal;
    const freezePayload = freeze.payload;
    const policyPayload = policy.payload;
    if (freezePayload.commitmentArtifactCanonicalSha256 !== commitment.canonicalSha256
      || policyPayload.commitmentArtifactCanonicalSha256 !== commitment.canonicalSha256
      || policyPayload.freezeArtifactCanonicalSha256 !== freeze.canonicalSha256
      || reveal.commitmentArtifactCanonicalSha256 !== commitment.canonicalSha256
      || reveal.freezeArtifactCanonicalSha256 !== freeze.canonicalSha256
      || reveal.policyArtifactCanonicalSha256 !== policy.canonicalSha256) {
      throw new Error('Ceremony artifact digest references do not form one authenticated chain');
    }
    if (sha256(reveal.salt) !== commitment.payload.saltCommitment.value) throw new Error('Revealed salt does not match signed commitment');
    const loadedManifest = loadBatchManifest(input.manifestContent);
    const manifest = loadedManifest.manifest;
    if (manifest.batchId !== freezePayload.batchId || manifest.revision !== freezePayload.revision
      || manifest.batchId !== policyPayload.batchId || manifest.revision !== policyPayload.revision) {
      throw new Error('Ceremony batch/revision does not match manifest');
    }
    if (loadedManifest.rawSha256 !== freezePayload.manifestRawSha256
      || loadedManifest.canonicalSha256 !== freezePayload.manifestCanonicalSha256) {
      throw new Error('Frozen manifest raw/canonical hashes do not match actual content');
    }
    this.verifyGitFreeze(freezePayload);

    const seedDigest = sha256(`${loadedManifest.rawSha256}:${reveal.salt}`);
    const random = xorshift32(Number.parseInt(seedDigest.slice(0, 8), 16));
    const shuffled = manifest.entries.map(({ id }) => id).sort();
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    const sampleSize = Math.min(shuffled.length, Math.max(5, Math.ceil(shuffled.length * 0.1)));
    const sampleEntryIds = shuffled.slice(0, sampleSize);
    const uniqueKey = `${policy.canonicalSha256}:${manifest.batchId}:${manifest.revision}`;
    const consumptionEvidence = deepFreeze({
      commitmentArtifactCanonicalSha256: commitment.canonicalSha256,
      commitmentArtifactRawSha256: commitment.rawSha256,
      freezeArtifactCanonicalSha256: freeze.canonicalSha256,
      freezeArtifactRawSha256: freeze.rawSha256,
      policyArtifactCanonicalSha256: policy.canonicalSha256,
      policyArtifactRawSha256: policy.rawSha256,
      revealCanonicalSha256: verifiedReveal.canonicalSha256,
      revealRawSha256: verifiedReveal.rawSha256,
      manifestRawSha256: loadedManifest.rawSha256,
      manifestCanonicalSha256: loadedManifest.canonicalSha256,
      sampleEntryIdsSha256: sha256(canonicaliseJson(sampleEntryIds)),
      sampleSize,
    });
    const evidenceCanonicalSha256 = sha256(canonicaliseJson(consumptionEvidence));
    const registryRecord = deepFreeze({
      uniqueKey,
      policyArtifactCanonicalSha256: policy.canonicalSha256,
      batchId: manifest.batchId,
      revision: manifest.revision,
      evidenceCanonicalSha256,
    });
    const transcriptReferences: SelectionTranscriptReferences = {
      kind: 'salt-reveal-recorded',
      revealCanonicalSha256: verifiedReveal.canonicalSha256,
      revealRawSha256: verifiedReveal.rawSha256,
      commitmentArtifactCanonicalSha256: commitment.canonicalSha256,
      commitmentArtifactRawSha256: commitment.rawSha256,
      freezeArtifactCanonicalSha256: freeze.canonicalSha256,
      freezeArtifactRawSha256: freeze.rawSha256,
      policyArtifactCanonicalSha256: policy.canonicalSha256,
      policyArtifactRawSha256: policy.rawSha256,
      revealedSaltSha256: sha256(reveal.salt),
    };
    this.#transcript.verifySelectionInputs(transcriptReferences);
    const created = await this.#createConsumptionRecord(registryRecord);
    if (typeof created !== 'boolean') throw new Error('Consumption registry must resolve to an atomic boolean');
    if (!created) throw new Error('Selection ceremony already consumed by the monotonic registry');
    const durableSequence = this.#transcript.recordConsumption({
      kind: 'selection-consumed',
      registryUniqueKey: uniqueKey,
      commitmentArtifactRawSha256: commitment.rawSha256,
      freezeArtifactRawSha256: freeze.rawSha256,
      policyArtifactCanonicalSha256: policy.canonicalSha256,
      policyArtifactRawSha256: policy.rawSha256,
      revealRawSha256: verifiedReveal.rawSha256,
      batchId: manifest.batchId,
      revision: manifest.revision,
      evidenceCanonicalSha256,
    }, transcriptReferences);
    return {
      sampleEntryIds,
      manifest: { batchId: manifest.batchId, revision: manifest.revision, entryCount: manifest.entryCount },
      evidence: {
        policyArtifactCanonicalSha256: policy.canonicalSha256,
        policyArtifactRawSha256: policy.rawSha256,
        commitmentArtifactCanonicalSha256: commitment.canonicalSha256,
        commitmentArtifactRawSha256: commitment.rawSha256,
        freezeArtifactCanonicalSha256: freeze.canonicalSha256,
        freezeArtifactRawSha256: freeze.rawSha256,
        revealCanonicalSha256: verifiedReveal.canonicalSha256,
        revealRawSha256: verifiedReveal.rawSha256,
        publicKeyFingerprintSha256: this.#publicKeyFingerprintSha256,
        manifestRawSha256: loadedManifest.rawSha256,
        manifestCanonicalSha256: loadedManifest.canonicalSha256,
        manifestEntryCount: manifest.entryCount,
        seedDigestSha256: seedDigest,
        sampleSize,
        sampleRule: policyPayload.sampleRule,
        freezeCommitSha: freezePayload.gitEvidence.freezeCommitSha,
        verificationCommitSha: this.#config.verificationCommitSha,
        durableSequence,
      },
    };
  }

  scanAuthenticatedLexicalLeakage(input: LexicalScanInput): AuthenticatedLexicalScanResult {
    if (!isRecord(input)) throw new Error('Lexical scan input must be an object');
    const unknown = Object.keys(input).filter((key) => ![
      'heldoutArtifactContent', 'corpusArtifactContent', 'policyArtifactContent',
    ].includes(key));
    if (unknown.length > 0) throw new Error(`Unknown precomputed lexical evidence is not accepted: ${unknown.join(', ')}`);
    const verified = verifyArtifactContent<LexicalLeakagePolicyPayload>(
      input.policyArtifactContent,
      this.#config.trustRoot,
      validateLexicalPolicyPayload,
    );
    const policy = verified.payload;
    const heldout = parseLexicalTextArtifact(input.heldoutArtifactContent, 'heldout');
    const corpus = parseLexicalTextArtifact(input.corpusArtifactContent, 'corpus');
    if (heldout.artifactId !== policy.heldoutArtifactId
      || heldout.rawSha256 !== policy.heldoutArtifactRawSha256
      || heldout.canonicalSha256 !== policy.heldoutArtifactCanonicalSha256
      || corpus.artifactId !== policy.corpusArtifactId
      || corpus.rawSha256 !== policy.corpusArtifactRawSha256
      || corpus.canonicalSha256 !== policy.corpusArtifactCanonicalSha256) {
      throw new Error('Lexical text artifact id/hash does not match the authenticated policy binding');
    }
    const metrics = computeLexicalLeakageMetrics(heldout.records, corpus.records, policy.normalization);
    const hits = applyLexicalPolicy(metrics, policy);
    return {
      metrics,
      hits,
      evidence: {
        policyArtifactCanonicalSha256: verified.canonicalSha256,
        policyArtifactRawSha256: verified.rawSha256,
        publicKeyFingerprintSha256: verified.fingerprint,
        heldoutArtifactId: heldout.artifactId,
        heldoutArtifactRawSha256: heldout.rawSha256,
        heldoutArtifactCanonicalSha256: heldout.canonicalSha256,
        heldoutEntryCount: heldout.records.length,
        corpusArtifactId: corpus.artifactId,
        corpusArtifactRawSha256: corpus.rawSha256,
        corpusArtifactCanonicalSha256: corpus.canonicalSha256,
        corpusEntryCount: corpus.records.length,
        metricAlgorithmVersion: policy.metricAlgorithmVersion,
        metricCount: metrics.length,
      },
    };
  }

  private verifyGitFreeze(payload: ManifestFreezePayload): void {
    if (payload.gitEvidence.repositoryIdentity !== this.#config.repositoryIdentity) throw new Error('Freeze repository identity mismatch');
    const commit = payload.gitEvidence.freezeCommitSha;
    try {
      execFileSync('git', ['-C', this.#config.repositoryRoot, 'cat-file', '-e', `${commit}^{commit}`], { stdio: 'ignore' });
      execFileSync('git', [
        '-C', this.#config.repositoryRoot, 'merge-base', '--is-ancestor', commit, this.#config.verificationCommitSha,
      ], { stdio: 'ignore' });
    } catch (error) {
      throw new Error('Freeze Git commit is missing or is not an ancestor of verification commit', { cause: error });
    }
    let committedManifest: Buffer;
    try {
      committedManifest = execFileSync('git', [
        '-C', this.#config.repositoryRoot, 'show', `${commit}:${payload.gitEvidence.manifestPath}`,
      ]);
    } catch (error) {
      throw new Error('Freeze Git commit does not contain the declared manifest path', { cause: error });
    }
    const committed = loadBatchManifest(committedManifest);
    if (committed.rawSha256 !== payload.manifestRawSha256
      || committed.canonicalSha256 !== payload.manifestCanonicalSha256) {
      throw new Error('Freeze Git blob does not match authenticated raw/canonical manifest hashes');
    }
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
    ...SIGNED_BASE_KEYS, 'policyId', 'metricAlgorithmVersion',
    'heldoutArtifactId', 'heldoutArtifactRawSha256', 'heldoutArtifactCanonicalSha256',
    'corpusArtifactId', 'corpusArtifactRawSha256', 'corpusArtifactCanonicalSha256',
    'normalization', 'allowedN', 'minimumSharedNgrams', 'minimumHeldoutContainment', 'combination',
  ], 'Lexical policy payload');
  validateSignedBase(payload, 'arkova-s33-lexical-leakage-policy');
  nonEmptyString(payload.policyId, 'Lexical policy id');
  if (payload.metricAlgorithmVersion !== 'token-set-ngram-v1') throw new Error('Lexical metric algorithm version is unsupported');
  nonEmptyString(payload.heldoutArtifactId, 'Heldout artifact id');
  assertSha256(payload.heldoutArtifactRawSha256, 'Heldout artifact raw hash');
  assertSha256(payload.heldoutArtifactCanonicalSha256, 'Heldout artifact canonical hash');
  nonEmptyString(payload.corpusArtifactId, 'Corpus artifact id');
  assertSha256(payload.corpusArtifactRawSha256, 'Corpus artifact raw hash');
  assertSha256(payload.corpusArtifactCanonicalSha256, 'Corpus artifact canonical hash');
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
  content: ArtifactContent,
  expectedRole: 'heldout' | 'corpus',
): ParsedLexicalTextArtifact {
  const document = parseStrictJsonDocument(content, `${expectedRole} lexical text artifact`);
  const parsed = document.parsed;
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
  return deepFreeze({
    schemaVersion: 1,
    algorithmVersion: 's33-lexical-text-artifact-v1',
    artifactId,
    role: expectedRole,
    records,
    rawSha256: document.rawSha256,
    canonicalSha256: document.canonicalSha256,
  });
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
  const descriptor = PRODUCTION_ACCEPTANCE_DESCRIPTOR;
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

function loadProductionConsumptionRegistry(): ConsumptionRegistry {
  const registry = PRODUCTION_ACCEPTANCE_DESCRIPTOR.consumptionRegistry;
  if (registry === null) {
    throw new Error('S3.3 production monotonic consumption registry is not configured; production must fail closed');
  }
  return registry;
}

function assertProductionAcceptanceDependenciesConfigured(): void {
  const descriptor = PRODUCTION_ACCEPTANCE_DESCRIPTOR;
  const missing: string[] = [];
  if (!descriptor.signerIdentity || !descriptor.signingKeyId || !descriptor.publicKeyFingerprintSha256) {
    missing.push('CTO trust root');
  }
  if (descriptor.consumptionRegistry === null) missing.push('monotonic consumption registry');
  if (missing.length > 0) {
    throw new Error(`S3.3 production ${missing.join(' and ')} not configured; production must fail closed`);
  }
}

export function createProductionS33AcceptanceOrchestrator(
  input: ProductionOrchestratorInput,
): S33AcceptanceOrchestrator {
  assertProductionAcceptanceDependenciesConfigured();
  return new AcceptanceOrchestrator({
    trustRoot: loadProductionTrustRoot(),
    consumptionRegistry: loadProductionConsumptionRegistry(),
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
