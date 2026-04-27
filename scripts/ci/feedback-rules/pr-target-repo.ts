#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1253 (R0-7) rule: feedback_pr_target_repo.
 *
 * PRs MUST target carson-see/ArkovaCarson, not Arkova-io/arkova-mvp2.
 * Reads GITHUB_REPOSITORY (set automatically by GH Actions) and fails if
 * the workflow is running on the wrong repo.
 */

import { repository } from '../lib/ciContext.js';

const ALLOWED_REPO = 'carson-see/ArkovaCarson';

export function run(): { ok: boolean; message: string } {
  if (!repository) {
    return { ok: true, message: 'ℹ️  GITHUB_REPOSITORY not set — skipping (likely local dev).' };
  }
  if (repository === ALLOWED_REPO) {
    return { ok: true, message: `✅ feedback_pr_target_repo: PR is on ${repository}.` };
  }
  return {
    ok: false,
    message: [
      '::error::feedback_pr_target_repo violation (R0-7 / SCRUM-1253).',
      `  PRs must target ${ALLOWED_REPO}, not ${repository}.`,
      '  See memory/feedback_pr_target_repo.md for context.',
    ].join('\n'),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  if (!result.ok) process.exit(1);
}
