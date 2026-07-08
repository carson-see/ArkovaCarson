import { describe, it, expect } from 'vitest';

import {
  newAiStats,
  recordAiOutcome,
  percentile,
  summarizeAiRun,
  buildTemplatePayload,
  buildTagsPayload,
  selectEndpointForSequence,
  type AiStats,
} from './harness-core.js';
import type { GoldenEntry } from './scoring.js';
import type { AiCallResult } from './ai-client.js';

const ENTRY: GoldenEntry = {
  id: 'GD-S3-CPE-001',
  description: 'clean CPE',
  strippedText: 'CPE certificate 8 credits issued 2026-01-05',
  credentialTypeHint: 'CPE',
  groundTruth: { credentialType: 'CPE', creditHours: 8, issuedDate: '2026-01-05', providerName: 'Acme', courseId: 'C-1' },
  source: 'synthetic/s3-cpe-cle/cpe-001',
  category: 'professional-education',
  tags: ['synthetic', 's3-cpe-cle', 'cpe', 'clean'],
};

function outcome(endpoint: AiCallResult['endpoint'], status: number, latencyMs: number): AiCallResult {
  return { endpoint, status, ok: status >= 200 && status < 300, latencyMs };
}

describe('percentile', () => {
  it('returns 0 for an empty sample', () => {
    expect(percentile([], 95)).toBe(0);
  });
  it('computes p50/p95 on a known sample', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 50)).toBe(60);
    expect(percentile(xs, 95)).toBe(100);
  });
});

describe('stats aggregation', () => {
  it('tallies ok/fail, per-status, and latency by endpoint', () => {
    const stats = newAiStats();
    recordAiOutcome(stats, outcome('extract', 200, 100));
    recordAiOutcome(stats, outcome('extract', 429, 5));
    recordAiOutcome(stats, outcome('template', 200, 300));
    const extract = stats.byEndpoint.extract;
    expect(extract.ok).toBe(1);
    expect(extract.fail).toBe(1);
    expect(extract.byStatus[200]).toBe(1);
    expect(extract.byStatus[429]).toBe(1);
    expect(stats.byEndpoint.template.ok).toBe(1);
  });

  it('counts 429s and transport errors distinctly for the evidence block', () => {
    const stats = newAiStats();
    recordAiOutcome(stats, outcome('extract', 429, 1));
    recordAiOutcome(stats, { endpoint: 'extract', status: 0, ok: false, latencyMs: 1, transportError: 'ECONNRESET' });
    const summary = summarizeAiRun(stats, 'ai-extract', 'https://pr-1413---x.run.app', 3600);
    expect(summary.rateLimited429).toBe(1);
    expect(summary.transportErrors).toBe(1);
    expect(summary.totalRequests).toBe(2);
  });

  it('embeds first-class reliability rates and per-variant counts in the summary', () => {
    const stats = newAiStats();
    recordAiOutcome(stats, outcome('extract', 200, 100), 'pdf-clean');
    recordAiOutcome(stats, outcome('extract', 429, 5), 'large');
    recordAiOutcome(stats, { endpoint: 'extract', status: 200, ok: true, latencyMs: 4600, body: { degraded: true, provider: 'fast-fallback', fields: {} } }, 'scan-ocr');
    recordAiOutcome(stats, outcome('extract', 400, 3), 'oversized');
    const summary = summarizeAiRun(stats, 'ai-extract', 'https://pr-1413---x.run.app', 3600);
    expect(summary.reliability.total).toBe(4);
    expect(summary.reliability.counts.rate_limited).toBe(1);
    expect(summary.reliability.counts.false_reading).toBe(1);
    expect(summary.reliability.counts.client_error).toBe(1); // the oversized 400
    expect(summary.reliability.falseReadingRate).toBeCloseTo(0.25, 5);
    expect(summary.byVariant).toEqual({ 'pdf-clean': 1, large: 1, 'scan-ocr': 1, oversized: 1 });
  });
});

describe('summarizeAiRun', () => {
  it('emits per-endpoint p50/p95/p99, error rate, and achieved req/hr', () => {
    const stats = newAiStats();
    for (let i = 0; i < 100; i++) recordAiOutcome(stats, outcome('extract', 200, i + 1));
    const summary = summarizeAiRun(stats, 'ai-extract', 'https://pr-1413---x.run.app', 3600);
    expect(summary.totalRequests).toBe(100);
    expect(summary.byEndpoint.extract.p50Ms).toBeGreaterThan(0);
    expect(summary.byEndpoint.extract.p99Ms).toBeGreaterThanOrEqual(summary.byEndpoint.extract.p95Ms);
    expect(summary.achievedRequestsPerHour).toBeCloseTo(100, 0);
    expect(summary.apiBase).toContain('pr-1413');
  });
});

describe('template/tags payloads (built from golden ground truth)', () => {
  it('builds a /ai/template payload from PII-stripped metadata + confidence (never document bytes)', () => {
    const payload = buildTemplatePayload(ENTRY);
    expect(payload.confidence).toBeGreaterThanOrEqual(0);
    expect(payload.confidence).toBeLessThanOrEqual(1);
    expect(payload.fields.credentialType).toBe('CPE');
    // no raw text / bytes smuggled in
    expect(JSON.stringify(payload)).not.toContain(ENTRY.strippedText);
  });
  it('builds a /ai/tags payload carrying only metadata fields', () => {
    const payload = buildTagsPayload(ENTRY);
    expect(payload.fields.credentialType).toBe('CPE');
    expect(JSON.stringify(payload)).not.toContain(ENTRY.strippedText);
  });
});

describe('selectEndpointForSequence', () => {
  it('drives all three AI endpoints in a fixed weighted rotation', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) seen.add(selectEndpointForSequence(i, ['extract', 'template', 'tags']));
    expect(seen).toEqual(new Set(['extract', 'template', 'tags']));
  });
  it('keeps the weighted rotation even if endpoint flags arrive in a different order', () => {
    const cycle = Array.from({ length: 4 }, (_, i) => selectEndpointForSequence(i, ['tags', 'extract', 'template']));
    expect(cycle).toEqual(['extract', 'template', 'extract', 'tags']);
  });
  it('honors a single-endpoint restriction (extract-only focus mode)', () => {
    for (let i = 0; i < 5; i++) expect(selectEndpointForSequence(i, ['extract'])).toBe('extract');
  });
});
