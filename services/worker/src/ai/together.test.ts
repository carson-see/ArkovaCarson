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

const traceMock = vi.hoisted(() => ({
  traceAiProviderCall: vi.fn(async (_options: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./observability.js', () => traceMock);

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
      expect(traceMock.traceAiProviderCall).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'together',
          operation: 'chat_completion',
          model: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
          inputCharacterCount: expect.any(Number),
        }),
        expect.any(Function),
        expect.any(Function),
      );

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

  // BUG-2026-06-24-014 parity: Together AI's `response_format: json_object`
  // native JSON mode suppresses markdown-fence wrapping but does not protect
  // against truncated output hitting the model's token limit mid-object. A
  // naked JSON.parse throws SyntaxError there, surfacing as an unhandled
  // extraction failure instead of recovering the object.
  describe('JSON parsing resilience', () => {
    it('recovers a response truncated mid-object at the token limit', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      // Missing the final closing brace — simulates output cut off when the
      // model hits max_tokens before emitting the terminator.
      const truncatedContent =
        '{"credentialType":"DEGREE","issuerName":"MIT","fieldOfStudy":"Computer Science","confidence":0.92';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: truncatedContent } }],
          usage: { total_tokens: 150 },
        }),
      });

      const result = await provider.extractMetadata({
        strippedText: '[NAME_REDACTED] graduated from MIT with a degree in Computer Science',
        credentialType: 'DEGREE',
        fingerprint: 'sha256:truncated',
      });

      expect(result.fields.credentialType).toBe('DEGREE');
      expect(result.fields.issuerName).toBe('MIT');
      expect(result.fields.fieldOfStudy).toBe('Computer Science');
      expect(result.provider).toBe('together');
    });

    it('recovers a response with trailing prose after the closing brace', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      const contentWithTrailingProse = [
        JSON.stringify({
          credentialType: 'LICENSE',
          issuerName: 'State Bar',
          confidence: 0.81,
        }),
        'Note: response truncated, additional context follows.',
      ].join('\n');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: contentWithTrailingProse } }],
          usage: { total_tokens: 130 },
        }),
      });

      const result = await provider.extractMetadata({
        strippedText: 'Licensed by State Bar',
        credentialType: 'LICENSE',
        fingerprint: 'sha256:trailingprose',
      });

      expect(result.fields.credentialType).toBe('LICENSE');
      expect(result.fields.issuerName).toBe('State Bar');
      expect(result.provider).toBe('together');
    });

    it('repairs a trailing comma left before the closing brace', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      const contentWithTrailingComma =
        '{"credentialType":"CERTIFICATE","issuerName":"Acme Institute","confidence":0.7,}';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: contentWithTrailingComma } }],
          usage: { total_tokens: 90 },
        }),
      });

      const result = await provider.extractMetadata({
        strippedText: 'Certificate issued by Acme Institute',
        credentialType: 'CERTIFICATE',
        fingerprint: 'sha256:trailingcomma',
      });

      expect(result.fields.credentialType).toBe('CERTIFICATE');
      expect(result.fields.issuerName).toBe('Acme Institute');
    });

    // Code-review finding (xhigh, correctness, CONFIRMED): the trailing-comma
    // repair regex ran over the whole text with no string-boundary awareness,
    // so a comma-then-bracket sequence *inside* a legitimate string value
    // (not a structural trailing comma) was silently stripped — corrupting
    // extracted field content while still reporting a successful parse.
    it('preserves a comma-then-bracket sequence inside a string value while still repairing the real trailing comma', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      // The `description` value contains ", ]" as ordinary prose text — not
      // JSON syntax — immediately followed later by a genuine structural
      // trailing comma before the closing brace that DOES need repair.
      const content =
        '{"credentialType":"CERTIFICATE","issuerName":"Acme Institute",' +
        '"description":"See item 3, ] cross-ref","confidence":0.7,}';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content } }],
          usage: { total_tokens: 90 },
        }),
      });

      const result = await provider.extractMetadata({
        strippedText: 'Certificate issued by Acme Institute',
        credentialType: 'CERTIFICATE',
        fingerprint: 'sha256:commainstring',
      });

      expect(result.fields.credentialType).toBe('CERTIFICATE');
      // The prose comma+bracket inside the string must survive verbatim.
      expect(result.fields.description).toBe('See item 3, ] cross-ref');
    });

    // Code-review finding (xhigh, correctness, CONFIRMED): balanceJsonDelimiters
    // only appended missing brackets — it never closed an unterminated string
    // literal, so output truncated mid-string (arguably the most realistic
    // max_tokens truncation shape) threw `Unterminated string` and was never
    // recovered at all.
    it('recovers a response truncated mid-string value', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      // Cut off in the middle of the issuerName string value — no closing
      // quote, no closing brace.
      const truncatedMidString =
        '{"credentialType":"DEGREE","issuerName":"Massachusetts Institute of Techno';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: truncatedMidString } }],
          usage: { total_tokens: 140 },
        }),
      });

      const result = await provider.extractMetadata({
        strippedText: 'Graduated from Massachusetts Institute of Technology',
        credentialType: 'DEGREE',
        fingerprint: 'sha256:midstringtrunc',
      });

      expect(result.fields.credentialType).toBe('DEGREE');
      // The salvaged value is itself truncated (a known, honest limitation)
      // but the object as a whole must parse instead of throwing.
      expect(result.fields.issuerName).toBe('Massachusetts Institute of Techno');
      expect(result.provider).toBe('together');
    });

    // Code-review finding (xhigh, correctness, CONFIRMED): the control-char
    // strip deliberately preserves tabs (0x09) so they can be escaped like
    // \n/\r, but escapeBareNewlinesInStrings never escaped tabs — so any
    // response containing a literal tab inside a string value threw `Bad
    // control character in string literal` and was never recovered.
    it('recovers a response containing a literal tab character inside a string value', async () => {
      const provider = new TogetherProvider(FAKE_API_KEY);

      const contentWithTab =
        '{"credentialType":"DEGREE","issuerName":"MIT\tSchool of Engineering","confidence":0.9}';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: 'assistant', content: contentWithTab } }],
          usage: { total_tokens: 100 },
        }),
      });

      const result = await provider.extractMetadata({
        strippedText: 'MIT School of Engineering degree',
        credentialType: 'DEGREE',
        fingerprint: 'sha256:tabinstring',
      });

      expect(result.fields.credentialType).toBe('DEGREE');
      expect(result.fields.issuerName).toBe('MIT\tSchool of Engineering');
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
