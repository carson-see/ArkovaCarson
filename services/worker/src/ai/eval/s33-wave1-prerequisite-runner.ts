#!/usr/bin/env -S npx tsx
/** Trusted-main, no-retry prerequisite network runner for S3.3 Wave 1. */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import { runCrossFieldChecks, validateFieldsForType } from '../crossFieldFraudChecks.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from '../prompts/extraction.js';
import { ExtractedFieldsSchema } from '../schemas.js';
import { stripJsonComments } from '../strip-json-comments.js';
import type { ExtractedFields } from '../types.js';
import { loadLeakageCorpus, type CorpusFile } from './heldout-leakage.js';
import {
  loadS33Wave1WorkflowReportEntries,
  verifyS33Wave1ProducerHead,
  type S33Wave1WorkflowReportEntry,
} from './s33-wave1-producer-verifier.js';

const GENERATION_MODEL = 'gemini-2.5-flash';
const EMBEDDING_MODEL = 'gemini-embedding-001';
const WORKFLOW_PATH = '.github/workflows/s33-wave1-prerequisites.yml';
const PROD_TIMEOUT_MS = 30_000;
const PROD_DEADLINE_MS = 45 * 60_000;
const EMBEDDING_DEADLINE_MS = 60 * 60_000;
const MAX_ENTRY_CHARS = 50_000;
const MAX_AGGREGATE_CHARS = 4_050_000;
const MAX_TRAINING_CHUNKS = 2_048;
const MAX_VECTOR_INPUTS = 2_129;
const MAX_EMBEDDING_HTTP_REQUESTS = 134;
const EMBEDDING_BATCH_SIZE = 16;
const EMBEDDING_DIMENSIONS = 3_072;
const CHUNK_TOKENS = 1_500;
const CHUNK_OVERLAP_TOKENS = 128;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RUN_ID_PATTERN = /^[1-9]\d*$/u;

type JsonRecord = Record<string, unknown>;
type FetchLike = typeof fetch;

export interface S33PrerequisiteRunnerContext {
  fetchImpl?: FetchLike;
  now?: () => Date;
  repositoryRoot: string;
  workerRoot: string;
  workflowEnvironment: Readonly<Record<string, string | undefined>>;
}

