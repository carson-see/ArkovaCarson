import { describe, expect, it } from 'vitest';

import { classifyEntries } from './generate-third-party-notices.js';

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
});
