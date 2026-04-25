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
