import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertHeicChunkIsolated } from './vendor-heic-chunk-isolation.js';

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

describe('assertHeicChunkIsolated (real vite.config.ts)', () => {
  it('the repo vite.config.ts honors the isolation rule today', () => {
    const source = readFileSync(resolve(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const result = assertHeicChunkIsolated(source);
    expect(result.isolated, result.violation).toBe(true);
  });
});
