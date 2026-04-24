import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../utils/gcp-auth.js', () => ({
  getGcpAccessToken: vi.fn().mockResolvedValue('mock-token'),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { vertexGenerate, vertexEmbed, isVertexEnabled } from './vertex-client.js';

describe('vertexGenerate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls Vertex AI generateContent endpoint', async () => {
    mockFetch.mockResolvedValueOnce({
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
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain(':generateContent');
    expect(opts.headers.Authorization).toBe('Bearer mock-token');
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({
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
  });

  it('returns embedding values', async () => {
    mockFetch.mockResolvedValueOnce({
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
  it('returns false by default', () => {
    delete process.env.ENABLE_VERTEX_AI;
    expect(isVertexEnabled()).toBe(false);
  });

  it('returns true when flag set', () => {
    process.env.ENABLE_VERTEX_AI = 'true';
    expect(isVertexEnabled()).toBe(true);
    delete process.env.ENABLE_VERTEX_AI;
  });
});
