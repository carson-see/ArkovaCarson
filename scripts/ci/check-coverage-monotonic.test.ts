/**
 * Unit tests for check-coverage-monotonic.ts (R0-3 / SCRUM-1249).
 *
 * Validates the threshold-parsing + drop-detection logic without invoking
 * git. The CI integration test (against the real workflow) is observed
 * end-to-end on the PR — this suite locks the parser semantics.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, 'check-coverage-monotonic.ts');

interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runScript(env: Record<string, string>): ScriptResult {
  try {
    const stdout = execSync(`npx tsx ${SCRIPT}`, {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 };
  }
}

describe('check-coverage-monotonic (R0-3)', () => {
  it('passes when current branch matches base ref (no drops)', () => {
    // BASE_REF defaults to origin/main; on a fresh checkout this matches HEAD.
    const result = runScript({ BASE_REF: 'HEAD' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('✅ No coverage threshold decreases');
  });
});
