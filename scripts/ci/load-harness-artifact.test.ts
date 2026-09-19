import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateLoadConcurrencyEvidence } from './check-staging-evidence';
import { validateLoadHarnessArtifactReference } from './load-harness-artifact';

const completed = {
  startedAt: '2026-09-19T12:00:00.000Z',
  endedAt: '2026-09-19T12:01:00.000Z',
  durationSec: 60,
  apiBase: 'https://pr-3001---arkova-worker-staging-abc-uc.a.run.app',
  mode: 'mixed',
  concurrency: 10,
  totalRequests: 2,
  byMode: { reads: { ok: 1, fail: 1, errorRate: 0.5, p50Ms: 20, p95Ms: 40, p99Ms: 40, byStatus: { 200: 1, 500: 1 } } },
};

function repoFixture(value: unknown, raw?: string) {
  const root = mkdtempSync(join(tmpdir(), 'load-artifact-'));
  const relative = 'docs/staging/test/load-result.json';
  mkdirSync(join(root, 'docs/staging/test'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const bytes = raw ?? `${JSON.stringify(value)}\n`;
  writeFileSync(join(root, relative), bytes);
  execFileSync('git', ['add', relative], { cwd: root });
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { root, relative, reference: `load-harness artifact=${relative} sha256=${digest} p95 load result` };
}

describe('load-harness release artifact consumer', () => {
  it('accepts tracked, exact, producer-shaped completed bytes', () => {
    const f = repoFixture(completed);
    expect(validateLoadHarnessArtifactReference(f.reference, f.root)).toBeNull();
  });

  it('makes the release gate reject real producer-shaped partial output', () => {
    const f = repoFixture({ ...completed, partial: true, interruptedBy: 'SIGTERM', plannedDurationSec: 7200 });
    const body = `Load/concurrency evidence: ${f.reference}`;
    expect(validateLoadConcurrencyEvidence(body, f.root)).toMatch(/salvage artifacts cannot satisfy release evidence/);
  });

  it('rejects hollow, malformed, missing, traversal, and symlink artifacts', () => {
    const hollow = repoFixture({});
    expect(validateLoadHarnessArtifactReference(hollow.reference, hollow.root)).toMatch(/not completed producer output/);
    const malformed = repoFixture(null, '{');
    expect(validateLoadHarnessArtifactReference(malformed.reference, malformed.root)).toMatch(/not valid JSON/);
    expect(validateLoadHarnessArtifactReference('load-harness artifact=docs/staging/test/load-missing.json sha256=' + '0'.repeat(64), hollow.root)).toMatch(/git-tracked/);
    mkdirSync(join(hollow.root, 'other'), { recursive: true });
    writeFileSync(join(hollow.root, 'other/load-outside.json'), JSON.stringify(completed));
    expect(validateLoadHarnessArtifactReference('load-harness artifact=docs/staging/../../other/load-outside.json sha256=' + '0'.repeat(64), hollow.root)).toMatch(/under docs\/staging/);
    symlinkSync(join(hollow.root, hollow.relative), join(hollow.root, 'docs/staging/test/load-link.json'));
    execFileSync('git', ['add', 'docs/staging/test/load-link.json'], { cwd: hollow.root });
    expect(validateLoadHarnessArtifactReference('load-harness artifact=docs/staging/test/load-link.json sha256=' + '0'.repeat(64), hollow.root)).toMatch(/non-symlinked/);
  });

  it('rejects digest changes and unbound harness claims', () => {
    const f = repoFixture(completed);
    expect(validateLoadHarnessArtifactReference(f.reference.replace(/sha256=[0-9a-f]+/, `sha256=${'0'.repeat(64)}`), f.root)).toMatch(/SHA-256 mismatch/);
    expect(validateLoadHarnessArtifactReference('load-harness p95 was 40ms', f.root)).toMatch(/must include artifact=/);
  });
});
