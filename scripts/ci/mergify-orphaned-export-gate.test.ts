/**
 * .mergify.yml — Orphaned Export Lint must actually gate the merge queue.
 *
 * The `orphaned-export-lint` ci.yml job (CTO ruling R14, SCRUM-3032/3033/3034)
 * is fail-closed BY DESIGN (`continue-on-error: false`; the script's own
 * new-vs-preexisting split is the leniency mechanism). But a CI job that is
 * not listed in `.mergify.yml` merge_conditions gates NOTHING — Mergify
 * merges while the check is red (the exact class documented in
 * `.github/workflows/agents.md`: "a new top-level job would not be in branch
 * protection or those merge conditions, so it could go red while Mergify
 * merged anyway"). This pins the check into every queue rule so the gate is
 * real, and pins the ci.yml job name so the two cannot silently drift apart.
 *
 * Follows the raw-content contract style of s33-wave2-workflow-contract.test.ts.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const mergify = readFileSync('.mergify.yml', 'utf8');
const CHECK_LINE = 'check-success = Orphaned Export Lint';

/** The queue_rules block: from `queue_rules:` to the next top-level key. */
function queueRulesBlock(): string {
  const start = mergify.indexOf('queue_rules:');
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = mergify.slice(start);
  const end = rest.search(/\nmerge_queue:/u);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('.mergify.yml — Orphaned Export Lint gates the queue', () => {
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
    expect(ci).toContain('name: Orphaned Export Lint');
  });
});
