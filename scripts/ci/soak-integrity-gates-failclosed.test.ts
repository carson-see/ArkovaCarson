/**
 * SCRUM-2897 / SCRUM-2965 / SCRUM-2977 — the two soak-integrity gates must be
 * wired FAIL-CLOSED.
 *
 * Both gates shipped under the W3-freeze CTO carve-out in report-only mode and
 * gated nothing. Three independent mechanisms had to be removed for either to
 * be real, and removing only one leaves the gate hollow:
 *
 *   1. the CLI `--report-only` flag (makes `main()` always return 0),
 *   2. `|| true` on the invocation (discards a non-zero exit),
 *   3. `continue-on-error: true` on the step (a failed step still greens the job),
 *
 * and a fourth, one level up:
 *
 *   4. absence from `.mergify.yml` merge_conditions — a check that Mergify does
 *      not evaluate can be red while Mergify merges anyway (the exact class
 *      already documented for `Orphaned Export Lint`; see
 *      `mergify-orphaned-export-gate.test.ts`).
 *
 * This suite pins all four so the activation cannot silently regress.
 *
 * It also pins the two preconditions that make a fail-closed flip SAFE rather
 * than a trap:
 *
 *   - Mergify's speculative merge-queue PRs (`mergify/merge-queue/*`) do not
 *     carry the original PR's evidence block, so the evidence-identity job must
 *     skip them or every queued merge deadlocks.
 *   - ci.yml's `pull_request` trigger declares no `types:`, so it defaults to
 *     `[opened, synchronize, reopened]` — a PR-body `edited` event never reaches
 *     it. Binding the check to the FROZEN `github.event.pull_request.*` payload
 *     would mean an author who fixes a stale `PR head SHA:` via `gh pr edit`
 *     could never turn the check green (SCRUM-3026 replay class). The job must
 *     resolve live PR state via `gh api`, same as staging-evidence.yml.
 *
 * Raw-content contract style, following mergify-orphaned-export-gate.test.ts
 * and staging-evidence-workflow-contract.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '..', '..');
const CI_PATH = resolve(REPO, '.github/workflows/ci.yml');
const MERGIFY_PATH = resolve(REPO, '.mergify.yml');

const ci = readFileSync(CI_PATH, 'utf8');
const mergify = readFileSync(MERGIFY_PATH, 'utf8');

const EVIDENCE_IDENTITY_CHECK = 'check-success = Evidence-identity gate';
const ANTI_HOLLOW_SOAK_CHECK = 'check-success = Anti-hollow-soak guards';

/**
 * Extract one top-level job block from ci.yml: from `  <jobId>:` up to (but not
 * including) the next job — either its key or the comment header that
 * introduces it, both at 2-space indent (a job's OWN keys and comments sit at
 * 4+).
 *
 * The comment half matters. Stopping only at the next KEY swallowed the next
 * job's header comments into this job's text — for `evidence-identity` that was
 * 16 lines of prose that name `--report-only`, `|| true` and
 * `continue-on-error`, i.e. exactly the strings the negative assertions below
 * search for. Every one of them would then have been judging a neighbour's
 * comment rather than this job's wiring, and the positive assertions could have
 * been satisfied by that prose instead of by the job.
 */