interface TrainingChunk {
  chunkOrdinal: number;
  chunkSha256: string;
  fileRawSha256: string;
  path: string;
  text: string;
  tokenEnd: number;
  tokenStart: number;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertForbiddenModelEnvironment(environment: Readonly<Record<string, string | undefined>>): void {
  for (const name of [
    'GEMINI_TUNED_MODEL',
    'GEMINI_V6_PROMPT',
    'GEMINI_TUNED_RESPONSE_SCHEMA',
    'GEMINI_MODEL',
    'GEMINI_EMBEDDING_MODEL',
  ]) {
    if (environment[name] !== undefined) throw new Error(`${name} must be absent for prod-parity prerequisites`);
  }
}

function workflowBinding(environment: Readonly<Record<string, string | undefined>>): JsonRecord {
  const workflowRunId = requiredEnvironment(environment, 'GITHUB_RUN_ID');
  const workflowRunAttempt = Number(requiredEnvironment(environment, 'GITHUB_RUN_ATTEMPT'));
  const trustedMainRunSha = requiredEnvironment(environment, 'GITHUB_SHA');
  if (!RUN_ID_PATTERN.test(workflowRunId)
    || !Number.isSafeInteger(Number(workflowRunId))) {
    throw new Error('GITHUB_RUN_ID must be a positive safe-integer decimal id');
  }
  if (workflowRunAttempt !== 1) throw new Error('GITHUB_RUN_ATTEMPT must be exactly 1');
  if (!SHA_PATTERN.test(trustedMainRunSha)) throw new Error('GITHUB_SHA must be a full lowercase Git SHA');
  if (environment.GITHUB_REPOSITORY !== 'carson-see/ArkovaCarson'
    || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_ACTIONS !== 'true') {
    throw new Error('Prerequisite runner requires the fixed repository workflow_dispatch on refs/heads/main');
  }
  return { workflowRunId, workflowRunAttempt, trustedMainRunSha, workflowPath: WORKFLOW_PATH };
}

export function validateS33PrerequisiteEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<{ apiKey: string; workflow: JsonRecord }> {
  assertForbiddenModelEnvironment(environment);
  if (environment.ENABLE_AI_EXTRACTION !== 'true') {
    throw new Error('ENABLE_AI_EXTRACTION must be exactly true');
  }
  return Object.freeze({
    apiKey: requiredEnvironment(environment, 'GEMINI_API_KEY'),
    workflow: workflowBinding(environment),
  });
}

function normalizedTokens(content: string): string[] {
  const normalized = content.normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return normalized.length === 0 ? [] : normalized.split(/\s+/u);
}

export function buildTrainingChunkManifest(corpus: readonly CorpusFile[]): Readonly<{
  chunks: readonly TrainingChunk[];
  lexicalTrainingManifestSha256: string;
  manifest: readonly JsonRecord[];
  manifestCanonicalSha256: string;
}> {
  if (corpus.length === 0) throw new Error('Merged leakage corpus is empty');
  const ordered = [...corpus].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const chunks: TrainingChunk[] = [];
  const manifest = ordered.map((file) => {
    const fileRawSha256 = sha256(file.content);
    const tokens = normalizedTokens(file.content);
    const fileChunks: JsonRecord[] = [];
    let ordinal = 0;
    for (let tokenStart = 0; tokenStart < tokens.length;) {
      const tokenEnd = Math.min(tokens.length, tokenStart + CHUNK_TOKENS);
      const text = tokens.slice(tokenStart, tokenEnd).join(' ');
      const chunk: TrainingChunk = {
        chunkOrdinal: ordinal,
        chunkSha256: sha256(text),
        fileRawSha256,
        path: file.path,
        text,
        tokenEnd,
        tokenStart,
      };
      chunks.push(chunk);
      fileChunks.push({
        chunkOrdinal: chunk.chunkOrdinal,
        tokenStart,
        tokenEnd,
        chunkSha256: chunk.chunkSha256,
      });
      ordinal += 1;
      if (tokenEnd === tokens.length) break;
      tokenStart = tokenEnd - CHUNK_OVERLAP_TOKENS;
    }
    return { path: file.path, rawSha256: fileRawSha256, chunks: fileChunks };
  });
  if (chunks.length > MAX_TRAINING_CHUNKS) {
    throw new Error(`Training chunk cap exceeded (${chunks.length} > ${MAX_TRAINING_CHUNKS})`);
  }
  const lexicalTrainingManifestSha256 = sha256(canonicaliseJson(
    manifest.map(({ path, rawSha256 }) => ({ path, rawSha256 })),
  ));
  const manifestDocument = { lexicalTrainingManifestSha256, files: manifest };
  return {
    chunks,
    lexicalTrainingManifestSha256,
    manifest,
    manifestCanonicalSha256: sha256(canonicaliseJson(manifestDocument)),
  };
}

function promptModuleDigest(workerRoot: string): string {
  return sha256(readFileSync(join(workerRoot, 'src/ai/prompts/extraction.ts')));
}

function usageRecord(value: unknown): JsonRecord {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
  const count = (key: string): number | null => Number.isSafeInteger(record[key]) && (record[key] as number) >= 0
    ? record[key] as number
    : null;
  return {
    promptTokenCount: count('promptTokenCount'),
    candidatesTokenCount: count('candidatesTokenCount'),
    totalTokenCount: count('totalTokenCount'),
  };
}

function candidateText(value: unknown): { text: string; usage: JsonRecord } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Gemini generation returned a malformed API envelope');
  }
  const envelope = value as JsonRecord;
  const candidates = envelope.candidates;
  if (!Array.isArray(candidates) || candidates.length < 1) {
    throw new Error('Gemini generation returned no candidate');
  }
  const candidate = candidates[0] as JsonRecord;
  if (candidate.finishReason !== 'STOP') {
    throw new Error(`Gemini generation was blocked (${String(candidate.finishReason)})`);
  }
  const content = candidate.content as JsonRecord | undefined;
  const parts = content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((part) => typeof part === 'object' && part !== null ? (part as JsonRecord).text : undefined)
      .filter((part): part is string => typeof part === 'string')
      .join('')
    : '';
  if (text.trim().length === 0) throw new Error('Gemini generation returned empty model text');
  return { text, usage: usageRecord(envelope.usageMetadata) };
}

async function jsonRequest(
  fetchImpl: FetchLike,
  url: string,
  apiKey: string,
  body: JsonRecord,
  timeoutMs = PROD_TIMEOUT_MS,
): Promise<{ json: unknown; status: number }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.arrayBuffer();
    throw new Error(`Google Generative Language request failed with HTTP ${response.status}`);
  }
  return { json: await response.json() as unknown, status: response.status };
}

