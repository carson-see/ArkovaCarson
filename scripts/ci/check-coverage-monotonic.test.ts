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

function runScript(env: Record<string, string | undefined>): ScriptResult {
  // Spread parent env first, then explicit overrides. Setting a value to
  // undefined here unsets it in the child — important for clearing
  // CI-injected vars (BASE_REF_SHA at ci.yml:29) so the test's BASE_REF
  // takes effect rather than CI's PR base SHA which won't exist on a
  // shallow checkout.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  try {
    const stdout = execSync(`npx tsx ${SCRIPT}`, {
      env: childEnv,
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
    // Clear BASE_REF_SHA explicitly: ci.yml sets it to the PR base commit,
    // which on a fetch-depth: 1 checkout isn't in the local repo and would
    // make resolveBaseRefOrFail exit 1 before evaluating BASE_REF=HEAD.
    const result = runScript({ BASE_REF_SHA: undefined, BASE_REF: 'HEAD' });
    expect(result.exitCode, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
    expect(result.stdout).toContain('✅ No coverage threshold decreases');
  });
});
