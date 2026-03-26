/**
 * Together AI Provider Tests (PH1-INT-04)
 *
 * Tests for TogetherProvider — Together AI's OpenAI-compatible inference API.
 * Uses fetch mocking (no real API calls per Constitution 1.7).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger to avoid config dependency
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TogetherProvider } from './together.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('TogetherProvider', () => {
  const FAKE_API_KEY = 'test-together-api-key-123';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TOGETHER_API_KEY = FAKE_API_KEY;
  });

  afterEach(() => {
    delete process.env.TOGETHER_API_KEY;
    delete process.env.TOGETHER_MODEL;
    delete process.env.TOGETHER_EMBEDDING_MODEL;
  });

  describe('constructor', () => {
    it('throws if no API key provided', () => {
      delete process.env.TOGETHER_API_KEY;
      expect(() => new TogetherProvider()).toThrow('TOGETHER_API_KEY is required');
    });

    it('accepts explicit API key parameter', () => {
      delete process.env.TOGETHER_API_KEY;
      const provider = new TogetherProvider('explicit-key');
      expect(provider.name).toBe('together');
    });

    it('reads API key from env', () => {
      const provider = new TogetherProvider();
      expect(provider.name).toBe('together');
    });
  });

  describe('extractMetadata', () => {
    it('calls Together AI chat completion and returns validated fields', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'chatcmpl-123',
          object: 'chat.completion',
          model: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  credentialType: 'DEGREE',
                  issuerName: 'MIT',
                  fieldOfStudy: 'Computer Science',
                  degreeLevel: 'Master of Science',
                  issuedDate: '2024-06-15',
                  confidence: 0.92,
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      });

      const result = await provider.extractMetadata({
        strippedText: '[NAME_REDACTED] graduated from MIT with Master of Science in Computer Science on June 15, 2024',
        credentialType: 'DEGREE',
        fingerprint: 'sha256:abc123',
      });

      expect(result.fields.issuerName).toBe('MIT');
      expect(result.fields.credentialType).toBe('DEGREE');
      expect(result.provider).toBe('together');
      expect(result.tokensUsed).toBeDefined();

      // Verify fetch was called with Together AI endpoint
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.together.xyz/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${FAKE_API_KEY}`,
          }),
        }),
      );
    });

    it('retries on transient failures', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      // First call fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => 'Bad Gateway',
      });

      // Second call succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  credentialType: 'LICENSE',
                  issuerName: 'State Bar',
                  confidence: 0.85,
                }),
              },
            },
          ],
          usage: { total_tokens: 100 },
        }),
      });

      const result = await provider.extractMetadata({
        strippedText: 'Licensed by State Bar',
        credentialType: 'LICENSE',
        fingerprint: 'sha256:def456',
      });

      expect(result.fields.credentialType).toBe('LICENSE');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('generateEmbedding', () => {
    it('calls Together AI embedding endpoint', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);
      const fakeEmbedding = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.01));

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ embedding: fakeEmbedding }],
          model: 'togethercomputer/m2-bert-80M-8k-retrieval',
        }),
      });

      const result = await provider.generateEmbedding('test embedding text');

      expect(result.embedding).toHaveLength(768);
      expect(result.model).toContain('m2-bert');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.together.xyz/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${FAKE_API_KEY}`,
          }),
        }),
      );
    });
  });

  describe('healthCheck', () => {
    it('returns healthy on successful ping', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: 'pong' } }],
        }),
      });

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.provider).toBe('together');
      expect(health.mode).toBe('together-inference');
    });

    it('returns unhealthy on failure', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.provider).toBe('together');
    });
  });

  describe('generateRAGResponse', () => {
    it('generates RAG response for Nessie context mode', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: 'MIT is a leading research university.',
                  citations: [{ record_id: 'rec-1', quote: 'MIT...' }],
                  confidence: 0.88,
                }),
              },
            },
          ],
          usage: { total_tokens: 200 },
        }),
      });

      const result = await provider.generateRAGResponse(
        'You are Nessie, an AI research assistant.',
        'Tell me about MIT',
      );

      expect(result.text).toContain('MIT');
      expect(result.tokensUsed).toBe(200);
    });
  });

  describe('circuit breaker', () => {
    it('opens after 5 consecutive failures', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      // Use auth errors to skip retries (auth errors are not retried)
      for (let i = 0; i < 5; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => 'Unauthorized API_KEY invalid',
        });
      }

      // 5 failed extractMetadata calls with auth errors (no retries)
      for (let i = 0; i < 5; i++) {
        try {
          await provider.extractMetadata({
            strippedText: 'test',
            credentialType: 'DEGREE',
            fingerprint: 'sha256:test',
          });
        } catch {
          // Expected — each failure recorded immediately
        }
      }

      // Circuit should be open now — next call should throw immediately
      const fetchCountBefore = mockFetch.mock.calls.length;
      await expect(
        provider.extractMetadata({
          strippedText: 'test',
          credentialType: 'DEGREE',
          fingerprint: 'sha256:test',
        }),
      ).rejects.toThrow('circuit breaker open');

      // Verify no new fetch calls were made (circuit rejected immediately)
      expect(mockFetch.mock.calls.length).toBe(fetchCountBefore);
    });
  });
});
