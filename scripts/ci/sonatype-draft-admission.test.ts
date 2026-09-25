import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('.github/workflows/sonatype-scan.yml', 'utf8');

/**
 * Mirrors the job's real `if:` exactly (Actions-budget hygiene, 2026-09-21):
 * dependabot is skipped (no repo secrets on a dependabot-authored PR run —
 * cheap: the job never provisions a runner), a GENUINE Mergify merge-queue
 * speculative PR is now ALSO skipped (this job is advisory-only, and the
 * original PR already ran it — SCRUM-3812-hardened: branch prefix alone is
 * author-controlled, so `mergifyAuthor` must also be true), and an ordinary
 * draft PR is deferred until it's ready.
 */
function admitted(event: {
  name: string;
  draft?: boolean;
  head?: string;
  dependabot?: boolean;
  mergifyAuthor?: boolean;
}): boolean {
  const isDependabot = event.dependabot === true;
  const isMergifyQueue = event.head?.startsWith('mergify/merge-queue/') === true && event.mergifyAuthor === true;
  const isOrdinaryDraft = event.name === 'pull_request' && event.draft === true;
  return !isDependabot && !isMergifyQueue && !isOrdinaryDraft;
}

describe('Sonatype draft admission', () => {
  it('runs after readiness transitions, retains scheduled coverage, and gained workflow_dispatch', () => {
    expect(source).toContain('types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]');
    expect(source).toContain("- cron: '0 12 * * 1'");
    expect(source).toContain('workflow_dispatch: {}');
  });

  it('defers ordinary drafts and now ALSO defers Mergify merge-queue speculative PRs (advisory-only, not a merge gate)', () => {
    expect(admitted({ name: 'pull_request', draft: true, head: 'feature/x' })).toBe(false);
    expect(admitted({ name: 'pull_request', draft: false, head: 'feature/x' })).toBe(true);
    // Genuine Mergify queue PR (branch prefix AND mergify[bot] author) — now skipped.
    expect(admitted({ name: 'pull_request', draft: true, head: 'mergify/merge-queue/1', mergifyAuthor: true })).toBe(false);
    // A branch merely NAMED like a queue PR, without the mergify[bot] author, is NOT
    // treated as a queue PR — it stays on the ordinary draft/ready path (SCRUM-3812
    // spoofing guard: branch name alone is author-controlled).
    expect(admitted({ name: 'pull_request', draft: false, head: 'mergify/merge-queue/1', mergifyAuthor: false })).toBe(true);
    expect(admitted({ name: 'schedule' })).toBe(true);
    expect(admitted({ name: 'pull_request', draft: false, dependabot: true })).toBe(false);
    expect(source).toContain("!(startsWith(github.head_ref, 'mergify/merge-queue/') && github.event.pull_request.user.login == 'mergify[bot]')");
    expect(source).toContain("github.event.pull_request.draft != true");
  });

  it('preserves the complete four-workspace matrix', () => {
    for (const name of ['root', 'worker', 'edge', 'embed']) {
      expect(source).toContain(`- { name: ${name},`);
    }
  });
});
