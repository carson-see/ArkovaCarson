import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  newDriverStats,
  recordOutcome,
  summarizeEvidence,
  classifyStatus,
  bodySnippet,
  captureProofErrorCode,
  fireLabeled,
  parseDriverArgs,
  type DriverOutcome,
} from './driver-core';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('driver-core: outcome recording + evidence summary', () => {
  it('starts with an empty stats object', () => {
    const stats = newDriverStats();
    expect(stats.outcomes).toEqual([]);
    expect(stats.byLabel).toEqual({});
    expect(typeof stats.startedAt).toBe('number');
  });

  it('records per-label expected/unexpected + status-mix counts', () => {
    const stats = newDriverStats();
    recordOutcome(stats, {
      label: 'unknown-id',
      endpoint: '/api/v1/verify/NOPE/proof',
      method: 'GET',
      status: 404,
      latencyMs: 12,
      expected: true,
    });
    recordOutcome(stats, {
      label: 'unknown-id',
      endpoint: '/api/v1/verify/NOPE/proof',
      method: 'GET',
      status: 500,
      latencyMs: 30,
      expected: false,
    });

    const slot = stats.byLabel['unknown-id'];
    expect(slot.expected).toBe(1);
    expect(slot.unexpected).toBe(1);
    expect(slot.byStatus[404]).toBe(1);
    expect(slot.byStatus[500]).toBe(1);
    expect(stats.outcomes).toHaveLength(2);
  });

  it('classifies expected vs unexpected against an allowed-status set', () => {
    // A 404 is EXPECTED for the RECORD_NOT_FOUND branch — soak evidence, not a failure.
    expect(classifyStatus(404, [404])).toBe(true);
    expect(classifyStatus(200, [404])).toBe(false);
    // A 429 is always expected when the rate limiter is in the allowed set.
    expect(classifyStatus(429, [200, 429])).toBe(true);
    // Transport error (status 0) is never "expected".
    expect(classifyStatus(0, [0])).toBe(false);
  });

  it('summarizeEvidence emits per-label counts, status mix, and captured bodies', () => {
    const stats = newDriverStats();
    recordOutcome(stats, {
      label: 'unknown-id',
      endpoint: '/api/v1/verify/NOPE/proof',
      method: 'GET',
      status: 404,
      latencyMs: 12,
      expected: true,
      capturedBody: { error: 'Record not found', proof_error_code: 'RECORD_NOT_FOUND' },
    });

    const ev = summarizeEvidence(stats, {
      driver: 'verify-proof',
      apiBase: 'https://pr-1439---arkova-worker-staging-x-uc.a.run.app',
      pr: '#1439',
    });

    expect(ev.driver).toBe('verify-proof');
    expect(ev.pr).toBe('#1439');
    expect(ev.totalRequests).toBe(1);
    expect(ev.byLabel['unknown-id'].expected).toBe(1);
    expect(ev.byLabel['unknown-id'].byStatus[404]).toBe(1);
    // Captured bodies prove the branch was actually hit — retained in evidence.
    expect(ev.capturedBodies).toContainEqual(
      expect.objectContaining({
        label: 'unknown-id',
        status: 404,
        body: expect.objectContaining({ proof_error_code: 'RECORD_NOT_FOUND' }),
      }),
    );
  });

  it('flags evidence as failing when any label recorded an unexpected status', () => {
    const stats = newDriverStats();
    recordOutcome(stats, {
      label: 'unknown-id',
      endpoint: '/x',
      method: 'GET',
      status: 200,
      latencyMs: 1,
      expected: false,
    });
    const ev = summarizeEvidence(stats, { driver: 'd', apiBase: 'https://x', pr: '#1' });
    expect(ev.allExpected).toBe(false);
  });

  it('marks evidence all-expected when every outcome matched its allowed set', () => {
    const stats = newDriverStats();
    recordOutcome(stats, { label: 'a', endpoint: '/x', method: 'GET', status: 404, latencyMs: 1, expected: true });
    recordOutcome(stats, { label: 'b', endpoint: '/y', method: 'GET', status: 200, latencyMs: 1, expected: true });
    const ev = summarizeEvidence(stats, { driver: 'd', apiBase: 'https://x', pr: '#1' });
    expect(ev.allExpected).toBe(true);
  });
});

describe('driver-core: body helpers', () => {
  it('bodySnippet truncates long strings but keeps JSON objects intact', () => {
    const long = 'x'.repeat(5000);
    const snip = bodySnippet(long);
    expect(typeof snip).toBe('string');
    expect((snip as string).length).toBeLessThanOrEqual(2048);
  });

  it('bodySnippet parses JSON bodies into objects', () => {
    const parsed = bodySnippet('{"error":"Record not found","proof_error_code":"RECORD_NOT_FOUND"}');
    expect(parsed).toEqual({ error: 'Record not found', proof_error_code: 'RECORD_NOT_FOUND' });
  });

  it('bodySnippet redacts signed artifact URLs before evidence persistence', () => {
    const parsed = bodySnippet(
      JSON.stringify({
        exports: {
          pdf: { signed_url: 'https://signed.example/pdf-token' },
          json: { signedUrl: 'https://signed.example/json-token' },
        },
      }),
    );
    expect(parsed).toEqual({
      exports: {
        pdf: { signed_url: '[REDACTED]' },
        json: { signedUrl: '[REDACTED]' },
      },
    });
  });

  it('captureProofErrorCode reads proof_error_code from a parsed body', () => {
    expect(captureProofErrorCode({ proof_error_code: 'NO_BATCH_PROOF' })).toBe('NO_BATCH_PROOF');
    // Falls back to null when the field is absent (main-branch shape has only `error`).
    expect(captureProofErrorCode({ error: 'Record not found' })).toBeNull();
    expect(captureProofErrorCode('not-json')).toBeNull();
  });
});

describe('driver-core: HTTP fire', () => {
  it('records status 0 when a request exceeds its timeout', async () => {
    globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('timed out', 'AbortError'));
        });
      });
    }) as never;

    const stats = newDriverStats();
    const outcome = await fireLabeled({
      stats,
      label: 'hung-endpoint',
      method: 'GET',
      endpoint: '/hung',
      url: 'https://pr-1.example/hung',
      allowedStatuses: [200],
      timeoutMs: 1,
    });

    expect(outcome.status).toBe(0);
    expect(outcome.expected).toBe(false);
    expect(stats.outcomes).toHaveLength(1);
  });
});

describe('driver-core: arg parsing', () => {
  it('parses duration + evidence-out with defaults', () => {
    const args = parseDriverArgs(['--duration', '5', '--evidence-out', 'docs/x.json']);
    expect(args.durationMin).toBe(5);
    expect(args.evidenceOut).toBe('docs/x.json');
    expect(args.dryRun).toBe(false);
  });

  it('defaults duration when omitted and honours --dry-run', () => {
    const args = parseDriverArgs(['--dry-run']);
    expect(args.durationMin).toBeGreaterThan(0);
    expect(args.dryRun).toBe(true);
  });

  it('rejects a non-positive duration', () => {
    expect(() => parseDriverArgs(['--duration', '0'])).toThrow(/duration/);
    expect(() => parseDriverArgs(['--duration', 'abc'])).toThrow(/duration/);
  });
});

// Type-only guard: DriverOutcome shape is stable.
const _sample: DriverOutcome = {
  label: 'x',
  endpoint: '/x',
  method: 'GET',
  status: 200,
  latencyMs: 1,
  expected: true,
};
void _sample;
