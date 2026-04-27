#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1253 (R0-7) rule: feedback_no_worktree_isolation.
 *
 * No worktree branches in this project — they confuse parallel sessions.
 * GH Actions sets GITHUB_HEAD_REF to the source branch on PR events.
 */

import { headRef } from '../lib/ciContext.js';

export function run(): { ok: boolean; message: string } {
  if (!headRef) {
    return { ok: true, message: 'ℹ️  GITHUB_HEAD_REF not set — skipping (likely local dev).' };
  }
  if (headRef.includes('.claude/worktrees/') || headRef.startsWith('worktree/') || /\bworktree\b/.test(headRef)) {
    return {
      ok: false,
      message: [
        '::error::feedback_no_worktree_isolation violation (R0-7 / SCRUM-1253).',
        `  Branch '${headRef}' looks like a Claude worktree path. Always work from the main checkout.`,
        '  See memory/feedback_no_worktree_isolation.md for context.',
      ].join('\n'),
    };
  }
  return { ok: true, message: `✅ feedback_no_worktree_isolation: branch '${headRef}' is not a worktree path.` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  if (!result.ok) process.exit(1);
}
