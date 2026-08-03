import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertHeicChunkIsolated, isHeicDependencyInstalled } from './vendor-heic-chunk-isolation.js';

const REPO_ROOT = resolve(__dirname, '../..');

function fakeConfig(manualChunksBody: string): string {
  return `
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes('node_modules')) return undefined;
${manualChunksBody}
          return undefined;
        },
      },
    },
  },
});
`;
}

describe('assertHeicChunkIsolated (synthetic vite.config.ts sources)', () => {
  it('is vacuously satisfied when heic-decode/libheif-js is not referenced at all', () => {
    const source = fakeConfig(`          if (id.includes('pdfjs-dist')) return 'vendor-pdf';`);
    const result = assertHeicChunkIsolated(source);
    expect(result).toEqual({ referencesHeicModules: false, isolated: true });
  });

  it('passes when heic-decode/libheif-js gets its own dedicated chunk', () => {
    const source = fakeConfig(`
          if (id.includes('pdfjs-dist')) return 'vendor-pdf';
          if (id.includes('heic-decode') || id.includes('libheif-js')) return 'vendor-heic';
          if (id.includes('@supabase/supabase-js')) return 'vendor-supabase';
`);
    const result = assertHeicChunkIsolated(source);
    expect(result.referencesHeicModules).toBe(true);
    expect(result.isolated).toBe(true);
  });

  it('FAILS when heic-decode is folded into an existing shared vendor chunk (regression case)', () => {
    const source = fakeConfig(`
          if (id.includes('@huggingface/transformers')) return 'vendor-ai-ner';
          if (id.includes('heic-decode') || id.includes('libheif-js')) return 'vendor-ai-ner';
`);
    const result = assertHeicChunkIsolated(source);
    expect(result.isolated).toBe(false);
    expect(result.violation).toMatch(/vendor-ai-ner/);
  });

  it('FAILS when heic-decode is referenced but no branch routes it (falls through to a default/shared chunk)', () => {
    // No `if (...) return` branch matches heic-decode/libheif-js at all —
    // simulates someone deleting the routing branch while a stray reference
    // to the module name remains elsewhere in the function (e.g. a debug
    // log), so the module silently falls through to `return undefined`.
    const source = fakeConfig(`
          if (id.includes('pdfjs-dist')) return 'vendor-pdf';
          if (id === 'debug') console.log('heic-decode module seen:', id);
`);
    const result = assertHeicChunkIsolated(source);
    expect(result.referencesHeicModules).toBe(true);
    expect(result.isolated).toBe(false);
    expect(result.violation).toMatch(/no `if/);
  });

  it('does not mistake a documentation comment mentioning heic-decode for a live branch', () => {
    const source = fakeConfig(`
          // Example: if (id.includes('heic-decode') || id.includes('libheif-js')) return 'vendor-heic';
          if (id.includes('pdfjs-dist')) return 'vendor-pdf';
`);
    const result = assertHeicChunkIsolated(source);
    expect(result).toEqual({ referencesHeicModules: false, isolated: true });
  });
});

// The guard used to be UNFALSIFIABLE: it parsed only vite.config.ts, so a
// missing heic branch was read as "dependency not in the tree yet — vacuously
// satisfied" and returned GREEN. That is exactly the violating state, and it is
// the state the repo was actually in: heic-decode has been a production
// dependency the whole time. These pin the fix.
describe('assertHeicChunkIsolated — dependency presence makes the guard falsifiable', () => {
  const noHeicBranch = fakeConfig(`
          if (id.includes('pdfjs-dist')) return 'vendor-pdf';
`);

  it('FAILS when the dependency is installed but no isolation branch exists', () => {
    const result = assertHeicChunkIsolated(noHeicBranch, true);
    expect(result.isolated).toBe(false);
    expect(result.violation).toMatch(/IS in the dependency tree/);
  });

  it('passes when the dependency is genuinely absent', () => {
    const result = assertHeicChunkIsolated(noHeicBranch, false);
    expect(result).toEqual({ referencesHeicModules: false, isolated: true });
  });

  it('a documentation comment alone does NOT satisfy the rule for an installed dependency', () => {
    const commentOnly = fakeConfig(`
          // Example: if (id.includes('heic-decode') || id.includes('libheif-js')) return 'vendor-heic';
          if (id.includes('pdfjs-dist')) return 'vendor-pdf';
`);
    expect(assertHeicChunkIsolated(commentOnly, true).isolated).toBe(false);
  });
});

describe('isHeicDependencyInstalled', () => {
  it('detects a direct package.json dependency', () => {
    expect(
      isHeicDependencyInstalled({
        packageJson: { dependencies: { 'heic-decode': '2.1.0' } },
        packageLockJson: {},
      }),
    ).toBe(true);
  });

  it('detects a transitive lockfile-only entry (libheif-js under heic-decode)', () => {
    expect(
      isHeicDependencyInstalled({
        packageJson: { dependencies: { react: '19.0.0' } },
        packageLockJson: { packages: { 'node_modules/libheif-js': { version: '1.19.8' } } },
      }),
    ).toBe(true);
  });

  it('returns false for an unrelated tree', () => {
    expect(
      isHeicDependencyInstalled({
        packageJson: { dependencies: { react: '19.0.0' } },
        packageLockJson: { packages: { 'node_modules/react': {} } },
      }),
    ).toBe(false);
  });
});

describe('assertHeicChunkIsolated (real vite.config.ts + real dependency tree)', () => {
  it('the repo vite.config.ts honors the isolation rule against the ACTUAL tree', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    const packageLockJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package-lock.json'), 'utf8'));
    const installed = isHeicDependencyInstalled({ packageJson, packageLockJson });

    // heic-decode IS shipped today (src/lib/ocrWorker.ts dynamically imports
    // it). If this ever flips to false, the guard below goes vacuous again —
    // assert it loudly rather than letting the suite quietly stop testing.
    expect(installed).toBe(true);

    const result = assertHeicChunkIsolated(source, installed);
    expect(result.isolated, result.violation).toBe(true);
  });
});
