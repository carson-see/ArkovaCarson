/**
 * Job postcondition assertion (SCRUM-3050 — silent-failure hardening).
 *
 * The failure class: `fetchAnchorRows` handed 1,000 UUIDs to a PostgREST
 * `.in()` filter, producing a ~38 KB query string that was rejected with
 * `400 Bad Request` on EVERY chunk. The handler logged the error, `continue`d,
 * returned an empty set — and the job reported HTTP 200. Zero anchors were
 * created for 70 hours while every cron dashboard stayed green.
 *
 * The generic defect is that "the handler ran to completion" was treated as
 * "the handler did its job". A cron that claimed N units of work and completed
 * ZERO of them has not succeeded; it must fail loudly so the failure lands in
 * the Cloud Scheduler log stream, where the SCRUM-3050 GCP alert policy is
 * watching for it.
 */

import { describe, it, expect } from 'vitest';

import {
  evaluateJobPostcondition,
  assertJobPostcondition,
  JobPostconditionError,
} from './jobPostcondition.js';

describe('evaluateJobPostcondition', () => {
  it('passes when there was genuinely nothing to do', () => {
    // Zero attempted is NOT a silent failure — an idle queue is a legitimate
    // state. "No work is arriving at all" is feeder-death, owned by a
    // different monitor (SCRUM-2900); asserting here would false-page nightly.
    const v = evaluateJobPostcondition({
      jobName: 'demo',
      attempted: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(v.ok).toBe(true);
    expect(v.degraded).toBe(false);
  });

  it('passes cleanly on a fully successful run', () => {
    const v = evaluateJobPostcondition({
      jobName: 'demo',
      attempted: 10,
      succeeded: 10,
      failed: 0,
    });
    expect(v.ok).toBe(true);
    expect(v.degraded).toBe(false);
  });

  it('FAILS when work was attempted and every unit errored (the 70h outage shape)', () => {
    const v = evaluateJobPostcondition({
      jobName: 'anchor-public-records',
      attempted: 1000,
      succeeded: 0,
      failed: 1000,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('1000');
    expect(v.reason).toMatch(/completed 0/i);
  });

  it('FAILS when work was attempted, nothing succeeded and nothing was even counted as failed', () => {
    // The accounting hole: units vanish without being tallied as errors. This
    // is strictly worse than a counted failure and must not read as success.
    const v = evaluateJobPostcondition({
      jobName: 'demo',
      attempted: 50,
      succeeded: 0,
      failed: 0,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/unaccounted/i);
  });

  it('FAILS when the counters are internally inconsistent (instrumentation is lying)', () => {
    const v = evaluateJobPostcondition({
      jobName: 'demo',
      attempted: 5,
      succeeded: 4,
      failed: 4,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/inconsistent/i);
  });

  it('FAILS on negative counters rather than trusting them', () => {
    const v = evaluateJobPostcondition({
      jobName: 'demo',
      attempted: -1,
      succeeded: 0,
      failed: 0,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/inconsistent|negative/i);
  });

  it('passes but marks DEGRADED on partial failure', () => {
    // Partial failure must NOT 500: retrying the whole job would redo the work
    // that already succeeded. It is surfaced as degraded so the caller can warn.
    const v = evaluateJobPostcondition({
      jobName: 'demo',
      attempted: 10,
      succeeded: 9,
      failed: 1,
    });
    expect(v.ok).toBe(true);
    expect(v.degraded).toBe(true);
    expect(v.reason).toContain('1');
  });

  it('treats a majority-failure run as degraded, not as success', () => {
    const v = evaluateJobPostcondition({
      jobName: 'demo',
      attempted: 100,
      succeeded: 1,
      failed: 99,
    });
    expect(v.ok).toBe(true);
    expect(v.degraded).toBe(true);
  });
});

describe('assertJobPostcondition', () => {
  it('throws a JobPostconditionError on total failure so the route returns 500', () => {
    expect(() =>
      assertJobPostcondition({
        jobName: 'monthly-allocation-rollover',
        attempted: 42,
        succeeded: 0,
        failed: 42,
      }),
    ).toThrow(JobPostconditionError);
  });

  it('names the job in the thrown message so the Cloud Scheduler log is actionable', () => {
    let caught: unknown;
    try {
      assertJobPostcondition({
        jobName: 'monthly-allocation-rollover',
        attempted: 42,
        succeeded: 0,
        failed: 42,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('monthly-allocation-rollover');
    expect((caught as JobPostconditionError).outcome.attempted).toBe(42);
  });

  it('does not throw on a healthy or merely degraded run', () => {
    expect(() =>
      assertJobPostcondition({ jobName: 'demo', attempted: 3, succeeded: 3, failed: 0 }),
    ).not.toThrow();
    expect(() =>
      assertJobPostcondition({ jobName: 'demo', attempted: 3, succeeded: 2, failed: 1 }),
    ).not.toThrow();
    expect(() =>
      assertJobPostcondition({ jobName: 'demo', attempted: 0, succeeded: 0, failed: 0 }),
    ).not.toThrow();
  });
});
