import { describe, expect, it } from 'vitest';

import {
  collectPlatformVariantNames,
  diffNotices,
  evaluate,
  stripPlatformSuffix,
  type Baseline,
  type NoticeLike,
} from './check-third-party-notices-fresh.js';

const entry = (name: string, version: string, license = 'MIT'): NoticeLike => ({
  name,
  version,
  license,
  repository: `https://example.invalid/${name}`,
});

const emptyBaseline: Baseline = {
  expires: '2099-01-01',
  driftingNames: [],
  blockedPinnedNotices: [],
};

const noDiff = {
  addedNames: [],
  removedNames: [],
  changedVersions: [],
  changedLicenses: [],
  skippedPlatformVariants: [],
};

describe('collectPlatformVariantNames', () => {
  it('selects packages constrained by os or cpu, keyed by bare package name', () => {
    const names = collectPlatformVariantNames({
      packages: {
        '': { version: '1.0.0' },
        'node_modules/react': { version: '19.0.0' },
        'node_modules/@img/sharp-darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
        'node_modules/@img/sharp-linux-x64': { os: ['linux'], cpu: ['x64'] },
        // cpu-only, no os — still platform-variant.
        'node_modules/onnxruntime-node': { cpu: ['x64', 'arm64'] },
        // libc-only: npm's third platform gate, and the one a hand-written
        // os/cpu check would miss.
        'node_modules/some-musl-only-pkg': { libc: ['musl'] },
        // Nested path: the bare name is what license-checker reports.
        'node_modules/sharp/node_modules/@img/colour': { version: '1.1.0' },
      },
    });

    expect(names).toEqual(
      new Set([
        '@img/sharp-darwin-arm64',
        '@img/sharp-linux-x64',
        'onnxruntime-node',
        'some-musl-only-pkg',
      ]),
    );
  });

  it('tolerates a lockfile with no packages map', () => {
    expect(collectPlatformVariantNames({})).toEqual(new Set());
  });
});

describe('stripPlatformSuffix', () => {
  it('collapses os/arch/abi variants of one family to the same root', () => {
    // The whole point: the darwin name a laptop generates and the linux name an
    // ubuntu runner generates must land on ONE token, or the gate fails spuriously.
    expect(stripPlatformSuffix('@img/sharp-libvips-darwin-arm64')).toBe('@img/sharp-libvips');
    expect(stripPlatformSuffix('@img/sharp-libvips-linux-x64')).toBe('@img/sharp-libvips');
    expect(stripPlatformSuffix('@img/sharp-libvips-linuxmusl-x64')).toBe('@img/sharp-libvips');
    expect(stripPlatformSuffix('@napi-rs/canvas-darwin-arm64')).toBe('@napi-rs/canvas');
    expect(stripPlatformSuffix('@napi-rs/canvas-linux-arm-gnueabihf')).toBe('@napi-rs/canvas');
    expect(stripPlatformSuffix('@napi-rs/canvas-win32-x64-msvc')).toBe('@napi-rs/canvas');
    expect(stripPlatformSuffix('@img/sharp-freebsd-wasm32')).toBe('@img/sharp');
    expect(stripPlatformSuffix('@img/sharp-wasm32')).toBe('@img/sharp');
  });

  it('leaves a platform-variant package with no suffix in its name alone', () => {
    // onnxruntime-node is os/cpu-constrained but carries no platform token.
    expect(stripPlatformSuffix('onnxruntime-node')).toBe('onnxruntime-node');
  });

  it('does not over-strip ordinary package names', () => {
    expect(stripPlatformSuffix('read-excel-file')).toBe('read-excel-file');
    expect(stripPlatformSuffix('crc-32')).toBe('crc-32');
    expect(stripPlatformSuffix('worker-f')).toBe('worker-f');
    expect(stripPlatformSuffix('@radix-ui/react-use-size')).toBe('@radix-ui/react-use-size');
  });
});

describe('diffNotices', () => {
  const platform = new Set(['@img/sharp-darwin-arm64', '@img/sharp-linux-x64']);

  it('reports nothing when the committed file matches the installed tree', () => {
    const list = [entry('react', '19.0.0'), entry('zod', '3.23.8')];
    expect(diffNotices({ committed: list, fresh: list, platformVariantNames: platform })).toEqual(
      noDiff,
    );
  });

  it('is stable across platforms — a darwin-generated file matches a linux run', () => {
    // The regression this gate would otherwise introduce: the committed file was
    // generated on a Mac (@img/sharp-darwin-arm64) and CI runs on ubuntu
    // (@img/sharp-linux-x64). Same tree, different platform binary.
    const committed = [entry('sharp', '0.34.5'), entry('@img/sharp-darwin-arm64', '0.34.5')];
    const fresh = [entry('sharp', '0.34.5'), entry('@img/sharp-linux-x64', '0.34.5')];

    const diff = diffNotices({ committed, fresh, platformVariantNames: platform });

    expect(diff.addedNames).toEqual([]);
    expect(diff.removedNames).toEqual([]);
    expect(diff.skippedPlatformVariants).toEqual([
      '@img/sharp-darwin-arm64',
      '@img/sharp-linux-x64',
    ]);
  });

  it('catches a new production dependency that was never disclosed', () => {
    // qrcode-generator@2.0.4 — the MIT dep a human reviewer caught by hand.
    const committed = [entry('react', '19.0.0')];
    const fresh = [entry('qrcode-generator', '2.0.4'), entry('react', '19.0.0')];

    expect(diffNotices({ committed, fresh, platformVariantNames: platform }).addedNames).toEqual([
      'qrcode-generator',
    ]);
  });

  it('catches a removed dependency and a version bump separately', () => {
    const committed = [entry('gone', '1.0.0'), entry('bumped', '1.0.0')];
    const fresh = [entry('bumped', '2.0.0')];

    const diff = diffNotices({ committed, fresh, platformVariantNames: platform });

    expect(diff.removedNames).toEqual(['gone']);
    expect(diff.addedNames).toEqual([]);
    expect(diff.changedVersions).toEqual([{ name: 'bumped', committed: '1.0.0', fresh: '2.0.0' }]);
  });

  it('catches a license change on an otherwise unchanged dependency', () => {
    const committed = [entry('relicensed', '1.0.0', 'MIT')];
    const fresh = [entry('relicensed', '1.0.0', 'BSD-3-Clause')];

    expect(
      diffNotices({ committed, fresh, platformVariantNames: platform }).changedLicenses,
    ).toEqual([{ name: 'relicensed', committed: 'MIT', fresh: 'BSD-3-Clause' }]);
  });
});

