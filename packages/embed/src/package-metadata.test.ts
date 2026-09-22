import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('published dist/ hygiene', () => {
  // 2026-09-21 independent-review finding: `npm pack` ships
  // dist/embed.{es,umd,iife}.js.map — vite.config.ts set `build.sourcemap: true`
  // with no exclusion in package.json's `files` array (unlike
  // packages/verifier-cli's `!dist/**/*.map` pattern, or packages/api-cli's
  // `tsconfig.json` `sourceMap: false`). Not introduced by PR #3035/#2986 —
  // a pre-existing condition caught by an independent tarball-hygiene pass.
  // Walks recursively (not a flat `readdirSync`), matching the same fix
  // `packages/api-cli/src/package-metadata.test.ts` needed for the same
  // class of bug (a flat scan missed a nested stale .map there).
  it('does not emit source maps ANYWHERE under dist/ (pretest/build already built it)', () => {
    const distDir = resolve(packageRoot, 'dist');
    expect(existsSync(distDir)).toBe(true);

    const mapFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const entryPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath);
        } else if (entry.name.endsWith('.map')) {
          mapFiles.push(entryPath);
        }
      }
    };
    walk(distDir);

    expect(mapFiles).toEqual([]);
  });
});
