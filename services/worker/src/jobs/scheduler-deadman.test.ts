/**
 * Tests for the dead-man-with-actor-attribution evaluator (SCRUM-2900).
 *
 * The existing batch-drain dead-man (routes/batch-drain-deadman.ts) proves a
 * stall exists. This layer answers the operator's next question: WHO or WHAT
 * stopped it? Given the codified scheduler manifest + a last-run signal per
 * critical job, it attributes an overdue job to the actor who paused it (from
 * the manifest) — or flags an ENABLED job that has gone silent as an
 * UNATTRIBUTED stall, the worst case, which must page for a human.
 */

import { describe, it, expect } from 'vitest';
import { evaluateSchedulerDeadman, type JobRunSignal } from './scheduler-deadman.js';
import type { ScheduledJobSpec } from './scheduler-manifest.js';

const NOW = Date.parse('2026-07-20T12:00:00Z');

const enabledDrain: ScheduledJobSpec = {
  id: 'batch-anchors',
  category: 'anchor-pipeline',
  schedule: '*/10 * * * *',
  targetPath: '/jobs/batch-anchors',
  method: 'POST',
  owner: 'lane-1',
  enabled: true,
  // Overdue if no run within this window.
  maxSilenceMs: 60 * 60 * 1000, // 1h
};

const pausedFeeder: ScheduledJobSpec = {
  id: 'fetch-courtlistener',
  category: 'feeder',
  schedule: '0 * * * *',
  targetPath: '/jobs/fetch-courtlistener',
  method: 'POST',
  owner: 'lane-3',
  enabled: false,
  pausedBy: 'carson',
  pausedReason: 'PI-0.5 feeder freeze (D12)',
  pausedAt: '2026-07-05',
  maxSilenceMs: 2 * 60 * 60 * 1000,
};

describe('evaluateSchedulerDeadman (SCRUM-2900 actor attribution)', () => {
  it('a recently-run enabled job is healthy, no firing', () => {
    const signals: JobRunSignal[] = [
      { id: 'batch-anchors', lastRunAt: '2026-07-20T11:50:00Z' },
    ];
    const report = evaluateSchedulerDeadman([enabledDrain], signals, NOW);
    expect(report.firing).toBe(false);
    expect(report.findings).toEqual([]);
  });

  it('an overdue ENABLED job fires as UNATTRIBUTED (worst case → page a human)', () => {
    const signals: JobRunSignal[] = [
      { id: 'batch-anchors', lastRunAt: '2026-07-20T08:00:00Z' }, // 4h silent, > 1h
    ];
    const report = evaluateSchedulerDeadman([enabledDrain], signals, NOW);
    expect(report.firing).toBe(true);
    const f = report.findings.find((x) => x.jobId === 'batch-anchors');
    expect(f?.attribution).toBe('unattributed');
    expect(f?.actor).toBeNull();
    expect(f?.message).toMatch(/enabled/i);
    expect(f?.message).toMatch(/batch-anchors/);
  });

  it('an enabled job that has NEVER run and is overdue fires unattributed', () => {
    const signals: JobRunSignal[] = [{ id: 'batch-anchors', lastRunAt: null }];
    const report = evaluateSchedulerDeadman([enabledDrain], signals, NOW);
    expect(report.firing).toBe(true);
    expect(report.findings[0].attribution).toBe('unattributed');
  });

  it('a PAUSED job that is silent is EXPECTED — attributed to the actor, not a page', () => {
    const signals: JobRunSignal[] = [
      { id: 'fetch-courtlistener', lastRunAt: '2026-07-05T00:00:00Z' },
    ];
    const report = evaluateSchedulerDeadman([pausedFeeder], signals, NOW);
    // A codified pause is expected silence — attributed, not firing.
    expect(report.firing).toBe(false);
    const f = report.findings.find((x) => x.jobId === 'fetch-courtlistener');
    expect(f?.attribution).toBe('paused');
    expect(f?.actor).toBe('carson');
    expect(f?.message).toMatch(/carson/);
    expect(f?.message).toMatch(/D12|freeze/i);
  });

  it('separates firing (enabled+overdue) from attributed-paused across a mixed fleet', () => {
    const signals: JobRunSignal[] = [
      { id: 'batch-anchors', lastRunAt: '2026-07-20T06:00:00Z' }, // overdue
      { id: 'fetch-courtlistener', lastRunAt: '2026-07-05T00:00:00Z' }, // paused
    ];
    const report = evaluateSchedulerDeadman([enabledDrain, pausedFeeder], signals, NOW);
    expect(report.firing).toBe(true);
    expect(report.firingJobIds).toEqual(['batch-anchors']);
    expect(report.findings).toHaveLength(2);
  });

  it('a monitored job with no signal at all fires unattributed (missing telemetry)', () => {
    const report = evaluateSchedulerDeadman([enabledDrain], [], NOW);
    expect(report.firing).toBe(true);
    expect(report.findings[0].attribution).toBe('unattributed');
    expect(report.findings[0].message).toMatch(/no run signal|never/i);
  });
});
