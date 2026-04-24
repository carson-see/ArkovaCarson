/**
 * GEMB2-01 — Gemini Embedding 2 client unit tests.
 *
 * Exercises the abstraction boundary: we inject stub auth + fetch so no live
 * Vertex calls happen. Real benchmark lives in scripts/benchmark-gemini2.ts
 * and requires a human-run session with GCP credentials.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createGemini2Client,
  GEMB2_LOCATION,
  GEMB2_MODEL,
  type FetchLike,
} from './gemini2.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeAuth(token = 'test-token'): { getAccessToken: () => Promise<string> } {
  return { getAccessToken: vi.fn(async () => token) };
}

function okResponse(values: number[]): Response {
  return new Response(
    JSON.stringify({ predictions: [{ embeddings: { values } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('createGemini2Client', () => {
  it('POSTs to the US-central Vertex predict endpoint with a bearer token', async () => {
    const fetchStub: FetchLike = vi.fn(async () => okResponse(new Array(768).fill(0.1)));
    const client = createGemini2Client({
      projectId: 'arkova1',
      auth: makeAuth(),
      fetch: fetchStub,
    });

    await client.embed({ text: 'A secured document' });

    expect(fetchStub).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchStub).mock.calls[0];
    expect(url).toContain(`${GEMB2_LOCATION}-aiplatform.googleapis.com`);
    expect(url).toContain('projects/arkova1');
    expect(url).toContain(`models/${GEMB2_MODEL}:predict`);
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token',
    );
  });

  it('defaults dim to 768 and requests outputDimensionality + autoTruncate', async () => {
    const fetchStub: FetchLike = vi.fn(async () => okResponse(new Array(768).fill(0.1)));
    const client = createGemini2Client({
      projectId: 'arkova1',
      auth: makeAuth(),
      fetch: fetchStub,
    });

    const res = await client.embed({ text: 'test' });

    const body = JSON.parse(vi.mocked(fetchStub).mock.calls[0][1]!.body as string) as {
      parameters: { outputDimensionality: number; autoTruncate: boolean };
      instances: Array<{ task_type: string }>;
    };
    expect(body.parameters.outputDimensionality).toBe(768);
    expect(body.parameters.autoTruncate).toBe(true);
    expect(body.instances[0].task_type).toBe('RETRIEVAL_DOCUMENT');
    expect(res.dim).toBe(768);
    expect(res.vector).toHaveLength(768);
    expect(res.model).toBe(GEMB2_MODEL);
  });

  it('respects a custom 3072 Matryoshka dim + RETRIEVAL_QUERY task type', async () => {
    const fetchStub: FetchLike = vi.fn(async () => okResponse(new Array(3072).fill(0.1)));
    const client = createGemini2Client({
      projectId: 'arkova1',
      auth: makeAuth(),
      fetch: fetchStub,
    });

    const res = await client.embed({ text: 'q', dim: 3072, taskType: 'RETRIEVAL_QUERY' });

    const body = JSON.parse(vi.mocked(fetchStub).mock.calls[0][1]!.body as string) as {
      parameters: { outputDimensionality: number };
      instances: Array<{ task_type: string }>;
    };
    expect(body.parameters.outputDimensionality).toBe(3072);
    expect(body.instances[0].task_type).toBe('RETRIEVAL_QUERY');
    expect(res.dim).toBe(3072);
    expect(res.vector).toHaveLength(3072);
  });

  it('rejects non-US locations (residency guard)', () => {
    expect(() =>
      createGemini2Client({
        projectId: 'arkova1',
        location: 'europe-west1',
        auth: makeAuth(),
      }),
    ).toThrow(/US-only residency/);
  });

  it('rejects unsupported dim values', async () => {
    const client = createGemini2Client({
      projectId: 'arkova1',
      auth: makeAuth(),
      fetch: vi.fn(),
    });
    await expect(
      client.embed({ text: 'x', dim: 1024 as unknown as 768 }),
    ).rejects.toThrow(/unsupported dim/);
  });

  it('rejects empty text', async () => {
    const client = createGemini2Client({
      projectId: 'arkova1',
      auth: makeAuth(),
      fetch: vi.fn(),
    });
    await expect(client.embed({ text: '   ' })).rejects.toThrow(/text is empty/);
  });

  it('raises when projectId is missing', () => {
    const prev = process.env.GCP_PROJECT_ID;
    delete process.env.GCP_PROJECT_ID;
    try {
      expect(() => createGemini2Client({ auth: makeAuth() })).toThrow(/projectId/);
    } finally {
      if (prev !== undefined) process.env.GCP_PROJECT_ID = prev;
    }
  });

  it('raises when Vertex returns non-2xx', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response('quota exceeded', { status: 429, headers: {} }),
    );
    const client = createGemini2Client({
      projectId: 'arkova1',
      auth: makeAuth(),
      fetch: fetchStub,
    });
    await expect(client.embed({ text: 'x' })).rejects.toThrow(/responded 429/);
  });

  it('raises when response dimension does not match requested dim', async () => {
    const fetchStub = vi.fn(async () => okResponse(new Array(256).fill(0.1)));
    const client = createGemini2Client({
      projectId: 'arkova1',
      auth: makeAuth(),
      fetch: fetchStub,
    });
    await expect(client.embed({ text: 'x', dim: 768 })).rejects.toThrow(
      /expected 768 dimensions, got 256/,
    );
  });

  it('surfaces latencyMs for observability', async () => {
    const fetchStub = vi.fn(
      async () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(okResponse(new Array(768).fill(0.0))), 25),
        ),
    );
    const client = createGemini2Client({
      projectId: 'arkova1',
      auth: makeAuth(),
      fetch: fetchStub,
    });

    const res = await client.embed({ text: 'x' });
    expect(res.latencyMs).toBeGreaterThanOrEqual(20);
  });

  it('raises when auth returns an empty token', async () => {
    const client = createGemini2Client({
      projectId: 'arkova1',
      auth: { getAccessToken: async () => '' },
      fetch: vi.fn(),
    });
    await expect(client.embed({ text: 'x' })).rejects.toThrow(/empty access token/);
  });
});
