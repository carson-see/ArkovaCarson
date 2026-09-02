import { describe, expect, it } from 'vitest';

import {
  createEvidenceSink,
  newStats,
  percentile,
  record,
  summarize,
  type EvidenceFile,
} from './load-harness-evidence';

const API = 'https://pr-1055---arkova-worker-pr-1055-staging-kvojbeutfa-uc.a.run.app';

function seededStats(startedMsAgo = 5_000) {
  const stats = newStats();
  stats.startedAt = Date.now() - startedMsAgo;
  record(stats, { mode: 'reads', endpoint: '/api/v1/verify/x', status: 200, latencyMs: 20, ok: true });
  record(stats, { mode: 'reads', endpoint: '/api/v1/verify/x', status: 500, latencyMs: 40, ok: false });
  record(stats, { mode: 'webhook', endpoint: '/webhooks/checkr', status: 401, latencyMs: 10, ok: false });
  return stats;
}

describe('summarize — completed runs', () => {
  it('carries totals, rates, and apiBase with NO partial marker', () => {
    const ev = summarize(seededStats(), 'mixed', 10, API);

    expect(ev.totalRequests).toBe(3);
    expect(ev.apiBase).toBe(API);
    expect(ev.mode).toBe('mixed');
    expect(ev.concurrency).toBe(10);
    expect(ev.byMode.reads).toMatchObject({ ok: 1, fail: 1, errorRate: 0.5 });
    expect(ev.byMode.webhook.byStatus[401]).toBe(1);
    expect(ev.durationSec).toBeGreaterThan(0);

    // A completed run must not carry ANY interruption marker — absent keys,
    // not false-y values, so a `has("partial")` check downstream is unambiguous.
    expect('partial' in ev).toBe(false);
    expect('interruptedBy' in ev).toBe(false);
    expect('plannedDurationSec' in ev).toBe(false);
    expect(Object.keys(JSON.parse(JSON.stringify(ev)))).not.toContain('partial');
  });

  it('attaches the classifier block only for classifier mode', () => {
    const stats = seededStats();
    stats.classifier.completed = 2;
    expect(summarize(stats, 'classifier', 4, API).classifier).toEqual(stats.classifier);
    expect(summarize(stats, 'mixed', 4, API).classifier).toBeUndefined();
  });
});

describe('summarize — interrupted runs (SCRUM-3444)', () => {
  it('stamps partial:true, the received signal, the planned window, and the elapsed window', () => {
    const stats = seededStats(5_000);
    const ev = summarize(stats, 'mixed', 10, API, {
      signal: 'SIGTERM',
      plannedDurationSec: 720 * 60,
    });

    expect(ev.partial).toBe(true);
    expect(ev.interruptedBy).toBe('SIGTERM');
    expect(ev.plannedDurationSec).toBe(43_200);
    // durationSec is the ELAPSED window at interruption time, self-describing
    // against plannedDurationSec so the file cannot pass as a completed soak.
    expect(ev.durationSec).toBeGreaterThanOrEqual(4);
    expect(ev.durationSec).toBeLessThan(60);
    expect(ev.durationSec).toBeLessThan(ev.plannedDurationSec!);
    // The salvage file still carries everything collected so far.
    expect(ev.totalRequests).toBe(3);

    // The marker must survive JSON serialization for downstream readers.
    const parsed = JSON.parse(JSON.stringify(ev)) as EvidenceFile;
    expect(parsed.partial).toBe(true);
    expect(parsed.interruptedBy).toBe('SIGTERM');
    expect(parsed.plannedDurationSec).toBe(43_200);
  });
});

describe('createEvidenceSink — single-write semantics (SCRUM-3444)', () => {
  it('writes the first flush and refuses every later flush', () => {
    const writes: EvidenceFile[] = [];
    const sink = createEvidenceSink((e) => writes.push(e));
    const completed = summarize(seededStats(), 'mixed', 10, API);
    const partial = summarize(seededStats(), 'mixed', 10, API, { signal: 'SIGINT', plannedDurationSec: 60 });

    expect(sink(completed)).toBe(true);
    // A signal landing after normal completion must NOT clobber the file.
    expect(sink(partial)).toBe(false);
    expect(writes).toEqual([completed]);
  });

  it('lets a signal flush first and then blocks the normal-completion write', () => {
    const writes: EvidenceFile[] = [];
    const sink = createEvidenceSink((e) => writes.push(e));
    const partial = summarize(seededStats(), 'reads', 1, API, { signal: 'SIGTERM', plannedDurationSec: 120 });
    const completed = summarize(seededStats(), 'reads', 1, API);

    expect(sink(partial)).toBe(true);
    expect(sink(completed)).toBe(false);
    expect(writes).toEqual([partial]);
  });
});

describe('percentile — latency math is preserved by the extraction', () => {
  it('keeps the existing behavior', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([10, 20, 30, 40], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40], 99)).toBe(40);
    expect(percentile([40, 10, 30, 20], 50)).toBe(30); // sorts a copy
  });
});
