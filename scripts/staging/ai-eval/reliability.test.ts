import { describe, it, expect } from 'vitest';

import {
  classifyReliability,
  newReliabilityStats,
  recordReliability,
  reliabilityReport,
  type ReliabilityStats,
} from './reliability.js';
import type { AiCallResult } from './ai-client.js';

function res(partial: Partial<AiCallResult> & { status: number }): AiCallResult {
  return {
    endpoint: 'extract',
    ok: partial.status >= 200 && partial.status < 300,
    latencyMs: 100,
    ...partial,
  };
}

describe('classifyReliability', () => {
  it('flags a 429 as rate_limited', () => {
    expect(classifyReliability(res({ status: 429, retryAfterSec: 5 }))).toBe('rate_limited');
  });
  it('flags a 503 (circuit breaker / gate) as server_unavailable', () => {
    expect(classifyReliability(res({ status: 503 }))).toBe('server_unavailable');
  });
  it('flags a 5xx as server_error', () => {
    expect(classifyReliability(res({ status: 500 }))).toBe('server_error');
  });
  it('flags a transport failure (status 0) as transport_error', () => {
    expect(classifyReliability(res({ status: 0, ok: false, transportError: 'ECONNRESET' }))).toBe('transport_error');
  });
  it('flags a client-side latency overrun as client_timeout', () => {
    expect(classifyReliability(res({ status: 0, ok: false, transportError: 'timeout after 10000ms', clientTimedOut: true }))).toBe('client_timeout');
  });
  it('flags a degraded 200 (fast-fallback) as false_reading', () => {
    expect(classifyReliability(res({ status: 200, body: { degraded: true, provider: 'fast-fallback', fields: {} } }))).toBe('false_reading');
  });
  it('flags a fast-fallback provider even without an explicit degraded flag', () => {
    expect(classifyReliability(res({ status: 200, body: { provider: 'fast-fallback', fields: {} } }))).toBe('false_reading');
  });
  it('classes a clean 200 from a real provider as ok', () => {
    expect(classifyReliability(res({ status: 200, body: { provider: 'gemini', fields: { credentialType: 'CPE' } } }))).toBe('ok');
  });
});

describe('reliability stats + report', () => {
  function seed(): ReliabilityStats {
    const s = newReliabilityStats();
    // 60 ok, 20 rate_limited, 8 false_reading, 6 server_unavailable, 4 client_timeout, 2 transport
    for (let i = 0; i < 60; i++) recordReliability(s, res({ status: 200, body: { provider: 'gemini', fields: {} } }));
    for (let i = 0; i < 20; i++) recordReliability(s, res({ status: 429 }));
    for (let i = 0; i < 8; i++) recordReliability(s, res({ status: 200, body: { degraded: true, provider: 'fast-fallback', fields: {} } }));
    for (let i = 0; i < 6; i++) recordReliability(s, res({ status: 503 }));
    for (let i = 0; i < 4; i++) recordReliability(s, res({ status: 0, ok: false, clientTimedOut: true, transportError: 't' }));
    for (let i = 0; i < 2; i++) recordReliability(s, res({ status: 0, ok: false, transportError: 'ECONNRESET' }));
    return s;
  }

  it('reports first-class 429 / timeout / false-reading rates', () => {
    const report = reliabilityReport(seed());
    expect(report.total).toBe(100);
    expect(report.rate429).toBeCloseTo(0.2, 5);
    expect(report.falseReadingRate).toBeCloseTo(0.08, 5);
    // "timeout" bucket = client_timeout + server_unavailable (circuit/timeout surfacing)
    expect(report.timeoutRate).toBeCloseTo(0.1, 5); // (4 + 6)/100
    expect(report.counts.rate_limited).toBe(20);
    expect(report.counts.false_reading).toBe(8);
    expect(report.counts.ok).toBe(60);
  });

  it('computes an overall unreliable rate (everything that is not a clean ok)', () => {
    const report = reliabilityReport(seed());
    expect(report.unreliableRate).toBeCloseTo(0.4, 5); // 40 of 100 not-ok
  });
});
