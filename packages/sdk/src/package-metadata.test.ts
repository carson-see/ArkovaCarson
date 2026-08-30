/**
 * package.json metadata regression tests
 *
 * npm keywords, description, and other package.json string fields are
 * indexed and rendered on npmjs.com / npm search — public-visible the same
 * way UI copy and README prose are, so CLAUDE.md §1.3's terminology ban
 * applies to them too.
 *
 * Found in npm-publish clean-room verification (2026-08-18): `keywords`
 * included "bitcoin" (banned) and the package was missing `repository` /
 * `author` fields present on the sibling arkova-mcp-server package.json.
 *
 * Story: npm publication prep (2026-08-18) — clean-room verification finding.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  license: string;
  author?: string;
  repository?: { type: string; url: string; directory: string };
};

const BANNED_TERMS = /\b(wallet|gas|hash|block|transaction|crypto|blockchain|bitcoin|testnet|mainnet|utxo|broadcast)\b/i;

describe('packages/sdk package.json metadata', () => {
  it('does not use §1.3-banned terminology in keywords', () => {
    for (const keyword of pkg.keywords) {
      expect(keyword, `keyword "${keyword}"`).not.toMatch(BANNED_TERMS);
    }
  });

  it('does not use §1.3-banned terminology in the description', () => {
    expect(pkg.description).not.toMatch(BANNED_TERMS);
  });

  it('is version 2.2.0, matching the published arkova-mcp-server and PyPI arkova packages', () => {
    expect(pkg.version).toBe('2.2.0');
  });

  it('has a repository field pointing at the monorepo, matching the sibling mcp-server package', () => {
    expect(pkg.repository).toBeDefined();
    expect(pkg.repository?.url).toBe('https://github.com/carson-see/ArkovaCarson');
    expect(pkg.repository?.directory).toBe('packages/sdk');
  });

  it('has an author field', () => {
    expect(pkg.author).toBeTruthy();
  });

  it('is MIT licensed, matching the LICENSE file and the README footer', () => {
    expect(pkg.license).toBe('MIT');
  });
});
