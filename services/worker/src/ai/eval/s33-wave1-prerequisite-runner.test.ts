import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGenerateContent = vi.fn();
const mockGetGenerativeModel = vi.fn();

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogleGenerativeAI {
    getGenerativeModel(...args: unknown[]) {
      return mockGetGenerativeModel(...args);
    }
  },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../grounding.js', () => ({
  verifyGrounding: vi.fn().mockReturnValue({
    fieldResults: [], groundingScore: 1, groundableFieldCount: 0,
    groundedFieldCount: 0, confidenceAdjustment: 0,
  }),
}));

import { GeminiProvider } from '../gemini.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from '../prompts/extraction.js';
import { ExtractedFieldsSchema } from '../schemas.js';
import {
  parseS33PrerequisiteCliArgs,
  parseS33ProductionExtractionResponse,
  runS33EmbeddingDiagnostic,
  runS33ProdReplay,
  validateS33PrerequisiteEnvironment,
  writeS33PrerequisiteRawReportsAtomically,
} from './s33-wave1-prerequisite-runner.js';

const roots: string[] = [];
const producer = {
  producerHeadSha: '1'.repeat(40),
  producerTreeSha: '2'.repeat(40),
  manifestRawSha256: '3'.repeat(64),
  manifestCanonicalSha256: '4'.repeat(64),
} as never;
const workflow = {
  workflowRunId: '12345', workflowRunAttempt: 1,
  trustedMainRunSha: '5'.repeat(40),
  workflowPath: '.github/workflows/s33-wave1-prerequisites.yml',
};

