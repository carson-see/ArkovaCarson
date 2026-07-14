import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from '../prompts/extraction.js';
import { WAVE1_ENTRY_IDS } from './s33-batch-acceptance.js';
import { buildTrainingChunkManifest } from './s33-wave1-prerequisite-runner.js';
import type {
  S33Wave1ProducerValidationReport,
  S33Wave1WorkflowReportEntry,
} from './s33-wave1-producer-verifier.js';
import {
  buildCrossReviewPlan,
  buildLexicalLeakageReport,
  deterministicSampleIds,
  normalizeEmbeddingDiagnostic,
  normalizeProdModelDiff,
} from './s33-wave1-workflow-reports.js';

const HEAD = '1'.repeat(40);
const PARENT = '2'.repeat(40);
const TREE = '3'.repeat(40);
const MANIFEST_RAW = '4'.repeat(64);
const MANIFEST_CANONICAL = '5'.repeat(64);
const RUN_SHA = '6'.repeat(40);
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function producer(): S33Wave1ProducerValidationReport {
  return {
    algorithmVersion: 's33-wave1-producer-validation-v1',
    batchId: 'S33-W1', corpusSourceBlobs: {},
    counts: { byCorpusSlice: {}, byCredentialType: {}, byDomain: {}, covered: 72, ood: 9, total: 81 },
    entries: WAVE1_ENTRY_IDS.map((id, index) => ({
      id, kind: index < 72 ? 'covered' : 'ood-abstention', normalizedInputSha256: '7'.repeat(64),
      postValidationDepth: index < 72 ? 5 : null, sourcePath: 'fixture.ts', strippedFields: [],
    })),
    manifestCanonicalSha256: MANIFEST_CANONICAL, manifestRawSha256: MANIFEST_RAW,
    producerChangedPaths: [], producerHeadSha: HEAD, producerParentSha: PARENT,
    producerTreeSha: TREE, reportDigestSha256: '8'.repeat(64), revision: 12, schemaVersion: 1,
    support: { commit: PARENT, parentRetainedTypesBlob: '9'.repeat(40), typesBlob: '9'.repeat(40),
      typesPath: 'services/worker/src/ai/eval/golden-dataset-s33-types.ts' },
  };
}

function entries(): readonly Readonly<S33Wave1WorkflowReportEntry>[] {
  return WAVE1_ENTRY_IDS.map((id) => ({
    id,
    strippedText: `Credential ${id} issued by Test Authority on 2026-07-14.`,
    groundTruth: { credentialType: 'OTHER', subType: 'other', fraudSignals: [] },
  }));
}

function prodConfig(): Record<string, unknown> {
  return {
    promptModule: 'services/worker/src/ai/prompts/extraction.ts',
    promptModuleRawSha256: sha256(readFileSync(join(workerRoot, 'src/ai/prompts/extraction.ts'))),
    systemPromptExport: 'EXTRACTION_SYSTEM_PROMPT', systemPromptSha256: sha256(EXTRACTION_SYSTEM_PROMPT),
    promptBuilder: 'buildExtractionPrompt',
    promptBuilderProbeSha256: sha256(buildExtractionPrompt('__S33_PIN__', 'OTHER', undefined)),
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 2048 },
    absentFlags: ['GEMINI_TUNED_MODEL', 'GEMINI_V6_PROMPT', 'GEMINI_TUNED_RESPONSE_SCHEMA'],
    timeoutMs: 30_000, concurrency: 1, maxRequests: 81, maxEntryCharacters: 50_000,
    maxAggregateInputCharacters: 4_050_000,
  };
}

