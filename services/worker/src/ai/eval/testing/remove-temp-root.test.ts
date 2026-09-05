/**
 * TDD: written before `remove-temp-root.ts`.
 *
 * The defect this closes is a CI flake, verified 2026-08-31 on PR #2513's
 * `Tests` run (33343897252), where the worker suite reported
 * `1 failed | 10972 passed` on a docs-only PR:
 *
 *   FAIL src/ai/eval/s33-wave1-dual-dag.test.ts
 *   Error: ENOTEMPTY: directory not empty, rmdir '/tmp/s33-dual-dag-P9Hq2b/.git/objects'
 *
 * The three s33 eval suites build real git fixtures under `os.tmpdir()` and
 * tear them down in `afterEach` with `rmSync(..., { maxRetries: 3,
 * retryDelay: 50 })`. Node retries ENOTEMPTY, but 3 x 50ms is a 150ms budget,
 * and on a loaded runner executing ~11k tests a git process can still be
 * flushing into `.git/objects` past that. The suite's assertions had all
 * passed; only the teardown raced.
 *
 * Two properties are required, and the second is the one that was missing:
 *   1. a retry budget wide enough to outlast a lagging git write;
 *   2. teardown of a throwaway OS temp directory must NEVER fail a suite whose
 *      assertions passed. A leftover directory under os.tmpdir() is reclaimed
 *      by the OS; a red `Tests` check on an unrelated PR is not free.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeTempRoot, TEMP_ROOT_RM_OPTIONS } from './remove-temp-root.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('removeTempRoot', () => {
  it('removes a populated directory tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-temp-root-'));
    mkdirSync(join(root, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(root, 'nested', 'deeper', 'blob'), 'x');

    removeTempRoot(root);

    expect(existsSync(root)).toBe(false);
  });

  it('is a no-op on a path that does not exist', () => {
    expect(() => removeTempRoot(join(tmpdir(), 'rm-temp-root-absent-12345'))).not.toThrow();
  });

  // The property the old inline `rmSync(...)` call sites lacked: a teardown
  // race must not turn a passing suite red.
  it('never throws when removal keeps failing', () => {
    const root = mkdtempSync(join(tmpdir(), 'rm-temp-root-'));
    const boom = Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir '.git/objects'"), {
      code: 'ENOTEMPTY',
    });

    expect(() => removeTempRoot(root, () => { throw boom; })).not.toThrow();

    removeTempRoot(root);
  });

  // Node retries ENOTEMPTY/EBUSY/EPERM internally; the budget has to outlast a
  // git process still flushing objects on a loaded runner. 150ms did not.
  it('allows at least a full second of retries', () => {
    expect(TEMP_ROOT_RM_OPTIONS.recursive).toBe(true);
    expect(TEMP_ROOT_RM_OPTIONS.force).toBe(true);
    expect(
      TEMP_ROOT_RM_OPTIONS.maxRetries * TEMP_ROOT_RM_OPTIONS.retryDelay,
    ).toBeGreaterThanOrEqual(1_000);
  });
});
