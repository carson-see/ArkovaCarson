/**
 * Tests for check-do-not-merge-body.ts (SCRUM-3804, the #2240 pattern).
 *
 * A PR body saying "do not merge" is a prose hold — and prose is INERT to
 * Mergify. Only the `do-not-merge` LABEL blocks the queue (`.mergify.yml`
 * queue_conditions). PR #2240 carried exactly that: a body-level hold, no
 * label, and nothing between it and an auto-merge. The lint fails any
 * NON-DRAFT PR whose body contains the phrase (case-insensitive) without the
 * label, so a written hold is either made real or consciously removed.
 *
 * The main()-level tests pin GITHUB_REF/PR_NUMBER/GITHUB_REPOSITORY empty so
 * the live `gh` fetch short-circuits to null — the tests must stay hermetic
 * when this suite itself runs inside a pull_request CI job (where GITHUB_REF
 * is a real refs/pull/N/merge).
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOLD_LABEL,
  bodyDeclaresHold,
  evaluateProseHold,
  main,
} from './check-do-not-merge-body';

describe('bodyDeclaresHold', () => {
  it('matches the phrase case-insensitively', () => {
    expect(bodyDeclaresHold('Do Not Merge until the soak completes')).toBe(true);
    expect(bodyDeclaresHold('DO NOT MERGE')).toBe(true);
    expect(bodyDeclaresHold('please do not merge this yet')).toBe(true);
  });

  it('matches across whitespace runs and line wraps', () => {
    expect(bodyDeclaresHold('do  not merge')).toBe(true);
    expect(bodyDeclaresHold('do not\nmerge')).toBe(true);
  });

  it('does NOT match the hyphenated label name — bodies legitimately reference `do-not-merge`', () => {
    expect(bodyDeclaresHold('apply the do-not-merge label to hold this PR')).toBe(false);
  });

  it('does not match absent or unrelated text', () => {
    expect(bodyDeclaresHold('')).toBe(false);
    expect(bodyDeclaresHold('ready to merge')).toBe(false);
    expect(bodyDeclaresHold('donotmerge')).toBe(false);
  });
});

describe('evaluateProseHold', () => {
  it('fails a non-draft PR with a prose hold and no label', () => {
    const violation = evaluateProseHold({ body: 'do not merge yet', draft: false, holdLabelApplied: false });
    expect(violation).not.toBeNull();
    // The remediation must name the label the queue actually honors.
    expect(violation).toContain(HOLD_LABEL);
  });

  it('passes when the hold is label-backed — Mergify honors the label', () => {
    expect(evaluateProseHold({ body: 'do not merge yet', draft: false, holdLabelApplied: true })).toBeNull();
  });

  it('passes drafts — a draft cannot enter the queue', () => {
    expect(evaluateProseHold({ body: 'do not merge yet', draft: true, holdLabelApplied: false })).toBeNull();
  });

  it('passes a body without the phrase', () => {
    expect(evaluateProseHold({ body: 'routine fix', draft: false, holdLabelApplied: false })).toBeNull();
  });
});

describe('main (env-driven)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Pin the CI-context vars so no live `gh` fetch fires from inside a real PR run. */
  function stubHermetic(): void {
    vi.stubEnv('GITHUB_REF', '');
    vi.stubEnv('PR_NUMBER', '');
    vi.stubEnv('GITHUB_REPOSITORY', '');
  }

  it('exits 1 for a non-draft PR body holding in prose without the label', () => {
    stubHermetic();
    vi.stubEnv('PR_BODY', 'Do not merge — waiting on the T3 soak.');
    vi.stubEnv('PR_DRAFT', 'false');
    vi.stubEnv('PR_LABELS', '');
    expect(main()).toBe(1);
  });

  it('exits 0 when the do-not-merge label backs the prose hold', () => {
    stubHermetic();
    vi.stubEnv('PR_BODY', 'Do not merge — waiting on the T3 soak.');
    vi.stubEnv('PR_DRAFT', 'false');
    vi.stubEnv('PR_LABELS', `soak,${HOLD_LABEL}`);
    expect(main()).toBe(0);
  });

  it('exits 0 for a draft PR regardless of body', () => {
    stubHermetic();
    vi.stubEnv('PR_BODY', 'do not merge');
    vi.stubEnv('PR_DRAFT', 'true');
    vi.stubEnv('PR_LABELS', '');
    expect(main()).toBe(0);
  });

  it('exits 0 on push builds / no PR context (empty body)', () => {
    stubHermetic();
    vi.stubEnv('PR_BODY', '');
    vi.stubEnv('PR_DRAFT', '');
    vi.stubEnv('PR_LABELS', '');
    expect(main()).toBe(0);
  });
});

describe('wiring — the lint actually runs and the label actually blocks the queue', () => {
  it('ci.yml runs the lint inside the Policy Lints job with body + draft from the PR payload', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    const job = /\n {2}policy-lints:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n)/u.exec(ci)?.[0];
    expect(job, 'ci.yml must keep the policy-lints job').toBeDefined();
    expect(job).toContain('scripts/ci/check-do-not-merge-body.ts');
    expect(job).toMatch(/PR_DRAFT:\s*\$\{\{\s*github\.event\.pull_request\.draft\s*\}\}/u);
  });

  it('.mergify.yml still blocks queue entry on the do-not-merge label for the non-hotfix queues', () => {
    // The lint's remediation ("apply the do-not-merge label") is only real
    // while the label blocks the queues a normal PR embarks through. Pins the
    // `default` and `s33-wave2-corpus` queue rules, which carry the condition
    // today. (The `urgent`/hotfix queue has never carried it — hotfix entry is
    // Carson-labeled — and widening it is out of this lint's scope.)
    const mergify = readFileSync('.mergify.yml', 'utf8');
    const queueRules = mergify.slice(mergify.indexOf('queue_rules:'), mergify.indexOf('\nmerge_queue:'));
    for (const ruleName of ['default', 's33-wave2-corpus']) {
      const rule = queueRules.split(/\n {2}- name: /u).slice(1).find((r) => r.startsWith(ruleName));
      expect(rule, `queue rule "${ruleName}" must exist`).toBeDefined();
      expect(rule, `queue rule "${ruleName}" must keep -label = ${HOLD_LABEL}`).toContain(`-label = ${HOLD_LABEL}`);
    }
  });
});
