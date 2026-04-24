import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('vertexGenerate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '';
  });

  it('calls Vertex AI generateContent endpoint', async () => {
    const { vertexGenerate } = await import('./vertex-client.js');
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: '{"name":"test"}' }] }, finishReason: 'STOP' }],
          usageMetadata: { totalTokenCount: 42 },
        }),
      });

    const result = await vertexGenerate({
      model: 'gemini-3-flash-preview',
      userPrompt: 'Extract metadata',
      systemPrompt: 'You are an extractor',
    });

    expect(result.text).toBe('{"name":"test"}');
    expect(result.tokensUsed).toBe(42);
  });

  it('throws on non-200 response', async () => {
    const { vertexGenerate } = await import('./vertex-client.js');
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limited'),
      });

    await expect(vertexGenerate({
      model: 'gemini-3-flash-preview',
      userPrompt: 'test',
    })).rejects.toThrow('Vertex AI generate failed: 429');
  });
});

describe('vertexEmbed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns embedding values', async () => {
    const { vertexEmbed } = await import('./vertex-client.js');
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'tok', expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          predictions: [{ embeddings: { values: [0.1, 0.2, 0.3] } }],
        }),
      });

    const result = await vertexEmbed({
      model: 'gemini-embedding-001',
      text: 'Test text',
      taskType: 'RETRIEVAL_DOCUMENT',
    });

    expect(result.values).toEqual([0.1, 0.2, 0.3]);
    expect(result.dimensions).toBe(3);
  });
});

describe('isVertexEnabled', () => {
  it('returns false by default', async () => {
    vi.resetModules();
    delete process.env.ENABLE_VERTEX_AI;
    const { isVertexEnabled } = await import('./vertex-client.js');
    expect(isVertexEnabled()).toBe(false);
  });

  it('returns true when flag set', async () => {
    vi.resetModules();
    process.env.ENABLE_VERTEX_AI = 'true';
    const { isVertexEnabled } = await import('./vertex-client.js');
    expect(isVertexEnabled()).toBe(true);
    delete process.env.ENABLE_VERTEX_AI;
  });
});