export async function runS33ProdReplay(input: Readonly<{
  apiKey: string;
  entries: readonly Readonly<S33Wave1WorkflowReportEntry>[];
  fetchImpl: FetchLike;
  now: () => Date;
  producer: ReturnType<typeof verifyS33Wave1ProducerHead>;
  workerRoot: string;
  workflow: JsonRecord;
}>): Promise<JsonRecord> {
  if (input.entries.length !== 81) throw new Error('Prod replay requires exactly 81 entries');
  const aggregateChars = input.entries.reduce((total, entry) => {
    if (entry.strippedText.length > MAX_ENTRY_CHARS) throw new Error(`${entry.id} exceeds 50,000 characters`);
    return total + entry.strippedText.length;
  }, 0);
  if (aggregateChars > MAX_AGGREGATE_CHARS) throw new Error('Prod replay aggregate input cap exceeded');
  const started = input.now();
  const deadline = started.getTime() + PROD_DEADLINE_MS;
  const results: JsonRecord[] = [];
  for (const entry of input.entries) {
    if (input.now().getTime() >= deadline) throw new Error('Prod replay 45-minute deadline exceeded');
    if (typeof entry.groundTruth.credentialType !== 'string' || entry.groundTruth.credentialType.length === 0) {
      throw new Error(`${entry.id} is missing its verified ground-truth credentialType`);
    }
    const credentialType = entry.groundTruth.credentialType;
    const prompt = buildExtractionPrompt(entry.strippedText, credentialType, undefined);
    const requestBody = {
      systemInstruction: { role: 'system', parts: [{ text: EXTRACTION_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 2048 },
    };
    const response = await jsonRequest(
      input.fetchImpl,
      `https://generativelanguage.googleapis.com/v1beta/models/${GENERATION_MODEL}:generateContent`,
      input.apiKey,
      requestBody,
      Math.max(1, Math.min(PROD_TIMEOUT_MS, deadline - input.now().getTime())),
    );
    const generated = candidateText(response.json);
    parseS33ProductionExtractionResponse(generated.text, entry.strippedText, credentialType);
    results.push({
      id: entry.id,
      inputSha256: sha256(entry.strippedText),
      requestSha256: sha256(canonicaliseJson(requestBody)),
      httpStatus: response.status,
      attempt: 1,
      rawModelText: generated.text,
      usage: generated.usage,
    });
  }
  if (results.length !== 81 || input.now().getTime() > deadline) {
    throw new Error('Prod replay did not complete its exact bounded universe');
  }
  const modelConfig = {
    promptModule: 'services/worker/src/ai/prompts/extraction.ts',
    promptModuleRawSha256: promptModuleDigest(input.workerRoot),
    systemPromptExport: 'EXTRACTION_SYSTEM_PROMPT',
    systemPromptSha256: sha256(EXTRACTION_SYSTEM_PROMPT),
    promptBuilder: 'buildExtractionPrompt',
    promptBuilderProbeSha256: sha256(buildExtractionPrompt('__S33_PIN__', 'OTHER', undefined)),
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 2048 },
    absentFlags: ['GEMINI_TUNED_MODEL', 'GEMINI_V6_PROMPT', 'GEMINI_TUNED_RESPONSE_SCHEMA'],
    timeoutMs: PROD_TIMEOUT_MS,
    concurrency: 1,
    maxRequests: 81,
    maxEntryCharacters: MAX_ENTRY_CHARS,
    maxAggregateInputCharacters: MAX_AGGREGATE_CHARS,
  };
  return {
    schemaVersion: 1,
    mode: 'offline-prod-parity-replay',
    producerHeadSha: input.producer.producerHeadSha,
    producerTreeSha: input.producer.producerTreeSha,
    manifestRawSha256: input.producer.manifestRawSha256,
    manifestCanonicalSha256: input.producer.manifestCanonicalSha256,
    entryUniverseSha256: sha256(canonicaliseJson(input.entries.map(({ id }) => id))),
    providerSurface: 'google-generative-language-developer-api',
    model: GENERATION_MODEL,
    modelConfig,
    modelConfigCanonicalSha256: sha256(canonicaliseJson(modelConfig)),
    ...input.workflow,
    startedAtUtc: started.toISOString(),
    completedAtUtc: input.now().toISOString(),
    requestCount: 81,
    retryCount: 0,
    results,
  };
}

function embeddingValues(value: unknown, expected: number): number[][] {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
  if (!Array.isArray(record.embeddings) || record.embeddings.length !== expected) {
    throw new Error('Embedding response count does not match request');
  }
  return record.embeddings.map((candidate, index) => {
    const embedding = typeof candidate === 'object' && candidate !== null
      ? (candidate as JsonRecord).values
      : undefined;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS
      || !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new Error(`Embedding response ${index} must contain exactly ${EMBEDDING_DIMENSIONS} finite values`);
    }
    return embedding as number[];
  });
}

