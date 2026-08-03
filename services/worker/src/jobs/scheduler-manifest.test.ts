/**
 * Tests for the config-as-code scheduler manifest (SCRUM-2900).
 *
 * The manifest is the repo source of truth for the CRITICAL scheduled jobs
 * (Cloud Scheduler → POST /jobs/*). D12: the public-record FEEDER jobs are
 * codified here as PAUSED, each carrying an actor attribution (who/what paused
 * it and why) so the dead-man can name the responsible party — the exact gap
 * behind the untracked-pause failure mode.
 */

import { describe, it, expect } from 'vitest';
import {
  SCHEDULER_MANIFEST,
  getScheduledJob,
  enabledScheduledJobs,
  pausedScheduledJobs,
  validateSchedulerManifest,
  type ScheduledJobSpec,
} from './scheduler-manifest.js';

describe('scheduler manifest (SCRUM-2900 config-as-code)', () => {
  it('is internally valid (no dup ids, pause fields consistent)', () => {
    expect(validateSchedulerManifest(SCHEDULER_MANIFEST)).toEqual([]);
  });

  it('has unique job ids', () => {
    const ids = SCHEDULER_MANIFEST.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every job targets a /jobs/* path with an explicit method', () => {
    for (const job of SCHEDULER_MANIFEST) {
      expect(job.targetPath.startsWith('/jobs/'), `${job.id} targetPath`).toBe(true);
      expect(['GET', 'POST']).toContain(job.method);
    }
  });

  it('every ENABLED job carries no pause attribution', () => {
    for (const job of enabledScheduledJobs()) {
      expect(job.enabled).toBe(true);
      expect(job.pausedBy, `${job.id} pausedBy`).toBeUndefined();
      expect(job.pausedReason, `${job.id} pausedReason`).toBeUndefined();
    }
  });

  it('any PAUSED job in the shipped manifest carries full actor attribution', () => {
    // The shipped manifest may legitimately have zero paused jobs (D12 pending).
    // Whatever IS paused must be fully attributed — the paused-machinery itself
    // is exercised by synthetic fixtures in the deadman/validator tests.
    for (const job of pausedScheduledJobs()) {
      expect(job.enabled).toBe(false);
      expect(job.pausedBy, `${job.id} pausedBy`).toBeTruthy();
      expect(job.pausedReason, `${job.id} pausedReason`).toBeTruthy();
      expect(job.pausedAt, `${job.id} pausedAt`).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  });

  it('includes the critical anchoring-drain scheduler, enabled', () => {
    const drain = getScheduledJob('batch-anchors');
    expect(drain).toBeDefined();
    expect(drain?.enabled).toBe(true);
    expect(drain?.category).toBe('anchor-pipeline');
  });

  it('records the public-record feeders as VERIFIED-active (not a false D12 pause)', () => {
    // Prod (Cloud Run logs 2026-07-20) shows these feeders ACTIVE. §1.5: the
    // manifest states what IS. D12 (codify-as-paused) is a pending ruling; when
    // applied it flips these to paused + attribution.
    const feeders = SCHEDULER_MANIFEST.filter((j) => j.category === 'feeder');
    expect(feeders.length).toBeGreaterThan(0);
    expect(feeders.every((j) => j.enabled)).toBe(true);
    expect(getScheduledJob('fetch-courtlistener')?.enabled).toBe(true);
  });

  it('validateSchedulerManifest catches a paused job missing attribution', () => {
    const bad: ScheduledJobSpec[] = [
      {
        id: 'x',
        category: 'feeder',
        schedule: '0 * * * *',
        targetPath: '/jobs/x',
        method: 'POST',
        owner: 'lane-3',
        enabled: false,
        // missing pausedBy / pausedReason / pausedAt
      },
    ];
    const errors = validateSchedulerManifest(bad);
    expect(errors.join(' ')).toMatch(/attribution|pausedBy|pausedReason/i);
  });

  it('validateSchedulerManifest catches an enabled job that still has pause fields', () => {
    const bad: ScheduledJobSpec[] = [
      {
        id: 'y',
        category: 'maintenance',
        schedule: '0 * * * *',
        targetPath: '/jobs/y',
        method: 'POST',
        owner: 'lane-1',
        enabled: true,
        pausedBy: 'someone',
        pausedReason: 'stale',
        pausedAt: '2026-07-01',
      },
    ];
    const errors = validateSchedulerManifest(bad);
    expect(errors.join(' ')).toMatch(/enabled/i);
  });

  it('validateSchedulerManifest catches duplicate ids', () => {
    const dup: ScheduledJobSpec[] = [
      { id: 'z', category: 'maintenance', schedule: '0 * * * *', targetPath: '/jobs/z', method: 'POST', owner: 'l1', enabled: true },
      { id: 'z', category: 'maintenance', schedule: '0 * * * *', targetPath: '/jobs/z', method: 'POST', owner: 'l1', enabled: true },
    ];
    expect(validateSchedulerManifest(dup).join(' ')).toMatch(/duplicate/i);
  });

  // GH #1835/#1836 (PR #1944 review round 3): register the renewal job so a
  // forgotten/failed Cloud Scheduler creation is COVERED BY CONSTRUCTION
  // once the dead-man audit (scheduler-deadman.ts / scheduler-pause-
  // attribution.ts) actually runs against this manifest — see the entry's
  // own HONESTY NOTE for the current (pre-existing, repo-wide) gap that
  // audit has no live trigger of its own yet.
  describe('drive-subscription-renewal (GH #1835/#1836)', () => {
    it('is registered, enabled, and hourly', () => {
      const job = getScheduledJob('drive-subscription-renewal');
      expect(job).toBeDefined();
      expect(job?.enabled).toBe(true);
      expect(job?.schedule).toBe('0 * * * *');
      expect(job?.targetPath).toBe('/jobs/drive-subscription-renewal');
      expect(job?.method).toBe('POST');
    });

    it('carries a maxSilenceMs budget (required for the dead-man to evaluate it at all)', () => {
      const job = getScheduledJob('drive-subscription-renewal');
      expect(job?.maxSilenceMs).toBeGreaterThan(0);
    });

    it('is included in enabledScheduledJobs()', () => {
      expect(enabledScheduledJobs().map((j) => j.id)).toContain('drive-subscription-renewal');
    });
  });
});
