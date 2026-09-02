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

  // R4: detect-reorgs is the control that protects SECURED integrity — it
  // reverts SECURED→SUBMITTED when a reorg displaces an anchor's block
  // (jobs/chain-maintenance.ts::detectReorgs, CRIT-2). It is declared in
  // scripts/gcp-setup/cloud-scheduler.sh, routed at POST /jobs/detect-reorgs,
  // and LIVE-VERIFIED ENABLED in prod Cloud Scheduler on 2026-09-02 (see the
  // entry's own comment for the gcloud read-back) — but was ABSENT from this
  // manifest, so nothing watched it for silence. The prod trigger is Cloud
  // Scheduler; routes/scheduled.ts also registers an in-process node-cron
  // backup, which is NOT disabled in prod (DISABLE_IN_PROCESS_ANCHOR_CRON is
  // unset, default false) but is serialised behind the same
  // acquireLock(LOCK_REORG_DETECTION), so it changes nothing for this budget.
  describe('detect-reorgs (R4 — SECURED-integrity control)', () => {
    it('is registered, enabled, and on the 10-minute chain-maintenance cadence', () => {
      const job = getScheduledJob('detect-reorgs');
      expect(job).toBeDefined();
      expect(job?.enabled).toBe(true);
      expect(job?.schedule).toBe('*/10 * * * *');
      expect(job?.targetPath).toBe('/jobs/detect-reorgs');
      expect(job?.method).toBe('POST');
    });

    it('is categorised on the anchor pipeline, not as a feeder', () => {
      // It mutates anchor lifecycle state (SECURED → SUBMITTED), so it escalates
      // to lane-1 like the rest of the pipeline, not to the feeder owner.
      const job = getScheduledJob('detect-reorgs');
      expect(job?.category).toBe('anchor-pipeline');
      expect(job?.owner).toBe('lane-1');
    });

    it('carries a maxSilenceMs budget the dead-man can evaluate', () => {
      expect(getScheduledJob('detect-reorgs')?.maxSilenceMs).toBeGreaterThan(0);
    });

    // The budget is derived from THIS job's own coverage band, not from the
    // cadence it shares with its peers. detectReorgs only inspects anchors with
    // chain_block_height >= tip - REORG_CHECK_DEPTH_BLOCKS (=10,
    // chain-maintenance.ts), and an anchor only reaches SECURED at
    // getMinConfirmations() = 6 on mainnet (check-confirmations.ts), i.e. at
    // height <= tip - 5. So any given anchor is reorg-checkable for a window of
    // ~5 blocks — ~50 min at Bitcoin's 10-minute target. Silence LONGER than
    // that band means anchors entered and left the checkable window without
    // ever being examined, which is precisely the SECURED-integrity gap this
    // entry exists to catch. A budget at or above the band can therefore only
    // alarm AFTER coverage was already lost.
    const BLOCK_TARGET_MS = 10 * 60 * 1000;
    // tip-10 (query floor) .. tip-5 (earliest SECURED) = 5 block slots.
    const REORG_COVERAGE_BAND_MS = 5 * BLOCK_TARGET_MS;

    it('budgets silence BELOW its own reorg-check coverage band, not at peer cadence', () => {
      const job = getScheduledJob('detect-reorgs');
      expect(job?.maxSilenceMs).toBeLessThan(REORG_COVERAGE_BAND_MS);
      // Still tolerant of two consecutive missed ticks (a deploy, a transient
      // mempool.space failure) before it pages: 30 min = 3 scheduled runs.
      expect(job?.maxSilenceMs).toBeGreaterThanOrEqual(3 * BLOCK_TARGET_MS);
      expect(job?.maxSilenceMs).toBe(30 * 60 * 1000);
    });

    it('is TIGHTER than the peer anchor-pipeline budgets, which are cadence-derived', () => {
      // batch-anchors / check-confirmations are */30 jobs whose 1h budget is
      // "two missed runs". Reusing that number here would exceed the coverage
      // band above, so this job deliberately does not match its peers.
      const job = getScheduledJob('detect-reorgs');
      expect(job?.maxSilenceMs).toBeLessThan(getScheduledJob('batch-anchors')?.maxSilenceMs ?? 0);
      expect(job?.maxSilenceMs).toBeLessThan(
        getScheduledJob('check-confirmations')?.maxSilenceMs ?? 0,
      );
    });

    it('is included in enabledScheduledJobs()', () => {
      expect(enabledScheduledJobs().map((j) => j.id)).toContain('detect-reorgs');
    });
  });
});
