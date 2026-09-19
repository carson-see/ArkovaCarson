import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateLoadHarnessArtifactReference } from './load-harness-artifact';

function fixture(value: object) {
  const root = mkdtempSync(join(tmpdir(), 'load-artifact-'));
  const relative = 'docs/staging/test/load-result.json';
  mkdirSync(join(root, 'docs/staging/test'), { recursive: true });
  const bytes = `${JSON.stringify(value)}\n`;
  writeFileSync(join(root, relative), bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { root, reference: `load-harness artifact=${relative} sha256=${digest} p95 load result` };
}

describe('load-harness release artifact consumer', () => {
  it('accepts exact trusted bytes for a completed artifact', () => {
    const { root, reference } = fixture({ startedAt: 'a', endedAt: 'b', totalRequests: 1 });
    expect(validateLoadHarnessArtifactReference(reference, root)).toBeNull();
  });

  it('rejects a digest-valid interrupted artifact', () => {
    const { root, reference } = fixture({ partial: true, interruptedBy: 'SIGTERM', totalRequests: 9 });
    expect(validateLoadHarnessArtifactReference(reference, root)).toMatch(/salvage artifacts cannot satisfy release evidence/);
  });

  it('rejects any partial key, a digest mismatch, and an unbound harness claim', () => {
    const falseMarker = fixture({ partial: false, totalRequests: 9 });
    expect(validateLoadHarnessArtifactReference(falseMarker.reference, falseMarker.root)).toMatch(/interruption marker/);
    expect(validateLoadHarnessArtifactReference(falseMarker.reference.replace(/sha256=[0-9a-f]+/, `sha256=${'0'.repeat(64)}`), falseMarker.root)).toMatch(/SHA-256 mismatch/);
    expect(validateLoadHarnessArtifactReference('load-harness p95 was 40ms', falseMarker.root)).toMatch(/must include artifact=/);
  });
});