describe('evaluate', () => {
  const today = '2026-08-30';

  it('passes when nothing drifts and nothing is baselined', () => {
    const verdict = evaluate({
      diff: noDiff,
      baseline: emptyBaseline,
      missingNotice: [],
      today,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it('fails on a new dependency that is not in the baseline', () => {
    const verdict = evaluate({
      diff: { ...noDiff, addedNames: ['qrcode-generator'] },
      baseline: emptyBaseline,
      missingNotice: [],
      today,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toContain('qrcode-generator');
  });

  it('tolerates drift that the baseline already records, and says so', () => {
    const verdict = evaluate({
      diff: { ...noDiff, addedNames: ['xlsx'], changedVersions: [] },
      baseline: { ...emptyBaseline, driftingNames: ['xlsx'] },
      missingNotice: [],
      today,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.join('\n')).toContain('xlsx');
  });

  it('still fails on a NEW name even while other names are baselined', () => {
    // The ratchet: inherited staleness is tolerated, fresh staleness is not.
    const verdict = evaluate({
      diff: { ...noDiff, addedNames: ['xlsx', 'qrcode-generator'] },
      baseline: { ...emptyBaseline, driftingNames: ['xlsx'] },
      missingNotice: [],
      today,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toContain('qrcode-generator');
    expect(verdict.failures.join('\n')).not.toContain('xlsx');
  });

  it('fails once the baseline expires, even if nothing new drifted', () => {
    // Anti-rot: a baseline with no deadline becomes permanent.
    const verdict = evaluate({
      diff: { ...noDiff, addedNames: ['xlsx'] },
      baseline: { expires: '2026-08-29', driftingNames: ['xlsx'], blockedPinnedNotices: [] },
      missingNotice: [],
      today,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toMatch(/expire/i);
  });

  it('surfaces the generator FATAL rather than skipping, when it is not baselined', () => {
    const verdict = evaluate({
      diff: noDiff,
      baseline: emptyBaseline,
      missingNotice: [entry('@img/sharp-libvips-darwin-arm64', '1.2.4', 'LGPL-3.0-or-later')],
      today,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toContain('third-party-notices.pinned.json');
  });

  it('matches a baselined FATAL by platform-independent family root', () => {
    // Recorded as "@img/sharp-libvips"; a mac reports darwin-arm64 and an ubuntu
    // runner reports linux-x64. Both must match the one recorded root.
    const baseline: Baseline = {
      ...emptyBaseline,
      blockedPinnedNotices: ['@img/sharp-libvips'],
    };

    for (const name of ['@img/sharp-libvips-darwin-arm64', '@img/sharp-libvips-linux-x64']) {
      const verdict = evaluate({
        diff: noDiff,
        baseline,
        missingNotice: [entry(name, '1.2.4', 'LGPL-3.0-or-later')],
        today,
      });
      expect(verdict.ok, name).toBe(true);
      expect(verdict.warnings.join('\n')).toContain('@img/sharp-libvips');
    }
  });

  it('fails on a NEW missing pinned notice even when another one is baselined', () => {
    const verdict = evaluate({
      diff: noDiff,
      baseline: { ...emptyBaseline, blockedPinnedNotices: ['@img/sharp-libvips'] },
      missingNotice: [
        entry('@img/sharp-libvips-linux-x64', '1.2.4', 'LGPL-3.0-or-later'),
        entry('brand-new-copyleft', '1.0.0', 'GPL-3.0'),
      ],
      today,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toContain('brand-new-copyleft');
  });

  it('demands the baseline be emptied once the notices file is regenerated', () => {
    // Drift is gone but the baseline still claims it. Left alone, those names
    // would be permanently excused from the gate.
    const verdict = evaluate({
      diff: noDiff,
      baseline: { ...emptyBaseline, driftingNames: ['xlsx'] },
      missingNotice: [],
      today,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toMatch(/xlsx/);
  });

  it('only warns about partially-stale baseline entries while drift remains', () => {
    // Mid-cleanup: some baselined names are fixed, others are not. Failing here
    // would red every unrelated PR, so this is a warning until drift hits zero.
    const verdict = evaluate({
      diff: { ...noDiff, addedNames: ['xlsx'] },
      baseline: { ...emptyBaseline, driftingNames: ['xlsx', 'already-fixed'] },
      missingNotice: [],
      today,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.warnings.join('\n')).toContain('already-fixed');
  });
});
