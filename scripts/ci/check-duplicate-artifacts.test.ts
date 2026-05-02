import { describe, expect, it } from 'vitest';
import {
  classifyDuplicateArtifactPath,
  scanTrackedPaths,
} from './check-duplicate-artifacts.js';

describe('check-duplicate-artifacts', () => {
  it('flags Finder-style copy suffixes', () => {
    expect(classifyDuplicateArtifactPath('src/api/client copy.ts')).toEqual([
      {
        path: 'src/api/client copy.ts',
        segment: 'client copy.ts',
        kind: 'copy-suffix',
      },
    ]);
  });

  it('flags numbered duplicate files', () => {
    expect(classifyDuplicateArtifactPath('src/api/client (2).ts')).toEqual([
      {
        path: 'src/api/client (2).ts',
        segment: 'client (2).ts',
        kind: 'numbered-copy',
      },
    ]);
  });

  it('flags stale merge and backup artifacts', () => {
    expect(classifyDuplicateArtifactPath('services/worker/src/api/verify.ts.orig')).toEqual([
      {
        path: 'services/worker/src/api/verify.ts.orig',
        segment: 'verify.ts.orig',
        kind: 'backup-or-merge-artifact',
      },
    ]);
  });

  it('flags copied repo/worktree directories inside the repo', () => {
    expect(classifyDuplicateArtifactPath('arkova-mvpcopy-main/src/App.tsx')).toEqual([
      {
        path: 'arkova-mvpcopy-main/src/App.tsx',
        segment: 'arkova-mvpcopy-main',
        kind: 'repo-copy-worktree',
      },
    ]);
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
