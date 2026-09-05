#!/usr/bin/env tsx
/**
 * Third-Party Notices generator
 *
 * Produces the static data file consumed by the shipped
 * `/legal/third-party-notices` page (src/pages/ThirdPartyNoticesPage.tsx).
 * This is what discharges the LGPL-3.0 / Apache-2.0 NOTICE obligations for
 * the frontend bundle — an unreachable or hand-maintained-and-forgotten list
 * does not (engineering-counsel review, 2026-07-28).
 *
 * Run with: npm run license:notices:generate
 *
 * Sources, merged:
 *  1. `license-checker` over the ROOT (frontend) production dependency tree —
 *     the "shipped frontend" the counsel review is about. services/worker and
 *     the publishable SDK packages ship separately and are out of scope for
 *     this particular page (worker-side legacy GPL/AGPL exposure — snarkjs
 *     and its transitive stack — is tracked in
 *     scripts/security/license-denylist.allowlist.json, not here).
 *  2. scripts/security/third-party-notices.pinned.json — hand-curated entries
 *     that need to be disclosed before (or in more detail than) an automated
 *     scan of the currently-installed tree can produce. See that file's
 *     `_comment` for why this exists.
 *
 * Any dependency whose license matches the copyleft family (GPL/AGPL/LGPL/
 * SSPL — see scripts/security/license-denylist.ts GPL_DENYLIST) is EXCLUDED
 * from the general list and instead requires an explicit allowlist entry in
 * license-denylist.allowlist.json with a written reason. Fail-safe: if a
 * copyleft dependency has not been through that review, this generator
 * omits it rather than guessing at a disclosure for it. That keeps the
 * notices page from silently drifting out of sync with the compliance gate
 * that's supposed to catch new copyleft deps in the first place.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModuleInfos } from 'license-checker';

import { GPL_DENYLIST } from './license-denylist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
export const OUTPUT_PATH = resolve(REPO_ROOT, 'src/data/thirdPartyNotices.generated.json');
const PINNED_PATH = resolve(__dirname, 'third-party-notices.pinned.json');
const ALLOWLIST_PATH = resolve(__dirname, 'license-denylist.allowlist.json');

export interface NoticeEntry {
  name: string;
  version: string;
  license: string;
  repository?: string;
  sourceUrl?: string;
  /**
   * SCRUM-3559: strict MIT-family attribution wants the copyright line and the
   * notice text themselves included, not just an SPDX identifier. Both come
   * from the package's own published license file — `copyright` via
   * license-checker's extractor, `licenseText` read verbatim from
   * `licenseFile` (never license-checker's flattened `licenseText`, which
   * rewrites quotes/newlines when invoked programmatically).
   */
  copyright?: string;
  licenseText?: string;
}

export interface PinnedCopyleftEntry extends NoticeEntry {
  status: 'pending' | 'active';
  statusNote: string;
  unmodified: boolean;
  licenseTextUrls: string[];
  licenseTextNote?: string;
}

interface AllowlistEntry {
  name: string;
  version: string;
  reason: string;
}

function loadPinned(): PinnedCopyleftEntry[] {
  if (!existsSync(PINNED_PATH)) return [];
  const parsed = JSON.parse(readFileSync(PINNED_PATH, 'utf8')) as { pending?: PinnedCopyleftEntry[] };
  return parsed.pending ?? [];
}

function loadAllowlist(): AllowlistEntry[] {
  if (!existsSync(ALLOWLIST_PATH)) return [];
  const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as { allowed?: AllowlistEntry[] };
  return parsed.allowed ?? [];
}

