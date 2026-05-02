/**
 * Shared helpers for migration-lint script tests (SCRUM-1275 / 1276).
 *
 * Both lint suites need the same scaffold: a temp repo with a
 * supabase/migrations subdirectory, a way to write fixture SQL, and a
 * way to invoke the lint script with a per-test repo root (via env var)
 * so the production migrations directory isn't touched.
 *
 * The scripts are invoked via the local `node_modules/.bin/tsx` binary
 * — NOT `npx` — so we don't depend on PATH lookups (Sonar hotspot
 * S4036). Resolving the binary at module load means any binary
 * reshuffle blows up at import time, not silently at run time.
 */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const TSX_BIN = resolve(process.cwd(), 'node_modules', '.bin', 'tsx');

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Invoke a lint script (path absolute) against a per-test temp repo.
 * The script reads the override repo root from the named env var, so
 * production migrations are never touched.
 */
export function runLintScript(
  scriptPath: string,
  repoRootEnvVar: string,
  repoRoot: string,
): RunResult {
  const res = spawnSync(TSX_BIN, [scriptPath], {
    cwd: process.cwd(),
    env: { ...process.env, [repoRootEnvVar]: repoRoot },
    encoding: 'utf8',
  });
  const stderr = [
    res.stderr ?? '',
    res.error ? `spawnSync failed: ${res.error.message}` : '',
  ].filter(Boolean).join('\n');
  return {
    code: res.status ?? (res.error ? 127 : 1),
    stdout: res.stdout ?? '',
    stderr,
  };
}

/**
 * Make a fresh temp repo with `supabase/migrations/` ready to receive
 * fixture SQL. Caller is responsible for cleanup via `rmSync(root, ...)`.
 */
export function makeTempMigrationsRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, 'supabase', 'migrations'), { recursive: true });
  return root;
}
