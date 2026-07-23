import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildS33Wave2BaseCorpusRegistry,
  extendS33Wave2CorpusRegistry,
  S33_WAVE1_IMMUTABLE_TUPLE,
} from './s33-wave2-corpus-registry.js';

const repositoryRoot = execFileSync('/usr/bin/git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const verificationHeadSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const registry = buildS33Wave2BaseCorpusRegistry({ repositoryRoot, verificationHeadSha });

describe('S3.3 Wave-2 trusted-main corpus registry', () => {
  it('consumes the exact merged #1544 tuple and immutable 81-entry universe', () => {
    expect(registry.verificationHeadSha).toBe(verificationHeadSha);
    expect(registry.wave1Tuple.mergeCommitSha).toBe('42530fd73f9bd0cb7e4e70fc1259324810780b2c');
    expect(registry.wave1Tuple.producerHeadSha).toBe('618e08d5a11cb73cb61394bc0343d33f4353ef39');
    expect(registry.wave1Tuple).toEqual(S33_WAVE1_IMMUTABLE_TUPLE);
    expect(registry.entries).toHaveLength(81);
    expect(new Set(registry.entries.map(({ id }) => id))).toHaveLength(81);
    expect(registry.registryDigestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it('fails closed on duplicate ids and normalized inputs during extension', () => {
    const existing = registry.entries[0];
    const batch = {
      batchId: 'S33-W2-TEST', revision: 1, manifestPath: 'docs/lane4/s33-wave2-batches/test/manifest.json',
      manifestRawSha256: 'a'.repeat(64), sourcePath: 'services/worker/src/ai/eval/golden-dataset-s33-wave2-test-heldout.ts',
      sourceBlobSha: 'b'.repeat(40), datasheetPath: 'docs/lane4/s33-wave2-batches/test/datasheet.json',
      datasheetBlobSha: 'c'.repeat(40), entryCount: 1,
    } as const;
    expect(() => extendS33Wave2CorpusRegistry(registry, batch, [{
      ...existing, batchId: batch.batchId, revision: batch.revision, sourcePath: batch.sourcePath,
    }])).toThrow(/duplicate entry id/iu);
  });
});
