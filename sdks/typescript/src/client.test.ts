/**
 * Tests for the Arkova TypeScript SDK client.
 *
 * Mirrors sdks/python/tests/test_client.py for the batch verification paths
 * (sync, async submit, job poll, wait helper) so the two SDKs stay in lock-step.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArkovaClient,
  ArkovaError,
  VERIFY_BATCH_MAX_SIZE,
  VERIFY_BATCH_SYNC_LIMIT,
  type BatchJob,
} from './index.js';

const BASE_URL = 'https://test.arkova.ai';

interface MockResponseInit {
  status?: number;
  json?: unknown;
}

function mockResponse({ status = 200, json = {} }: MockResponseInit = {}): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(): ArkovaClient {
  return new ArkovaClient({ apiKey: 'ak_test_123', baseUrl: BASE_URL });
}

describe('ArkovaClient — init', () => {
  it('rejects empty apiKey', () => {
    expect(() => new ArkovaClient({ apiKey: '' })).toThrow(ArkovaError);
  });

  it('strips trailing slash from baseUrl', () => {
    const c = new ArkovaClient({ apiKey: 'ak_test', baseUrl: 'https://api.example.com/' });
    expect(c).toBeDefined();
  });
});

describe('ArkovaClient.fingerprint', () => {
  it('produces SHA-256 hex of "hello world"', async () => {
    const fp = await ArkovaClient.fingerprint('hello world');
    expect(fp).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    expect(fp).toHaveLength(64);
  });

  it('is consistent across calls', async () => {
    const a = await ArkovaClient.fingerprint('test');
    const b = await ArkovaClient.fingerprint('test');
    expect(a).toBe(b);
  });
});

describe('ArkovaClient.verifyBatch (sync, ≤20)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns [] for empty input without hitting the network', async () => {
    const client = makeClient();
    const results = await client.verifyBatch([]);
    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws batch_too_large when count > VERIFY_BATCH_SYNC_LIMIT', async () => {
    const client = makeClient();
    const ids = Array.from({ length: VERIFY_BATCH_SYNC_LIMIT + 1 }, (_, i) => `ARK-${i}`);
    await expect(client.verifyBatch(ids)).rejects.toMatchObject({
      name: 'ArkovaError',
      statusCode: 400,
      code: 'batch_too_large',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns mapped batch results for ≤20 IDs', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        json: {
          results: [
            { public_id: 'ARK-1', verified: true, status: 'ACTIVE', issuer_name: 'Univ A' },
            { public_id: 'ARK-2', verified: false, error: 'Record not found' },
          ],
          total: 2,
        },
      }),
    );

    const client = makeClient();
    const results = await client.verifyBatch(['ARK-1', 'ARK-2']);

    expect(results).toHaveLength(2);
    expect(results[0].public_id).toBe('ARK-1');
    expect(results[0].verified).toBe(true);
    expect(results[1].verified).toBe(false);
    expect(results[1].error).toBe('Record not found');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/verify/batch`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ public_ids: ['ARK-1', 'ARK-2'] });
  });

  it('surfaces non-ok responses as ArkovaError', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ status: 429, json: { error: 'rate_limit_exceeded' } }),
    );

    const client = makeClient();
    await expect(client.verifyBatch(['ARK-1'])).rejects.toMatchObject({
      name: 'ArkovaError',
      statusCode: 429,
    });
  });
});

describe('ArkovaClient.verifyBatchAsync (21–100)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('rejects ≤ VERIFY_BATCH_SYNC_LIMIT (server returns sync results)', async () => {
    const client = makeClient();
    const ids = Array.from({ length: VERIFY_BATCH_SYNC_LIMIT }, (_, i) => `ARK-${i}`);
    await expect(client.verifyBatchAsync(ids)).rejects.toMatchObject({
      name: 'ArkovaError',
      statusCode: 400,
      code: 'batch_too_small',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects > VERIFY_BATCH_MAX_SIZE', async () => {
    const client = makeClient();
    const ids = Array.from({ length: VERIFY_BATCH_MAX_SIZE + 1 }, (_, i) => `ARK-${i}`);
    await expect(client.verifyBatchAsync(ids)).rejects.toMatchObject({
      code: 'batch_too_large',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns BatchJob with submitted status when server returns 202', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        status: 202,
        json: { job_id: 'job_abc', total: 25, expires_at: '2026-05-05T00:00:00Z' },
      }),
    );

    const client = makeClient();
    const ids = Array.from({ length: 25 }, (_, i) => `ARK-${i}`);
    const job = await client.verifyBatchAsync(ids);

    expect(job.job_id).toBe('job_abc');
    expect(job.status).toBe('submitted');
    expect(job.total).toBe(25);
    expect(job.expires_at).toBe('2026-05-05T00:00:00Z');
    expect(job.results).toBeUndefined();
  });

  it('throws unexpected_response when server omits job_id', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ status: 200, json: { results: [], total: 25 } }),
    );

    const client = makeClient();
    const ids = Array.from({ length: 25 }, (_, i) => `ARK-${i}`);
    await expect(client.verifyBatchAsync(ids)).rejects.toMatchObject({
      code: 'unexpected_response',
    });
  });
});

describe('ArkovaClient.getBatchJob', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns processing job without results', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        json: {
          job_id: 'job_abc',
          status: 'processing',
          total: 30,
          created_at: '2026-04-28T00:00:00Z',
          completed_at: null,
          expires_at: '2026-05-05T00:00:00Z',
        },
      }),
    );

    const client = makeClient();
    const job = await client.getBatchJob('job_abc');

    expect(job.status).toBe('processing');
    expect(job.total).toBe(30);
    expect(job.results).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      `${BASE_URL}/api/v1/jobs/job_abc`,
      expect.any(Object),
    );
  });

  it('returns complete job with mapped results', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        json: {
          job_id: 'job_done',
          status: 'complete',
          total: 2,
          created_at: '2026-04-28T00:00:00Z',
          completed_at: '2026-04-28T00:01:00Z',
          expires_at: '2026-05-05T00:00:00Z',
          results: [
            { public_id: 'ARK-1', verified: true, status: 'ACTIVE' },
            { public_id: 'ARK-2', verified: false, error: 'Record not found' },
          ],
        },
      }),
    );

    const client = makeClient();
    const job = await client.getBatchJob('job_done');

    expect(job.status).toBe('complete');
    expect(job.results).toHaveLength(2);
    expect(job.results?.[0].public_id).toBe('ARK-1');
    expect(job.results?.[1].error).toBe('Record not found');
  });

  it('returns failed job with error_message', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        json: {
          job_id: 'job_bad',
          status: 'failed',
          total: 25,
          created_at: '2026-04-28T00:00:00Z',
          completed_at: '2026-04-28T00:01:00Z',
          expires_at: '2026-05-05T00:00:00Z',
          error_message: 'Background worker crashed',
        },
      }),
    );

    const client = makeClient();
    const job = await client.getBatchJob('job_bad');

    expect(job.status).toBe('failed');
    expect(job.error_message).toBe('Background worker crashed');
  });

  it('surfaces 404 as ArkovaError', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({ status: 404, json: { error: 'not_found' } }),
    );

    const client = makeClient();
    await expect(client.getBatchJob('missing')).rejects.toMatchObject({
      name: 'ArkovaError',
      statusCode: 404,
    });
  });
});

describe('ArkovaClient.waitForBatchJob', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('polls until complete then returns the terminal job', async () => {
    const processing: BatchJob = {
      job_id: 'job_xyz',
      status: 'processing',
      total: 25,
      created_at: '2026-04-28T00:00:00Z',
      expires_at: '2026-05-05T00:00:00Z',
    };
    const complete: BatchJob = {
      ...processing,
      status: 'complete',
      completed_at: '2026-04-28T00:01:00Z',
      results: [{ public_id: 'ARK-1', verified: true, status: 'ACTIVE' }],
    };

    fetchSpy
      .mockResolvedValueOnce(mockResponse({ json: processing }))
      .mockResolvedValueOnce(mockResponse({ json: complete }));

    const client = makeClient();
    const job = await client.waitForBatchJob('job_xyz', {
      timeoutMs: 5_000,
      pollIntervalMs: 0,
    });

    expect(job.status).toBe('complete');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns immediately when job is already failed', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        json: {
          job_id: 'job_fail',
          status: 'failed',
          total: 25,
          created_at: '2026-04-28T00:00:00Z',
          completed_at: '2026-04-28T00:01:00Z',
          expires_at: '2026-05-05T00:00:00Z',
          error_message: 'boom',
        },
      }),
    );

    const client = makeClient();
    const job = await client.waitForBatchJob('job_fail', {
      timeoutMs: 5_000,
      pollIntervalMs: 0,
    });
    expect(job.status).toBe('failed');
    expect(job.error_message).toBe('boom');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws batch_job_timeout when deadline elapses', async () => {
    fetchSpy.mockResolvedValue(
      mockResponse({
        json: {
          job_id: 'job_slow',
          status: 'processing',
          total: 25,
          created_at: '2026-04-28T00:00:00Z',
          expires_at: '2026-05-05T00:00:00Z',
        },
      }),
    );

    const client = makeClient();
    await expect(
      client.waitForBatchJob('job_slow', { timeoutMs: 0, pollIntervalMs: 0 }),
    ).rejects.toMatchObject({
      code: 'batch_job_timeout',
      statusCode: 408,
    });
  });
});

describe('limit constants', () => {
  it('VERIFY_BATCH_SYNC_LIMIT matches server SYNC_THRESHOLD', () => {
    expect(VERIFY_BATCH_SYNC_LIMIT).toBe(20);
  });

  it('VERIFY_BATCH_MAX_SIZE matches server MAX_BATCH_SIZE', () => {
    expect(VERIFY_BATCH_MAX_SIZE).toBe(100);
  });
});
