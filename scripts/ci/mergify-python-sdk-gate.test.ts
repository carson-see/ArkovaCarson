/**
 * .mergify.yml — Python SDK Tests must actually gate the merge queue.
 *
 * The `python-sdk-tests` ci.yml job (BUG-2026-08-12-007) exists because
 * packages/arkova-py's pytest/ruff suite ran NOWHERE on a pull request — its
 * only invocation lived in publish-python-sdk.yml, which fires after the
 * release decision. But a CI job that is not listed in `.mergify.yml`
 * merge_conditions gates NOTHING — Mergify merges while the check is red (the
 * exact class documented in `.github/workflows/agents.md`: "a new top-level
 * job would not be in branch protection or those merge conditions, so it
 * could go red while Mergify merged anyway"). Adding the job without wiring
 * it would have reproduced the original blindness one layer up: the suite
 * would run on every PR and still stop nothing.
 *
 * This pins the check into every queue rule so the gate is real, and pins the
 * ci.yml job name so the two cannot silently drift apart. No conditional-job
 * deadlock is possible: the job carries no job-level `if:` and no path filter
 * (see the ci.yml comment — deliberately "on every PR"), so the check name is
 * reported on every PR run of ci.yml, SDK-touching or not.
 *
 * Follows the raw-content contract style of s33-wave2-workflow-contract.test.ts
 * and the queue-gate shape of mergify-orphaned-export-gate.test.ts (PR #2257).
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const mergify = readFileSync('.mergify.yml', 'utf8');
const CHECK_LINE = 'check-success = Python SDK Tests (packages/arkova-py)';

/** The queue_rules block: from `queue_rules:` to the next top-level key. */
function queueRulesBlock(): string {
  const start = mergify.indexOf('queue_rules:');
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = mergify.slice(start);
  const end = rest.search(/\nmerge_queue:/u);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('.mergify.yml — Python SDK Tests gates the queue', () => {
  it('every queue rule lists the check in its merge_conditions', () => {
    const block = queueRulesBlock();
    // Split into individual queue rules on their `- name:` headers.
    const rules = block.split(/\n {2}- name: /u).slice(1);
    expect(rules.length).toBeGreaterThanOrEqual(3);
    for (const rule of rules) {
      const ruleName = rule.split('\n', 1)[0];
      expect(rule, `queue rule "${ruleName}" must gate on ${CHECK_LINE}`).toContain(CHECK_LINE);
    }
  });

  it('ci.yml still names the job exactly as the mergify condition expects', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    // Mergify matches check-run NAMES; the condition is only as real as this
    // exact job name in ci.yml.
    expect(ci).toContain('name: Python SDK Tests (packages/arkova-py)');
  });

  it('the gated job stays unconditional — a path-filtered job here would deadlock non-SDK PRs', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    // Extract the python-sdk-tests job block (same shape as
    // ci-workflow-contract.test.ts uses for this job).
    const job = /\n {2}python-sdk-tests:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n)/u.exec(ci)?.[0];
    expect(job, 'ci.yml must keep the python-sdk-tests job').toBeDefined();
    // A job-level `if:` (indented 4 spaces, directly under the job key) would
    // let the check go unreported on PRs where the condition is false, and an
    // unreported required check never satisfies `check-success` — the queue
    // would wait forever. Path conditioning in this repo is done with
    // step-level `if:` inside always-reporting jobs (e.g. ai-eval-gate's
    // `ai-changed` guard), never by suppressing a gated job.
    expect(
      job,
      'python-sdk-tests must not gain a job-level if: while listed in merge_conditions',
    ).not.toMatch(/\n {4}if:/u);
  });
});