export async function runS33EmbeddingDiagnostic(input: Readonly<{
  apiKey: string;
  corpus: readonly CorpusFile[];
  entries: readonly Readonly<S33Wave1WorkflowReportEntry>[];
  fetchImpl: FetchLike;
  now: () => Date;
  producer: ReturnType<typeof verifyS33Wave1ProducerHead>;
  workflow: JsonRecord;
}>): Promise<JsonRecord> {
  const training = buildTrainingChunkManifest(input.corpus);
  const records = [
    ...input.entries.map((entry) => ({ kind: 'heldout' as const, id: entry.id, text: entry.strippedText })),
    ...training.chunks.map((chunk) => ({ kind: 'training' as const, ...chunk })),
  ];
  if (input.entries.length !== 81 || records.length > MAX_VECTOR_INPUTS) {
    throw new Error('Embedding vector-input universe exceeds its exact cap');
  }
  const expectedRequests = Math.ceil(records.length / EMBEDDING_BATCH_SIZE);
  if (expectedRequests > MAX_EMBEDDING_HTTP_REQUESTS) throw new Error('Embedding HTTP request cap exceeded');
  const started = input.now();
  const deadline = started.getTime() + EMBEDDING_DEADLINE_MS;
  const vectorRecords: JsonRecord[] = [];
  const requestRecords: JsonRecord[] = [];
  for (let offset = 0; offset < records.length; offset += EMBEDDING_BATCH_SIZE) {
    if (input.now().getTime() >= deadline) throw new Error('Embedding 60-minute deadline exceeded');
    const batch = records.slice(offset, offset + EMBEDDING_BATCH_SIZE);
    const body = {
      requests: batch.map(({ text }) => ({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        taskType: 'SEMANTIC_SIMILARITY',
        outputDimensionality: EMBEDDING_DIMENSIONS,
      })),
    };
    const response = await jsonRequest(
      input.fetchImpl,
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`,
      input.apiKey,
      body,
      Math.max(1, Math.min(PROD_TIMEOUT_MS, deadline - input.now().getTime())),
    );
    const vectors = embeddingValues(response.json, batch.length);
    if (vectors.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error('Embedding dimensions drifted between batches');
    }
    requestRecords.push({
      requestOrdinal: requestRecords.length,
      inputCount: batch.length,
      httpStatus: response.status,
      attempt: 1,
      requestSha256: sha256(canonicaliseJson(body)),
    });
    batch.forEach((record, index) => {
      const vector = vectors[index];
      vectorRecords.push(record.kind === 'heldout'
        ? { kind: 'heldout', id: record.id, inputSha256: sha256(record.text), vector }
        : {
            kind: 'training',
            path: record.path,
            fileRawSha256: record.fileRawSha256,
            chunkOrdinal: record.chunkOrdinal,
            tokenStart: record.tokenStart,
            tokenEnd: record.tokenEnd,
            chunkSha256: record.chunkSha256,
            vector,
          });
    });
  }
  if (vectorRecords.length !== records.length || requestRecords.length !== expectedRequests
    || input.now().getTime() > deadline) {
    throw new Error('Embedding phase did not complete its exact bounded universe');
  }
  const modelConfig = {
    taskType: 'SEMANTIC_SIMILARITY',
    dimensions: EMBEDDING_DIMENSIONS,
    batchSize: EMBEDDING_BATCH_SIZE,
    timeoutMs: PROD_TIMEOUT_MS,
    concurrency: 1,
    retryCount: 0,
    chunkTokens: CHUNK_TOKENS,
    chunkOverlapTokens: CHUNK_OVERLAP_TOKENS,
    maxTrainingChunks: MAX_TRAINING_CHUNKS,
    maxVectorInputs: MAX_VECTOR_INPUTS,
    maxHttpRequests: MAX_EMBEDDING_HTTP_REQUESTS,
  };
  return {
    schemaVersion: 1,
    role: 'diagnostic-only',
    canOverrideExactScan: false,
    producerHeadSha: input.producer.producerHeadSha,
    producerTreeSha: input.producer.producerTreeSha,
    manifestRawSha256: input.producer.manifestRawSha256,
    manifestCanonicalSha256: input.producer.manifestCanonicalSha256,
    entryUniverseSha256: sha256(canonicaliseJson(input.entries.map(({ id }) => id))),
    providerSurface: 'google-generative-language-developer-api',
    model: EMBEDDING_MODEL,
    modelConfig,
    modelConfigCanonicalSha256: sha256(canonicaliseJson(modelConfig)),
    ...input.workflow,
    startedAtUtc: started.toISOString(),
    completedAtUtc: input.now().toISOString(),
    heldoutRecordCount: input.entries.length,
    trainingFileCount: input.corpus.length,
    trainingChunkCount: training.chunks.length,
    vectorInputCount: records.length,
    requestCount: requestRecords.length,
    retryCount: 0,
    lexicalTrainingManifestSha256: training.lexicalTrainingManifestSha256,
    trainingChunkManifestCanonicalSha256: training.manifestCanonicalSha256,
    trainingManifest: training.manifest,
    requests: requestRecords,
    vectors: vectorRecords,
  };
}

export async function runS33Wave1Prerequisites(
  producerHeadSha: string,
  context: S33PrerequisiteRunnerContext,
): Promise<Readonly<{ embedding: JsonRecord; prod: JsonRecord }>> {
  if (!SHA_PATTERN.test(producerHeadSha)) throw new Error('Producer head must be a full lowercase Git SHA');
  const { apiKey, workflow } = validateS33PrerequisiteEnvironment(context.workflowEnvironment);
  const producer = verifyS33Wave1ProducerHead({ repositoryRoot: context.repositoryRoot, producerHeadSha });
  const entries = loadS33Wave1WorkflowReportEntries({ repositoryRoot: context.repositoryRoot, producerHeadSha });
  const fetchImpl = context.fetchImpl ?? fetch;
  const now = context.now ?? (() => new Date());
  const prod = await runS33ProdReplay({ apiKey, entries, fetchImpl, now, producer, workerRoot: context.workerRoot, workflow });
  const corpus = loadLeakageCorpus(context.workerRoot, { failOnUnreadable: true });
  const embedding = await runS33EmbeddingDiagnostic({ apiKey, corpus, entries, fetchImpl, now, producer, workflow });
  return Object.freeze({ embedding, prod });
}

const STRING_EXTRACTION_FIELDS = new Set([
  'credentialType', 'subType', 'issuerName', 'recipientIdentifier', 'issuedDate',
  'expiryDate', 'fieldOfStudy', 'degreeLevel', 'licenseNumber', 'accreditingBody',
  'jurisdiction', 'creditType', 'barNumber', 'activityNumber', 'courseId',
  'providerName', 'approvedBy', 'deliveryMethod', 'nasbaStatus', 'einNumber',
  'taxExemptStatus', 'governingBody', 'crdNumber', 'firmName', 'finraRegistration',
  'seriesLicenses', 'entityType', 'stateOfFormation', 'registeredAgent',
  'goodStandingStatus', 'suggestedType', 'reasoning', 'confidenceReasoning', 'description',
]);
const NUMBER_EXTRACTION_FIELDS = new Set(['creditHours', 'ethicsHours']);
const STRING_ARRAY_EXTRACTION_FIELDS = new Set(['fraudSignals', 'concerns']);
const BOOLEAN_EXTRACTION_FIELDS = new Set(['issuerVerified']);

export function parseS33ProductionExtractionResponse(
  text: string,
  strippedText: string,
  credentialTypeHint: string,
): ExtractedFields {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseModelJson(text);
  } catch (error) {
    if (!isProfessionalEducationText(strippedText, credentialTypeHint)) throw error;
    parsed = { credentialType: credentialTypeHint, confidence: 0.55 };
  }
  const { confidence: _confidence, ...rawFields } = parsed;
  const validated = ExtractedFieldsSchema.safeParse(sanitizeExtractedFields(rawFields));
  if (!validated.success) throw new Error('Extraction schema validation failed');
  const fields = normalizeProfessionalEducationFields(
    validated.data,
    strippedText,
    credentialTypeHint,
  );
  const validation = validateFieldsForType(fields);
  for (const key of validation.stripped) delete (fields as Record<string, unknown>)[key];
  const crossField = runCrossFieldChecks(fields);
  const mergedSignals = [...new Set([
    ...(fields.fraudSignals ?? []),
    ...crossField.additionalFraudSignals,
  ])];
  return mergedSignals.length > 0 ? { ...fields, fraudSignals: mergedSignals } : fields;
}

function parseModelJson(text: string): Record<string, unknown> {
  const cleaned = stripJsonComments(text).trim();
  const unfenced = stripMarkdownJsonFence(cleaned);
  try {
    return ensureJsonObject(JSON.parse(unfenced));
  } catch (initialError) {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = unfenced.slice(start, end + 1);
      try {
        return ensureJsonObject(JSON.parse(candidate));
      } catch {
        return ensureJsonObject(JSON.parse(repairModelJson(candidate)));
      }
    }
    const repaired = repairModelJson(unfenced);
    if (repaired !== unfenced) return ensureJsonObject(JSON.parse(repaired));
    throw initialError;
  }
}

function repairModelJson(text: string): string {
  const withoutControlChars = text
    .replace(/^\uFEFF/u, '')
    // eslint-disable-next-line no-control-regex -- intentional production-parity repair
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, ' ');
  const withoutTrailingCommas = withoutControlChars.replace(/,\s*([}\]])/gu, '$1');
  return escapeBareNewlinesInStrings(balanceJsonDelimiters(withoutTrailingCommas));
}

function balanceJsonDelimiters(text: string): string {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const character of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === '{') stack.push('}');
    if (character === '[') stack.push(']');
    if ((character === '}' || character === ']') && stack.at(-1) === character) stack.pop();
  }
  return text + stack.reverse().join('');
}

function escapeBareNewlinesInStrings(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      output += character;
      continue;
    }
    if (inString && character === '\n') {
      output += '\\n';
      continue;
    }
    if (inString && character === '\r') {
      output += '\\r';
      continue;
    }
    output += character;
  }
  return output;
}

function stripMarkdownJsonFence(cleaned: string): string {
  if (!cleaned.startsWith('```')) return cleaned;
  const firstLineBreak = cleaned.indexOf('\n');
  const withoutOpeningFence = firstLineBreak >= 0 ? cleaned.slice(firstLineBreak + 1) : cleaned.slice(3);
  const trimmed = withoutOpeningFence.trim();
  return trimmed.endsWith('```') ? trimmed.slice(0, -3).trim() : trimmed;
}

function ensureJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error('Extraction response was not a JSON object');
}

function sanitizeExtractedFields(rawFields: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawFields)) {
    const coerced = coerceExtractionField(key, value);
    if (coerced !== undefined) sanitized[key] = coerced;
  }
  return sanitized;
}

