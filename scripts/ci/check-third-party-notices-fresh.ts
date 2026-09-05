#!/usr/bin/env tsx
/**
 * Third-Party Notices freshness gate
 *
 * `src/data/thirdPartyNotices.generated.json` is the data behind the shipped
 * `/legal/third-party-notices` page. It is GENERATED
 * (scripts/security/generate-third-party-notices.ts, `npm run
 * license:notices:generate`) but nothing ever ran that generator in CI, so the
 * file drifted from the dependency set for over a month with no signal:
 * `qrcode-generator@2.0.4` (a new MIT production dependency) went undisclosed
 * until a reviewer caught it by hand, and the generator itself had been failing
 * closed since some point after 2026-07-28 without anyone noticing.
 *
 * This gate re-derives the notices payload from the INSTALLED tree and compares
 * it to what is committed. It deliberately goes through the generator's own
 * `buildNotices()` rather than re-deriving the classification here — a second
 * copy of that logic would drift from the first and start silently comparing
 * the wrong thing.
 *
 * Two things make a naive diff unusable, and both are handled below:
 *
 *  1. `generatedAt` changes on every run. Ignored.
 *
 *  2. The generator reads the INSTALLED tree, and npm installs only the
 *     platform-matching build of an optional native dependency. The committed
 *     file was generated on darwin-arm64, so it lists `@img/sharp-darwin-arm64`
 *     and `@napi-rs/canvas-darwin-arm64`; an ubuntu runner installs
 *     `@img/sharp-linux-x64` and `@napi-rs/canvas-linux-x64-gnu` instead. Left
 *     alone, this job would fail on every PR for a reason that has nothing to do
 *     with the notices being stale. Platform-variant packages are therefore
 *     excluded from the comparison — identified MECHANICALLY, from the `os`/`cpu`
 *     constraints in package-lock.json, not from a hardcoded family list. That
 *     matters: the mechanical rule catches `onnxruntime-node`, which is
 *     os/cpu-constrained but carries no platform token in its name and which a
 *     hand-written `@img/*` + `@napi-rs/*` list would have missed.
 *
 *     Excluding them loses no real signal, because every platform-fanned family
 *     is an optional-dependency fan-out of a NON-platform parent that stays in
 *     the comparison: `sharp`, `@napi-rs/canvas`, `@img/colour`. A version bump
 *     of the binaries moves the parent too, and that is caught.
 *
 * The gate is a RATCHET, not an absolute assertion, and the distinction is the
 * whole reason it can be required rather than advisory. As of 2026-08-30 the
 * committed file carries ~1 month of inherited drift (13+ undisclosed packages
 * and dozens of version bumps) AND the generator refuses to write at all, both
 * of which are owned by the separate "Regenerate third-party notices (blocked by
 * sharp)" task. Failing on that inherited state would red every open PR at once
 * and blackout the Mergify queue — the failure mode this repo has already paid
 * for, where one red required check stalled every merge at once. So the
 * known-bad state is recorded, with an expiry date, in
 * scripts/ci/snapshots/third-party-notices-drift-baseline.json, and this gate
 * fails on anything BEYOND it. New drift — the `qrcode-generator` class — is
 * blocked from day one; inherited drift is reported loudly on every run and
 * hard-fails once the baseline expires.
 *
 * Run locally: npx tsx scripts/ci/check-third-party-notices-fresh.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildNotices,
  OUTPUT_PATH,
  type NoticeEntry,
} from '../security/generate-third-party-notices.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const LOCKFILE_PATH = resolve(REPO_ROOT, 'package-lock.json');
const BASELINE_PATH = resolve(__dirname, 'snapshots/third-party-notices-drift-baseline.json');

export type NoticeLike = Pick<NoticeEntry, 'name' | 'version' | 'license'> & {
  repository?: string;
};

export interface LockfileShape {
  // Real lockfile entries carry version/resolved/integrity/... — only the three
  // platform gates matter here, so the rest is accepted and ignored.
  packages?: Record<
    string,
    { os?: string[]; cpu?: string[]; libc?: string[]; [key: string]: unknown }
  >;
}

export interface NoticesDiff {
  addedNames: string[];
  removedNames: string[];
  changedVersions: { name: string; committed: string; fresh: string }[];
  changedLicenses: { name: string; committed: string; fresh: string }[];
  skippedPlatformVariants: string[];
}

export interface Baseline {
  /** ISO date (YYYY-MM-DD). Past this, inherited drift stops being excused. */
  expires: string;
  /** Package names whose drift is already known and owned elsewhere. */
  driftingNames: string[];
  /**
   * Platform-INDEPENDENT family roots (see stripPlatformSuffix) of
   * allowlist-cleared copyleft deps that currently have no pinned notice, i.e.
   * the packages the generator is failing closed on.
   */
  blockedPinnedNotices: string[];
}

