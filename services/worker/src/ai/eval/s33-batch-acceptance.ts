/**
 * Sprint 3.3 Lane-4 → Lane-3 batch-acceptance primitives.
 *
 * These functions deliberately separate measurable leakage evidence from the
 * policy that turns evidence into a reject verdict. The acceptance protocol
 * names lexical n=6..13 and embedding near-duplicate scans, but the binding
 * model/version and cutoffs are CTO inputs. There are therefore no threshold
 * defaults in this module: callers must supply the signed policy explicitly.
 */

import { createHash } from 'node:crypto';

export interface TextRecord {
  id: string;
  text: string;
}

export interface SampleOptions {
  ratio?: number;
  minimum?: number;
}

export interface ManifestSamplePolicy {
  manifestHash: string;
  hashRepresentation: 'raw-file-sha256' | 'canonical-json-sha256';
  prng: 'xorshift32-v1';
  unpredictability:
    | { mode: 'predictable-signed' }
    | {
      mode: 'lane3-salt-commit-reveal-v1';
      saltCommitment: string;
      revealedSalt: string;
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

/**
 * Deterministically select the Lane-3 cross-review sample under an explicit
 * signed hash/PRNG/unpredictability policy. Entry ids are sorted before
 * shuffling so producer file order cannot influence the sample.
 */
export function selectManifestSeededSample(
  entryIds: readonly string[],
  policy: ManifestSamplePolicy,
  options: SampleOptions = {},
): string[] {
  assertUniqueNonEmptyIds(entryIds, 'Batch');
  const ratio = options.ratio ?? 0.1;
  const minimum = options.minimum ?? 5;
  if (!(ratio > 0 && ratio <= 1)) throw new Error('Sample ratio must be in (0, 1]');
  if (!Number.isInteger(minimum) || minimum < 1) throw new Error('Sample minimum must be a positive integer');

  if (!policy
    || !/^[0-9a-f]{64}$/.test(policy.manifestHash)
    || !['raw-file-sha256', 'canonical-json-sha256'].includes(policy.hashRepresentation)
    || policy.prng !== 'xorshift32-v1'
    || !policy.unpredictability
    || !['predictable-signed', 'lane3-salt-commit-reveal-v1'].includes(policy.unpredictability.mode)
    || (policy.unpredictability.mode === 'lane3-salt-commit-reveal-v1'
      && (!/^[0-9a-f]{64}$/.test(policy.unpredictability.saltCommitment)
        || !/^[0-9a-f]{64,}$/.test(policy.unpredictability.revealedSalt)))) {
    throw new Error('Invalid sampling policy; signed hash representation, PRNG, and unpredictability rule required');
  }

  if (policy.unpredictability.mode === 'lane3-salt-commit-reveal-v1') {
    const actualCommitment = createHash('sha256')
      .update(policy.unpredictability.revealedSalt, 'utf8')
      .digest('hex');
    if (actualCommitment !== policy.unpredictability.saltCommitment) {
      throw new Error('Revealed Lane-3 sampling salt does not match its signed commitment');
    }
  }

  const seedDigest = policy.unpredictability.mode === 'predictable-signed'
    ? policy.manifestHash
    : createHash('sha256')
      .update(`${policy.manifestHash}:${policy.unpredictability.revealedSalt}`, 'utf8')
      .digest('hex');
  const random = xorshift32(Number.parseInt(seedDigest.slice(0, 8), 16));
  const shuffled = [...entryIds].sort();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  const sampleSize = Math.min(shuffled.length, Math.max(minimum, Math.ceil(shuffled.length * ratio)));
  return shuffled.slice(0, sampleSize);
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

function validateLexicalNormalizationPolicy(policy: LexicalNormalizationPolicy | undefined): void {
  if (!policy
    || !['none', 'NFC', 'NFKC'].includes(policy.unicodeForm)
    || !['preserve', 'lowercase'].includes(policy.caseFold)
    || !['preserve', 'space'].includes(policy.nonAlphanumeric)
    || !['preserve', 'collapse'].includes(policy.whitespace)) {
    throw new Error('Invalid lexical normalization policy; a signed explicit policy is required');
  }
}

/** Apply only the explicitly supplied, signed normalization policy. */
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
  if (policy.allowedN.length === 0
    || policy.allowedN.some((n) => !Number.isInteger(n) || n < 1)
    || new Set(policy.allowedN).size !== policy.allowedN.length
    || !Number.isInteger(policy.minimumSharedNgrams)
    || policy.minimumSharedNgrams < 1
    || !(policy.minimumHeldoutContainment > 0 && policy.minimumHeldoutContainment <= 1)
    || (policy.combination !== 'all' && policy.combination !== 'any')) {
    throw new Error('Invalid lexical leakage policy; a signed explicit policy is required');
  }
}

/** Apply an explicit signed policy to previously emitted lexical metrics. */
export function applyLexicalLeakagePolicy(
  metrics: readonly LexicalLeakageMetric[],
  policy: LexicalLeakagePolicy,
): LexicalLeakageMetric[] {
  validateLexicalPolicy(policy);
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
  }
  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
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