const entries = Array.from({ length: 81 }, (_, index) => ({
  id: `GD-S33-TEST-${String(index + 1).padStart(3, '0')}`,
  strippedText: `Issuer ${index + 1} issued credential ${index + 1}.`,
  groundTruth: { credentialType: 'OTHER', subType: 'other' },
})) as never;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function generationResponse(text = '{"credentialType":"OTHER","subType":"other","confidence":0.9}') {
  return {
    candidates: [{
      finishReason: 'STOP',
      content: { parts: [{ text }] },
    }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
}

function prodInput(
  fetchImpl: typeof fetch,
  now: () => Date = () => new Date('2026-07-14T12:00:00Z'),
): Parameters<typeof runS33ProdReplay>[0] {
  return {
    apiKey: 'test-api-key', entries, fetchImpl, now, producer,
    workerRoot: join(process.cwd()), workflow,
  };
}

function embeddingInput(
  fetchImpl: typeof fetch,
  now: () => Date = () => new Date('2026-07-14T12:00:00Z'),
): Parameters<typeof runS33EmbeddingDiagnostic>[0] {
  return {
    apiKey: 'test-api-key',
    corpus: [{ path: 'training-data/one.txt', content: 'alpha beta gamma delta epsilon zeta' }],
    entries,
    fetchImpl,
    now,
    producer,
    workflow,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENABLE_AI_EXTRACTION = 'true';
  delete process.env.GEMINI_TUNED_MODEL;
  delete process.env.GEMINI_V6_PROMPT;
  delete process.env.GEMINI_TUNED_RESPONSE_SCHEMA;
  mockGetGenerativeModel.mockReturnValue({ generateContent: mockGenerateContent });
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('S3.3 prerequisite runner network contracts', () => {
  it('issues exactly 81 ordered, no-retry prod requests with the production system/body/model', async () => {
    let callIndex = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      );
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('test-api-key');
      const body = JSON.parse(String(init?.body)) as {
        contents: Array<{ role: string; parts: Array<{ text: string }> }>;
        generationConfig: Record<string, unknown>;
        systemInstruction: { role: string; parts: Array<{ text: string }> };
      };
      expect(body.systemInstruction).toEqual({ role: 'system', parts: [{ text: EXTRACTION_SYSTEM_PROMPT }] });
      expect(body.generationConfig).toEqual({
        responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 2048,
      });
      const entry = (entries as unknown as Array<{ strippedText: string }>)[callIndex];
      expect(body.contents).toEqual([{ role: 'user', parts: [{
        text: buildExtractionPrompt(entry.strippedText, 'OTHER', undefined),
      }] }]);
      callIndex += 1;
      return jsonResponse(generationResponse());
    }) as unknown as typeof fetch;

    const report = await runS33ProdReplay(prodInput(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(81);
    expect(report.requestCount).toBe(81);
    expect(report.retryCount).toBe(0);
    expect((report.results as Array<Record<string, unknown>>).map(({ id }) => id))
      .toEqual((entries as Array<{ id: string }>).map(({ id }) => id));
  });

  it.each([
    ['HTTP failure', () => jsonResponse({ error: 'quota' }, 429), /HTTP 429/u],
    ['MAX_TOKENS', () => jsonResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), /blocked/u],
    ['empty output', () => jsonResponse(generationResponse('   ')), /empty model text/u],
    ['missing candidates', () => jsonResponse({ usageMetadata: {} }), /no candidate/u],
    ['malformed JSON', () => jsonResponse(generationResponse('{ definitely-not-json')), /JSON/u],
  ])('fails %s on the first attempt without retry or partial report', async (_label, response, message) => {
    const fetchImpl = vi.fn(async () => response()) as unknown as typeof fetch;
    await expect(runS33ProdReplay(prodInput(fetchImpl))).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a rejected/timeout fetch', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('timed out', 'AbortError');
    }) as unknown as typeof fetch;
    await expect(runS33ProdReplay(prodInput(fetchImpl))).rejects.toThrow(/timed out/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails input and 45-minute deadline caps before issuing an out-of-contract request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(generationResponse())) as unknown as typeof fetch;
    const oversized = (entries as unknown as Array<Record<string, unknown>>).map((entry, index) => index === 0
      ? { ...entry, strippedText: 'x'.repeat(50_001) }
      : entry) as never;
    await expect(runS33ProdReplay({ ...prodInput(fetchImpl), entries: oversized } as never))
      .rejects.toThrow(/50,000 characters/u);
    expect(fetchImpl).not.toHaveBeenCalled();

    const times = [
      new Date('2026-07-14T12:00:00Z'),
      new Date('2026-07-14T12:45:00Z'),
    ];
    await expect(runS33ProdReplay(prodInput(fetchImpl, () => times.shift()!)))
      .rejects.toThrow(/45-minute deadline/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('batches embeddings at <=16, pins every request to 3072 dimensions, and makes exactly six calls', async () => {
    const batchSizes: number[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('gemini-embedding-001:batchEmbedContents');
      const body = JSON.parse(String(init?.body)) as { requests: Array<Record<string, unknown>> };
      batchSizes.push(body.requests.length);
      expect(body.requests.every((request) => request.outputDimensionality === 3072)).toBe(true);
      expect(body.requests.every((request) => request.taskType === 'SEMANTIC_SIMILARITY')).toBe(true);
      return jsonResponse({ embeddings: body.requests.map(() => ({ values: Array(3072).fill(0.01) })) });
    }) as unknown as typeof fetch;

    const report = await runS33EmbeddingDiagnostic(embeddingInput(fetchImpl));
    expect(batchSizes).toEqual([16, 16, 16, 16, 16, 2]);
    expect(report.vectorInputCount).toBe(82);
    expect(report.requestCount).toBe(6);
    expect(report.retryCount).toBe(0);
  });

  it.each([
    ['dimension drift', Array(3071).fill(0.01)],
    ['nonfinite value', [...Array(3071).fill(0.01), Number.POSITIVE_INFINITY]],
  ])('rejects embedding %s after one call without retry', async (_label, vector) => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({ embeddings: body.requests.map(() => ({ values: vector })) }),
      } as Response;
    }) as unknown as typeof fetch;
    await expect(runS33EmbeddingDiagnostic(embeddingInput(fetchImpl))).rejects.toThrow(/3072 finite/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['HTTP failure', async () => jsonResponse({ error: 'unavailable' }, 503), /HTTP 503/u],
    ['response-count mismatch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
      return jsonResponse({ embeddings: body.requests.slice(1).map(() => ({ values: Array(3072).fill(0.01) })) });
    }, /count does not match/u],
  ])('rejects embedding %s after one call without retry', async (_label, implementation, message) => {
    const fetchImpl = vi.fn(implementation as (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>) as unknown as typeof fetch;
    await expect(runS33EmbeddingDiagnostic(embeddingInput(fetchImpl))).rejects.toThrow(message);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('enforces the 60-minute embedding deadline before a request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const times = [
      new Date('2026-07-14T12:00:00Z'),
      new Date('2026-07-14T13:00:00Z'),
    ];
    await expect(runS33EmbeddingDiagnostic(embeddingInput(fetchImpl, () => times.shift()!)))
      .rejects.toThrow(/60-minute deadline/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('S3.3 prerequisite parser parity', () => {
  it.each([
    {
      name: 'clean no-signal extraction',
      type: 'OTHER',
      source: 'Unclassified credential with neutral metadata.',
      text: '{"credentialType":"OTHER","subType":"other","confidence":"0.9"}',
    },
    {
      name: 'fenced/coerced extraction',
      type: 'CLE',
      source: 'State Bar CLE Credits Awarded: 3.5. Course ID: LAW-22. Delivery Method: Live.',
      text: '```json\n{"credentialType":"CLE","creditHours":"3.5","courseId":["LAW-22"],"confidence":0.8}\n```',
    },
    {
      name: 'cross-field fraud-signal merge',
      type: 'LICENSE',
      source: 'Example professional license.',
      text: '{"credentialType":"LICENSE","issuedDate":"2030-01-01","expiryDate":"2020-01-01","fraudSignals":["existing"],"confidence":0.7}',
    },
    {
      name: 'per-type invalid field stripping',
      type: 'DEGREE',
      source: 'University Example degree credential.',
      text: '{"credentialType":"DEGREE","issuerName":"University Example","creditHours":9,"confidence":0.8}',
    },
    {
      name: 'professional-education malformed-response recovery',
      type: 'CPE',
      source: 'CPE Credits: 8. Course ID: CPE-8. Delivery Method: Online. NASBA Registry Status: Active.',
      text: 'not-json-at-all',
    },
  ])('matches successful production final fields for $name', async ({ type, source, text }) => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => text, usageMetadata: { totalTokenCount: 10 } },
    });
    const provider = new GeminiProvider('test-key');
    const production = await provider.extractMetadata({
      strippedText: source,
      credentialType: type,
      fingerprint: 'f'.repeat(64),
    });
    expect(parseS33ProductionExtractionResponse(text, source, type)).toEqual(production.fields);
    if (type === 'LICENSE') expect(production.fields.fraudSignals).toContain('SUSPICIOUS_DATES');
    if (type === 'OTHER') expect(production.fields.fraudSignals ?? []).toEqual([]);
    if (type === 'DEGREE') expect(production.fields).not.toHaveProperty('creditHours');
  });

  it('rejects malformed non-professional output and a non-object credential payload', () => {
    expect(() => parseS33ProductionExtractionResponse(
      'not-json', 'University Example degree.', 'DEGREE',
    )).toThrow(/JSON/u);
    expect(() => parseS33ProductionExtractionResponse(
      '["DEGREE"]', 'University Example degree.', 'DEGREE',
    )).toThrow(/JSON object/u);
  });

  it('fails closed at the shared extraction-schema boundary in both offline and production paths', async () => {
    const schemaSpy = vi.spyOn(ExtractedFieldsSchema, 'safeParse').mockReturnValue({
      success: false,
      error: { message: 'forced schema-boundary failure' },
    } as never);
    const text = '{"credentialType":"OTHER","subType":"other","confidence":0.9}';
    try {
      expect(() => parseS33ProductionExtractionResponse(text, 'Neutral credential.', 'OTHER'))
        .toThrow(/Extraction schema validation failed/u);
      mockGenerateContent.mockResolvedValue({
        response: { text: () => text, usageMetadata: { totalTokenCount: 10 } },
      });
      vi.useFakeTimers();
      const provider = new GeminiProvider('test-key');
      const productionRejection = expect(provider.extractMetadata({
        strippedText: 'Neutral credential.',
        credentialType: 'OTHER',
        fingerprint: 'f'.repeat(64),
      })).rejects.toThrow(/Extraction schema validation failed/u);
      await vi.runAllTimersAsync();
      await productionRejection;
    } finally {
      vi.useRealTimers();
      schemaSpy.mockRestore();
    }
  });
});

