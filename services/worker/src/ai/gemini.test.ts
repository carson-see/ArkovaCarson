/**
 * Tests for Gemini AI Provider (P8-S1)
 *
 * All tests use mocked GoogleGenerativeAI — no real API calls (Constitution 1.7).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger to avoid config dependency
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mock grounding verification to return neutral results (tested separately)
vi.mock('./grounding.js', () => ({
  verifyGrounding: vi.fn().mockReturnValue({
    fieldResults: [],
    groundingScore: 1.0,
    groundableFieldCount: 0,
    groundedFieldCount: 0,
    confidenceAdjustment: 0,
  }),
}));

// Mock @google/generative-ai
const mockGenerateContent = vi.fn();
const mockEmbedContent = vi.fn();
const mockGetGenerativeModel = vi.fn();

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class MockGoogleGenerativeAI {
      constructor() {
        // noop
      }
      getGenerativeModel(...args: unknown[]) {
        return mockGetGenerativeModel(...args);
      }
    },
  };
});

import { GeminiProvider } from './gemini.js';
import type { ExtractionRequest } from './types.js';
import { logger } from '../utils/logger.js';

function upstreamLogAttempts(): unknown[] {
  return vi.mocked(logger.error).mock.calls
    .filter(([details]) => (
      (details as { event?: unknown } | undefined)?.event === 'ai_upstream_http_error'
    ))
    .map(([details]) => (details as { attempt?: unknown }).attempt);
}

function upstreamLogRequestInstanceIds(): unknown[] {
  return vi.mocked(logger.error).mock.calls
    .filter(([details]) => (
      (details as { event?: unknown } | undefined)?.event === 'ai_upstream_http_error'
    ))
    .map(([details]) => (
      (details as { requestInstanceId?: unknown }).requestInstanceId
    ));
}

describe('GeminiProvider', () => {
  // §1.6: ENABLE_AI_EXTRACTION defaults TRUE in production. Mirror that here so the
  // standard extraction tests exercise the production-default state; tests that
  // assert the fail-closed guard (BUG-2026-06-24-015) override to 'false' locally.
  const originalExtractionFlag = process.env.ENABLE_AI_EXTRACTION;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENABLE_AI_EXTRACTION = 'true';
    mockGetGenerativeModel.mockReturnValue({
      generateContent: mockGenerateContent,
      embedContent: mockEmbedContent,
    });
  });
  afterEach(() => {
    if (originalExtractionFlag === undefined) {
      delete process.env.ENABLE_AI_EXTRACTION;
    } else {
      process.env.ENABLE_AI_EXTRACTION = originalExtractionFlag;
    }
  });

  describe('constructor', () => {
    it('throws if no API key provided', () => {
      const original = process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_API_KEY;
      expect(() => new GeminiProvider()).toThrow('GEMINI_API_KEY is required');
      process.env.GEMINI_API_KEY = original;
    });

    it('accepts explicit API key', () => {
      const provider = new GeminiProvider('test-key');
      expect(provider.name).toBe('gemini');
    });
  });

  describe('generateExtractionJson (ENABLE_AI_EXTRACTION gate)', () => {
    it('throws when AI extraction is disabled (no raw-mode bypass)', async () => {
      const original = process.env.ENABLE_AI_EXTRACTION;
      process.env.ENABLE_AI_EXTRACTION = 'false';
      try {
        const provider = new GeminiProvider('test-key');
        await expect(
          provider.generateExtractionJson({ systemPrompt: 'sys', userPrompt: 'user' }),
        ).rejects.toThrow('ENABLE_AI_EXTRACTION');
        // The model must never be invoked when the gate is closed.
        expect(mockGenerateContent).not.toHaveBeenCalled();
      } finally {
        process.env.ENABLE_AI_EXTRACTION = original;
      }
    });

    it('runs when AI extraction is enabled', async () => {
      const original = process.env.ENABLE_AI_EXTRACTION;
      process.env.ENABLE_AI_EXTRACTION = 'true';
      mockGenerateContent.mockResolvedValue({
        response: { text: () => '{"courseId":"X"}', usageMetadata: { totalTokenCount: 12 } },
      });
      try {
        const provider = new GeminiProvider('test-key');
        const out = await provider.generateExtractionJson({ systemPrompt: 'sys', userPrompt: 'user' });
        expect(out.text).toContain('courseId');
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      } finally {
        process.env.ENABLE_AI_EXTRACTION = original;
      }
    });
  });

  describe('extractMetadata', () => {
    const request: ExtractionRequest = {
      strippedText: 'University of Michigan\nBachelor of Science\nComputer Science\nIssued: 2024-05-15',
      credentialType: 'DEGREE',
      fingerprint: 'a'.repeat(64),
      issuerHint: 'University of Michigan',
    };

    it('extracts metadata from PII-stripped text', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({
            credentialType: 'DEGREE',
            issuerName: 'University of Michigan',
            fieldOfStudy: 'Computer Science',
            degreeLevel: 'Bachelor',
            issuedDate: '2024-05-15',
            confidence: 0.92,
          }),
          usageMetadata: { totalTokenCount: 150 },
        },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.extractMetadata(request);

      expect(result.fields.credentialType).toBe('DEGREE');
      expect(result.fields.issuerName).toBe('University of Michigan');
      expect(result.fields.fieldOfStudy).toBe('Computer Science');
      // Meta-model adjusts raw confidence based on extraction features
      expect(result.confidence).toBeGreaterThan(0.85);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.provider).toBe('gemini');
      expect(result.tokensUsed).toBe(150);
    });

    it('salvages valid extraction fields instead of failing on schema drift', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({
            credentialType: 'CLE',
            issuerName: 'State Bar of Michigan',
            creditHours: '3.5',
            fraudSignals: [{ signal: 'font_mismatch', severity: 'low' }, 'date_mismatch'],
            unexpectedModelNote: 'extra keys should not fail the whole extraction',
            confidence: '0.78',
          }),
          usageMetadata: { totalTokenCount: 120 },
        },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.extractMetadata({
        ...request,
        credentialType: 'CLE',
      });

      expect(result.fields.credentialType).toBe('CLE');
      expect(result.fields.issuerName).toBe('State Bar of Michigan');
      expect(result.fields.creditHours).toBe(3.5);
      expect(result.fields.fraudSignals).toContain('font_mismatch');
      expect(result.fields.fraudSignals).toContain('date_mismatch');
      expect(result.fields).not.toHaveProperty('unexpectedModelNote');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('parses fenced JSON responses instead of failing extraction', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => [
            '```json',
            JSON.stringify({
              credentialType: 'DEGREE',
              issuerName: 'University of Michigan',
              confidence: 0.82,
            }),
            '```',
          ].join('\n'),
          usageMetadata: { totalTokenCount: 90 },
        },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.extractMetadata(request);

      expect(result.fields.credentialType).toBe('DEGREE');
      expect(result.fields.issuerName).toBe('University of Michigan');
    });

    it('repairs common malformed Gemini JSON instead of falling back on SyntaxError', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => [
            '{',
            '  "credentialType": "CERTIFICATE",',
            '  "issuerName": "Ridgeline Professional Education Institute",',
            '  "reasoning": "Clean certificate',
            'with line break",',
            '  "confidence": 0.9,',
            '}',
          ].join('\n'),
          usageMetadata: { totalTokenCount: 140 },
        },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.extractMetadata({
        strippedText: [
          'Certificate of Completion — Continuing Professional Education.',
          'Course ID: RPEI-TAX-2026-041.',
          'CPE Credits: 8.0.',
          'Delivery Method: Group Internet Based.',
          'NASBA Registry Status: Active.',
          'Completion Date: April 14, 2026.',
        ].join(' '),
        credentialType: 'CPE',
        fingerprint: 'b'.repeat(64),
      });

      expect(result.provider).toBe('gemini');
      expect(result.fields.credentialType).toBe('CPE');
      expect(result.fields.creditHours).toBe(8);
    });

    it('normalizes explicit CPE fields from source text for the live eval gate', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({
            credentialType: 'CERTIFICATE',
            issuerName: 'Blue Harbor CPA Academy',
            fieldOfStudy: 'Auditing',
            confidence: 0.9,
          }),
          usageMetadata: { totalTokenCount: 130 },
        },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.extractMetadata({
        strippedText: [
          'Blue Harbor CPA Academy hereby certifies completion.',
          'Program Code BHCA-AUD-2025-217.',
          'Credits Awarded: 6.0 CPE.',
          'Delivery Method: QAS Self Study.',
          'NASBA Sponsor Registry: Active.',
        ].join(' '),
        credentialType: 'CPE',
        fingerprint: 'c'.repeat(64),
      });

      expect(result.fields.credentialType).toBe('CPE');
      expect(result.fields.creditType).toBe('CPE');
      expect(result.fields.creditHours).toBe(6);
      expect(result.fields.courseId).toBe('BHCA-AUD-2025-217');
      expect(result.fields.activityNumber).toBe('BHCA-AUD-2025-217');
      expect(result.fields.deliveryMethod).toBe('QAS Self Study');
      expect(result.fields.nasbaStatus).toBe('active');
    });

    it('clamps confidence to [0, 1] range', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({ confidence: 1.5, credentialType: 'DEGREE' }),
          usageMetadata: { totalTokenCount: 50 },
        },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.extractMetadata(request);
      // Cross-field checks and grounding may adjust confidence down from 1.0
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('defaults confidence to 0.5 if not provided', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({ credentialType: 'CERTIFICATE' }),
          usageMetadata: { totalTokenCount: 50 },
        },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.extractMetadata(request);
      // Meta-model adjusts default 0.5 confidence based on extraction features
      expect(result.confidence).toBeGreaterThan(0.4);
      expect(result.confidence).toBeLessThanOrEqual(0.8);
    });

    it('uses structured JSON output mode', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => JSON.stringify({ confidence: 0.8 }),
          usageMetadata: { totalTokenCount: 50 },
        },
      });

      const provider = new GeminiProvider('test-key');
      await provider.extractMetadata(request);

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          generationConfig: expect.objectContaining({
            responseMimeType: 'application/json',
            temperature: 0.1,
          }),
        }),
      );
    });

    it('retries on transient errors', async () => {
      mockGenerateContent
        .mockRejectedValueOnce(new Error('UNAVAILABLE'))
        .mockResolvedValue({
          response: {
            text: () => JSON.stringify({ confidence: 0.7 }),
            usageMetadata: { totalTokenCount: 50 },
          },
        });

      const provider = new GeminiProvider('test-key');
      const result = await provider.extractMetadata(request);
      // Meta-model adjusts raw 0.7 confidence based on extraction features
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.confidence).toBeLessThanOrEqual(0.85);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
    });

    it('emits bounded retry-loop attempt identity on every Developer API 429', async () => {
      vi.useFakeTimers();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      mockGenerateContent.mockRejectedValue({
        status: 429,
        message: 'Jane Doe jane.doe@example.com secret-provider-body',
        headers: { get: (name: string) => (name === 'retry-after' ? '11' : null) },
      });

      try {
        const provider = new GeminiProvider('test-key');
        const outcome = provider.extractMetadata(request).catch((error: unknown) => error);
        await vi.runAllTimersAsync();
        const error = await outcome;

        expect(error).toMatchObject({
          name: 'AIProviderHttpError',
          status: 429,
          retryAfterSec: 11,
          apiSurface: 'Developer-API',
        });
        expect(mockGenerateContent).toHaveBeenCalledTimes(3);
        expect(upstreamLogAttempts()).toEqual([1, 2, 3]);
        expect(upstreamLogRequestInstanceIds()).toHaveLength(3);
        expect(new Set(upstreamLogRequestInstanceIds()).size).toBe(1);
        expect(upstreamLogRequestInstanceIds()[0]).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        const serializedLogs = JSON.stringify(vi.mocked(logger.error).mock.calls);
        expect(serializedLogs).not.toContain('Jane Doe');
        expect(serializedLogs).not.toContain('jane.doe@example.com');
        expect(serializedLogs).not.toContain('secret-provider-body');
      } finally {
        randomSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('generates a distinct server request-instance ID for each withRetry invocation', async () => {
      vi.useFakeTimers();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      mockGenerateContent.mockRejectedValue({ status: 429, message: 'rate limited' });

      try {
        const provider = new GeminiProvider('test-key');
        const firstOutcome = provider.extractMetadata(request).catch((error: unknown) => error);
        await vi.runAllTimersAsync();
        await firstOutcome;
        const firstIds = upstreamLogRequestInstanceIds();

        vi.mocked(logger.error).mockClear();
        const secondOutcome = provider.extractMetadata(request).catch((error: unknown) => error);
        await vi.runAllTimersAsync();
        await secondOutcome;
        const secondIds = upstreamLogRequestInstanceIds();

        expect(firstIds).toHaveLength(3);
        expect(secondIds).toHaveLength(3);
        expect(new Set(firstIds).size).toBe(1);
        expect(new Set(secondIds).size).toBe(1);
        expect(firstIds[0]).not.toBe(secondIds[0]);
      } finally {
        randomSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('does not retry on auth errors', async () => {
      mockGenerateContent.mockRejectedValue(new Error('API_KEY_INVALID'));

      const provider = new GeminiProvider('test-key');
      await expect(provider.extractMetadata(request)).rejects.toThrow('API_KEY_INVALID');
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    });

    it('throws after max retries', async () => {
      mockGenerateContent.mockRejectedValue(new Error('UNAVAILABLE'));

      const provider = new GeminiProvider('test-key');
      await expect(provider.extractMetadata(request)).rejects.toThrow('UNAVAILABLE');
      expect(mockGenerateContent).toHaveBeenCalledTimes(3);
    });

    // BUG-2026-06-24-015: in-provider §1.6 fail-closed guard. The production
    // extraction path must not rely solely on route middleware — a routing
    // regression must not let extraction run while the launch-gate is off.
    describe('ENABLE_AI_EXTRACTION fail-closed guard (§1.6)', () => {
      it('fails closed when ENABLE_AI_EXTRACTION is explicitly not "true"', async () => {
        const original = process.env.ENABLE_AI_EXTRACTION;
        process.env.ENABLE_AI_EXTRACTION = 'false';
        try {
          const provider = new GeminiProvider('test-key');
          await expect(provider.extractMetadata(request)).rejects.toThrow('ENABLE_AI_EXTRACTION');
          // The model must never be invoked when the gate is closed.
          expect(mockGenerateContent).not.toHaveBeenCalled();
        } finally {
          process.env.ENABLE_AI_EXTRACTION = original;
        }
      });

      it('runs normally when ENABLE_AI_EXTRACTION is "true" (prod default)', async () => {
        const original = process.env.ENABLE_AI_EXTRACTION;
        process.env.ENABLE_AI_EXTRACTION = 'true';
        mockGenerateContent.mockResolvedValue({
          response: {
            text: () => JSON.stringify({ credentialType: 'DEGREE', confidence: 0.9 }),
            usageMetadata: { totalTokenCount: 50 },
          },
        });
        try {
          const provider = new GeminiProvider('test-key');
          const result = await provider.extractMetadata(request);
          expect(result.fields.credentialType).toBe('DEGREE');
          expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        } finally {
          process.env.ENABLE_AI_EXTRACTION = original;
        }
      });
    });
  });

  // BUG-2026-06-24-014: generateTags and reconstructTemplate must use the same
  // hardened JSON pipeline (markdown-fence strip + comment strip + brace-salvage)
  // that extractMetadata uses. Gemini Flash routinely ```json-fences and truncates
  // output; a naked JSON.parse throws SyntaxError → HTTP 500 on /ai/tags + /ai/template.
  describe('generateTags (hardened JSON parsing)', () => {
    const fields = { credentialType: 'DEGREE', issuerName: 'University of Michigan' };

    it('parses ```json-fenced tag responses instead of throwing SyntaxError', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => [
            '```json',
            JSON.stringify({
              tags: ['degree', 'university'],
              documentType: 'Academic Credential',
              category: 'Education',
              subcategory: 'Higher Education',
            }),
            '```',
          ].join('\n'),
          usageMetadata: { totalTokenCount: 30 },
        },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.generateTags(fields);

      expect(result.tags).toEqual(['degree', 'university']);
      expect(result.documentType).toBe('Academic Credential');
      expect(result.category).toBe('Education');
    });

    it('salvages a truncated tag payload with trailing junk after the closing brace', async () => {
      // Flash sometimes appends a stray continuation token / prose after the JSON
      // object; naked JSON.parse rejects the whole string. Brace-salvage recovers it.
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () =>
            `${JSON.stringify({
              tags: ['license'],
              documentType: 'License',
              category: 'Legal',
              subcategory: 'Bar',
            })}\nNote: truncated response continues here without closing fence`,
          usageMetadata: { totalTokenCount: 28 },
        },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.generateTags(fields);

      expect(result.tags).toEqual(['license']);
      expect(result.documentType).toBe('License');
    });
  });

  describe('reconstructTemplate (hardened JSON parsing)', () => {
    const fields = { credentialType: 'DEGREE', issuerName: 'University of Michigan' };

    const validTemplate = {
      templateType: 'formal' as const,
      documentTitle: 'Bachelor of Science',
      sections: [
        {
          heading: 'Credential',
          fields: [{ label: 'Issuer', value: 'University of Michigan', displayType: 'text' as const }],
        },
      ],
      tags: ['degree'],
      documentType: 'Academic Credential',
      summary: 'A bachelor of science degree.',
      verificationNotes: null,
    };

    it('parses ```json-fenced template responses instead of throwing SyntaxError', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => ['```json', JSON.stringify(validTemplate), '```'].join('\n'),
          usageMetadata: { totalTokenCount: 200 },
        },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.reconstructTemplate(fields, 0.9);

      expect(result.templateType).toBe('formal');
      expect(result.documentTitle).toBe('Bachelor of Science');
      expect(result.sections).toHaveLength(1);
      // tokensUsed is attached from usageMetadata after parse.
      expect(result.tokensUsed).toBe(200);
    });

    it('salvages a truncated template payload with trailing junk after the closing brace', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () =>
            `${JSON.stringify(validTemplate)} <-- model kept emitting past the object`,
          usageMetadata: { totalTokenCount: 180 },
        },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.reconstructTemplate(fields, 0.9);

      expect(result.templateType).toBe('formal');
      expect(result.summary).toBe('A bachelor of science degree.');
      expect(result.tokensUsed).toBe(180);
    });
  });

  describe('generateEmbedding', () => {
    it('returns embedding vector', async () => {
      const mockValues = new Array(768).fill(0.1);
      // generateEmbedding uses fetch directly (REST API), not the SDK's embedContent
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ embedding: { values: mockValues } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const provider = new GeminiProvider('test-key');
      const result = await provider.generateEmbedding('University of Michigan Computer Science');

      expect(result.embedding).toHaveLength(768);
      expect(result.model).toBe('gemini-embedding-001');
      fetchSpy.mockRestore();
    });

    it('uses the Gemini batchEmbedContents endpoint for native batch embeddings', async () => {
      const first = new Array(768).fill(0.1);
      const second = new Array(768).fill(0.2);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          embeddings: [
            { values: first },
            { values: second },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const provider = new GeminiProvider('test-key');
      const result = await provider.generateEmbeddings([
        { text: 'DEGREE University of Michigan' },
        { text: 'CERTIFICATE Example Academy' },
      ], 'RETRIEVAL_DOCUMENT');

      expect(result.embeddings).toHaveLength(2);
      expect(result.embeddings[0].embedding).toEqual(first);
      expect(result.embeddings[1].embedding).toEqual(second);
      expect(result.model).toBe('gemini-embedding-001');
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(':batchEmbedContents'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'x-goog-api-key': 'test-key' }),
        }),
      );
      const requestBody = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as {
        requests: Array<{ taskType: string; content: { parts: Array<{ text: string }> } }>;
      };
      expect(requestBody.requests).toHaveLength(2);
      expect(requestBody.requests[0]).toMatchObject({
        model: 'models/gemini-embedding-001',
        taskType: 'RETRIEVAL_DOCUMENT',
        outputDimensionality: 768,
        content: { parts: [{ text: 'DEGREE University of Michigan' }] },
      });
      fetchSpy.mockRestore();
    });

    it('does not log raw batch embedding error bodies that may contain PII', async () => {
      const piiErrorBody = JSON.stringify({
        error: {
          message: 'Invalid text: Jane Doe jane.doe@example.com SSN 123-45-6789',
          echoedRequest: 'Jane Doe credential text',
        },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
        new Response(piiErrorBody, {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(piiErrorBody.length),
          },
        })
      ));

      const provider = new GeminiProvider('test-key');
      await expect(provider.generateEmbeddings([
        { text: 'Jane Doe credential text' },
      ])).rejects.toThrow('Batch embedding generation failed (status 500)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 500,
          contentLength: String(piiErrorBody.length),
          model: 'gemini-embedding-001',
        }),
        'Gemini batch embedding API error',
      );
      for (const call of vi.mocked(logger.error).mock.calls) {
        expect(JSON.stringify(call)).not.toContain('Jane Doe');
        expect(JSON.stringify(call)).not.toContain('jane.doe@example.com');
        expect(JSON.stringify(call)).not.toContain('123-45-6789');
        expect(JSON.stringify(call)).not.toContain('echoedRequest');
        expect(JSON.stringify(call)).not.toContain(piiErrorBody);
      }
      fetchSpy.mockRestore();
    });

    it('passes an abort timeout signal to batch embedding fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          embeddings: [{ values: new Array(768).fill(0.1) }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const provider = new GeminiProvider('test-key');
      await provider.generateEmbeddings([{ text: 'DEGREE University of Michigan' }]);

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      fetchSpy.mockRestore();
    });

    it('rejects malformed native batch embedding vectors', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
        new Response(JSON.stringify({
          embeddings: [
            { values: new Array(768).fill(0.1) },
            { values: [0.2, Number.POSITIVE_INFINITY] },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      ));

      const provider = new GeminiProvider('test-key');
      await expect(provider.generateEmbeddings([
        { text: 'DEGREE University of Michigan' },
        { text: 'CERTIFICATE Example Academy' },
      ])).rejects.toThrow('Batch embedding generation returned malformed embedding data');

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 1,
          expectedDim: 768,
          actualDim: 2,
          valuesType: 'array',
          model: 'gemini-embedding-001',
        }),
        'Gemini batch embedding API returned malformed embedding data',
      );
      fetchSpy.mockRestore();
    });

    it('preserves a Developer API 429 and Retry-After through every safe retry clone', async () => {
      vi.useFakeTimers();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const providerErrorBody = JSON.stringify({
        error: {
          message: 'Quota hit for Jane Doe jane.doe@example.com',
          apiKey: 'secret-provider-key',
        },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => (
        new Response(providerErrorBody, {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(providerErrorBody.length),
            'Retry-After': '17',
          },
        })
      ));

      try {
        const provider = new GeminiProvider('test-key');
        const outcome = provider.generateEmbedding('PII-stripped input').then(
          () => null,
          (error: unknown) => error,
        );
        await vi.runAllTimersAsync();
        const error = await outcome;

        expect(error).toMatchObject({
          name: 'AIProviderHttpError',
          status: 429,
          retryAfterSec: 17,
          apiSurface: 'Developer-API',
          model: 'gemini-embedding-001',
          region: 'global',
          v6PromptActive: false,
          responseSchema: 'unset',
          responseMimeType: 'application/json',
        });
        expect(fetchSpy).toHaveBeenCalledTimes(3);
        expect(upstreamLogAttempts()).toEqual([1, 2, 3]);
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'ai_upstream_http_error',
            bucket: 'upstream-model',
            status: 429,
            retryAfterSec: 17,
            apiSurface: 'Developer-API',
          }),
          'Gemini embedding API error',
        );
        const serializedLogs = JSON.stringify(vi.mocked(logger.error).mock.calls);
        expect(serializedLogs).not.toContain('Jane Doe');
        expect(serializedLogs).not.toContain('jane.doe@example.com');
        expect(serializedLogs).not.toContain('secret-provider-key');
        expect(serializedLogs).not.toContain(providerErrorBody);
      } finally {
        fetchSpy.mockRestore();
        randomSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe('tuned Vertex upstream errors', () => {
    it('preserves 429 provenance and Retry-After without retaining or logging the provider body', async () => {
      vi.useFakeTimers();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const originalTunedModel = process.env.GEMINI_TUNED_MODEL;
      const originalV6Prompt = process.env.GEMINI_V6_PROMPT;
      const originalResponseSchema = process.env.GEMINI_TUNED_RESPONSE_SCHEMA;
      const tunedModel = 'projects/arkova1/locations/us-central1/endpoints/6611494259700793344';
      process.env.GEMINI_TUNED_MODEL = tunedModel;
      process.env.GEMINI_V6_PROMPT = 'true';
      delete process.env.GEMINI_TUNED_RESPONSE_SCHEMA;

      const providerErrorBody = JSON.stringify({
        error: {
          message: 'Quota hit while processing Jane Doe jane.doe@example.com',
          authorization: 'Bearer secret-token',
        },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        if (String(input).includes('metadata.google.internal')) {
          return new Response(JSON.stringify({ access_token: 'metadata-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(providerErrorBody, {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(providerErrorBody.length),
            'Retry-After': '23',
          },
        });
      });

      try {
        const provider = new GeminiProvider('test-key');
        const outcome = provider.extractMetadata({
          strippedText: 'PII-stripped credential text',
          credentialType: 'DEGREE',
          fingerprint: 'a'.repeat(64),
        }).then(
          () => null,
          (error: unknown) => error,
        );
        await vi.runAllTimersAsync();
        const error = await outcome;

        expect(error).toMatchObject({
          name: 'AIProviderHttpError',
          status: 429,
          retryAfterSec: 23,
          apiSurface: 'Vertex-regional',
          model: tunedModel,
          region: 'us-central1',
          v6PromptActive: true,
          responseSchema: 'unset',
          responseMimeType: 'application/json',
        });
        expect(fetchSpy).toHaveBeenCalledTimes(6);
        expect(upstreamLogAttempts()).toEqual([1, 2, 3]);
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'ai_upstream_http_error',
            bucket: 'upstream-model',
            status: 429,
            retryAfterSec: 23,
            apiSurface: 'Vertex-regional',
            model: tunedModel,
            region: 'us-central1',
            v6PromptActive: true,
            responseSchema: 'unset',
          }),
          'Vertex AI tuned model error',
        );
        const serializedLogs = JSON.stringify(vi.mocked(logger.error).mock.calls);
        expect(serializedLogs).not.toContain('Jane Doe');
        expect(serializedLogs).not.toContain('jane.doe@example.com');
        expect(serializedLogs).not.toContain('secret-token');
        expect(serializedLogs).not.toContain(providerErrorBody);
      } finally {
        fetchSpy.mockRestore();
        randomSpy.mockRestore();
        vi.useRealTimers();
        if (originalTunedModel === undefined) delete process.env.GEMINI_TUNED_MODEL;
        else process.env.GEMINI_TUNED_MODEL = originalTunedModel;
        if (originalV6Prompt === undefined) delete process.env.GEMINI_V6_PROMPT;
        else process.env.GEMINI_V6_PROMPT = originalV6Prompt;
        if (originalResponseSchema === undefined) delete process.env.GEMINI_TUNED_RESPONSE_SCHEMA;
        else process.env.GEMINI_TUNED_RESPONSE_SCHEMA = originalResponseSchema;
      }
    });
  });

  describe('healthCheck', () => {
    it('returns healthy when API responds', async () => {
      mockGenerateContent.mockResolvedValue({
        response: { text: () => 'pong' },
      });

      const provider = new GeminiProvider('test-key');
      const result = await provider.healthCheck();

      expect(result.healthy).toBe(true);
      expect(result.provider).toBe('gemini');
      expect(result.mode).toBe('direct');
    });

    it('returns unhealthy on error', async () => {
      mockGenerateContent.mockRejectedValue(new Error('connection timeout'));

      const provider = new GeminiProvider('test-key');
      const result = await provider.healthCheck();

      expect(result.healthy).toBe(false);
    });
  });

  describe('circuit breaker', () => {
    it('opens circuit after consecutive failures', async () => {
      vi.useFakeTimers();

      // Auth errors skip retries, so each call = 1 failure record
      mockGenerateContent.mockRejectedValue(new Error('API_KEY_INVALID'));

      const provider = new GeminiProvider('test-key');
      const request: ExtractionRequest = {
        strippedText: 'test',
        credentialType: 'DEGREE',
        fingerprint: 'a'.repeat(64),
      };

      // 5 consecutive auth failures → circuit opens
      for (let i = 0; i < 5; i++) {
        await expect(provider.extractMetadata(request)).rejects.toThrow('API_KEY_INVALID');
      }

      // Circuit should now be open
      await expect(provider.extractMetadata(request)).rejects.toThrow('circuit breaker open');

      vi.useRealTimers();
    });
  });
});