function modelDiffRaw(): Buffer {
  const corpus = entries();
  const modelConfig = prodConfig();
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, mode: 'offline-prod-parity-replay', producerHeadSha: HEAD,
    producerTreeSha: TREE, manifestRawSha256: MANIFEST_RAW, manifestCanonicalSha256: MANIFEST_CANONICAL,
    entryUniverseSha256: sha256(canonicaliseJson(WAVE1_ENTRY_IDS)),
    providerSurface: 'google-generative-language-developer-api', model: 'gemini-2.5-flash',
    modelConfig, modelConfigCanonicalSha256: sha256(canonicaliseJson(modelConfig)),
    workflowRunId: '123', workflowRunAttempt: 1, trustedMainRunSha: RUN_SHA,
    workflowPath: '.github/workflows/s33-wave1-prerequisites.yml',
    startedAtUtc: '2026-07-14T14:00:00.000Z', completedAtUtc: '2026-07-14T14:10:00.000Z',
    requestCount: 81, retryCount: 0,
    results: corpus.map((entry) => {
      const request = {
        systemInstruction: { role: 'system', parts: [{ text: EXTRACTION_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{
          text: buildExtractionPrompt(entry.strippedText, 'OTHER', undefined),
        }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 2048 },
      };
      return {
        id: entry.id, inputSha256: sha256(entry.strippedText), requestSha256: sha256(canonicaliseJson(request)),
        httpStatus: 200, attempt: 1, rawModelText: '{"credentialType":"OTHER","subType":"other"}',
        usage: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      };
    }),
  }));
}

function embeddingRaw(corpus = [{ path: 'training.jsonl', content: 'unrelated training corpus words' }]): Buffer {
  const training = buildTrainingChunkManifest(corpus);
  const corpusEntries = entries();
  const inputs = [...corpusEntries.map(({ strippedText }) => strippedText), ...training.chunks.map(({ text }) => text)];
  const modelConfig = {
    taskType: 'SEMANTIC_SIMILARITY', dimensions: 3072, batchSize: 16, timeoutMs: 30_000,
    concurrency: 1, retryCount: 0, chunkTokens: 1500, chunkOverlapTokens: 128,
    maxTrainingChunks: 2048, maxVectorInputs: 2129, maxHttpRequests: 134,
  };
  const vector = Array.from({ length: 3072 }, () => 1);
  const requests = [];
  for (let offset = 0; offset < inputs.length; offset += 16) {
    const batch = inputs.slice(offset, offset + 16);
    const body = { requests: batch.map((text) => ({
      model: 'models/gemini-embedding-001', content: { parts: [{ text }] },
      taskType: 'SEMANTIC_SIMILARITY', outputDimensionality: 3072,
    })) };
    requests.push({ requestOrdinal: requests.length, inputCount: batch.length, httpStatus: 200,
      attempt: 1, requestSha256: sha256(canonicaliseJson(body)) });
  }
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, role: 'diagnostic-only', canOverrideExactScan: false,
    producerHeadSha: HEAD, producerTreeSha: TREE, manifestRawSha256: MANIFEST_RAW,
    manifestCanonicalSha256: MANIFEST_CANONICAL, entryUniverseSha256: sha256(canonicaliseJson(WAVE1_ENTRY_IDS)),
    providerSurface: 'google-generative-language-developer-api', model: 'gemini-embedding-001',
    modelConfig, modelConfigCanonicalSha256: sha256(canonicaliseJson(modelConfig)),
    workflowRunId: '123', workflowRunAttempt: 1, trustedMainRunSha: RUN_SHA,
    workflowPath: '.github/workflows/s33-wave1-prerequisites.yml',
    startedAtUtc: '2026-07-14T14:10:00.000Z', completedAtUtc: '2026-07-14T14:20:00.000Z',
    heldoutRecordCount: 81, trainingFileCount: corpus.length, trainingChunkCount: training.chunks.length,
    vectorInputCount: inputs.length, requestCount: requests.length, retryCount: 0,
    lexicalTrainingManifestSha256: training.lexicalTrainingManifestSha256,
    trainingChunkManifestCanonicalSha256: training.manifestCanonicalSha256,
    trainingManifest: training.manifest, requests,
    vectors: [
      ...corpusEntries.map((entry) => ({ kind: 'heldout', id: entry.id,
        inputSha256: sha256(entry.strippedText), vector })),
      ...training.chunks.map((chunk) => ({ kind: 'training', path: chunk.path,
        fileRawSha256: chunk.fileRawSha256, chunkOrdinal: chunk.chunkOrdinal,
        tokenStart: chunk.tokenStart, tokenEnd: chunk.tokenEnd, chunkSha256: chunk.chunkSha256, vector })),
    ],
  }));
}

