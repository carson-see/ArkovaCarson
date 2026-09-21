import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * MIT-licensed, publishable TS packages must actually ship a LICENSE file —
 * `"license": "MIT"` in package.json is a claim, not a grant, if the tarball
 * that reaches npm doesn't contain the license text. Modeled on
 * packages/verifier-cli, the one package that already gets this right.
 */
const TS_PACKAGES = [
  'packages/sdk',
  'packages/verifier',
  'sdks/mcp-server',
  'packages/embed',
  'sdks/langchain-ts',
] as const;

const REPO_ROOT = resolve(__dirname, '../..');

describe('publishable package LICENSE files (engineering-counsel LGPL/MIT review)', () => {
  it.each(TS_PACKAGES)('%s has a LICENSE file', (pkgDir) => {
    const licensePath = resolve(REPO_ROOT, pkgDir, 'LICENSE');
    expect(existsSync(licensePath), `expected ${pkgDir}/LICENSE to exist`).toBe(true);
  });

  it.each(TS_PACKAGES)('%s LICENSE text is the MIT license with the Arkova copyright line', (pkgDir) => {
    const licensePath = resolve(REPO_ROOT, pkgDir, 'LICENSE');
    const text = readFileSync(licensePath, 'utf8');
    expect(text).toContain('MIT License');
    expect(text).toContain('Copyright (c) 2026 Arkova');
  });

  it.each(TS_PACKAGES)('%s package.json declares MIT and includes LICENSE in the published files array', (pkgDir) => {
    const pkgJsonPath = resolve(REPO_ROOT, pkgDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { license?: string; files?: string[] };
    expect(pkg.license).toBe('MIT');
    expect(pkg.files, `${pkgDir}/package.json "files" array`).toContain('LICENSE');
  });

  it('packages/arkova-py has a LICENSE file with MIT text', () => {
    const licensePath = resolve(REPO_ROOT, 'packages/arkova-py', 'LICENSE');
    expect(existsSync(licensePath), 'expected packages/arkova-py/LICENSE to exist').toBe(true);
    const text = readFileSync(licensePath, 'utf8');
    expect(text).toContain('MIT License');
    expect(text).toContain('Copyright (c) 2026 Arkova');
  });

  it('packages/arkova-py/pyproject.toml packages the LICENSE file (PEP 639 license-files)', () => {
    const pyprojectPath = resolve(REPO_ROOT, 'packages/arkova-py', 'pyproject.toml');
    const text = readFileSync(pyprojectPath, 'utf8');
    expect(text).toMatch(/license-files\s*=\s*\[\s*"LICENSE"\s*\]/);
  });
});
