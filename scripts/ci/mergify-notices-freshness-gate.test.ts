/**
 * .mergify.yml — Third-Party Notices Freshness must actually gate the merge queue.
 *
 * The gate exists because `src/data/thirdPartyNotices.generated.json` (the data
 * behind the shipped /legal/third-party-notices page) is GENERATED but its
 * generator was never wired into CI: the file drifted from the dependency set
 * for over a month with no signal, and `qrcode-generator@2.0.4` shipped as an
 * undisclosed production dependency until a reviewer caught it by hand.
 *
 * Adding the ci.yml job is only half of that fix. A CI job that is not listed in
 * `.mergify.yml` merge_conditions gates NOTHING — Mergify merges while the check
 * is red, which is exactly how `Orphaned Export Lint` sat inert for a month. This
 * pins the check into every queue rule, and pins the ci.yml job name, so the two
 * cannot silently drift apart.
 *
 * It also pins the two properties that make requiring the check SAFE rather than
 * a queue deadlock: the job must carry no job-level `if:` and no path filter, or
 * it reports `skipped` on the PRs it does not apply to — and `skipped` never
 * satisfies `check-success`.
 *
 * Follows the raw-content contract style of mergify-orphaned-export-gate.test.ts.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const mergify = readFileSync('.mergify.yml', 'utf8');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

const CHECK_LINE = 'check-success = Third-Party Notices Freshness';
const JOB_KEY = 'notices-freshness:';

/** The queue_rules block: from `queue_rules:` to the next top-level key. */
function queueRulesBlock(): string {
  const start = mergify.indexOf('queue_rules:');
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = mergify.slice(start);
  const end = rest.search(/\nmerge_queue:/u);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The `notices-freshness:` job body: to the next top-level (2-space) job key. */
function noticesJobBlock(): string {
  const start = ci.indexOf(`  ${JOB_KEY}`);
  expect(start, `ci.yml must define the ${JOB_KEY} job`).toBeGreaterThanOrEqual(0);
  const rest = ci.slice(start + JOB_KEY.length + 2);
  const end = rest.search(/\n {2}[a-z0-9][a-z0-9-]*:\n/u);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('.mergify.yml — Third-Party Notices Freshness gates the queue', () => {
  it('every queue rule lists the check in its merge_conditions', () => {
    const block = queueRulesBlock();
    const rules = block.split(/\n {2}- name: /u).slice(1);
    expect(rules.length).toBeGreaterThanOrEqual(3);
    for (const rule of rules) {
      const ruleName = rule.split('\n', 1)[0];
      expect(rule, `queue rule "${ruleName}" must gate on ${CHECK_LINE}`).toContain(CHECK_LINE);
    }
  });

  it('ci.yml names the job exactly as the mergify condition expects', () => {
    // Mergify matches check-run NAMES; the condition is only as real as this
    // exact job name in ci.yml.
    expect(ci).toContain('name: Third-Party Notices Freshness');
  });
});

describe('ci.yml — the notices-freshness job cannot deadlock the queue', () => {
  it('carries no job-level `if:` guard', () => {
    const job = noticesJobBlock();
    // A job-level `if:` that evaluates false reports `skipped`, and `skipped`
    // never satisfies `check-success` — the queue would wait forever.
    expect(job).not.toMatch(/\n {4}if:/u);
  });

  it('carries no path filter', () => {
    const job = noticesJobBlock();
    expect(job).not.toMatch(/\n {4}paths(-ignore)?:/u);
  });

  it('is fail-closed — no continue-on-error', () => {
    // `continue-on-error: true` makes the job report success even when the
    // script exits 1, which would make the merge_conditions entry above hollow.
    const job = noticesJobBlock();
    expect(job).not.toMatch(/continue-on-error:\s*true/u);
  });

  it('installs dependencies, because the check compares the INSTALLED tree', () => {
    const job = noticesJobBlock();
    expect(job).toContain('npm ci');
    // Supply-chain guardrail, same rule scripts/ci/check-npm-install-policy.ts
    // enforces repo-wide: a compliance gate must not run package lifecycle
    // scripts.
    expect(job).toContain('npm ci --ignore-scripts');
  });

  it('invokes the checker directly, without touching root package.json', () => {
    // Deliberately NOT an npm script: root package.json governs the app/runtime
    // dependency tree, so `check-staging-evidence.ts` holds any PR touching it
    // above T0 and would demand soak evidence for a CI-only change. Same
    // invocation style as the `doc-pointers` job.
    const job = noticesJobBlock();
    expect(job).toContain('node_modules/.bin/tsx scripts/ci/check-third-party-notices-fresh.ts');
  });
});
