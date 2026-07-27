/**
 * SCRUM-2977 — unit tests for the anti-hollow-soak guard set.
 *
 * TDD note: the FAILING-CASE fixtures below reproduce each of the five hollow
 * signatures from the 2026-07-19 B1 incident family; each must fail its OWN
 * check and no other. The PASSING-CASE fixtures represent a healthy pre-clock
 * preflight where every guard passes and the soak clock may start.
 */

import { describe, expect, it } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkNonSkipDrainPreflight,
  checkSchedulerOidcAudience,
  checkTreasuryFunded,
  checkDeployProvenance,
  checkBaseIsMainPremerge,
  runAntiHollowSoakGuards,
  formatReport,
  main,
  type AntiHollowSoakInput,
  type DrainCycle,
  type SchedulerJob,
} from './guards.js';

// ---------------------------------------------------------------------------
// Passing baseline fixtures (a healthy pre-clock preflight)
// ---------------------------------------------------------------------------

const WORKER_URI = 'https://arkova-worker-staging-b1-abc123-uc.a.run.app';
const PR_HEAD_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

const PRODUCTIVE_DRAIN: DrainCycle[] = [
  { processed: 0, skipped: true, reason: 'warmup cycle' },
  { processed: 42, skipped: false, path: 'batch-anchor-drain' },
  { processed: 17, skipped: false, path: 'batch-anchor-drain' },
];

const HEALTHY_SCHEDULER: SchedulerJob = {
  name: 'b1-forced-flush',
  httpTarget: {
    uri: WORKER_URI,
    oidcToken: { audience: WORKER_URI },
  },
};

function healthyInput(): AntiHollowSoakInput {
  return {
    drainLog: PRODUCTIVE_DRAIN,
    schedulerJob: HEALTHY_SCHEDULER,
    treasury: { treasuryBalanceSats: 5_000_000, minRequiredSats: 100_000 },
    deployProvenance: {
      deployLogRows: [
        { head_sha: PR_HEAD_SHA, service: 'arkova-worker-staging-b1', at: '2026-07-19T02:00:00Z' },
      ],
      prHeadSha: PR_HEAD_SHA,
      service: 'arkova-worker-staging-b1',
    },
    base: { baseRefName: 'main' },
    changedPaths: ['batch-anchor-drain'],
  };
}

// ---------------------------------------------------------------------------
// Check 1 — non-skip-drain-preflight
// ---------------------------------------------------------------------------

describe('checkNonSkipDrainPreflight', () => {
  it('passes when at least one cycle processed real records', () => {
    const result = checkNonSkipDrainPreflight(PRODUCTIVE_DRAIN);
    expect(result.pass).toBe(true);
    expect(result.name).toBe('non-skip-drain-preflight');
  });

  it('FAILS (signature #1) when every cycle is a skip', () => {
    const allSkip: DrainCycle[] = [
      { processed: 0, skipped: true, reason: 'ENABLE_BATCH_ANCHORING=false' },
      { processed: 0, skipped: true, reason: 'ENABLE_BATCH_ANCHORING=false' },
      { processed: 0, skipped: true, reason: 'ENABLE_BATCH_ANCHORING=false' },
    ];
    const result = checkNonSkipDrainPreflight(allSkip);
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/ENABLE_BATCH_ANCHORING=false/);
    expect(result.message).toMatch(/signature-#1|empty-cycle/i);
  });

  it('FAILS when cycles are non-skip but always processed 0 (empty drain)', () => {
    const emptyDrain: DrainCycle[] = [
      { processed: 0, skipped: false },
      { processed: 0, skipped: false },
    ];
    const result = checkNonSkipDrainPreflight(emptyDrain);
    expect(result.pass).toBe(false);
  });

  it('FAILS when the drain log is empty', () => {
    expect(checkNonSkipDrainPreflight([]).pass).toBe(false);
  });

  // G-4: a productive cycle is not enough — the processed work must be
  // attributed to the PR's CHANGED path, not generic synthetic load. A rig can
  // burn a soak clock draining an unrelated (unchanged) queue and look
  // "productive" while the changed behavior is never exercised.
  it('passes when a productive cycle is attributed to a changed path (G-4)', () => {
    const attributed: DrainCycle[] = [
      { processed: 12, skipped: false, path: 'batch-anchor-drain' },
      { processed: 3, skipped: false, path: 'synthetic-load' },
    ];
    const result = checkNonSkipDrainPreflight(attributed, ['batch-anchor-drain']);
    expect(result.pass).toBe(true);
    expect(result.message).toMatch(/batch-anchor-drain/);
  });

  it('FAILS (G-4) when productive cycles exist but only on non-changed synthetic paths', () => {
    const syntheticOnly: DrainCycle[] = [
      { processed: 500, skipped: false, path: 'synthetic-load' },
      { processed: 250, skipped: false, path: 'synthetic-load' },
    ];
    const result = checkNonSkipDrainPreflight(syntheticOnly, ['batch-anchor-drain']);
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/synthetic|changed path/i);
    expect(result.message).toMatch(/batch-anchor-drain/);
  });

  it('FAILS (G-4) when changed paths are declared but no cycle carries attribution', () => {
    const unattributed: DrainCycle[] = [
      { processed: 42, skipped: false },
      { processed: 17, skipped: false },
    ];
    const result = checkNonSkipDrainPreflight(unattributed, ['batch-anchor-drain']);
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/attribut/i);
  });

  it('passes with a caveat when no changed paths are declared (legacy attribution-unaware)', () => {
    const result = checkNonSkipDrainPreflight(PRODUCTIVE_DRAIN, []);
    expect(result.pass).toBe(true);
    expect(result.message).toMatch(/attribution not asserted|not asserted/i);
  });
});

