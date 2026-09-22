#!/usr/bin/env -S npx tsx
/**
 * Dependabot T0 fast-path probe for staging-evidence.yml (Actions-budget
 * hygiene, 2026-09-21).
 *
 * `staging-evidence.yml`'s "Staging Soak Evidence Gate" job ran to
 * completion (full checkout, full `npm ci`, the full multi-hundred-line
 * `check()` in `check-staging-evidence.ts`: RC-manifest loading, S3.3
 * Lane-1 import scanning, base-drift diagnostics, …) on every Dependabot
 * PR, even a pure `packages/*` / `integrations/*` dependency bump that
 * `requiredTierFor()` already classifies T0 (docs/tests/CI/tooling-only —
 * see `isT0OnlyFile()`'s package.json/package-lock.json carve-outs in
 * check-staging-evidence.ts).
 *
 * This script is the CHEAP half of that fast path: it re-uses the SAME
 * `requiredTierFor()` the full gate uses — never a reimplementation — over
 * the PR's real changed-file list fetched from the GitHub API
 * (`gh api .../pulls/<n>/files`, no git diff needed since `requiredTierFor`
 * only classifies file PATHS). Deliberately NOT a parallel classifier: a
 * second copy of the T0 rules would drift from the source of truth exactly
 * the way `scripts/ci/agents.md`'s 2026-09-05 CLAIM_RULES entry describes
 * (a renamed/moved rule going silently dead while still reporting clean).
 *
 * Honesty note (see the PR body for the full writeup): this does NOT skip
 * `actions/checkout` or `npm ci` outright — running the real TypeScript
 * classifier still needs the compiled source and `typescript`/`tsx`
 * installed, and duplicating the classification logic to avoid that
 * dependency was rejected as a correctness risk, not attempted as a
 * shortcut. What it DOES skip, when the PR classifies T0, is the expensive
 * full `check()` invocation this workflow would otherwise run next — the
 * part that reads far more of the repository than a lockfile-only PR
 * touches.
 *
 * Exit code is always 0 — this is a probe that writes `eligible=true|false`
 * to `$GITHUB_OUTPUT`, never a gate. A malformed/missing input fails CLOSED
 * (eligible=false), so the calling workflow always falls through to the
 * full, authoritative gate on any doubt.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { requiredTierFor } from './check-staging-evidence.js';

function main(): void {
  const filesPath = process.env.CHANGED_FILES_PATH;
  const githubOutput = process.env.GITHUB_OUTPUT;

  if (!filesPath || !existsSync(filesPath)) {
    console.log(`CHANGED_FILES_PATH (${filesPath ?? '<unset>'}) is missing or unreadable — not eligible, falling through to the full gate.`);
    if (githubOutput) appendFileSync(githubOutput, 'eligible=false\n');
    return;
  }

  const files = readFileSync(filesPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (files.length === 0) {
    console.log('Changed-file list is empty — not eligible, falling through to the full gate.');
    if (githubOutput) appendFileSync(githubOutput, 'eligible=false\n');
    return;
  }

  const { tier, reason } = requiredTierFor(files);
  const eligible = tier === 'T0';

  console.log(`requiredTierFor() -> ${tier} (${reason}) over ${files.length} changed file(s):`);
  for (const f of files) console.log(`  - ${f}`);
  console.log(eligible
    ? 'ELIGIBLE: Dependabot T0 fast-path — the full Staging Soak Evidence check() will be skipped.'
    : `NOT ELIGIBLE (tier ${tier}) — falling through to the full Staging Soak Evidence Gate.`);

  if (githubOutput) appendFileSync(githubOutput, `eligible=${eligible}\n`);
}

main();
