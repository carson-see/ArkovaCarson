import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

describe('CLI source and release metadata', () => {
  it('accepts only a complete source or release manifest state', () => {
    const sourceState = manifest.private === true && manifest.dependencies?.arkova === 'file:../sdk';
    const releaseState = manifest.private === undefined && manifest.dependencies?.arkova === '3.0.0';

    expect(sourceState || releaseState).toBe(true);
  });

  it('ships only the executable, declarations, README, and license', () => {
    expect(manifest.files).toEqual(['dist', 'README.md', 'LICENSE']);
    expect(manifest.license).toBe('MIT');
    expect(manifest.repository?.directory).toBe('packages/api-cli');
  });

  it('documents the exact isolated registry rewrite', () => {
    expect(publishing).toContain("npm pkg delete private");
    expect(publishing).toContain("npm pkg set 'dependencies.arkova=3.0.0'");
    expect(publishing).toContain('no `file:` dependency');
    expect(publishing).toContain('npm ci --ignore-scripts');
    expect(publishing).toContain('npm test');
  });
});