function jobBlock(jobId: string): string {
  const lines = ci.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  expect(start, `ci.yml must define a top-level job \`${jobId}\``).toBeGreaterThanOrEqual(0);

  const block = [lines[start]];
  for (let cursor = start + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (/^ {2}(?:[A-Za-z0-9_-]+:\s*$|#)/u.test(line)) break;
    block.push(line);
  }
  return block.join('\n');
}

/**
 * The queue_rules block: from `queue_rules:` to whatever top-level key comes
 * next.
 *
 * Deliberately not anchored on `merge_queue:` by name — renaming or removing
 * that unrelated key would silently run this slice to EOF and drag the
 * `pull_request_rules` entries in as if they were queue rules.
 */
function queueRulesBlock(): string {
  const header = '\nqueue_rules:';
  const start = mergify.indexOf(header);
  expect(start, '.mergify.yml must define queue_rules').toBeGreaterThanOrEqual(0);
  const rest = mergify.slice(start + header.length);
  const end = rest.search(/\n[A-Za-z_][A-Za-z0-9_]*:/u);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Individual queue rules, split on their `- name:` headers. */
function queueRules(): Array<{ name: string; body: string }> {
  const rules = queueRulesBlock().split(/\n {2}- name: /u).slice(1);
  expect(rules.length, 'expected at least the three known queue rules').toBeGreaterThanOrEqual(3);
  return rules.map((body) => ({ name: body.split('\n', 1)[0], body }));
}

// ---------------------------------------------------------------------------
// evidence-identity (SCRUM-2897 / SCRUM-2965)
// ---------------------------------------------------------------------------

describe('ci.yml — evidence-identity gate is wired fail-closed', () => {
  // Guards every assertion below. A jobBlock() that runs past this job's own
  // steps into the NEXT job's header comments would have the negative
  // assertions judging a neighbour's prose about `--report-only` / `|| true` /
  // `continue-on-error`, and would let the positive ones be satisfied by that
  // prose instead of by this job's wiring.
  it('scopes the extracted block to this job only', () => {
    const block = jobBlock('evidence-identity');
    expect(block, "must not bleed into the next job's header comments").not.toMatch(
      /anti-hollow-soak/u,
    );
    expect(block, 'and must still cover this job in full').toMatch(
      /check-evidence-identity\.ts/u,
    );
  });

  it('names the job without a report-only qualifier', () => {
    const block = jobBlock('evidence-identity');
    expect(block, 'the job name is the check name Mergify matches').toMatch(
      /^\s+name: Evidence-identity gate\s*$/mu,
    );
  });

  it('invokes the checker WITHOUT --report-only', () => {
    const block = jobBlock('evidence-identity');
    expect(block, 'check-evidence-identity.ts must actually be invoked').toMatch(
      /check-evidence-identity\.ts/u,
    );
    expect(
      block,
      '`--report-only` makes main() always exit 0 — the gate would decide nothing',
    ).not.toMatch(/--report-only/u);
  });

  it('does not discard the checker exit code with `|| true`', () => {
    expect(
      jobBlock('evidence-identity'),
      '`|| true` swallows a non-zero exit and greens the step regardless',
    ).not.toMatch(/\|\|\s*true/u);
  });

  it('does not carry continue-on-error on any step', () => {
    expect(
      jobBlock('evidence-identity'),
      'continue-on-error: true greens the JOB even when the step failed',
    ).not.toMatch(/continue-on-error:\s*true/u);
  });

  it('skips Mergify speculative merge-queue PRs', () => {
    const block = jobBlock('evidence-identity');
    // Speculative queue PRs carry Mergify's own body, not the original PR's
    // evidence block. Without this skip a fail-closed gate deadlocks the queue.
    expect(block, 'must recognise the mergify/merge-queue/* head ref').toContain(
      'mergify/merge-queue/',
    );
  });

  it('resolves LIVE PR state instead of the frozen event payload', () => {
    const block = jobBlock('evidence-identity');
    // ci.yml's pull_request trigger has no `types:` (default: opened,
    // synchronize, reopened) — a body edit never fires it. A frozen-payload
    // binding would make a `gh pr edit` fix unobservable even on a rerun.
    expect(block, 'expected a `Resolve live PR state` step (id: live_pr)').toMatch(
      /^\s+id: live_pr\s*$/mu,
    );
    expect(block, 'PR_BODY must bind to the live-resolved body').toMatch(
      /PR_BODY:\s*\$\{\{\s*steps\.live_pr\.outputs\.body\s*\}\}/u,
    );
    expect(block, 'PR_HEAD_SHA must bind to the live-resolved head SHA').toMatch(
      /PR_HEAD_SHA:\s*\$\{\{\s*steps\.live_pr\.outputs\.head_sha\s*\}\}/u,
    );
    expect(
      block,
      'the evidence inputs must not read the frozen github.event.pull_request payload',
    ).not.toMatch(/PR_(?:BODY|HEAD_SHA):\s*\$\{\{\s*github\.event\.pull_request\./u);
  });

  it('frames the author-controlled PR body with a per-run random heredoc delimiter', () => {
    const block = jobBlock('evidence-identity');
    // SECURITY: the PR body is fully author-controlled. A FIXED $GITHUB_OUTPUT
    // heredoc delimiter would let an author close the value early and inject
    // `key=value` lines — including overwriting head_sha, forging the very
    // identity this gate exists to make unforgeable.
    const delimiterAssignment = /(?<var>[A-Z_]+)="[a-z_]*\$\(openssl rand -hex \d+\)"/u.exec(block);
    expect(
      delimiterAssignment,
      'expected a per-run random heredoc delimiter (openssl rand)',
    ).not.toBeNull();
    const delimiterVar = delimiterAssignment?.groups?.var as string;
    expect(block, 'the heredoc must open with the random delimiter variable').toContain(
      `body<<\${${delimiterVar}}`,
    );
  });
});

// ---------------------------------------------------------------------------
// anti-hollow-soak (SCRUM-2977)
// ---------------------------------------------------------------------------

describe('ci.yml — anti-hollow-soak guards are wired fail-closed', () => {
  it('names the job without a report-only qualifier', () => {
    expect(jobBlock('anti-hollow-soak')).toMatch(/^\s+name: Anti-hollow-soak guards\s*$/mu);
  });

  it('invokes the guards WITHOUT --report-only', () => {
    const block = jobBlock('anti-hollow-soak');
    expect(block).toMatch(/anti-hollow-soak\/guards\.ts/u);
    expect(
      block,
      '`--report-only` makes main() always exit 0 — the guards would block nothing',
    ).not.toMatch(/--report-only/u);
  });

  it('does not discard the guard exit code with `|| true`', () => {
    expect(
      jobBlock('anti-hollow-soak'),
      '`|| true` was the belt-and-suspenders that made the flag removal moot',
    ).not.toMatch(/\|\|\s*true/u);
  });

  it('does not carry continue-on-error on any step', () => {
    expect(jobBlock('anti-hollow-soak')).not.toMatch(/continue-on-error:\s*true/u);
  });

  it('only invokes the guards with an --input preflight', () => {
    const block = jobBlock('anti-hollow-soak');
    // Fail-closed `main()` returns usage exit code 2 with no --input. The
    // "no preflight committed" case must stay a notice + exit 0, not a red job,
    // or every PR in the repo fails on an absent convention directory.
    // Match executed lines only (`tsx <path>`), not prose mentions of the path.
    const invocations = block.match(/^.*tsx\s+\S*anti-hollow-soak\/guards\.ts.*$/gmu) ?? [];
    expect(invocations.length, 'expected at least one guards.ts invocation').toBeGreaterThan(0);
    for (const line of invocations) {
      expect(line, 'a bare guards.ts call exits 2 (usage) in fail-closed mode').toMatch(
        /--input/u,
      );
    }
  });

  it('propagates a guard failure out of the per-preflight loop', () => {
    const block = jobBlock('anti-hollow-soak');
    // A loop that runs each preflight but never records the failure reproduces
    // the hollow wiring in shell instead of YAML: every file gets "checked",
    // the step still exits 0.
    expect(
      block,
      'the loop must record a failing preflight instead of continuing silently',
    ).toMatch(/failed=1/u);
    expect(block, 'expected an explicit non-zero exit path for a failed guard').toMatch(
      /^\s+exit 1\s*$/mu,
    );
  });
});

// ---------------------------------------------------------------------------
// .mergify.yml — a check absent from merge_conditions gates nothing
// ---------------------------------------------------------------------------

describe('.mergify.yml — both soak-integrity gates gate the merge queue', () => {
  it('every queue rule gates on the evidence-identity check', () => {
    for (const rule of queueRules()) {
      expect(
        rule.body,
        `queue rule "${rule.name}" must list \`${EVIDENCE_IDENTITY_CHECK}\``,
      ).toContain(EVIDENCE_IDENTITY_CHECK);
    }
  });

  it('every queue rule gates on the anti-hollow-soak check', () => {
    for (const rule of queueRules()) {
      expect(
        rule.body,
        `queue rule "${rule.name}" must list \`${ANTI_HOLLOW_SOAK_CHECK}\``,
      ).toContain(ANTI_HOLLOW_SOAK_CHECK);
    }
  });

  it('ci.yml names the jobs exactly as the mergify conditions expect', () => {
    // Mergify matches check-run NAMES; each condition is only as real as the
    // exact job name in ci.yml.
    for (const check of [EVIDENCE_IDENTITY_CHECK, ANTI_HOLLOW_SOAK_CHECK]) {
      const jobName = check.replace('check-success = ', '');
      expect(ci, `ci.yml must keep the job name "${jobName}"`).toMatch(
        new RegExp(`^\\s+name: ${jobName}\\s*$`, 'mu'),
      );
    }
  });
});