describe('S3.3 prerequisite CLI and atomic output', () => {
  const validEnvironment = {
    ENABLE_AI_EXTRACTION: 'true',
    GEMINI_API_KEY: 'test-key',
    GITHUB_RUN_ID: '12345',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_REPOSITORY: 'carson-see/ArkovaCarson',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTIONS: 'true',
  };

  it('requires the fixed workflow environment and rejects every model/tuned/schema override', () => {
    expect(validateS33PrerequisiteEnvironment(validEnvironment)).toMatchObject({ apiKey: 'test-key' });
    expect(() => validateS33PrerequisiteEnvironment({
      ...validEnvironment, ENABLE_AI_EXTRACTION: 'false',
    })).toThrow(/ENABLE_AI_EXTRACTION/u);
    expect(() => validateS33PrerequisiteEnvironment({
      ...validEnvironment, GITHUB_RUN_ID: String(Number.MAX_SAFE_INTEGER + 1),
    })).toThrow(/safe-integer/u);
    for (const name of [
      'GEMINI_TUNED_MODEL', 'GEMINI_V6_PROMPT', 'GEMINI_TUNED_RESPONSE_SCHEMA',
      'GEMINI_MODEL', 'GEMINI_EMBEDDING_MODEL',
    ]) {
      expect(() => validateS33PrerequisiteEnvironment({
        ...validEnvironment, [name]: 'forbidden',
      })).toThrow(new RegExp(name, 'u'));
    }
  });

  it('accepts only the exact subcommand and two unique flags', () => {
    expect(parseS33PrerequisiteCliArgs([
      'prerequisites', '--producer-head', 'a'.repeat(40), '--raw-output-dir', './out',
    ])).toEqual({ producerHeadSha: 'a'.repeat(40), rawOutputDir: join(process.cwd(), 'out') });
    expect(() => parseS33PrerequisiteCliArgs(['prerequisites'])).toThrow(/Expected/u);
    expect(() => parseS33PrerequisiteCliArgs([
      'prerequisites', '--producer-head', 'a', '--producer-head', 'b',
    ])).toThrow(/unique/u);
  });

  it('publishes both raw reports atomically and removes staging on serialization failure', () => {
    const parent = mkdtempSync(join(tmpdir(), 's33-prerequisite-output-'));
    roots.push(parent);
    const output = join(parent, 'raw');
    writeS33PrerequisiteRawReportsAtomically(output, { prod: { ok: true }, embedding: { ok: true } });
    expect(JSON.parse(readFileSync(join(output, 'prod-model-diff.raw.json'), 'utf8'))).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(output, 'embedding-diagnostic.raw.json'), 'utf8'))).toEqual({ ok: true });
    expect(() => writeS33PrerequisiteRawReportsAtomically(output, {
      prod: { ok: true }, embedding: { invalid: 1n },
    })).toThrow(/already exist/u);

    const failingOutput = join(parent, 'failed');
    expect(() => writeS33PrerequisiteRawReportsAtomically(failingOutput, {
      prod: { ok: true }, embedding: { invalid: 1n },
    })).toThrow(/BigInt/u);
    expect(readdirSync(parent).filter((name) => name.startsWith('.s33-wave1-prerequisite-'))).toEqual([]);
    expect(readdirSync(parent)).not.toContain('failed');
  });
});
