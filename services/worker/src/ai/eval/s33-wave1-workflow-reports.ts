#!/usr/bin/env -S npx tsx
/**
 * Trusted-main producer for Sprint 3.3 Wave-1 machine reports.
 *
 * This CLI never fetches, parses, or vouches for a human review. It emits a
 * deterministic cross-review plan only; Team 2's GitHub trust gate alone
 * authenticates the exact-head review and creates cross-review.json.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from '../prompts/extraction.js';
import { parseStrictJsonDocument } from './s33-batch-acceptance.js';
import { loadLeakageCorpus, type CorpusFile } from './heldout-leakage.js';
import {
  buildTrainingChunkManifest,
  parseS33ProductionExtractionResponse,
} from './s33-wave1-prerequisite-runner.js';
import {
  loadS33Wave1WorkflowReportEntries,
  verifyS33Wave1ProducerHead,
  type S33Wave1ProducerValidationReport,
  type S33Wave1WorkflowReportEntry,
} from './s33-wave1-producer-verifier.js';

const REPORT_FILENAMES = Object.freeze([
  'cross-review-plan.json',
  'prod-model-diff.json',
  'lexical-leakage.json',
  'embedding-diagnostic.json',
] as const);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REQUIRED_N = Object.freeze([6, 7, 8, 9, 10, 11, 12, 13]);
const SAMPLE_ALGORITHM = 'sha256-manifest-entry-rank-v1';
const SAMPLE_RULE = 'ceil(10%),minimum-5,capped-at-entry-count';

type JsonRecord = Record<string, unknown>;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly [${wanted.join(', ')}]`);
  }
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) throw new Error(`${label} must be a lowercase Git SHA`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function parseJsonBytes(bytes: Buffer, label: string): JsonRecord {
  return { ...parseStrictJsonDocument(bytes, label).parsed };
}

function reportEnvelope(
  artifactType: string,
  producer: S33Wave1ProducerValidationReport,
  payload: JsonRecord,
): JsonRecord {
  return {
    schemaVersion: 1,
    batchId: 'S33-W1',
    artifactType,
    producerHeadSha: producer.producerHeadSha,
    manifestRawSha256: producer.manifestRawSha256,
    status: 'PASS',
    payload,
  };
}

export function deterministicSampleIds(
  manifestRawSha256: string,
  entryIds: readonly string[],
): string[] {
  assertSha256(manifestRawSha256, 'Manifest raw SHA-256');
  if (entryIds.length === 0 || new Set(entryIds).size !== entryIds.length) {
    throw new Error('Deterministic review sample requires a non-empty unique entry universe');
  }
  const size = Math.min(entryIds.length, Math.max(5, Math.ceil(entryIds.length * 0.1)));
  return entryIds.map((id) => ({ id, rank: sha256(`${manifestRawSha256}\0${id}`) }))
    .sort((left, right) => left.rank < right.rank
      ? -1
      : left.rank > right.rank ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .slice(0, size)
    .map(({ id }) => id);
}

export function buildCrossReviewPlan(producer: S33Wave1ProducerValidationReport): JsonRecord {
  const entryIds = producer.entries.map(({ id }) => id);
  if (entryIds.length !== 81 || producer.counts.covered !== 72 || producer.counts.ood !== 9) {
    throw new Error('Cross-review plan requires the complete 81=72 covered+9 OOD machine-validated batch');
  }
  const kenyaIds = entryIds.slice(0, 11);
  if (kenyaIds.some((id) => !id.startsWith('GD-S33-KE-'))) {
    throw new Error('Cross-review plan requires the Kenya-first ordered producer universe');
  }
  return reportEnvelope('arkova-s33-wave1-cross-review-plan', producer, {
    producerTreeSha: producer.producerTreeSha,
    manifestCanonicalSha256: producer.manifestCanonicalSha256,
    sampleAlgorithm: SAMPLE_ALGORITHM,
    sampleRule: SAMPLE_RULE,
    manifestEntryCount: 81,
    sampleEntryIds: deterministicSampleIds(producer.manifestRawSha256, entryIds),
    wholeBatchMachineValidation: {
      status: 'PASS',
      covered: 72,
      ood: 9,
      total: 81,
      reportDigestSha256: producer.reportDigestSha256,
    },
    kenyaFirst: { status: 'PASS', entryIds: kenyaIds },
  });
}

function exactEntryUniverse(
  candidates: unknown,
  producer: S33Wave1ProducerValidationReport,
  label: string,
): JsonRecord[] {
  const rows = array(candidates, label).map((candidate, index) => record(candidate, `${label}[${index}]`));
  const actualIds = rows.map((row, index) => string(row.id, `${label}[${index}].id`));
  const expectedIds = producer.entries.map(({ id }) => id);
  if (actualIds.length !== expectedIds.length
    || actualIds.some((id, index) => id !== expectedIds[index])) {
    throw new Error(`${label} must cover the exact ordered 81-entry producer universe`);
  }
  return rows;
}

export function normalizeProdModelDiff(
  rawBytes: Buffer,
  producer: S33Wave1ProducerValidationReport,
  entries: readonly Readonly<S33Wave1WorkflowReportEntry>[],
): JsonRecord {
  const input = parseJsonBytes(rawBytes, 'Production-model-diff raw report');
  exactKeys(input, [
    'schemaVersion', 'mode', 'producerHeadSha', 'producerTreeSha', 'manifestRawSha256',
    'manifestCanonicalSha256', 'entryUniverseSha256', 'providerSurface', 'model',
    'modelConfig', 'modelConfigCanonicalSha256', 'workflowRunId', 'workflowRunAttempt',
    'trustedMainRunSha', 'workflowPath', 'startedAtUtc', 'completedAtUtc',
    'requestCount', 'retryCount', 'results',
  ], 'Production-model-diff raw report');
  if (input.schemaVersion !== 1
    || input.mode !== 'offline-prod-parity-replay'
    || input.producerHeadSha !== producer.producerHeadSha
    || input.producerTreeSha !== producer.producerTreeSha
    || input.manifestRawSha256 !== producer.manifestRawSha256
    || input.manifestCanonicalSha256 !== producer.manifestCanonicalSha256
    || input.entryUniverseSha256 !== sha256(canonicaliseJson(producer.entries.map(({ id }) => id)))
    || input.providerSurface !== 'google-generative-language-developer-api'
    || input.model !== 'gemini-2.5-flash'
    || input.workflowRunAttempt !== 1
    || input.workflowPath !== '.github/workflows/s33-wave1-prerequisites.yml'
    || input.requestCount !== 81
    || input.retryCount !== 0
    || entries.length !== 81) {
    throw new Error('Production-model-diff raw report is not bound to the exact Wave-1 producer');
  }
  assertSha(input.trustedMainRunSha, 'Production-model-diff trusted-main run SHA');
  if (!/^[1-9]\d*$/u.test(string(input.workflowRunId, 'Production-model-diff workflow run id'))) {
    throw new Error('Production-model-diff workflow run id must be a positive decimal id');
  }
  const workflowRunId = Number(input.workflowRunId);
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId < 1) {
    throw new Error('Production-model-diff workflow run id must be a positive safe integer');
  }
  const modelConfig = record(input.modelConfig, 'Production-model-diff modelConfig');
  assertExactProdModelConfig(modelConfig);
  assertSha256(input.modelConfigCanonicalSha256, 'Production-model-diff model-config SHA-256');
  if (input.modelConfigCanonicalSha256 !== sha256(canonicaliseJson(modelConfig))) {
    throw new Error('Production-model-diff model-config digest does not match its canonical bytes');
  }
  assertBoundedPhaseTimes(input.startedAtUtc, input.completedAtUtc, 45 * 60_000, 'Production-model-diff');
  const results = exactEntryUniverse(input.results, producer, 'Production-model-diff results').map((row, index) => {
    exactKeys(row, [
      'id', 'inputSha256', 'requestSha256', 'httpStatus', 'attempt', 'rawModelText', 'usage',
    ], `Production-model-diff results[${index}]`);
    const entry = entries[index];
    if (row.inputSha256 !== sha256(entry.strippedText) || row.httpStatus !== 200 || row.attempt !== 1) {
      throw new Error(`Production-model-diff results[${index}] request facts do not bind the producer row`);
    }
    assertSha256(row.requestSha256, `Production-model-diff results[${index}].requestSha256`);
    const rawModelText = string(row.rawModelText, `Production-model-diff results[${index}].rawModelText`);
    const credentialType = entry.groundTruth.credentialType;
    if (typeof credentialType !== 'string' || credentialType.length === 0) {
      throw new Error(`Production-model-diff producer row ${entry.id} has no credentialType`);
    }
    const requestBody = {
      systemInstruction: { role: 'system', parts: [{ text: EXTRACTION_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: buildExtractionPrompt(entry.strippedText, credentialType, undefined) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 2048 },
    };
    if (row.requestSha256 !== sha256(canonicaliseJson(requestBody))) {
      throw new Error(`Production-model-diff results[${index}].requestSha256 is not the production request`);
    }
    const modelOutput = parseS33ProductionExtractionResponse(rawModelText, entry.strippedText, credentialType);
    const groundTruth = entry.groundTruth as Readonly<Record<string, unknown>>;
    const differingFields = [...new Set([...Object.keys(groundTruth), ...Object.keys(modelOutput)])]
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .flatMap((field) => {
        const expected = groundTruth[field];
        const actual = (modelOutput as Record<string, unknown>)[field];
        if (canonicaliseJson(expected) === canonicaliseJson(actual)) return [];
        const matchType = expected === undefined
          ? 'false_positive'
          : actual === undefined ? 'false_negative' : 'mismatch';
        return [{ field, expected: expected ?? null, actual: actual ?? null, matchType }];
      });
    return {
      id: entry.id,
      modelOutputRawSha256: sha256(rawModelText),
      modelOutputCanonicalSha256: sha256(canonicaliseJson(modelOutput)),
      groundTruthCanonicalSha256: sha256(canonicaliseJson(groundTruth)),
      classification: differingFields.length === 0 ? 'MATCH' : 'MISMATCH',
      differingFields,
    };
  });
  return reportEnvelope('arkova-s33-wave1-prod-model-diff', producer, {
    mode: 'offline-prod-parity-replay',
    producerTreeSha: producer.producerTreeSha,
    manifestCanonicalSha256: producer.manifestCanonicalSha256,
    entryUniverseSha256: input.entryUniverseSha256,
    providerSurface: input.providerSurface,
    model: input.model,
    modelConfig,
    modelConfigCanonicalSha256: input.modelConfigCanonicalSha256,
    workflowRunId,
    workflowRunAttempt: input.workflowRunAttempt,
    trustedMainRunSha: input.trustedMainRunSha,
    workflowPath: input.workflowPath,
    startedAtUtc: input.startedAtUtc,
    completedAtUtc: input.completedAtUtc,
    requestCount: 81,
    retryCount: 0,
    entryCount: 81,
    results,
    rawReportSha256: sha256(rawBytes),
    rawReportCanonicalSha256: sha256(canonicaliseJson(input)),
  });
}

function tokens(value: string): string[] {
  const normalized = value.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return normalized.length === 0 ? [] : normalized.split(/\s+/u);
}

function ngramDigests(value: string, n: number): Set<string> {
  const words = tokens(value);
  const digests = new Set<string>();
  for (let index = 0; index + n <= words.length; index += 1) {
    digests.add(sha256(words.slice(index, index + n).join(' ')));
  }
  return digests;
}

export function buildLexicalLeakageReport(
  entries: readonly Readonly<S33Wave1WorkflowReportEntry>[],
  corpus: readonly CorpusFile[],
  producer: S33Wave1ProducerValidationReport,
): JsonRecord {
  if (corpus.length === 0) throw new Error('Merged training leakage corpus is empty; refusing an unscanned PASS');
  const trainingManifest = corpus.map(({ path, content }) => ({ path, rawSha256: sha256(content) }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const corpusNgrams = new Map<number, Set<string>>();
  for (const n of REQUIRED_N) {
    const set = new Set<string>();
    for (const file of corpus) for (const digest of ngramDigests(file.content, n)) set.add(digest);
    corpusNgrams.set(n, set);
  }
  const hits: Array<{ entryId: string; n: number; ngramSha256: string }> = [];
  for (const entry of entries) {
    for (const n of REQUIRED_N) {
      for (const digest of ngramDigests(entry.strippedText, n)) {
        if (corpusNgrams.get(n)!.has(digest)) hits.push({ entryId: entry.id, n, ngramSha256: digest });
      }
    }
  }
  if (hits.length > 0) throw new Error(`Exact normalized n-gram leakage detected (${hits.length} hit(s))`);
  return reportEnvelope('arkova-s33-wave1-lexical-leakage', producer, {
    algorithm: 'normalized-token-exact-ngram-v1',
    normalization: 'NFKC;lowercase;non-alphanumeric-space;whitespace-collapse',
    n: [...REQUIRED_N],
    producerTreeSha: producer.producerTreeSha,
    manifestCanonicalSha256: producer.manifestCanonicalSha256,
    entryCount: entries.length,
    trainingCorpusFileCount: corpus.length,
    trainingManifestSha256: sha256(canonicaliseJson(trainingManifest)),
    exactMatchCount: 0,
    hits: [],
  });
}

export function normalizeEmbeddingDiagnostic(
  rawBytes: Buffer,
  producer: S33Wave1ProducerValidationReport,
  entries: readonly Readonly<S33Wave1WorkflowReportEntry>[],
  corpus: readonly CorpusFile[],
): JsonRecord {
  const input = parseJsonBytes(rawBytes, 'Embedding diagnostic raw report');
  exactKeys(input, [
    'schemaVersion', 'role', 'canOverrideExactScan', 'producerHeadSha', 'producerTreeSha',
    'manifestRawSha256', 'manifestCanonicalSha256', 'entryUniverseSha256', 'providerSurface',
    'model', 'modelConfig', 'modelConfigCanonicalSha256', 'workflowRunId', 'workflowRunAttempt',
    'trustedMainRunSha', 'workflowPath', 'startedAtUtc', 'completedAtUtc',
    'heldoutRecordCount', 'trainingFileCount', 'trainingChunkCount', 'vectorInputCount',
    'requestCount', 'retryCount', 'lexicalTrainingManifestSha256',
    'trainingChunkManifestCanonicalSha256', 'trainingManifest', 'requests', 'vectors',
  ], 'Embedding diagnostic raw report');
  if (input.schemaVersion !== 1
    || input.role !== 'diagnostic-only'
    || input.canOverrideExactScan !== false
    || input.producerHeadSha !== producer.producerHeadSha
    || input.producerTreeSha !== producer.producerTreeSha
    || input.manifestRawSha256 !== producer.manifestRawSha256
    || input.manifestCanonicalSha256 !== producer.manifestCanonicalSha256
    || input.entryUniverseSha256 !== sha256(canonicaliseJson(producer.entries.map(({ id }) => id)))
    || input.providerSurface !== 'google-generative-language-developer-api'
    || input.model !== 'gemini-embedding-001'
    || input.workflowRunAttempt !== 1
    || input.workflowPath !== '.github/workflows/s33-wave1-prerequisites.yml'
    || input.heldoutRecordCount !== 81
    || input.retryCount !== 0
    || entries.length !== 81) {
    throw new Error('Embedding diagnostic raw report is not bound to the exact Wave-1 producer');
  }
  assertSha(input.trustedMainRunSha, 'Embedding trusted-main run SHA');
  if (!/^[1-9]\d*$/u.test(string(input.workflowRunId, 'Embedding workflow run id'))) {
    throw new Error('Embedding workflow run id must be a positive decimal id');
  }
  const workflowRunId = Number(input.workflowRunId);
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId < 1) {
    throw new Error('Embedding workflow run id must be a positive safe integer');
  }
  assertBoundedPhaseTimes(input.startedAtUtc, input.completedAtUtc, 60 * 60_000, 'Embedding diagnostic');
  const modelConfig = record(input.modelConfig, 'Embedding modelConfig');
  assertExactEmbeddingModelConfig(modelConfig);
  assertSha256(input.modelConfigCanonicalSha256, 'Embedding model-config SHA-256');
  if (input.modelConfigCanonicalSha256 !== sha256(canonicaliseJson(modelConfig))) {
    throw new Error('Embedding model-config digest does not match its canonical bytes');
  }
  const training = buildTrainingChunkManifest(corpus);
  if (input.trainingFileCount !== corpus.length
    || input.trainingChunkCount !== training.chunks.length
    || input.vectorInputCount !== 81 + training.chunks.length
    || input.requestCount !== Math.ceil((81 + training.chunks.length) / 16)
    || input.lexicalTrainingManifestSha256 !== training.lexicalTrainingManifestSha256
    || input.trainingChunkManifestCanonicalSha256 !== training.manifestCanonicalSha256
    || canonicaliseJson(input.trainingManifest) !== canonicaliseJson(training.manifest)) {
    throw new Error('Embedding training manifest/counts do not match the trusted merged leakage corpus');
  }
  const requests = array(input.requests, 'Embedding requests').map((candidate, index) => {
    const row = record(candidate, `Embedding requests[${index}]`);
    exactKeys(row, ['requestOrdinal', 'inputCount', 'httpStatus', 'attempt', 'requestSha256'], `Embedding requests[${index}]`);
    if (row.requestOrdinal !== index || row.httpStatus !== 200 || row.attempt !== 1
      || !Number.isSafeInteger(row.inputCount) || (row.inputCount as number) < 1 || (row.inputCount as number) > 16) {
      throw new Error(`Embedding requests[${index}] violates the bounded batch contract`);
    }
    assertSha256(row.requestSha256, `Embedding requests[${index}].requestSha256`);
    return row;
  });
  if (requests.length !== input.requestCount) throw new Error('Embedding request records are incomplete');
  const vectors = array(input.vectors, 'Embedding vectors').map((candidate, index) => {
    const row = record(candidate, `Embedding vectors[${index}]`);
    const vector = array(row.vector, `Embedding vectors[${index}].vector`);
    if (vector.length !== 3072 || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`Embedding vectors[${index}] must contain exactly 3072 finite values`);
    }
    return { row, vector: vector as number[] };
  });
  if (vectors.length !== input.vectorInputCount) throw new Error('Embedding vector universe is incomplete');
  const heldout = vectors.slice(0, 81);
  heldout.forEach(({ row }, index) => {
    exactKeys(row, ['kind', 'id', 'inputSha256', 'vector'], `Embedding heldout vectors[${index}]`);
    if (row.kind !== 'heldout' || row.id !== entries[index].id || row.inputSha256 !== sha256(entries[index].strippedText)) {
      throw new Error(`Embedding heldout vectors[${index}] does not bind the ordered producer row`);
    }
  });
  const trainingVectors = vectors.slice(81);
  if (trainingVectors.length === 0) throw new Error('Embedding diagnostic requires at least one nonempty training chunk');
  trainingVectors.forEach(({ row }, index) => {
    exactKeys(row, [
      'kind', 'path', 'fileRawSha256', 'chunkOrdinal', 'tokenStart', 'tokenEnd', 'chunkSha256', 'vector',
    ], `Embedding training vectors[${index}]`);
    const expected = training.chunks[index];
    if (row.kind !== 'training' || row.path !== expected.path || row.fileRawSha256 !== expected.fileRawSha256
      || row.chunkOrdinal !== expected.chunkOrdinal || row.tokenStart !== expected.tokenStart
      || row.tokenEnd !== expected.tokenEnd || row.chunkSha256 !== expected.chunkSha256) {
      throw new Error(`Embedding training vectors[${index}] does not bind the deterministic chunk manifest`);
    }
  });
  const embeddingInputs = [
    ...entries.map(({ strippedText }) => strippedText),
    ...training.chunks.map(({ text }) => text),
  ];
  requests.forEach((request, index) => {
    const batch = embeddingInputs.slice(index * 16, (index + 1) * 16);
    const body = {
      requests: batch.map((text) => ({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
        taskType: 'SEMANTIC_SIMILARITY',
        outputDimensionality: 3072,
      })),
    };
    if (request.inputCount !== batch.length
      || request.requestSha256 !== sha256(canonicaliseJson(body))) {
      throw new Error(`Embedding requests[${index}] is not the deterministic pinned batch request`);
    }
  });
  const results = heldout.map(({ row, vector }) => {
    let nearestIndex = 0;
    let nearest = cosine(vector, trainingVectors[0].vector);
    for (let candidate = 1; candidate < trainingVectors.length; candidate += 1) {
      const similarity = cosine(vector, trainingVectors[candidate].vector);
      if (similarity > nearest) {
        nearest = similarity;
        nearestIndex = candidate;
      }
    }
    return {
      id: row.id,
      nearestTrainingDocumentSha256: training.chunks[nearestIndex].fileRawSha256,
      nearestTrainingChunkSha256: training.chunks[nearestIndex].chunkSha256,
      cosineSimilarity: nearest,
    };
  });
  return reportEnvelope('arkova-s33-wave1-embedding-diagnostic', producer, {
    role: 'diagnostic-only',
    canOverrideExactScan: false,
    producerTreeSha: producer.producerTreeSha,
    manifestCanonicalSha256: producer.manifestCanonicalSha256,
    entryUniverseSha256: input.entryUniverseSha256,
    providerSurface: input.providerSurface,
    model: input.model,
    modelConfig,
    modelConfigCanonicalSha256: input.modelConfigCanonicalSha256,
    workflowRunId,
    workflowRunAttempt: input.workflowRunAttempt,
    trustedMainRunSha: input.trustedMainRunSha,
    workflowPath: input.workflowPath,
    startedAtUtc: input.startedAtUtc,
    completedAtUtc: input.completedAtUtc,
    heldoutRecordCount: 81,
    trainingFileCount: input.trainingFileCount,
    trainingChunkCount: input.trainingChunkCount,
    vectorInputCount: input.vectorInputCount,
    requestCount: input.requestCount,
    retryCount: 0,
    lexicalTrainingManifestSha256: input.lexicalTrainingManifestSha256,
    trainingChunkManifestCanonicalSha256: input.trainingChunkManifestCanonicalSha256,
    entryCount: 81,
    results,
    rawReportSha256: sha256(rawBytes),
    rawReportCanonicalSha256: sha256(canonicaliseJson(input)),
  });
}

function assertExactEmbeddingModelConfig(modelConfig: JsonRecord): void {
  exactKeys(modelConfig, [
    'taskType', 'outputDimensionality', 'batchSize', 'timeoutMs', 'concurrency', 'retryCount',
    'chunkTokens', 'chunkOverlapTokens', 'maxTrainingChunks', 'maxVectorInputs', 'maxHttpRequests',
  ], 'Embedding modelConfig');
  if (modelConfig.taskType !== 'SEMANTIC_SIMILARITY' || modelConfig.outputDimensionality !== 3072
    || modelConfig.batchSize !== 16 || modelConfig.timeoutMs !== 30_000
    || modelConfig.concurrency !== 1 || modelConfig.retryCount !== 0
    || modelConfig.chunkTokens !== 1500 || modelConfig.chunkOverlapTokens !== 128
    || modelConfig.maxTrainingChunks !== 2048 || modelConfig.maxVectorInputs !== 2129
    || modelConfig.maxHttpRequests !== 134) {
    throw new Error('Embedding modelConfig is not the CTO-pinned diagnostic configuration');
  }
}

function assertExactProdModelConfig(modelConfig: JsonRecord): void {
  exactKeys(modelConfig, [
    'promptModule', 'promptModuleRawSha256', 'systemPromptExport', 'systemPromptSha256',
    'promptBuilder', 'promptBuilderProbeSha256', 'generationConfig', 'absentFlags',
    'timeoutMs', 'concurrency', 'maxRequests', 'maxEntryCharacters',
    'maxAggregateInputCharacters',
  ], 'Production-model-diff modelConfig');
  const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const generationConfig = record(modelConfig.generationConfig, 'Production-model-diff generationConfig');
  exactKeys(generationConfig, ['responseMimeType', 'temperature', 'maxOutputTokens'], 'Production-model-diff generationConfig');
  if (modelConfig.promptModule !== 'services/worker/src/ai/prompts/extraction.ts'
    || modelConfig.promptModuleRawSha256 !== sha256(readFileSync(join(workerRoot, 'src/ai/prompts/extraction.ts')))
    || modelConfig.systemPromptExport !== 'EXTRACTION_SYSTEM_PROMPT'
    || modelConfig.systemPromptSha256 !== sha256(EXTRACTION_SYSTEM_PROMPT)
    || modelConfig.promptBuilder !== 'buildExtractionPrompt'
    || modelConfig.promptBuilderProbeSha256 !== sha256(buildExtractionPrompt('__S33_PIN__', 'OTHER', undefined))
    || generationConfig.responseMimeType !== 'application/json'
    || generationConfig.temperature !== 0.1
    || generationConfig.maxOutputTokens !== 2048
    || canonicaliseJson(modelConfig.absentFlags) !== canonicaliseJson([
      'GEMINI_TUNED_MODEL', 'GEMINI_V6_PROMPT', 'GEMINI_TUNED_RESPONSE_SCHEMA',
    ])
    || modelConfig.timeoutMs !== 30_000 || modelConfig.concurrency !== 1
    || modelConfig.maxRequests !== 81 || modelConfig.maxEntryCharacters !== 50_000
    || modelConfig.maxAggregateInputCharacters !== 4_050_000) {
    throw new Error('Production-model-diff modelConfig is not the CTO-pinned prod-parity configuration');
  }
}

function assertBoundedPhaseTimes(startValue: unknown, endValue: unknown, maximumMs: number, label: string): void {
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
  const start = string(startValue, `${label} startedAtUtc`);
  const end = string(endValue, `${label} completedAtUtc`);
  if (!pattern.test(start) || !pattern.test(end)) throw new Error(`${label} timestamps must be ISO-8601 UTC`);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs || endMs - startMs > maximumMs) {
    throw new Error(`${label} timestamps violate the bounded phase duration`);
  }
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) throw new Error('Embedding vector has zero magnitude');
  return Math.max(-1, Math.min(1, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))));
}

function optionalEnvironmentPath(name: string): string | undefined {
  const value = process.env[name];
  return value ? resolve(value) : undefined;
}

function outputDirectory(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--output-dir' || args[1].trim().length === 0) {
    throw new Error('Expected exactly --output-dir <dir>');
  }
  return resolve(args[1]);
}

function writeReport(outputDir: string, filename: (typeof REPORT_FILENAMES)[number], value: JsonRecord): void {
  writeFileSync(resolve(outputDir, filename), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function writeReportBytes(outputDir: string, filename: (typeof REPORT_FILENAMES)[number], value: Buffer): void {
  writeFileSync(resolve(outputDir, filename), value, { flag: 'wx' });
}

export function generateWorkflowReports(input: Readonly<{
  embeddingDiagnosticRawPath: string;
  outputDir: string;
  prodModelDiffRawPath: string;
  producerHeadSha: string;
  repositoryRoot: string;
}>): void {
  assertSha(input.producerHeadSha, 'S33_PRODUCER_HEAD_SHA');
  const producer = verifyS33Wave1ProducerHead({
    repositoryRoot: input.repositoryRoot,
    producerHeadSha: input.producerHeadSha,
  });
  const entries = loadS33Wave1WorkflowReportEntries({
    repositoryRoot: input.repositoryRoot,
    producerHeadSha: input.producerHeadSha,
  });
  const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const corpus = loadLeakageCorpus(workerRoot, { failOnUnreadable: true });
  const reports = {
    'cross-review-plan.json': buildCrossReviewPlan(producer),
    'prod-model-diff.json': normalizeProdModelDiff(readFileSync(input.prodModelDiffRawPath), producer, entries),
    'lexical-leakage.json': buildLexicalLeakageReport(entries, corpus, producer),
    'embedding-diagnostic.json': normalizeEmbeddingDiagnostic(
      readFileSync(input.embeddingDiagnosticRawPath),
      producer,
      entries,
      corpus,
    ),
  } satisfies Record<(typeof REPORT_FILENAMES)[number], JsonRecord>;
  mkdirSync(input.outputDir, { recursive: true });
  for (const filename of REPORT_FILENAMES) writeReport(input.outputDir, filename, reports[filename]);
}

export function generateAcceptanceWorkflowReports(input: Readonly<{
  embeddingDiagnosticFinalPath: string;
  outputDir: string;
  prodModelDiffFinalPath: string;
  producerHeadSha: string;
  repositoryRoot: string;
}>): void {
  assertSha(input.producerHeadSha, 'S33_PRODUCER_HEAD_SHA');
  const producer = verifyS33Wave1ProducerHead({
    repositoryRoot: input.repositoryRoot,
    producerHeadSha: input.producerHeadSha,
  });
  const entries = loadS33Wave1WorkflowReportEntries({
    repositoryRoot: input.repositoryRoot,
    producerHeadSha: input.producerHeadSha,
  });
  const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const corpus = loadLeakageCorpus(workerRoot, { failOnUnreadable: true });
  const prodBytes = readFileSync(input.prodModelDiffFinalPath);
  const embeddingBytes = readFileSync(input.embeddingDiagnosticFinalPath);
  const lexicalReport = buildLexicalLeakageReport(entries, corpus, producer);
  const lexicalPayload = record(lexicalReport.payload, 'Acceptance lexical payload');
  validateFinalReportBytes(
    prodBytes,
    'arkova-s33-wave1-prod-model-diff',
    producer,
    entries,
  );
  validateFinalReportBytes(
    embeddingBytes,
    'arkova-s33-wave1-embedding-diagnostic',
    producer,
    entries,
    lexicalPayload.trainingManifestSha256 as string,
  );
  mkdirSync(input.outputDir, { recursive: true });
  writeReport(input.outputDir, 'cross-review-plan.json', buildCrossReviewPlan(producer));
  writeReport(input.outputDir, 'lexical-leakage.json', lexicalReport);
  writeReportBytes(input.outputDir, 'prod-model-diff.json', prodBytes);
  writeReportBytes(input.outputDir, 'embedding-diagnostic.json', embeddingBytes);
}

function validateFinalReportBytes(
  bytes: Buffer,
  artifactType: 'arkova-s33-wave1-prod-model-diff' | 'arkova-s33-wave1-embedding-diagnostic',
  producer: S33Wave1ProducerValidationReport,
  entries: readonly Readonly<S33Wave1WorkflowReportEntry>[],
  lexicalTrainingManifestSha256?: string,
): void {
  const report = parseJsonBytes(bytes, artifactType);
  exactKeys(report, [
    'schemaVersion', 'batchId', 'artifactType', 'producerHeadSha', 'manifestRawSha256', 'status', 'payload',
  ], artifactType);
  if (report.schemaVersion !== 1 || report.batchId !== 'S33-W1' || report.artifactType !== artifactType
    || report.producerHeadSha !== producer.producerHeadSha
    || report.manifestRawSha256 !== producer.manifestRawSha256 || report.status !== 'PASS') {
    throw new Error(`${artifactType} final envelope is not bound to the verified producer`);
  }
  const payload = record(report.payload, `${artifactType} payload`);
  if (payload.producerTreeSha !== producer.producerTreeSha
    || payload.manifestCanonicalSha256 !== producer.manifestCanonicalSha256
    || payload.entryUniverseSha256 !== sha256(canonicaliseJson(entries.map(({ id }) => id)))
    || payload.entryCount !== 81) {
    throw new Error(`${artifactType} final payload is not bound to the exact producer universe`);
  }
  if (!Number.isSafeInteger(payload.workflowRunId) || (payload.workflowRunId as number) < 1
    || payload.workflowRunAttempt !== 1
    || payload.workflowPath !== '.github/workflows/s33-wave1-prerequisites.yml') {
    throw new Error(`${artifactType} final payload has an invalid prerequisite workflow binding`);
  }
  assertSha(payload.trustedMainRunSha, `${artifactType} trusted-main run SHA`);
  if (artifactType === 'arkova-s33-wave1-prod-model-diff') {
    exactKeys(payload, [
      'mode', 'producerTreeSha', 'manifestCanonicalSha256', 'entryUniverseSha256',
      'providerSurface', 'model', 'modelConfig', 'modelConfigCanonicalSha256',
      'workflowRunId', 'workflowRunAttempt', 'trustedMainRunSha', 'workflowPath',
      'startedAtUtc', 'completedAtUtc', 'requestCount', 'retryCount', 'entryCount',
      'results', 'rawReportSha256', 'rawReportCanonicalSha256',
    ], 'Final prod-model-diff payload');
    if (payload.mode !== 'offline-prod-parity-replay'
      || payload.providerSurface !== 'google-generative-language-developer-api'
      || payload.model !== 'gemini-2.5-flash'
      || payload.requestCount !== 81 || payload.retryCount !== 0) {
      throw new Error('Final prod-model-diff violates the no-retry replay contract');
    }
    assertExactProdModelConfig(record(payload.modelConfig, 'Final prod-model-diff modelConfig'));
    assertSha256(payload.modelConfigCanonicalSha256, 'Final prod-model-diff model-config SHA-256');
    if (payload.modelConfigCanonicalSha256 !== sha256(canonicaliseJson(payload.modelConfig))) {
      throw new Error('Final prod-model-diff model-config digest mismatch');
    }
    assertBoundedPhaseTimes(payload.startedAtUtc, payload.completedAtUtc, 45 * 60_000, 'Final prod-model-diff');
    assertSha256(payload.rawReportSha256, 'Final prod-model-diff raw-report SHA-256');
    assertSha256(payload.rawReportCanonicalSha256, 'Final prod-model-diff canonical raw-report SHA-256');
    exactEntryUniverse(payload.results, producer, 'Final prod-model-diff results').forEach((row, index) => {
      exactKeys(row, [
        'id', 'modelOutputRawSha256', 'modelOutputCanonicalSha256',
        'groundTruthCanonicalSha256', 'classification', 'differingFields',
      ], `Final prod-model-diff results[${index}]`);
      if (!['MATCH', 'MISMATCH'].includes(String(row.classification)) || !Array.isArray(row.differingFields)) {
        throw new Error(`Final prod-model-diff results[${index}] has invalid machine classification`);
      }
      assertSha256(row.modelOutputRawSha256, `Final prod-model-diff results[${index}] raw output SHA-256`);
      assertSha256(row.modelOutputCanonicalSha256, `Final prod-model-diff results[${index}] canonical output SHA-256`);
      assertSha256(row.groundTruthCanonicalSha256, `Final prod-model-diff results[${index}] ground-truth SHA-256`);
      if ((row.classification === 'MATCH') !== (row.differingFields.length === 0)) {
        throw new Error(`Final prod-model-diff results[${index}] classification/diff conflict`);
      }
      row.differingFields.forEach((candidate, fieldIndex) => {
        const field = record(candidate, `Final prod-model-diff results[${index}].differingFields[${fieldIndex}]`);
        exactKeys(field, ['field', 'expected', 'actual', 'matchType'], 'Final prod-model-diff differing field');
        string(field.field, 'Final prod-model-diff differing field name');
        if (!['false_positive', 'false_negative', 'mismatch'].includes(String(field.matchType))) {
          throw new Error('Final prod-model-diff differing field has invalid matchType');
        }
      });
    });
  } else {
    exactKeys(payload, [
      'role', 'canOverrideExactScan', 'producerTreeSha', 'manifestCanonicalSha256',
      'entryUniverseSha256', 'providerSurface', 'model', 'modelConfig',
      'modelConfigCanonicalSha256', 'workflowRunId', 'workflowRunAttempt',
      'trustedMainRunSha', 'workflowPath', 'startedAtUtc', 'completedAtUtc',
      'heldoutRecordCount', 'trainingFileCount', 'trainingChunkCount', 'vectorInputCount',
      'requestCount', 'retryCount', 'lexicalTrainingManifestSha256',
      'trainingChunkManifestCanonicalSha256', 'entryCount', 'results',
      'rawReportSha256', 'rawReportCanonicalSha256',
    ], 'Final embedding payload');
    if (payload.role !== 'diagnostic-only' || payload.canOverrideExactScan !== false
      || payload.providerSurface !== 'google-generative-language-developer-api'
      || payload.model !== 'gemini-embedding-001'
      || payload.heldoutRecordCount !== 81
      || !Number.isSafeInteger(payload.trainingFileCount) || (payload.trainingFileCount as number) < 1
      || !Number.isSafeInteger(payload.trainingChunkCount) || (payload.trainingChunkCount as number) < 1
      || payload.vectorInputCount !== 81 + (payload.trainingChunkCount as number)
      || payload.requestCount !== Math.ceil((payload.vectorInputCount as number) / 16)
      || payload.retryCount !== 0
      || payload.lexicalTrainingManifestSha256 !== lexicalTrainingManifestSha256) {
      throw new Error('Final embedding report violates the diagnostic-only contract');
    }
    assertExactEmbeddingModelConfig(record(payload.modelConfig, 'Final embedding modelConfig'));
    assertSha256(payload.modelConfigCanonicalSha256, 'Final embedding model-config SHA-256');
    if (payload.modelConfigCanonicalSha256 !== sha256(canonicaliseJson(payload.modelConfig))) {
      throw new Error('Final embedding model-config digest mismatch');
    }
    assertBoundedPhaseTimes(payload.startedAtUtc, payload.completedAtUtc, 60 * 60_000, 'Final embedding');
    assertSha256(payload.rawReportSha256, 'Final embedding raw-report SHA-256');
    assertSha256(payload.rawReportCanonicalSha256, 'Final embedding canonical raw-report SHA-256');
    exactEntryUniverse(payload.results, producer, 'Final embedding results').forEach((row, index) => {
      exactKeys(row, [
        'id', 'nearestTrainingDocumentSha256', 'nearestTrainingChunkSha256', 'cosineSimilarity',
      ], `Final embedding results[${index}]`);
      assertSha256(row.nearestTrainingDocumentSha256, `Final embedding results[${index}] document SHA-256`);
      assertSha256(row.nearestTrainingChunkSha256, `Final embedding results[${index}] chunk SHA-256`);
      if (typeof row.cosineSimilarity !== 'number' || !Number.isFinite(row.cosineSimilarity)
        || row.cosineSimilarity < -1 || row.cosineSimilarity > 1) {
        throw new Error(`Final embedding results[${index}] cosineSimilarity is invalid`);
      }
    });
  }
}

function main(): void {
  const repositoryRoot = process.env.S33_REPOSITORY_ROOT
    ? resolve(process.env.S33_REPOSITORY_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const outputDir = outputDirectory(process.argv.slice(2));
  const producerHeadSha = string(process.env.S33_PRODUCER_HEAD_SHA, 'S33_PRODUCER_HEAD_SHA');
  const rawProd = optionalEnvironmentPath('S33_PROD_MODEL_DIFF_RAW_PATH');
  const rawEmbedding = optionalEnvironmentPath('S33_EMBEDDING_DIAGNOSTIC_RAW_PATH');
  const finalProd = optionalEnvironmentPath('S33_PROD_MODEL_DIFF_FINAL_PATH');
  const finalEmbedding = optionalEnvironmentPath('S33_EMBEDDING_DIAGNOSTIC_FINAL_PATH');
  if (rawProd && rawEmbedding && !finalProd && !finalEmbedding) {
    generateWorkflowReports({
      embeddingDiagnosticRawPath: rawEmbedding,
      outputDir,
      prodModelDiffRawPath: rawProd,
      producerHeadSha,
      repositoryRoot,
    });
    return;
  }
  if (finalProd && finalEmbedding && !rawProd && !rawEmbedding) {
    generateAcceptanceWorkflowReports({
      embeddingDiagnosticFinalPath: finalEmbedding,
      outputDir,
      prodModelDiffFinalPath: finalProd,
      producerHeadSha,
      repositoryRoot,
    });
    return;
  }
  throw new Error('Set exactly one complete RAW or FINAL prerequisite report path pair');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
