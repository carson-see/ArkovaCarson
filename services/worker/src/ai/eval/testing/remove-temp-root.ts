/**
 * Resilient teardown for throwaway git fixture roots under `os.tmpdir()`.
 *
 * WHY THIS EXISTS. The s33 eval suites build real git repositories in the OS
 * temp directory and remove them in `afterEach`. Verified on 2026-08-31 (PR
 * #2513 `Tests` run 33343897252), that teardown raced a lagging git write on a
 * loaded runner and failed a docs-only PR:
 *
 *   FAIL src/ai/eval/s33-wave1-dual-dag.test.ts
 *   Error: ENOTEMPTY: directory not empty, rmdir '/tmp/s33-dual-dag-P9Hq2b/.git/objects'
 *
 * Every assertion in that suite had passed. Only the cleanup threw, and it
 * turned the repo-wide `Tests` check red on an unrelated pull request.
 *
 * The previous inline call sites used `{ maxRetries: 3, retryDelay: 50 }`.
 * Node does retry ENOTEMPTY/EBUSY/EPERM/EMFILE/ENFILE internally, but 3 x 50ms
 * is a 150ms budget — too tight for a `git` child process still flushing loose
 * objects while ~11k other tests contend for the same runner.
 *
 * Two changes, and the second matters more than the first:
 *   1. widen the retry budget to a full second;
 *   2. make teardown non-fatal. A directory left under `os.tmpdir()` is
 *      reclaimed by the OS; a red required check on someone else's PR is not.
 *      Cleanup of a disposable fixture is best-effort by definition, so it
 *      reports to stderr and returns rather than propagating.
 */

import { rmSync } from 'node:fs';

/**
 * Removal options for a disposable fixture root. Exported so the budget is
 * assertable rather than a magic pair of numbers at each call site.
 */
export const TEMP_ROOT_RM_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
} as const;

/** The `rmSync`-shaped remover. Injectable so the failure path is testable. */
type Remover = (path: string) => void;

const defaultRemover: Remover = (path) => rmSync(path, TEMP_ROOT_RM_OPTIONS);

/**
 * Best-effort removal of a disposable fixture root. Never throws.
 *
 * @param root   directory to remove; a missing path is a no-op (`force: true`).
 * @param remove seam for tests only — production callers omit it.
 */
export function removeTempRoot(root: string, remove: Remover = defaultRemover): void {
  try {
    remove(root);
  } catch (err) {
    // Deliberately swallowed — see the module header. Surfaced so a genuine
    // leak is still visible in the run log instead of disappearing silently.
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[test-cleanup] could not remove fixture root ${root}: ${reason}\n`);
  }
}
