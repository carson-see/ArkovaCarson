import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
  license?: string;
  repository?: { directory?: string };
};
const publishing = readFileSync(resolve(packageRoot, 'PUBLISHING.md'), 'utf8');

describe('CLI source and release metadata', () => {
  it('keeps the sibling SDK build-only and the executable portable', () => {
    expect(manifest.private).toBe(true);
    expect(manifest.dependencies?.arkova).toBeUndefined();
    expect(manifest.devDependencies?.arkova).toBe('file:../sdk');
    expect(manifest.scripts?.build).toContain('tsup src/cli.ts');
    const executable = readFileSync(resolve(packageRoot, 'dist', 'cli.js'), 'utf8');
    expect(executable).toMatch(/^#!\/usr\/bin\/env node/);
    expect(executable).not.toMatch(/(?:from|require\()\s*['"]arkova['"]/);
  });

  it('ships only the executable, README, and license', () => {
    expect(manifest.files).toEqual(['dist', 'README.md', 'LICENSE']);
    expect(manifest.license).toBe('MIT');
    expect(manifest.repository?.directory).toBe('packages/api-cli');
  });

  it('does not emit source maps ANYWHERE under dist/, including nested dirs (pretest already built it)', () => {
    // Walks the whole tree rather than `readdirSync(distDir)` alone: a flat
    // scan is blind to a `.map` sitting in a subdirectory (e.g. tsc mirroring
    // a nested src/ layout, or a stale file left behind by a previous build
    // that `npm run build` didn't clean first — see the `build` script's
    // `rm -rf dist` prestep, added for exactly this reason). Demonstrated
    // during this fix: manually placing `dist/nested/stale.js.map` left the
    // old flat-`readdirSync` version of this test GREEN.
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

  it('documents isolated clean-install qualification before any publication', () => {
    expect(publishing).toContain('remove `private`');
    expect(publishing).toContain('no runtime `file:` dependency');
    expect(publishing).toContain('outside this repository');
    expect(publishing).toContain('npm ci --ignore-scripts');
    expect(publishing).toContain('npm test');
  });

  it('packs and runs from a clean consumer outside the checkout', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'arkova-cli-pack-'));
    try {
      const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: packageRoot, encoding: 'utf8', timeout: 15_000 }))[0] as { filename: string; files: Array<{ path: string }> };
      expect(packed.files.map(f => f.path).sort()).toEqual(['LICENSE', 'README.md', 'dist/cli.js', 'package.json']);
      execFileSync('npm', ['init', '-y'], { cwd: scratch, stdio: 'ignore', timeout: 10_000 });
      execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(scratch, packed.filename)], { cwd: scratch, stdio: 'ignore', timeout: 15_000 });
      const output = execFileSync(join(scratch, 'node_modules/.bin/arkova'), ['--help'], { cwd: scratch, encoding: 'utf8', timeout: 10_000 });
      expect(JSON.parse(output).command).toBe('arkova');
      expect(existsSync(join(scratch, 'node_modules/arkova'))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
