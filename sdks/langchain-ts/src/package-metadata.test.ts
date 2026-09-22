import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  devDependencies?: Record<string, string>;
  license?: string;
};
const tsconfig = JSON.parse(readFileSync(resolve(packageRoot, 'tsconfig.json'), 'utf8')) as {
  compilerOptions?: { moduleResolution?: string; module?: string };
};

describe('release manifest state (first-public-release qualification)', () => {
  it('owns its TypeScript and Vitest dev toolchain instead of relying on the repo root', () => {
    expect(manifest.devDependencies?.typescript).toBeDefined();
    expect(manifest.devDependencies?.vitest).toBeDefined();
  });

  it('declares MIT license for standalone publishing', () => {
    expect(manifest.license).toBe('MIT');
  });

  it('does not use the deprecated node10 moduleResolution alias ("node" resolves to it)', () => {
    const resolution = (tsconfig.compilerOptions?.moduleResolution ?? '').toLowerCase();
    expect(resolution).not.toBe('node');
    expect(resolution).not.toBe('node10');
  });
});
