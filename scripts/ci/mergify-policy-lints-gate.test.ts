/**
 * .mergify.yml — Policy Lints must actually gate the merge queue (SCRUM-3804).
 *
 * The `policy-lints` ci.yml job consolidates the governance lints (coverage
 * monotonic, count:'exact' baseline, feedback rules, config-drift, MCP
 * tool-claim parity, HANDOFF.md verification lint, Confluence coverage,
 * do-not-merge body/label parity). It has run on every PR — but a CI job that
 * is not listed in `.mergify.yml` merge_conditions gates NOTHING: Mergify
 * merges while the check is red (the exact class documented in
 * `.github/workflows/agents.md` and in `scripts/ci/agents.md`'s own
 * 2026-08-23 NOTE: "`Policy Lints` is in neither `.mergify.yml`'s
 * required-check set nor `main`'s branch-protection `required_status_checks`
 * … fails loudly in the run log while gating nothing"). Every documented
 * override label in the job (`mcp-claim-parity-reviewed`,
 * `handoff-narrative-only`, `coverage-drop-allowed`, …) was therefore a no-op
 * AS A MERGE GATE — there was nothing to override.
 *
 * This pins the check into every queue rule so the gate is real, and pins the
 * ci.yml job name so the two cannot silently drift apart. No conditional-job
 * deadlock is possible: the job carries no job-level `if:` and no path filter,
 * so the check name is reported on every PR run of ci.yml. (The ci.yml-wide
 * `paths-ignore` caveat — a PR touching ONLY LICENSE/.gitignore/README.md/
 * memory/**.md runs no ci.yml job at all — is shared with every other gated
 * ci.yml check and documented in `.mergify.yml` itself; it is not introduced
 * here.) Branch protection's required-check set is a separate, Carson/admin-
 * only surface — this test pins only the in-repo Mergify layer.
 *
 * Follows the raw-content contract style of s33-wave2-workflow-contract.test.ts
 * and the queue-gate shape of mergify-orphaned-export-gate.test.ts /
 * mergify-python-sdk-gate.test.ts.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const mergify = readFileSync('.mergify.yml', 'utf8');
const CHECK_LINE = 'check-success = Policy Lints';

/** The queue_rules block: from `queue_rules:` to the next top-level key. */
function queueRulesBlock(): string {
  const start = mergify.indexOf('queue_rules:');
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = mergify.slice(start);
  const end = rest.search(/\nmerge_queue:/u);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('.mergify.yml — Policy Lints gates the queue', () => {
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
    expect(ci).toContain('name: Policy Lints');
  });

  it('the gated job stays unconditional — a conditional job here would deadlock the queue', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const job = /\n {2}policy-lints:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n)/u.exec(ci)?.[0];
    expect(job, 'ci.yml must keep the policy-lints job').toBeDefined();
    // A job-level `if:` (indented 4 spaces, directly under the job key) would
    // let the check go unreported on PRs where the condition is false, and an
    // unreported required check never satisfies `check-success` — the queue
    // would wait forever. Path conditioning in this repo is done with
    // step-level `if:` inside always-reporting jobs (policy-lints already does
    // exactly that for its Confluence coverage step), never by suppressing a
    // gated job.
    expect(
      job,
      'policy-lints must not gain a job-level if: while listed in merge_conditions',
    ).not.toMatch(/\n {4}if:/u);
  });
});
