import { describe, expect, it } from 'vitest';

import {
  GPL_DENYLIST,
  findDeniedLicenses,
  formatDeniedLicenseReport,
} from './license-denylist.js';

describe('license deny-list scan', () => {
  it('flags GPL, AGPL, and SSPL licenses from npm package-lock metadata', () => {
    const matches = findDeniedLicenses({
      lockfileVersion: 3,
      packages: {
        '': { name: 'arkova', version: '0.1.0' },
        'node_modules/mit-only': { version: '1.0.0', license: 'MIT' },
        'node_modules/gpl-lib': { version: '2.0.0', license: 'GPL-3.0-only' },
        'node_modules/agpl-lib': { version: '3.0.0', license: 'AGPL-3.0-or-later' },
        'node_modules/sspl-lib': { version: '4.0.0', license: 'SSPL-1.0' },
      },
    }, 'package-lock.json');

    expect(matches.map((match) => match.name).sort((a, b) => a.localeCompare(b))).toEqual([
      'agpl-lib',
      'gpl-lib',
      'sspl-lib',
    ]);
    expect(matches.every((match) => GPL_DENYLIST.test(match.license))).toBe(true);
  });

  it('formats a concise CI failure report', () => {
    const report = formatDeniedLicenseReport([
      {
        lockfile: 'services/worker/package-lock.json',
        name: 'copyleft-lib',
        version: '1.2.3',
        license: 'GPL-2.0',
        path: 'node_modules/copyleft-lib',
      },
    ]);

    expect(report).toContain('services/worker/package-lock.json');
    expect(report).toContain('copyleft-lib@1.2.3');
    expect(report).toContain('GPL-2.0');
  });

  it('describes successful scans as no unapproved denied licenses', () => {
    expect(formatDeniedLicenseReport([])).toBe('No unapproved GPL/AGPL/SSPL licenses found.');
  });
});

describe('GPL_DENYLIST regex — LGPL coverage (LGPL-blind gate hole)', () => {
  // BUG: the pre-fix pattern `/\b(?:AGPL|GPL|SSPL)(...)?\b/i` requires a word
  // boundary immediately before `GPL`. In "LGPL-3.0" the character before
  // "GPL" is "L" — a word character — so `\b` never matches at that position
  // and the whole license string sails through undetected. Verified against
  // libheif-js@1.19.8's exact lockfile license string ("LGPL-3.0"), which is
  // how an LGPL-3.0 dependency reached the tree unflagged.
  it.each([
    'LGPL-3.0',
    'LGPL-2.1-only',
    'LGPL-2.1-or-later',
    'LGPLv2.1',
    'LGPL',
  ])('flags %s', (license) => {
    expect(GPL_DENYLIST.test(license)).toBe(true);
  });

  // Must not regress the licenses the pre-fix pattern already caught.
  it.each([
    'AGPL-3.0',
    'AGPL-3.0-or-later',
    'GPL-3.0-or-later',
    'GPL-2.0',
    'SSPL-1.0',
  ])('still flags %s (no regression)', (license) => {
    expect(GPL_DENYLIST.test(license)).toBe(true);
  });

  it.each([
    'MIT',
    'Apache-2.0',
    'BSD-3-Clause',
    'ISC',
    '(MIT OR Apache-2.0)',
    'Unlicense',
    '0BSD',
  ])('does not flag %s', (license) => {
    expect(GPL_DENYLIST.test(license)).toBe(false);
  });

  it('flags a real libheif-js-shaped package-lock entry (LGPL-3.0)', () => {
    const matches = findDeniedLicenses({
      lockfileVersion: 3,
      packages: {
        '': { name: 'arkova', version: '0.1.0' },
        'node_modules/libheif-js': { version: '1.19.8', license: 'LGPL-3.0' },
      },
    }, 'package-lock.json');

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ name: 'libheif-js', version: '1.19.8', license: 'LGPL-3.0' });
  });
});