export interface Verdict {
  ok: boolean;
  failures: string[];
  warnings: string[];
}

/**
 * npm platform/arch/abi tokens, as they appear in the trailing segments of
 * platform-fanned package names. Used only to derive a stable family root for
 * REPORTING and for matching baselined FATALs across platforms — never to decide
 * whether a package is platform-variant (package-lock.json's os/cpu decides that).
 */
const PLATFORM_TOKENS = new Set([
  // os / platform
  'darwin',
  'linux',
  'linuxmusl',
  'win32',
  'freebsd',
  'openbsd',
  'netbsd',
  'sunos',
  'aix',
  'android',
  'openharmony',
  'webcontainers',
  'browser',
  // arch
  'arm',
  'arm64',
  'x64',
  'x32',
  'ia32',
  'riscv64',
  's390x',
  'ppc64',
  'loong64',
  'mips64el',
  'wasm32',
  // abi / libc
  'gnu',
  'musl',
  'msvc',
  'gnueabihf',
  'eabi',
]);

/**
 * Package names carrying an `os`, `cpu` or `libc` constraint in the lockfile —
 * npm installs only the ones matching the host, so these and only these differ
 * between a darwin laptop and an ubuntu runner. Those three fields are npm's
 * COMPLETE set of platform gates; every other install difference would have to
 * come from the lockfile itself, which is committed and therefore identical on
 * both. `libc` is redundant today (all 30 libc-constrained packages here also
 * carry os/cpu) but is checked so a future libc-only package cannot slip past.
 */
export function collectPlatformVariantNames(lock: LockfileShape): Set<string> {
  const names = new Set<string>();
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path || !meta) continue;
    if (!meta.os && !meta.cpu && !meta.libc) continue;
    names.add(path.replace(/^.*node_modules\//, ''));
  }
  return names;
}

/**
 * Collapse `@img/sharp-libvips-darwin-arm64` and `@img/sharp-libvips-linux-x64`
 * onto the single token `@img/sharp-libvips`, so a baseline entry written on one
 * platform still matches on another. Names with no platform suffix are returned
 * unchanged.
 */
export function stripPlatformSuffix(name: string): string {
  let out = name;
  for (;;) {
    const dash = out.lastIndexOf('-');
    if (dash <= 0) return out;
    if (!PLATFORM_TOKENS.has(out.slice(dash + 1))) return out;
    out = out.slice(0, dash);
  }
}

/**
 * Deterministic, locale-INDEPENDENT string order.
 *
 * Sonar S2871 wants an explicit comparator on `.sort()` and suggests
 * `localeCompare`. Deliberately NOT localeCompare: its result depends on the
 * host's ICU data, and `versionsOf()` / `licensesOf()` feed their sorted output
 * straight into a string comparison between what a laptop generated and what an
 * ubuntu runner generated. A locale-sensitive order is precisely the kind of
 * host-dependent difference this gate exists to be immune to. Code-unit order is
 * fixed by the language spec and identical on every host.
 */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Group entries by package name. A name can legitimately appear MORE THAN ONCE:
 * `onnxruntime-common`, `pako` and `sprintf-js` are each present at two hoisted
 * versions in this tree. Keying a plain Map by name would silently keep only the
 * last of each, which both hides drift on the dropped one and makes the result
 * depend on license-checker's iteration order — an ordering nothing guarantees
 * is identical across hosts. Hence a name -> entries[] multimap, compared as
 * order-independent sorted sets below.
 */
