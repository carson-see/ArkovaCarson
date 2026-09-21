import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  private?: boolean;
  dependencies?: Record<string, string>;
  files?: string[];
  license?: string;
  repository?: { directory?: string };
};
const publishing = readFileSync(resolve(packageRoot, 'PUBLISHING.md'), 'utf8');

// Read live, not pinned: packages/sdk's version moves independently of this
// package (e.g. #3034 bumps it to 3.2.0), and a hardcoded expectation here
// goes stale the moment it does — exactly the class of drift PUBLISHING.md's
// runbook must also not encode as an exact pin. See its "release version"
// section: the published `arkova` dependency must be a caret range
// (`^X.Y.Z`) against the SDK version this CLI was actually built and tested
// against, not an exact string copied at authoring time.
const sdkPackageJsonPath = resolve(packageRoot, '..', 'sdk', 'package.json');
const sdkManifest = JSON.parse(readFileSync(sdkPackageJsonPath, 'utf8')) as { version: string };
const expectedReleaseRange = `^${sdkManifest.version}`;

describe('CLI source and release metadata', () => {
  it('accepts only a complete source or release manifest state', () => {
    const sourceState = manifest.private === true && manifest.dependencies?.arkova === 'file:../sdk';
    const releaseState = manifest.private === undefined
      && manifest.dependencies?.arkova === expectedReleaseRange;

    expect(sourceState || releaseState).toBe(true);
  });

  it('ships only the executable, declarations, README, and license', () => {
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

  it('documents the exact isolated registry rewrite without hardcoding an SDK version', () => {
    expect(publishing).toContain('npm pkg delete private');
    // Caret range derived from the SDK's OWN package.json at release time —
    // never a literal version number copied into this file (that number goes
    // stale the moment packages/sdk bumps, e.g. #3034 -> 3.2.0).
    expect(publishing).toContain('npm pkg set "dependencies.arkova=^$sdk_version"');
    expect(publishing).toContain("require('../sdk/package.json').version");
    expect(publishing).toContain('no `file:` dependency');
    expect(publishing).toContain('npm ci --ignore-scripts');
    expect(publishing).toContain('npm test');

    // No hardcoded semver literal (e.g. "3.1.0") anywhere in the runbook —
    // every version reference must go through $sdk_version / <sdk_version>.
    const bareVersionRE = /\barkova["'@=\s]*\d+\.\d+\.\d+\b/;
    expect(bareVersionRE.test(publishing)).toBe(false);
  });
});