// ---------------------------------------------------------------------------
// Check 2 — scheduler-oidc-audience
// ---------------------------------------------------------------------------

describe('checkSchedulerOidcAudience', () => {
  it('passes when the OIDC audience matches the target URI', () => {
    const result = checkSchedulerOidcAudience(HEALTHY_SCHEDULER);
    expect(result.pass).toBe(true);
    expect(result.name).toBe('scheduler-oidc-audience');
  });

  it('FAILS (signature #2) when the OIDC audience is missing', () => {
    const noAudience: SchedulerJob = {
      name: 'b1-forced-flush',
      httpTarget: { uri: WORKER_URI, oidcToken: {} },
    };
    const result = checkSchedulerOidcAudience(noAudience);
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/no OIDC audience/i);
    expect(result.message).toMatch(/signature #2/);
  });

  it('FAILS when the OIDC token block is absent entirely', () => {
    const noToken: SchedulerJob = {
      name: 'b1-forced-flush',
      httpTarget: { uri: WORKER_URI },
    };
    expect(checkSchedulerOidcAudience(noToken).pass).toBe(false);
  });

  it('FAILS when the audience points somewhere other than the target URI', () => {
    const mismatched: SchedulerJob = {
      name: 'b1-forced-flush',
      httpTarget: {
        uri: WORKER_URI,
        oidcToken: { audience: 'https://some-other-service.a.run.app' },
      },
    };
    const result = checkSchedulerOidcAudience(mismatched);
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/does not match/i);
  });

  // G-3: a healthy Cloud Scheduler -> Cloud Run job carries the SERVICE ORIGIN
  // as its OIDC audience while the httpTarget.uri includes the invoked PATH
  // (e.g. /jobs/flush). Comparing the full uri+path against the audience
  // false-fails these. The correct comparison is origin-vs-origin.
  it('passes when the audience is the service origin and the uri carries a path (G-3)', () => {
    const healthyWithPath: SchedulerJob = {
      name: 'b1-forced-flush',
      httpTarget: {
        uri: `${WORKER_URI}/jobs/anchor-flush`,
        oidcToken: { audience: WORKER_URI },
      },
    };
    const result = checkSchedulerOidcAudience(healthyWithPath);
    expect(result.pass).toBe(true);
    expect(result.message).toMatch(/origin/i);
  });

  it('passes when the audience carries a trailing slash but the origin matches (G-3)', () => {
    const trailingSlash: SchedulerJob = {
      name: 'b1-forced-flush',
      httpTarget: {
        uri: `${WORKER_URI}/jobs/anchor-flush`,
        oidcToken: { audience: `${WORKER_URI}/` },
      },
    };
    expect(checkSchedulerOidcAudience(trailingSlash).pass).toBe(true);
  });

  it('FAILS when the audience origin differs even though the path would match (G-3)', () => {
    const crossHost: SchedulerJob = {
      name: 'b1-forced-flush',
      httpTarget: {
        uri: `${WORKER_URI}/jobs/anchor-flush`,
        oidcToken: { audience: 'https://some-other-service.a.run.app/jobs/anchor-flush' },
      },
    };
    const result = checkSchedulerOidcAudience(crossHost);
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/does not match/i);
  });

  it('FAILS when the httpTarget.uri is not a parseable URL (G-3)', () => {
    const badUri: SchedulerJob = {
      name: 'b1-forced-flush',
      httpTarget: { uri: 'not-a-url', oidcToken: { audience: WORKER_URI } },
    };
    expect(checkSchedulerOidcAudience(badUri).pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Check 3 — treasury-funded
// ---------------------------------------------------------------------------

describe('checkTreasuryFunded', () => {
  it('passes when balance meets the minimum', () => {
    const result = checkTreasuryFunded({ treasuryBalanceSats: 200_000, minRequiredSats: 100_000 });
    expect(result.pass).toBe(true);
    expect(result.name).toBe('treasury-funded');
  });

  it('passes when balance exactly equals the minimum', () => {
    expect(checkTreasuryFunded({ treasuryBalanceSats: 100_000, minRequiredSats: 100_000 }).pass).toBe(true);
  });

  it('FAILS (signature #3) when balance is below the minimum', () => {
    const result = checkTreasuryFunded({ treasuryBalanceSats: 0, minRequiredSats: 100_000 });
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/hasFunds\(\) would skip/);
    expect(result.message).toMatch(/signature #3/);
  });

  it('FAILS when balance/minimum are not numbers', () => {
    // @ts-expect-error deliberately malformed input
    expect(checkTreasuryFunded({ treasuryBalanceSats: undefined, minRequiredSats: 100 }).pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Check 4 — deploy-provenance
// ---------------------------------------------------------------------------

describe('checkDeployProvenance', () => {
  it('passes when a staging_deploy_log row matches head SHA + service', () => {
    const result = checkDeployProvenance({
      deployLogRows: [
        { head_sha: PR_HEAD_SHA, service: 'arkova-worker-staging-b1', at: '2026-07-19T02:00:00Z' },
      ],
      prHeadSha: PR_HEAD_SHA,
      service: 'arkova-worker-staging-b1',
    });
    expect(result.pass).toBe(true);
    expect(result.name).toBe('deploy-provenance');
  });

  it('FAILS (signature #4) when the rig wrote no deploy-log rows', () => {
    const result = checkDeployProvenance({
      deployLogRows: [],
      prHeadSha: PR_HEAD_SHA,
      service: 'arkova-worker-staging-b1',
    });
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/no staging_deploy_log rows/);
    expect(result.message).toMatch(/signature #4/);
  });

  it('FAILS when rows exist but none match the PR head SHA', () => {
    const result = checkDeployProvenance({
      deployLogRows: [
        { head_sha: 'deadbeef00000000000000000000000000000000', service: 'arkova-worker-staging-b1' },
      ],
      prHeadSha: PR_HEAD_SHA,
      service: 'arkova-worker-staging-b1',
    });
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/no staging_deploy_log row for/);
  });

  it('FAILS when the head SHA matches but the service does not', () => {
    const result = checkDeployProvenance({
      deployLogRows: [{ head_sha: PR_HEAD_SHA, service: 'some-other-service' }],
      prHeadSha: PR_HEAD_SHA,
      service: 'arkova-worker-staging-b1',
    });
    expect(result.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Check 5 — base-is-main-premerge
// ---------------------------------------------------------------------------

describe('checkBaseIsMainPremerge', () => {
  it('passes when the base ref is main', () => {
    const result = checkBaseIsMainPremerge({ baseRefName: 'main' });
    expect(result.pass).toBe(true);
    expect(result.name).toBe('base-is-main-premerge');
  });

  it('FAILS (signature #5) when the base is an agent/codex branch', () => {
    const result = checkBaseIsMainPremerge({ baseRefName: 'agent/s33-wave2-lane4-v71' });
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/not "main"/);
    expect(result.message).toMatch(/signature #5/);
  });

  it('FAILS when no base ref is supplied', () => {
    expect(checkBaseIsMainPremerge({ baseRefName: '' }).pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — passing case
// ---------------------------------------------------------------------------

describe('runAntiHollowSoakGuards — passing case', () => {
  it('passes all five guards on a healthy pre-clock preflight', () => {
    const report = runAntiHollowSoakGuards(healthyInput());
    expect(report.allPassed).toBe(true);
    expect(report.results).toHaveLength(5);
    expect(report.results.every((r) => r.pass)).toBe(true);
  });

  it('exposes one result per named check', () => {
    const report = runAntiHollowSoakGuards(healthyInput());
    expect(report.results.map((r) => r.name)).toEqual([
      'non-skip-drain-preflight',
      'scheduler-oidc-audience',
      'treasury-funded',
      'deploy-provenance',
      'base-is-main-premerge',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — each hollow signature fails ONLY its own check
// ---------------------------------------------------------------------------

describe('runAntiHollowSoakGuards — one hollow signature at a time', () => {
  function expectOnlyFails(input: AntiHollowSoakInput, failingCheck: string) {
    const report = runAntiHollowSoakGuards(input);
    expect(report.allPassed).toBe(false);
    const failed = report.results.filter((r) => !r.pass);
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe(failingCheck);
  }

  it('signature #1 (empty drain) fails ONLY non-skip-drain-preflight', () => {
    const input = healthyInput();
    input.drainLog = [{ processed: 0, skipped: true, reason: 'ENABLE_BATCH_ANCHORING=false' }];
    expectOnlyFails(input, 'non-skip-drain-preflight');
  });

  it('signature #2 (no OIDC audience) fails ONLY scheduler-oidc-audience', () => {
    const input = healthyInput();
    input.schedulerJob = { name: 'b1-forced-flush', httpTarget: { uri: WORKER_URI, oidcToken: {} } };
    expectOnlyFails(input, 'scheduler-oidc-audience');
  });

  it('signature #3 (unfunded treasury) fails ONLY treasury-funded', () => {
    const input = healthyInput();
    input.treasury = { treasuryBalanceSats: 0, minRequiredSats: 100_000 };
    expectOnlyFails(input, 'treasury-funded');
  });

  it('signature #4 (no provenance row) fails ONLY deploy-provenance', () => {
    const input = healthyInput();
    input.deployProvenance = {
      deployLogRows: [],
      prHeadSha: PR_HEAD_SHA,
      service: 'arkova-worker-staging-b1',
    };
    expectOnlyFails(input, 'deploy-provenance');
  });

  it('signature #5 (base-drift) fails ONLY base-is-main-premerge', () => {
    const input = healthyInput();
    input.base = { baseRefName: 'codex/soak-fix' };
    expectOnlyFails(input, 'base-is-main-premerge');
  });
});

// ---------------------------------------------------------------------------
// formatReport + CLI
// ---------------------------------------------------------------------------

describe('formatReport', () => {
  it('renders a start-the-clock line when all guards pass', () => {
    const out = formatReport(runAntiHollowSoakGuards(healthyInput()));
    expect(out).toMatch(/All guards passed/);
    expect(out).toMatch(/✅/);
  });

  it('renders a CI ::error:: line and blocks the clock when a guard fails', () => {
    const input = healthyInput();
    input.treasury = { treasuryBalanceSats: 0, minRequiredSats: 100_000 };
    const out = formatReport(runAntiHollowSoakGuards(input));
    expect(out).toMatch(/::error::/);
    expect(out).toMatch(/must NOT start/);
  });
});

describe('main (CLI)', () => {
  it('returns usage exit code 2 when no --input is given', () => {
    expect(main([])).toBe(2);
  });

  it('returns 2 when the input file cannot be read', () => {
    expect(main(['--input', '/nonexistent/anti-hollow-soak-input.json'])).toBe(2);
  });

  // Report-only mode (SCRUM-2977 / CTO W3 carve-out): the guard is wired into
  // ci.yml in report-only/warn mode until >=1 real green soak calibrates it. In
  // that mode the CLI must NEVER exit non-zero — it only annotates.
  it('report-only returns 0 with a notice when no --input is supplied', () => {
    expect(main(['--report-only'])).toBe(0);
  });

  it('report-only returns 0 (not 2) when the input file cannot be read', () => {
    expect(main(['--report-only', '--input', '/nonexistent/x.json'])).toBe(0);
  });

  it('report-only returns 0 even when a guard would block the soak clock', () => {
    const tmp = join(tmpdir(), `ahs-report-only-${Date.now()}.json`);
    const failing = healthyInput();
    failing.treasury = { treasuryBalanceSats: 0, minRequiredSats: 100_000 };
    writeFileSync(tmp, JSON.stringify(failing));
    try {
      expect(main(['--report-only', '--input', tmp])).toBe(0);
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it('non-report-only still returns 1 when a guard fails', () => {
    const tmp = join(tmpdir(), `ahs-gating-${Date.now()}.json`);
    const failing = healthyInput();
    failing.treasury = { treasuryBalanceSats: 0, minRequiredSats: 100_000 };
    writeFileSync(tmp, JSON.stringify(failing));
    try {
      expect(main(['--input', tmp])).toBe(1);
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
