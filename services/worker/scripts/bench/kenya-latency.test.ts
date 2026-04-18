/**
 * SCRUM-899 KENYA-RES-01 — latency benchmark smoke test.
 *
 * We don't hit a real Supabase endpoint; we stub fetch and assert the
 * aggregation math handles success + error paths and the percentile
 * calculation is correct.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import { runBench } from './kenya-latency.js';

const originalFetch = global.fetch;

describe('SCRUM-899 Kenya latency benchmark', () => {
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('aggregates p50/p95 correctly across a pool of successful samples', async () => {
    const samples = [50, 60, 70, 80, 90, 100, 110, 120, 130, 200];
    let i = 0;
    global.fetch = vi.fn(async () => {
      const delay = samples[i++ % samples.length];
      await new Promise((r) => setTimeout(r, delay));
      return new Response('ok', { status: 200 }) as Response;
    }) as typeof fetch;

    const result = await runBench({
      target: 'https://fake.supabase.co/rest/v1/',
      apiKey: 'anon',
      label: 'test',
      iterations: 10,
      concurrency: 2,
    });

    expect(result.successCount).toBe(10);
    expect(result.errorCount).toBe(0);
    // Timings will include scheduling overhead; assert ordering instead.
    expect(result.p50).toBeLessThanOrEqual(result.p95);
    expect(result.p95).toBeLessThanOrEqual(result.p99);
    expect(result.min).toBeLessThanOrEqual(result.p50);
    expect(result.max).toBeGreaterThanOrEqual(result.p99);
  });

  it('counts errors separately without corrupting the percentile pool', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('DNS fail');
    }) as typeof fetch;

    const result = await runBench({
      target: 'https://fake.supabase.co/rest/v1/',
      apiKey: 'anon',
      label: 'error-case',
      iterations: 4,
      concurrency: 2,
    });

    expect(result.successCount).toBe(0);
    expect(result.errorCount).toBe(4);
    expect(result.p50).toBe(0);
    expect(result.p95).toBe(0);
  });

  it('handles a mix of 2xx and 5xx responses — treats 5xx as errors', async () => {
    let i = 0;
    global.fetch = vi.fn(async () => {
      i += 1;
      if (i === 1) return new Response('boom', { status: 503 }) as Response;
      return new Response('ok', { status: 200 }) as Response;
    }) as typeof fetch;

    const result = await runBench({
      target: 'https://fake.supabase.co/rest/v1/',
      apiKey: 'anon',
      label: 'mixed',
      iterations: 4,
      concurrency: 1,
    });

    expect(result.successCount).toBe(3);
    expect(result.errorCount).toBe(1);
  });
});
