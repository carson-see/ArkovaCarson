/**
 * Nessie AI Provider Tests (RunPod vLLM)
 *
 * Tests for NessieProvider — RunPod serverless vLLM endpoint.
 * Uses fetch mocking (no real API calls per Constitution 1.7).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger to avoid config dependency
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { NessieProvider } from './nessie.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('NessieProvider', () => {
  const FAKE_API_KEY = 'test-runpod-api-key-123';
  const FAKE_ENDPOINT_ID = 'test-endpoint-xyz';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RUNPOD_API_KEY = FAKE_API_KEY;
    process.env.RUNPOD_ENDPOINT_ID = FAKE_ENDPOINT_ID;
  });

  afterEach(() => {
    delete process.env.RUNPOD_API_KEY;
    delete process.env.RUNPOD_ENDPOINT_ID;
  });

  describe('constructor', () => {
    it('throws if no API key provided', () => {
      delete process.env.RUNPOD_API_KEY;
      expect(() => new NessieProvider()).toThrow('RUNPOD_API_KEY is required');
    });

    it('throws if no endpoint ID provided', () => {
      delete process.env.RUNPOD_ENDPOINT_ID;
      expect(() => new NessieProvider(FAKE_API_KEY)).toThrow('RUNPOD_ENDPOINT_ID is required');
    });

    it('accepts explicit parameters', () => {
      delete process.env.RUNPOD_API_KEY;
      delete process.env.RUNPOD_ENDPOINT_ID;
      const provider = new NessieProvider('explicit-key', 'explicit-endpoint');
      expect(provider.name).toBe('nessie');
    });

    it('reads config from env vars', () => {
      const provider = new NessieProvider();
      expect(provider.name).toBe('nessie');
    });
  });

  describe('extractMetadata', () => {
    it('calls RunPod vLLM endpoint and returns validated fields', async () => {
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'chatcmpl-123',
          object: 'chat.completion',
          model: 'nessie-v2',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  credentialType: 'DEGREE',
                  issuerName: 'Stanford University',
                  fieldOfStudy: 'Computer Science',
                  degreeLevel: 'Master',
                  issuedDate: '2024-06-15',
                  fraudSignals: [],
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
        strippedText: '[NAME_REDACTED] graduated from Stanford University with Master in Computer Science on June 15, 2024',
        credentialType: 'DEGREE',
        fingerprint: 'sha256:abc123',
      });

      expect(result.fields.issuerName).toBe('Stanford University');
      expect(result.fields.credentialType).toBe('DEGREE');
      expect(result.provider).toBe('nessie');
      expect(result.tokensUsed).toBe(150);

      // Verify fetch was called with RunPod endpoint
      expect(mockFetch).toHaveBeenCalledWith(
        `https://api.runpod.ai/v2/${FAKE_ENDPOINT_ID}/openai/v1/chat/completions`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${FAKE_API_KEY}`,
          }),
        }),
      );
    });

    it('retries on transient failures (handles cold start)', async () => {
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);

      // First call fails (cold start timeout)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => 'Worker not ready',
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
                  issuerName: 'State Board',
                  confidence: 0.85,
                }),
              },
            },
          ],
          usage: { total_tokens: 100 },
        }),
      });

      const result = await provider.extractMetadata({
        strippedText: 'Licensed by State Board',
        credentialType: 'LICENSE',
        fingerprint: 'sha256:def456',
      });

      expect(result.fields.credentialType).toBe('LICENSE');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('applies grounding and cross-field fraud checks', async () => {
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  credentialType: 'LICENSE',
                  issuerName: 'Texas Board of Nursing',
                  issuedDate: '2028-01-01',
                  expiryDate: '2025-12-31',
                  confidence: 0.80,
                  fraudSignals: [],
                }),
              },
            },
          ],
          usage: { total_tokens: 120 },
        }),
      });

      const result = await provider.extractMetadata({
        strippedText: 'Texas Board of Nursing. License issued 2028-01-01. Expires 2025-12-31.',
        credentialType: 'LICENSE',
        fingerprint: 'sha256:ghi789',
      });

      // Cross-field checks should detect issued > expiry
      expect(result.confidence).toBeLessThan(0.80);
    });
  });

  describe('generateEmbedding', () => {
    it('throws — Nessie does not support embeddings', async () => {
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);
      await expect(provider.generateEmbedding('test')).rejects.toThrow(
        'does not support embeddings',
      );
    });
  });

  describe('healthCheck', () => {
    it('returns healthy on successful ping', async () => {
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: '{"status":"ok"}' } }],
        }),
      });

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.provider).toBe('nessie');
      expect(health.mode).toBe('runpod-serverless');
    });

    it('returns unhealthy on failure', async () => {
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.provider).toBe('nessie');
    });
  });

  describe('generateRAGResponse', () => {
    it('generates RAG response for verified context mode', async () => {
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: 'Stanford is a leading research university.',
                  citations: [{ record_id: 'rec-1', excerpt: 'Stanford...' }],
                  confidence: 0.88,
                }),
              },
            },
          ],
          usage: { total_tokens: 200 },
        }),
      });

      const result = await provider.generateRAGResponse(
        'You are Nessie.',
        'Tell me about Stanford',
      );

      expect(result.text).toContain('Stanford');
      expect(result.tokensUsed).toBe(200);
    });
  });

  describe('constrained decoding (NVI-16)', () => {
    afterEach(() => {
      delete process.env.ENABLE_CONSTRAINED_DECODING;
    });

    it('adds response_format when constrained decoding is enabled and regulation detected', async () => {
      process.env.ENABLE_CONSTRAINED_DECODING = 'true';
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  answer: 'FCRA requires pre-adverse action notice.',
                  citations: [{ record_id: 'fcra-604-b-3', relevance: 'direct' }],
                  confidence: 0.85,
                  risks: [{ description: 'Missing disclosure' }],
                  recommendations: [{ description: 'Add standalone disclosure' }],
                }),
              },
            },
          ],
          usage: { total_tokens: 200 },
        }),
      });

      await provider.generateRAGResponse(
        'You are a compliance assistant.',
        'What are FCRA adverse action requirements?',
      );

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.response_format).toBeDefined();
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.name).toBe('intelligence_response');
      expect(body.response_format.json_schema.schema.properties.citations.items.properties.record_id.enum).toBeDefined();
    });

    it('does not add response_format when constrained decoding is disabled', async () => {
      process.env.ENABLE_CONSTRAINED_DECODING = 'false';
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"answer":"test"}' } }],
          usage: { total_tokens: 50 },
        }),
      });

      await provider.generateRAGResponse(
        'You are a compliance assistant.',
        'What are FCRA requirements?',
      );

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.response_format).toBeUndefined();
    });

    it('does not add response_format when regulation is not detected', async () => {
      process.env.ENABLE_CONSTRAINED_DECODING = 'true';
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"answer":"generic answer"}' } }],
          usage: { total_tokens: 50 },
        }),
      });

      await provider.generateRAGResponse(
        'You are a compliance assistant.',
        'Tell me about general compliance best practices.',
      );

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.response_format).toBeUndefined();
    });

    it('does not add response_format when env var is not set', async () => {
      delete process.env.ENABLE_CONSTRAINED_DECODING;
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"answer":"test"}' } }],
          usage: { total_tokens: 50 },
        }),
      });

      await provider.generateRAGResponse(
        'You are a compliance assistant.',
        'What are HIPAA requirements?',
      );

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.response_format).toBeUndefined();
    });
  });

  describe('circuit breaker', () => {
    it('opens after 5 consecutive failures', async () => {
      const provider = new NessieProvider(FAKE_API_KEY, FAKE_ENDPOINT_ID);

      // Auth errors skip retries
      for (let i = 0; i < 5; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
          text: async () => 'Unauthorized API_KEY invalid',
        });
      }

      for (let i = 0; i < 5; i++) {
        try {
          await provider.extractMetadata({
            strippedText: 'test',
            credentialType: 'DEGREE',
            fingerprint: 'sha256:test',
          });
        } catch {
          // Expected
        }
      }

      // Circuit should be open
      await expect(
        provider.extractMetadata({
          strippedText: 'test',
          credentialType: 'DEGREE',
          fingerprint: 'sha256:test',
        }),
      ).rejects.toThrow('circuit breaker open');
    });
  });
});