describe('S3.3 Wave-1 trusted workflow reports', () => {
  it('creates the locked deterministic nine-entry cross-review plan without a human verdict', () => {
    const sample = deterministicSampleIds(MANIFEST_RAW, WAVE1_ENTRY_IDS);
    expect(sample).toHaveLength(9);
    expect(buildCrossReviewPlan(producer())).toMatchObject({
      artifactType: 'arkova-s33-wave1-cross-review-plan', status: 'PASS',
      payload: { sampleEntryIds: sample, manifestEntryCount: 81 },
    });
  });

  it('derives prod output/ground-truth hashes and MATCH/MISMATCH without machine adjudication', () => {
    const report = normalizeProdModelDiff(modelDiffRaw(), producer(), entries());
    expect(report).toMatchObject({
      artifactType: 'arkova-s33-wave1-prod-model-diff', status: 'PASS',
      payload: { mode: 'offline-prod-parity-replay', entryCount: 81, requestCount: 81, retryCount: 0 },
    });
    expect(JSON.stringify(report)).not.toMatch(/MODEL_HARD|LABEL_DEFECT|adjudication/u);
    const first = (report.payload as Record<string, unknown>).results as Array<Record<string, unknown>>;
    expect(first[0]).toHaveProperty('modelOutputRawSha256');
    expect(first[0]).toHaveProperty('groundTruthCanonicalSha256');
  });

  it('rejects supplied prod classifications, duplicate keys, config drift, and reordered universes', () => {
    const supplied = JSON.parse(modelDiffRaw().toString('utf8')) as Record<string, unknown>;
    (supplied.results as Array<Record<string, unknown>>)[0].adjudication = 'MODEL_HARD';
    expect(() => normalizeProdModelDiff(Buffer.from(JSON.stringify(supplied)), producer(), entries()))
      .toThrow(/contain exactly/i);
    const duplicate = modelDiffRaw().toString('utf8').replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    expect(() => normalizeProdModelDiff(Buffer.from(duplicate), producer(), entries())).toThrow(/duplicate JSON key/i);
    const drift = JSON.parse(modelDiffRaw().toString('utf8')) as Record<string, unknown>;
    (drift.modelConfig as Record<string, unknown>).maxRequests = 82;
    drift.modelConfigCanonicalSha256 = sha256(canonicaliseJson(drift.modelConfig));
    expect(() => normalizeProdModelDiff(Buffer.from(JSON.stringify(drift)), producer(), entries()))
      .toThrow(/CTO-pinned/i);
    const reordered = JSON.parse(modelDiffRaw().toString('utf8')) as Record<string, unknown>;
    (reordered.results as unknown[]).reverse();
    expect(() => normalizeProdModelDiff(Buffer.from(JSON.stringify(reordered)), producer(), entries()))
      .toThrow(/exact ordered 81-entry/i);
  });

  it('runs exact normalized n=6-13 leakage and refuses an empty corpus or hit', () => {
    const one = [{ id: WAVE1_ENTRY_IDS[0], strippedText: 'alpha bravo charlie delta echo foxtrot golf',
      groundTruth: { credentialType: 'OTHER' } }];
    expect(buildLexicalLeakageReport(one, [{ path: 'clean', content: 'unrelated words' }], producer()))
      .toMatchObject({ payload: { exactMatchCount: 0 } });
    expect(() => buildLexicalLeakageReport(one, [], producer())).toThrow(/corpus is empty/i);
    expect(() => buildLexicalLeakageReport(one, [{ path: 'hit', content: 'alpha bravo charlie delta echo foxtrot' }], producer()))
      .toThrow(/exact normalized n-gram leakage/i);
  });

  it('derives 3072-dimensional nearest-neighbor diagnostics and rejects dimension drift', () => {
    const corpus = [{ path: 'training.jsonl', content: 'unrelated training corpus words' }];
    const report = normalizeEmbeddingDiagnostic(embeddingRaw(corpus), producer(), entries(), corpus);
    expect(report).toMatchObject({
      artifactType: 'arkova-s33-wave1-embedding-diagnostic', status: 'PASS',
      payload: { role: 'diagnostic-only', canOverrideExactScan: false, entryCount: 81 },
    });
    const drift = JSON.parse(embeddingRaw(corpus).toString('utf8')) as Record<string, unknown>;
    ((drift.vectors as Array<Record<string, unknown>>)[0].vector as unknown[]).pop();
    expect(() => normalizeEmbeddingDiagnostic(Buffer.from(JSON.stringify(drift)), producer(), entries(), corpus))
      .toThrow(/exactly 3072/i);
  });
});