function byName(entries: readonly NoticeLike[], skip: ReadonlySet<string>) {
  const map = new Map<string, NoticeLike[]>();
  const skipped: string[] = [];
  for (const e of entries) {
    if (skip.has(e.name)) {
      skipped.push(e.name);
      continue;
    }
    const existing = map.get(e.name);
    if (existing) existing.push(e);
    else map.set(e.name, [e]);
  }
  return { map, skipped };
}

/** Sorted, de-duplicated projection so comparison never depends on input order. */
function versionsOf(entries: readonly NoticeLike[]): string {
  return [...new Set(entries.map((e) => e.version))].sort(byCodeUnit).join(', ');
}

function licensesOf(entries: readonly NoticeLike[]): string {
  return [...new Set(entries.map((e) => e.license))].sort(byCodeUnit).join(', ');
}

export function diffNotices(args: {
  committed: readonly NoticeLike[];
  fresh: readonly NoticeLike[];
  platformVariantNames: ReadonlySet<string>;
}): NoticesDiff {
  const a = byName(args.committed, args.platformVariantNames);
  const b = byName(args.fresh, args.platformVariantNames);

  const addedNames = [...b.map.keys()].filter((n) => !a.map.has(n)).sort(byCodeUnit);
  const removedNames = [...a.map.keys()].filter((n) => !b.map.has(n)).sort(byCodeUnit);

  const changedVersions: NoticesDiff['changedVersions'] = [];
  const changedLicenses: NoticesDiff['changedLicenses'] = [];
  for (const [name, before] of a.map) {
    const after = b.map.get(name);
    if (!after) continue;
    const beforeVersions = versionsOf(before);
    const afterVersions = versionsOf(after);
    if (beforeVersions !== afterVersions) {
      changedVersions.push({ name, committed: beforeVersions, fresh: afterVersions });
    }
    const beforeLicenses = licensesOf(before);
    const afterLicenses = licensesOf(after);
    if (beforeLicenses !== afterLicenses) {
      changedLicenses.push({ name, committed: beforeLicenses, fresh: afterLicenses });
    }
  }

  return {
    addedNames,
    removedNames,
    changedVersions: changedVersions.sort((x, y) => byCodeUnit(x.name, y.name)),
    changedLicenses: changedLicenses.sort((x, y) => byCodeUnit(x.name, y.name)),
    skippedPlatformVariants: [...new Set([...a.skipped, ...b.skipped])].sort(byCodeUnit),
  };
}

/** Every package name this diff says is out of sync, in one set. */
function driftingNamesOf(diff: NoticesDiff): Set<string> {
  return new Set([
    ...diff.addedNames,
    ...diff.removedNames,
    ...diff.changedVersions.map((c) => c.name),
    ...diff.changedLicenses.map((c) => c.name),
  ]);
}

