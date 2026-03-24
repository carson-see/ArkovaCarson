/**
 * Tests for Gemini AI Provider (P8-S1)
 *
 * All tests use mocked GoogleGenerativeAI — no real API calls (Constitution 1.7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('GeminiProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGenerativeModel.mockReturnValue({
      generateContent: mockGenerateContent,
      embedContent: mockEmbedContent,
    });
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
      expect(result.confidence).toBe(0.92);
      expect(result.provider).toBe('gemini');
      expect(result.tokensUsed).toBe(150);
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
      expect(result.confidence).toBe(1);
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
      expect(result.confidence).toBe(0.5);
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
      expect(result.confidence).toBe(0.7);
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
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