function coerceExtractionField(key: string, value: unknown): unknown {
  if (STRING_EXTRACTION_FIELDS.has(key)) return coerceString(value, key === 'description' ? 500 : undefined);
  if (NUMBER_EXTRACTION_FIELDS.has(key)) return coerceNumber(value);
  if (STRING_ARRAY_EXTRACTION_FIELDS.has(key)) {
    const coerced = coerceStringArray(value);
    return coerced.length > 0 ? coerced : undefined;
  }
  if (BOOLEAN_EXTRACTION_FIELDS.has(key)) return coerceBoolean(value);
  return undefined;
}

function coerceString(value: unknown, maxLength?: number): string | undefined {
  let text: string | undefined;
  if (typeof value === 'string') text = value;
  if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  if (Array.isArray(value)) {
    text = value.map((item) => coerceString(item)).filter((item): item is string => Boolean(item)).join(', ');
  }
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function coerceStringArray(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => {
    if (typeof item === 'object' && item !== null) {
      const row = item as Record<string, unknown>;
      return coerceString(row.signal ?? row.code ?? row.description ?? row.message ?? JSON.stringify(row));
    }
    return coerceString(item);
  }).filter((item): item is string => Boolean(item));
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^true$/iu.test(value.trim())) return true;
    if (/^false$/iu.test(value.trim())) return false;
  }
  return undefined;
}