function parseNameVersion(key: string): { name: string; version: string } {
  // license-checker keys are "name@version"; scoped packages are
  // "@scope/name@version" — split on the LAST "@".
  const at = key.lastIndexOf('@');
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

async function runLicenseChecker(): Promise<ModuleInfos> {
  const licenseChecker = await import('license-checker');
  return new Promise((resolvePromise, reject) => {
    licenseChecker.init(
      {
        start: REPO_ROOT,
        production: true,
        excludePrivatePackages: true,
        json: true,
        // `copyright` asks license-checker to extract the copyright statement
        // from each package's license file (SCRUM-3559). Deliberately NOT
        // requesting `licenseText` here: invoked programmatically (no CLI
        // `_args`), license-checker flattens newlines and rewrites quotes,
        // which is no longer the verbatim upstream text. The verbatim read
        // happens in attachVerbatimLicenseTexts() from `licenseFile` instead.
        customFormat: { copyright: '' },
      },
      (err: Error, packages: ModuleInfos) => {
        if (err) reject(err);
        else resolvePromise(packages);
      },
    );
  });
}

/**
 * Make `licenseText`/`copyright` trustworthy on every scanned row, in place.
 *
 * AUTHORITATIVE, not additive: when customFormat is set at all,
 * license-checker fills `licenseText` and `copyright` for EVERY package from
 * whatever file it settled on as `licenseFile` — and its detection falls back
 * to the package README when no license file exists. A README is not a
 * license text (live example: @img/sharp-libvips-* ships only a README, whose
 * prose would have been published on /legal/third-party-notices as "license
 * text"), so rows whose licenseFile fails the name check get BOTH fields
 * removed. Rows with a real license file get `licenseText` re-read verbatim
 * from disk — license-checker's programmatic value rewrites quotes/newlines —
 * and keep license-checker's extracted `copyright`.
 */
export function attachVerbatimLicenseTexts(raw: ModuleInfos): void {
  for (const row of Object.values(raw)) {
    if (row.licenseFile && licenseFileLooksLikeLicense(row.licenseFile)) {
      try {
        row.licenseText = readFileSync(row.licenseFile, 'utf8');
        continue;
      } catch {
        // Unreadable license file: fall through and strip rather than ship
        // license-checker's flattened copy of a file we could not verify.
      }
    }
    delete row.licenseText;
    delete row.copyright;
  }
}

/** license-checker reports `licenses` as either a string or a string[] (dual/multi-license). */
function normalizeLicenses(licenses: string | string[] | undefined): string {
  if (!licenses) return 'UNKNOWN';
  return Array.isArray(licenses) ? licenses.join(' AND ') : licenses;
}

/**
 * license-checker pre-seeds every module with the customFormat default value
 * (an empty string) before extraction runs, so "no copyright found" arrives as
 * `''`, not `undefined`. Blank strings must never ship as rendered fields.
 */
function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * license-checker's licenseFile detection falls back to a package's README
 * when no license file exists. A README is not a license text — inlining one
 * on /legal/third-party-notices would publish arbitrary prose as if it were
 * the license — so only files whose NAME looks like a license/notice file are
 * eligible for verbatim inclusion.
 */
export function licenseFileLooksLikeLicense(filePath: string): boolean {
  return /licen[cs]e|copying|notice/i.test(basename(filePath));
}

export function classifyEntries(
  raw: ModuleInfos,
  allowlist: AllowlistEntry[],
): {
  general: NoticeEntry[];
  unresolvedCopyleft: NoticeEntry[];
  allowlistedCopyleft: NoticeEntry[];
} {
  const allowed = new Set(allowlist.map((entry) => `${entry.name}@${entry.version}`));
  const general: NoticeEntry[] = [];
  const unresolvedCopyleft: NoticeEntry[] = [];
  /**
   * Copyleft deps that ARE allowlist-cleared. They are excluded from `general`
   * because their notice text is supposed to live in third-party-notices.pinned.json
   * — but nothing used to verify that it actually did, so an allowlisted package
   * with no pinned entry fell into NO bucket and got zero attribution on the
   * published page. `jszip` (MIT OR GPL-3.0-or-later, elected MIT) was exactly
   * that case: the one dependency where the allowlist records a license ELECTION,
   * i.e. where MIT attribution is load-bearing, and it appeared nowhere.
   * main() now reconciles this list against the pinned file.
   */
  const allowlistedCopyleft: NoticeEntry[] = [];

  for (const [key, row] of Object.entries(raw)) {
    const { name, version } = parseNameVersion(key);
    // Skip the root package itself (arkova@...) — not a third-party dep.
    if (name === 'arkova') continue;

    const license = normalizeLicenses(row.licenses);
    const entry: NoticeEntry = {
      name,
      version,
      license,
      repository: row.repository,
      copyright: normalizeOptionalText(row.copyright),
      licenseText: normalizeOptionalText(row.licenseText),
    };

    if (GPL_DENYLIST.test(license)) {
      // Copyleft-family license. Only include it here if it has been
      // through the license-denylist allowlist review — that's the
      // one source of truth for "this copyleft dependency is cleared."
      // The pinned file (loaded separately by main()) is where its full
      // notice text lives; this generator does not fabricate one.
      if (allowed.has(`${name}@${version}`)) {
        allowlistedCopyleft.push(entry);
      } else {
        unresolvedCopyleft.push(entry);
      }
      continue;
    }

    general.push(entry);
  }

  general.sort((a, b) => a.name.localeCompare(b.name));
  allowlistedCopyleft.sort((a, b) => a.name.localeCompare(b.name));
  return { general, unresolvedCopyleft, allowlistedCopyleft };
}

export interface NoticesBuild {
  output: {
    generatedAt: string;
    generalDependencies: NoticeEntry[];
    copyleftDependencies: PinnedCopyleftEntry[];
  };
  /**
   * Allowlist-cleared copyleft deps with NO pinned notice. Non-empty means the
   * CLI below refuses to write — see main(). Returned rather than thrown so a
   * caller that only needs to know whether the COMMITTED file still matches the
   * dependency set (scripts/ci/check-third-party-notices-fresh.ts) can still
   * compute that while this is outstanding, instead of being blinded by an
   * unrelated compliance gap.
   */
  missingNotice: NoticeEntry[];
  unresolvedCopyleft: NoticeEntry[];
}

/**
 * Compose the notices payload. Pure of I/O apart from the license-checker scan
 * and reading the two committed JSON inputs, so both the CLI and the freshness
 * gate go through exactly one implementation — a second, re-derived copy in the
 * checker would drift from this one and silently start comparing the wrong thing.
 *
 * `generatedAt` is injectable because it is the one field that legitimately
 * changes on every run, and the freshness gate has to hold it constant to diff
 * anything at all.
 */
export async function buildNotices(
  generatedAt: string = new Date().toISOString(),
): Promise<NoticesBuild> {
  const raw = await runLicenseChecker();
  attachVerbatimLicenseTexts(raw);
  const allowlist = loadAllowlist();
  const pinned = loadPinned();

  const { general, unresolvedCopyleft, allowlistedCopyleft } = classifyEntries(raw, allowlist);

  // An allowlist-cleared copyleft dep is excluded from `general` on the
  // assumption its notice lives in the pinned file. Verify that, or it silently
  // gets NO attribution anywhere on the published page — the failure mode that
  // dropped `jszip` (elected MIT, so attribution is required) entirely.
  const pinnedNames = new Set(pinned.map((entry) => `${entry.name}@${entry.version}`));
  const missingNotice = allowlistedCopyleft.filter(
    (entry) => !pinnedNames.has(`${entry.name}@${entry.version}`),
  );

  // Enrich pinned entries with the copyright line / verbatim license text of
  // the INSTALLED package where the scan found one (e.g. libheif-js and jszip
  // ship real license files; the @img/sharp-* platform binaries publish none,
  // so those keep their licenseTextUrls links only). Hand-curated fields in
  // the pinned file always win over scan-derived ones.
  //
  // Platform-stable by construction, which matters because the freshness gate
  // (scripts/ci/check-third-party-notices-fresh.ts) compares this block as an
  // exact string across hosts: a pinned package that is not installed on this
  // platform is passed through untouched, and the @img/sharp-* binaries that
  // ARE installed ship no license file, so attachVerbatimLicenseTexts has
  // already stripped both fields off them.
  const copyleftDependencies = pinned.map((entry) => {
    const scanned = raw[`${entry.name}@${entry.version}`];
    if (!scanned) return entry;
    return {
      ...entry,
      copyright: entry.copyright ?? normalizeOptionalText(scanned.copyright),
      licenseText: entry.licenseText ?? normalizeOptionalText(scanned.licenseText),
    };
  });

  return {
    output: {
      generatedAt,
      generalDependencies: general,
      copyleftDependencies,
    },
    missingNotice,
    unresolvedCopyleft,
  };
}

async function main() {
  const { output, missingNotice, unresolvedCopyleft } = await buildNotices();

  if (missingNotice.length > 0) {
    console.error(
      '[generate-third-party-notices] FATAL: allowlist-cleared copyleft dependencies have no entry in ' +
      'third-party-notices.pinned.json, so they would receive NO attribution on /legal/third-party-notices. ' +
      'Add a pinned notice for each (name + version must match exactly):',
    );
    for (const entry of missingNotice) {
      console.error(`  - ${entry.name}@${entry.version} (${entry.license})`);
    }
    process.exitCode = 1;
    return;
  }

  if (unresolvedCopyleft.length > 0) {
    console.warn(
      '[generate-third-party-notices] Skipped copyleft dependencies with no license-denylist allowlist entry ' +
      '(resolve via scripts/security/license-denylist.allowlist.json first, then re-run):',
    );
    for (const entry of unresolvedCopyleft) {
      console.warn(`  - ${entry.name}@${entry.version} (${entry.license})`);
    }
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `[generate-third-party-notices] Wrote ${output.generalDependencies.length} general + ` +
    `${output.copyleftDependencies.length} copyleft entries to ${OUTPUT_PATH}`,
  );
}

if (process.argv[1]?.endsWith('generate-third-party-notices.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