export function evaluate(args: {
  diff: NoticesDiff;
  baseline: Baseline;
  missingNotice: readonly NoticeLike[];
  today: string;
}): Verdict {
  const failures: string[] = [];
  const warnings: string[] = [];

  const baselined = new Set(args.baseline.driftingNames);
  const drifting = driftingNamesOf(args.diff);
  const expired = args.today > args.baseline.expires;

  if (expired && (drifting.size > 0 || args.missingNotice.length > 0)) {
    failures.push(
      `The drift baseline expired on ${args.baseline.expires} (today is ${args.today}) and the ` +
        `notices file is still out of sync. Regenerate it (npm run license:notices:generate), ` +
        `empty scripts/ci/snapshots/third-party-notices-drift-baseline.json, or — if the work is ` +
        `genuinely still in flight — extend the expiry deliberately and say why in the file.`,
    );
  }

  // --- drift beyond the baseline: the regression this gate exists to block ---
  const unexcused = [...drifting].filter((n) => expired || !baselined.has(n)).sort(byCodeUnit);
  if (unexcused.length > 0) {
    const detail = unexcused.map((n) => {
      if (args.diff.addedNames.includes(n)) return `  + ${n} (installed, NOT disclosed)`;
      if (args.diff.removedNames.includes(n)) return `  - ${n} (disclosed, NOT installed)`;
      const lic = args.diff.changedLicenses.find((c) => c.name === n);
      if (lic) return `  ~ ${n} LICENSE ${lic.committed} -> ${lic.fresh}`;
      const ver = args.diff.changedVersions.find((c) => c.name === n);
      return `  ~ ${n} ${ver?.committed} -> ${ver?.fresh}`;
    });
    failures.push(
      `src/data/thirdPartyNotices.generated.json is stale for ${unexcused.length} ` +
        `dependenc${unexcused.length === 1 ? 'y' : 'ies'}:\n${detail.join('\n')}`,
    );
  }

  const excused = [...drifting].filter((n) => !expired && baselined.has(n)).sort(byCodeUnit);
  if (excused.length > 0) {
    warnings.push(
      `${excused.length} inherited drift entr${excused.length === 1 ? 'y' : 'ies'} tolerated by ` +
        `the baseline (expires ${args.baseline.expires}): ${excused.join(', ')}`,
    );
  }

  // --- generator FATAL: surfaced, not skipped ---
  const blockedRoots = new Set(args.baseline.blockedPinnedNotices);
  const missingRoots = args.missingNotice.map((e) => ({ entry: e, root: stripPlatformSuffix(e.name) }));
  const newlyBlocked = missingRoots.filter((m) => expired || !blockedRoots.has(m.root));
  if (newlyBlocked.length > 0) {
    failures.push(
      `The generator is refusing to write: allowlist-cleared copyleft dependencies have no entry ` +
        `in scripts/security/third-party-notices.pinned.json, so they would receive NO attribution ` +
        `on /legal/third-party-notices:\n` +
        newlyBlocked.map((m) => `  - ${m.entry.name}@${m.entry.version} (${m.entry.license})`).join('\n') +
        `\nAdd a pinned notice for each (name + version must match exactly), or clear the ` +
        `allowlist entry if the dependency should not have been cleared.`,
    );
  }
  const blockedKnown = missingRoots.filter((m) => !expired && blockedRoots.has(m.root));
  if (blockedKnown.length > 0) {
    // Pluralise on DISTINCT roots, not on entries: one root routinely covers
    // several installed packages (an ubuntu runner has both
    // @img/sharp-libvips-linux-x64 and -linuxmusl-x64 under @img/sharp-libvips),
    // so counting entries said "families" while listing one.
    const knownRoots = [...new Set(blockedKnown.map((m) => m.root))];
    warnings.push(
      `Generator still failing closed on known-blocked famil${knownRoots.length === 1 ? 'y' : 'ies'}: ` +
        `${knownRoots.join(', ')} — ` +
        `\`npm run license:notices:generate\` cannot write until this is resolved.`,
    );
  }

  // --- stale baseline entries ---
  // Hard-fail only once ALL drift is gone (the baseline has done its job and must
  // be emptied). While drift remains, this is mid-cleanup and failing here would
  // red unrelated PRs, so it is a warning.
  const staleDrift = args.baseline.driftingNames.filter((n) => !drifting.has(n)).sort(byCodeUnit);
  const staleBlocked = args.baseline.blockedPinnedNotices
    .filter((r) => !missingRoots.some((m) => m.root === r))
    .sort(byCodeUnit);
  const stale = [...staleDrift, ...staleBlocked];
  if (stale.length > 0) {
    const isClean = drifting.size === 0 && args.missingNotice.length === 0;
    const message =
      `${stale.length} baseline entr${stale.length === 1 ? 'y is' : 'ies are'} no longer drifting: ` +
      `${stale.join(', ')}. Remove ${stale.length === 1 ? 'it' : 'them'} from ` +
      `scripts/ci/snapshots/third-party-notices-drift-baseline.json — a stale exemption is a live hole.`;
    if (isClean) failures.push(message);
    else warnings.push(message);
  }

  return { ok: failures.length === 0, failures, warnings };
}