function normalizeProfessionalEducationFields(
  fields: ExtractedFields,
  strippedText: string,
  credentialTypeHint: string,
): ExtractedFields {
  const normalized: ExtractedFields = { ...fields };
  const text = strippedText.replace(/\s+/gu, ' ').trim();
  const { isCpe, isCle } = detectProfessionalEducation(text, credentialTypeHint);
  if (!isCpe && !isCle) return normalized;

  normalized.credentialType = isCle && !isCpe ? 'CLE' : 'CPE';
  const baseCreditType = isCle && !isCpe ? 'CLE' : 'CPE';
  if (/regulatory ethics|professional ethics|ethics requirement/iu.test(text)) {
    normalized.creditType = `${baseCreditType} Ethics`;
  } else if (!normalized.creditType || !/^C(?:P|L)E(?:\s+Ethics)?$/iu.test(normalized.creditType)) {
    normalized.creditType = baseCreditType;
  }

  const creditHours = extractFirstNumber(text, [
    /\bCPE\s+(?:Credits?|Hours?)\s*[:-]?\s*(\d+(?:\.\d+)?)/iu,
    /\bCredits?\s+Awarded\s*[:-]?\s*(\d+(?:\.\d+)?)\s*(?:CPE|CLE)?/iu,
    /\b(?:Total\s+)?(?:CLE|CPE)?\s*Credits?\s*[:-]?\s*(\d+(?:\.\d+)?)/iu,
    /\b(?:Credit|Contact)\s+Hours?\s*[:-]?\s*(\d+(?:\.\d+)?)/iu,
    /\b(\d+(?:\.\d+)?)\s+(?:CPE|CLE)\b/iu,
  ]);
  if (creditHours !== undefined) normalized.creditHours = creditHours;
  const ethicsHours = extractFirstNumber(text, [
    /\b(?:Ethics|Regulatory Ethics|Professional Responsibility)\s*(?:Credits?|Hours?)\s*[:-]?\s*(\d+(?:\.\d+)?)/iu,
    /\b(\d+(?:\.\d+)?)\s+(?:Regulatory\s+)?Ethics\b/iu,
  ]);
  if (ethicsHours !== undefined) normalized.ethicsHours = ethicsHours;

  const courseId = extractFirstText(text, [
    /\bC\s*o\s*u\s*r\s*s\s*e\s+(?:ID|Number)\s*[:-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/iu,
    /\bCourse\s+(?:ID|Number|Code)\s*[:-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/iu,
    /\bProgram\s+Code\s+([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/iu,
    /\bProgram\s+ID\s*[:-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/iu,
    /\bModule\s+ID\s*[:-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/iu,
    /\bConference\s+Code\s*[:-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/iu,
    /\bActivity\s+Number\s*[:-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/iu,
  ]);
  if (courseId) {
    normalized.courseId = courseId;
    if (!normalized.activityNumber) normalized.activityNumber = courseId;
  }
  const deliveryMethod = extractFirstText(text, [
    /\bDelivery\s+Method\s*[:-]\s*([^.;]+)/iu,
    /\bDelivery\s*[:-]\s*([^.;]+)/iu,
    /\bDeli\s*very\s*[:-]\s*([^.;]+)/iu,
  ]);
  if (deliveryMethod) normalized.deliveryMethod = deliveryMethod;
  const nasbaStatus = extractFirstText(text, [
    /\bNASBA\s+(?:Sponsor\s+)?Registry(?:\s+Status)?\s*[:-]\s*(active|lapsed|pending|revoked|not registered)/iu,
    /\bNASBA\s+(?:National\s+)?Registry\s+of\s+CPE\s+Sponsors\s*[:-]\s*(active|lapsed|pending|revoked|not registered)/iu,
    /\bNASBA\s+Sponsor\s+Status\s*[:-]\s*(active|lapsed|pending|revoked|not registered)/iu,
    /\bNASBA\s+Spon\s*sor\s+Regis\s*try\s*[:-]\s*(active|lapsed|pending|revoked|not registered)/iu,
  ]);
  if (nasbaStatus) normalized.nasbaStatus = nasbaStatus.toLowerCase();
  const providerName = extractFirstText(text, [
    /\bSponsor\s*[:-]\s*([^.;]+)/iu,
    /\bProvider\s*[:-]\s*([^.;]+)/iu,
    /^(.+?)\s+(?:hereby certifies|Certificate of|CPE Certificate|—\s+Certificate|Annual Assurance Conference)/iu,
  ]);
  if (providerName) {
    normalized.providerName = providerName;
    if (!normalized.issuerName) normalized.issuerName = providerName;
  }
  if (/nasba/iu.test(text)) normalized.accreditingBody = 'NASBA';
  const jurisdiction = extractFirstText(text, [
    /\bJurisdiction\s*[:-]\s*([^.;]+)/iu,
    /\bLocation\s*[:-]\s*[^,.;]+,\s*([A-Z][a-z]+)\b/iu,
    /\bApproved\s+for\s+([A-Z][a-z]+)\s+State\s+Board/iu,
  ]);
  if (jurisdiction) normalized.jurisdiction = jurisdiction.replace(/,\s*USA$/iu, '');
  else if (!normalized.jurisdiction) normalized.jurisdiction = 'United States';
  const issuedDate = extractIsoDate(text, [
    /\bCompletion\s+Date\s*[:-]?\s*([A-Z][a-z]+\s+\d{1,2}\s*,\s*\d{4})/iu,
    /\bDate\s+of\s+Completion\s*[:-]?\s*([A-Z][a-z]+\s+\d{1,2}\s*,\s*\d{4})/iu,
    /\bCompleted\s*[:-]?\s*([A-Z][a-z]+\s+\d{1,2}\s*,\s*\d{4})/iu,
    /\bDate\s*[:-]?\s*([A-Z][a-z]+\s+\d{1,2}\s*,\s*\d{4})/iu,
    /\bon\s+([A-Z][a-z]+\s+\d{1,2}\s*,\s*\d{4})/iu,
  ]);
  if (issuedDate) normalized.issuedDate = issuedDate;
  return normalized;
}

function isProfessionalEducationText(strippedText: string, credentialTypeHint: string): boolean {
  const { isCpe, isCle } = detectProfessionalEducation(strippedText, credentialTypeHint);
  return isCpe || isCle;
}

function detectProfessionalEducation(text: string, credentialTypeHint: string): { isCpe: boolean; isCle: boolean } {
  const lower = text.toLowerCase();
  const hint = credentialTypeHint.toUpperCase();
  return {
    isCpe: hint === 'CPE' || /\bcpe\b/u.test(lower)
      || /continuing professional education/iu.test(text) || /nasba/iu.test(text),
    isCle: hint === 'CLE' || /\bcle\b/u.test(lower)
      || /continuing legal education/iu.test(text) || /\bbar\b/iu.test(text) || /\bmcle\b/iu.test(text),
  };
}

function extractFirstNumber(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractFirstText(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim().replace(/\s+/gu, ' ').replace(/[.,;:]+$/u, '');
    if (value) return value;
  }
  return undefined;
}

function extractIsoDate(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const parsed = new Date(match[1]);
    if (Number.isNaN(parsed.getTime())) continue;
    const year = parsed.getUTCFullYear();
    const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const day = String(parsed.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return undefined;
}

export function parseS33PrerequisiteCliArgs(
  args: readonly string[],
): { producerHeadSha: string; rawOutputDir: string } {
  if (args.length !== 5 || args[0] !== 'prerequisites') {
    throw new Error('Expected prerequisites --producer-head <sha> --raw-output-dir <dir>');
  }
  const flags = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !value || !['--producer-head', '--raw-output-dir'].includes(flag) || flags.has(flag)) {
      throw new Error('Only unique --producer-head and --raw-output-dir arguments are accepted');
    }
    flags.set(flag, value);
  }
  return {
    producerHeadSha: flags.get('--producer-head') ?? '',
    rawOutputDir: resolve(flags.get('--raw-output-dir') ?? ''),
  };
}

async function main(): Promise<void> {
  const args = parseS33PrerequisiteCliArgs(process.argv.slice(2));
  const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const repositoryRoot = resolve(requiredEnvironment(process.env, 'S33_REPOSITORY_ROOT'));
  const reports = await runS33Wave1Prerequisites(args.producerHeadSha, {
    repositoryRoot,
    workerRoot,
    workflowEnvironment: process.env,
  });
  writeS33PrerequisiteRawReportsAtomically(args.rawOutputDir, reports);
}

export function writeS33PrerequisiteRawReportsAtomically(
  rawOutputDir: string,
  reports: Readonly<{ embedding: JsonRecord; prod: JsonRecord }>,
): void {
  if (statExists(rawOutputDir)) throw new Error('Raw output directory must not already exist');
  const parent = dirname(rawOutputDir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, '.s33-wave1-prerequisite-'));
  try {
    writeFileSync(join(staging, 'prod-model-diff.raw.json'), `${JSON.stringify(reports.prod, null, 2)}\n`, {
      flag: 'wx', mode: 0o600,
    });
    writeFileSync(join(staging, 'embedding-diagnostic.raw.json'), `${JSON.stringify(reports.embedding, null, 2)}\n`, {
      flag: 'wx', mode: 0o600,
    });
    renameSync(staging, rawOutputDir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
