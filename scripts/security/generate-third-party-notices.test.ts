import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ModuleInfos } from 'license-checker';

import {
  attachVerbatimLicenseTexts,
  classifyEntries,
  licenseFileLooksLikeLicense,
} from './generate-third-party-notices.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

describe('classifyEntries', () => {
  it('puts ordinary permissive licenses in the general bucket', () => {
    const { general, unresolvedCopyleft } = classifyEntries(
      {
        'left-pad@1.3.0': { licenses: 'MIT', repository: 'https://github.com/example/left-pad' },
        'is-thing@2.0.0': { licenses: 'ISC' },
        'has-flag@4.0.0': { licenses: 'BSD-3-Clause' },
      },
      [],
    );

    expect(general.map((e) => e.name)).toEqual(['has-flag', 'is-thing', 'left-pad']);
    expect(unresolvedCopyleft).toEqual([]);
  });

  it('excludes the root package itself', () => {
    const { general } = classifyEntries({ 'arkova@2.2.0': { licenses: 'UNLICENSED' } }, []);
    expect(general).toEqual([]);
  });

  it('routes an unallowlisted copyleft dependency to unresolvedCopyleft, not general', () => {
    const { general, unresolvedCopyleft } = classifyEntries(
      { 'sharp-libvips-example@1.2.4': { licenses: 'LGPL-3.0-or-later' } },
      [],
    );

    expect(general).toEqual([]);
    expect(unresolvedCopyleft).toEqual([
      { name: 'sharp-libvips-example', version: '1.2.4', license: 'LGPL-3.0-or-later', repository: undefined },
    ]);
  });

  it('excludes an allowlisted copyleft dependency from BOTH buckets (its notice lives in the pinned file)', () => {
    const { general, unresolvedCopyleft } = classifyEntries(
      { 'jszip@3.10.1': { licenses: '(MIT OR GPL-3.0-or-later)' } },
      [{ name: 'jszip', version: '3.10.1', reason: 'Dual-licensed; used under MIT.' }],
    );

    expect(general).toEqual([]);
    expect(unresolvedCopyleft).toEqual([]);
  });

  it('handles scoped package names (last "@" splits name/version)', () => {
    const { general } = classifyEntries(
      { '@radix-ui/react-dialog@1.1.20': { licenses: 'MIT' } },
      [],
    );

    expect(general).toEqual([
      { name: '@radix-ui/react-dialog', version: '1.1.20', license: 'MIT', repository: undefined },
    ]);
  });

  it('carries copyright and licenseText through to the notice entry (SCRUM-3559)', () => {
    const { general } = classifyEntries(
      {
        'left-pad@1.3.0': {
          licenses: 'MIT',
          repository: 'https://github.com/example/left-pad',
          copyright: 'Copyright (c) 2018 Example Author',
          licenseText: 'The MIT License (MIT)\n\nCopyright (c) 2018 Example Author\n\nPermission is hereby granted...',
        },
      },
      [],
    );

    expect(general).toHaveLength(1);
    expect(general[0].copyright).toBe('Copyright (c) 2018 Example Author');
    expect(general[0].licenseText).toBe(
      'The MIT License (MIT)\n\nCopyright (c) 2018 Example Author\n\nPermission is hereby granted...',
    );
  });

  it('carries copyright/licenseText on allowlisted copyleft entries too (feeds pinned enrichment)', () => {
    const { allowlistedCopyleft } = classifyEntries(
      {
        'jszip@3.10.1': {
          licenses: '(MIT OR GPL-3.0-or-later)',
          copyright: 'Copyright (c) 2009-2016 Stuart Knightley',
          licenseText: 'JSZip is dual licensed...',
        },
      },
      [{ name: 'jszip', version: '3.10.1', reason: 'Dual-licensed; used under MIT.' }],
    );

    expect(allowlistedCopyleft).toHaveLength(1);
    expect(allowlistedCopyleft[0].copyright).toBe('Copyright (c) 2009-2016 Stuart Knightley');
    expect(allowlistedCopyleft[0].licenseText).toBe('JSZip is dual licensed...');
  });

  it('normalizes empty/blank copyright and licenseText to absent, not empty strings', () => {
    // license-checker pre-seeds every module with the customFormat default ('')
    // before extraction; an empty string must not ship as a rendered field.
    const { general } = classifyEntries(
      { 'is-thing@2.0.0': { licenses: 'ISC', copyright: '', licenseText: '   ' } },
      [],
    );

    expect(general).toHaveLength(1);
    expect(general[0].copyright).toBeUndefined();
    expect(general[0].licenseText).toBeUndefined();
  });
});