function loadBaseline(): Baseline {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Partial<Baseline>;
  return {
    expires: parsed.expires ?? '1970-01-01',
    driftingNames: parsed.driftingNames ?? [],
    blockedPinnedNotices: parsed.blockedPinnedNotices ?? [],
  };
}

async function main() {
  const committed = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')) as {
    generatedAt: string;
    generalDependencies: NoticeLike[];
    copyleftDependencies: unknown[];
  };
  const lock = JSON.parse(readFileSync(LOCKFILE_PATH, 'utf8')) as LockfileShape;
  const baseline = loadBaseline();

  // generatedAt is the one field that legitimately changes every run — pin it to
  // the committed value so it can never be the thing that differs.
  const { output, missingNotice } = await buildNotices(committed.generatedAt);

  const platformVariantNames = collectPlatformVariantNames(lock);
  const diff = diffNotices({
    committed: committed.generalDependencies,
    fresh: output.generalDependencies,
    platformVariantNames,
  });

  const verdict = evaluate({
    diff,
    baseline,
    missingNotice,
    today: new Date().toISOString().slice(0, 10),
  });

  // `--emit-baseline` prints the baseline that WOULD make this tree pass. It is
  // how scripts/ci/snapshots/third-party-notices-drift-baseline.json gets
  // (re)generated, and it is also the probe used to prove this gate is
  // platform-stable: run it on darwin and on linux/amd64 and the two payloads
  // must be identical. Never wire it into the gate itself — a check that writes
  // its own expected value gates nothing.
  if (process.argv.includes('--emit-baseline')) {
    console.log(
      JSON.stringify(
        {
          expires: baseline.expires,
          driftingNames: [...driftingNamesOf(diff)].sort(byCodeUnit),
          blockedPinnedNotices: [
            ...new Set(missingNotice.map((e) => stripPlatformSuffix(e.name))),
          ].sort(byCodeUnit),
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  // The pinned copyleft block is hand-curated and platform-independent: the
  // committed file must match third-party-notices.pinned.json exactly, or an
  // edit to the pinned notices never reached the published page.
  const pinnedCommitted = JSON.stringify(committed.copyleftDependencies);
  const pinnedFresh = JSON.stringify(output.copyleftDependencies);
  if (pinnedCommitted !== pinnedFresh) {
    verdict.failures.push(
      `The copyleftDependencies block in src/data/thirdPartyNotices.generated.json does not match ` +
        `scripts/security/third-party-notices.pinned.json. An edit to the pinned notices never ` +
        `reached the published page. Re-run: npm run license:notices:generate`,
    );
    verdict.ok = false;
  }

  console.log(
    `check-third-party-notices-fresh: compared ${committed.generalDependencies.length} committed ` +
      `vs ${output.generalDependencies.length} installed entries ` +
      `(${diff.skippedPlatformVariants.length} platform-variant name(s) excluded: ` +
      `${diff.skippedPlatformVariants.join(', ') || 'none'}).`,
  );

  for (const w of verdict.warnings) console.warn(`\n[warn] ${w}`);

  if (verdict.ok) {
    console.log('\ncheck-third-party-notices-fresh: OK — no drift beyond the recorded baseline.');
    process.exit(0);
  }

  console.error('\ncheck-third-party-notices-fresh: FAILED\n');
  for (const f of verdict.failures) console.error(`${f}\n`);
  console.error(
    `Fix: run \`npm run license:notices:generate\` and commit the updated ` +
      `src/data/thirdPartyNotices.generated.json.\n` +
      `/legal/third-party-notices is what discharges our attribution obligations; a dependency ` +
      `that ships without appearing there is an undisclosed one.`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith('check-third-party-notices-fresh.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
