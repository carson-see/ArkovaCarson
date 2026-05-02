import { describe, expect, it } from 'vitest';
import {
  classifyDuplicateArtifactPath,
  scanTrackedPaths,
  type DuplicateArtifactKind,
} from './check-duplicate-artifacts.js';

function expectSingleViolation(path: string, segment: string, kind: DuplicateArtifactKind): void {
  expect(classifyDuplicateArtifactPath(path)).toEqual([{ path, segment, kind }]);
}

describe('check-duplicate-artifacts', () => {
  it('flags Finder-style copy suffixes', () => {
    expectSingleViolation('src/api/client copy.ts', 'client copy.ts', 'copy-suffix');
  });

  it('flags numbered duplicate files', () => {
    expectSingleViolation('src/api/client (2).ts', 'client (2).ts', 'numbered-copy');
  });

  it('flags stale merge and backup artifacts', () => {
    expectSingleViolation(
      'services/worker/src/api/verify.ts.orig',
      'verify.ts.orig',
      'backup-or-merge-artifact',
    );
  });

  it('flags copied repo/worktree directories inside the repo', () => {
    expectSingleViolation(
      'arkova-mvpcopy-main/src/App.tsx',
      'arkova-mvpcopy-main',
      'repo-copy-worktree',
    );
  });

  it('does not flag legitimate copy-related source names', () => {
    expect(scanTrackedPaths([
      'scripts/check-copy-terms.ts',
      'scripts/check-copy-terms.test.ts',
      'src/lib/copy.ts',
      'docs/product-copy-guide.md',
    ])).toEqual([]);
  });
});