describe('licenseFileLooksLikeLicense', () => {
  it('accepts LICENSE / COPYING / NOTICE file-name variants', () => {
    expect(licenseFileLooksLikeLicense('/x/node_modules/dep/LICENSE')).toBe(true);
    expect(licenseFileLooksLikeLicense('/x/node_modules/dep/LICENSE.markdown')).toBe(true);
    expect(licenseFileLooksLikeLicense('/x/node_modules/dep/licence.txt')).toBe(true);
    expect(licenseFileLooksLikeLicense('/x/node_modules/dep/COPYING')).toBe(true);
    expect(licenseFileLooksLikeLicense('/x/node_modules/dep/NOTICE.md')).toBe(true);
  });

  it('rejects license-checker README fallbacks (a README is not a license text)', () => {
    expect(licenseFileLooksLikeLicense('/x/node_modules/dep/README.md')).toBe(false);
    expect(licenseFileLooksLikeLicense('/x/node_modules/dep/readme.markdown')).toBe(false);
  });

  it('judges the file NAME, not the directory path', () => {
    // node_modules paths routinely contain "license"-ish directory names.
    expect(licenseFileLooksLikeLicense('/x/license-checker/node_modules/dep/README.md')).toBe(false);
  });
});

describe('attachVerbatimLicenseTexts', () => {
  it('REMOVES licenseText/copyright that license-checker derived from a README fallback', () => {
    // license-checker (customFormat set) fills licenseText/copyright for
    // every package from whatever file it settled on as licenseFile — README
    // included. @img/sharp-libvips-* is a live example: no license file
    // shipped, so its README leaked onto the public notices page as
    // "license text" until this guard became authoritative.
    const raw = {
      'no-license-file-dep@2.0.0': {
        licenses: 'LGPL-3.0-or-later',
        licenseFile: '/x/node_modules/no-license-file-dep/README.md',
        licenseText: '# no-license-file-dep\n\nA README, not a license.',
        copyright: 'Copyright statement scraped out of a README',
      },
    };

    attachVerbatimLicenseTexts(raw);

    expect(raw['no-license-file-dep@2.0.0'].licenseText).toBeUndefined();
    expect(raw['no-license-file-dep@2.0.0'].copyright).toBeUndefined();
  });

  it('removes licenseText/copyright when there is no licenseFile at all', () => {
    const raw = {
      'ghost@1.0.0': { licenses: 'MIT', licenseText: 'stale', copyright: 'stale' },
    };
    attachVerbatimLicenseTexts(raw);
    expect(raw['ghost@1.0.0'].licenseText).toBeUndefined();
    expect(raw['ghost@1.0.0'].copyright).toBeUndefined();
  });

  it('replaces licenseText with the VERBATIM license file contents and keeps extracted copyright', () => {
    // license-checker's programmatic licenseText rewrites quotes/newlines;
    // the published page must carry the upstream text byte-for-byte.
    const licensePath = resolve(REPO_ROOT, 'node_modules/jszip/LICENSE.markdown');
    const expected = readFileSync(licensePath, 'utf8');
    const raw = {
      'jszip@3.10.1': {
        licenses: '(MIT OR GPL-3.0-or-later)',
        licenseFile: licensePath,
        licenseText: expected.replace(/\r?\n|\r/g, ' '), // the flattened form
        copyright: 'Copyright (c) 2009-2016 Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso',
      },
    };

    attachVerbatimLicenseTexts(raw);

    expect(raw['jszip@3.10.1'].licenseText).toBe(expected);
    expect(raw['jszip@3.10.1'].copyright).toContain('Stuart Knightley');
  });
});

/**
 * SCRUM-3553 — every allowlist-cleared copyleft dependency reachable from the
 * ROOT production dependency tree must have a pinned notice entry, or the
 * generator FATALs and the /legal/third-party-notices page gives the package
 * zero attribution. This reconstructs the generator's inputs from the real
 * package-lock.json (non-dev entries — `license-checker --production` never
 * sees dev-only subtrees like miniflare's) and the real allowlist/pinned
 * files, so it fails on ANY platform's package set, not just the one the
 * generator last ran on.
 */
describe('pinned notice coverage of allowlisted copyleft dependencies (SCRUM-3553)', () => {
  it('every allowlisted copyleft package in the production lockfile has a pinned notice', () => {
    const lock = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { version?: string; license?: string; dev?: boolean }>;
    };
    const allowlist = (
      JSON.parse(
        readFileSync(resolve(__dirname, 'license-denylist.allowlist.json'), 'utf8'),
      ) as { allowed: { name: string; version: string; reason: string }[] }
    ).allowed;
    const pinned = (
      JSON.parse(
        readFileSync(resolve(__dirname, 'third-party-notices.pinned.json'), 'utf8'),
      ) as { pending: { name: string; version: string }[] }
    ).pending;

    const raw: ModuleInfos = {};
    for (const [path, info] of Object.entries(lock.packages)) {
      if (!path.includes('node_modules/') || info.dev || !info.version || !info.license) continue;
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      raw[`${name}@${info.version}`] = { licenses: info.license };
    }

    const { allowlistedCopyleft } = classifyEntries(raw, allowlist);
    expect(allowlistedCopyleft.length).toBeGreaterThan(0); // non-vacuity: jszip + libheif-js at minimum

    const pinnedNames = new Set(pinned.map((entry) => `${entry.name}@${entry.version}`));
    const missing = allowlistedCopyleft
      .map((entry) => `${entry.name}@${entry.version}`)
      .filter((key) => !pinnedNames.has(key));

    expect(missing).toEqual([]);
  });
});
