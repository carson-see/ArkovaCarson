#!/usr/bin/env tsx
/**
 * Aggregate this PR's commit messages into a file for the governance gates.
 *
 * WHY A FILE. ci.yml used to inline `git log --format=%B "$BASE_SHA"..HEAD`
 * into a $GITHUB_OUTPUT value that was then injected as the PR_COMMITS_MSGS
 * **environment variable** into the `HANDOFF.md verification lint` and
 * `Confluence page coverage` steps. Linux caps a single argv/envp string at
 * MAX_ARG_STRLEN = 131,072 bytes, so a large enough aggregate made `execve` of
 * the consuming step's `/usr/bin/bash` fail with E2BIG — "Argument list too
 * long". That is raised at process spawn, BEFORE any script logic runs: no
 * override label can clear it, and the red check carries no lint diagnosis.
 * Measured on PR #2346 (run 32666797304, job 97261336883, 2026-08-23): 153
 * commits / 138,166 bytes. A file has no such ceiling.
 *
 * WHY ANCHORED. The range was two-dotted straight from
 * `github.event.pull_request.base.sha`, which GitHub refreshes on
 * `synchronize` but NOT on close/reopen. #2346 stayed pinned at its
 * 2026-08-22 creation base, so when PR #2219 merged at 2026-08-23T20:57Z and
 * brought a long-lived branch's history into range, six real commits
 * presented as 153. That is the FD-GATE-2 shape already fixed for
 * `changedFiles`; this reuses the SAME {@link resolveDiffBase} rather than
 * re-deriving anchoring in shell, so the two cannot drift. Note that a plain
 * `git merge-base` would NOT have fixed it — the frozen base is an ancestor of
 * the recomputed merge preview, so it returns the frozen base unchanged.
 * HEAD^1 (the live base tip the preview was built on) is what collapses it.
 *
 * Usage (ci.yml `Aggregate commit messages` step):
 *   PR_COMMITS_MSGS_FILE=$RUNNER_TEMP/pr-commit-msgs.txt \
 *     node_modules/.bin/tsx scripts/ci/aggregate-commit-messages.ts
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';

import { GIT_BIN, REPO, getBaseRef, isMainModule, resolveDiffBase } from './lib/ciContext.js';

/**
 * git log can legitimately exceed execFileSync's 1MB `maxBuffer` default on a
 * long-lived branch, and ENOBUFS there would simply relocate the failure the
 * file transport exists to remove. 64MB is far above any plausible aggregate
 * while still bounding a runaway read.
 */
const MAX_LOG_BUFFER = 64 * 1024 * 1024;

/**
 * The PR's own commit messages, full bodies (`%B`).
 *
 * With an explicit base (pull_request builds) the range is anchored by
 * {@link resolveDiffBase}. Without one (push builds, where ci.yml passes an
 * empty `BASE_REF_SHA`) this returns the tip commit only — the pre-existing
 * shell behavior, preserved verbatim.
 */
export function commitMessagesForPr(env: NodeJS.ProcessEnv = process.env): string {
  const hasExplicitBase = Boolean(env.BASE_REF_SHA || env.BASE_REF);

  // Fail CLOSED on an unresolvable base: getBaseRef({ required: true })
  // exits(1) with the SCRUM-1246 message rather than letting the gates run
  // against an empty haystack and pass.
  const args = hasExplicitBase
    ? ['log', '--format=%B', `${resolveDiffBase(getBaseRef({ required: true })!)}..HEAD`]
    : ['log', '--format=%B', '-1'];

  return execFileSync(GIT_BIN, args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: MAX_LOG_BUFFER,
  });
}

/**
 * Write the aggregate to the path named by PR_COMMITS_MSGS_FILE.
 *
 * Throws when the path is unset. A silent no-op would leave both gates reading
 * an empty haystack and reporting green — the wrong direction for a governance
 * check, and indistinguishable from "this PR made no claims."
 */
export function writeCommitMessages(env: NodeJS.ProcessEnv = process.env): {
  path: string;
  bytes: number;
} {
  const path = env.PR_COMMITS_MSGS_FILE?.trim();
  if (!path) {
    throw new Error(
      'PR_COMMITS_MSGS_FILE is not set. The commit-message aggregate must be written to a ' +
        'file — passing it as an environment variable is what raised E2BIG on PR #2346.',
    );
  }

  const messages = commitMessagesForPr(env);
  writeFileSync(path, messages, 'utf8');
  return { path, bytes: Buffer.byteLength(messages) };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const { path, bytes } = writeCommitMessages();
  console.log(`Aggregated commit messages -> ${path} (${bytes} bytes)`);
}
