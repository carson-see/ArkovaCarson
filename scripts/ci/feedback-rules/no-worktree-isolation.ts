#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1253 (R0-7) rule: feedback_no_worktree_isolation.
 *
 * No worktree branches in this project — they confuse parallel sessions.
 * GH Actions sets GITHUB_HEAD_REF to the source branch on PR events.
 *
 * Override: PR labeled `worktree-branch-exception`.
 *
 * Why the override exists: PR #1737's branch (`worktree-agent-a1f762e7b0577b322`)
 * is a leftover artifact of the original push from a Claude worktree session —
 * the branch name, not the PR content, trips this gate. The diff itself is
 * founder-P0 UI, fully reviewed. CTO ruling (2026-08-01): keep the PR intact
 * on its existing branch rather than force a rename/re-push that would reset
 * review + CI state; label the exception instead of relaxing the rule itself.
 */

import { headRef, hasLabel, LABELS } from '../lib/ciContext.js';

export function run(): { ok: boolean; message: string } {
  if (!headRef) {
    return { ok: true, message: 'ℹ️  GITHUB_HEAD_REF not set — skipping (likely local dev).' };
  }
  const isWorktreeBranch =
    headRef.includes('.claude/worktrees/') || headRef.startsWith('worktree/') || /\bworktree\b/.test(headRef);

  if (!isWorktreeBranch) {
    return { ok: true, message: `✅ feedback_no_worktree_isolation: branch '${headRef}' is not a worktree path.` };
  }

  const overridden = hasLabel(LABELS.worktreeBranchException);
  const out = [`Branch '${headRef}' looks like a Claude worktree path.`];

  if (overridden) {
    out.push(`\n⚠️  PR labeled \`${LABELS.worktreeBranchException}\` — allowing.`);
    return { ok: true, message: out.join('\n') };
  }

  out.push('');
  out.push('::error::feedback_no_worktree_isolation violation (R0-7 / SCRUM-1253).');
  out.push('  Always work from the main checkout.');
  out.push('  See memory/feedback_no_worktree_isolation.md for context.');
  out.push(`  To allow this branch name, label the PR \`${LABELS.worktreeBranchException}\`.`);
  return { ok: false, message: out.join('\n') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  if (!result.ok) process.exit(1);
}
