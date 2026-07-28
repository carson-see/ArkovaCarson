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
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModuleInfos } from 'license-checker';

import { GPL_DENYLIST } from './license-denylist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const OUTPUT_PATH = resolve(REPO_ROOT, 'src/data/thirdPartyNotices.generated.json');
const PINNED_PATH = resolve(__dirname, 'third-party-notices.pinned.json');
const ALLOWLIST_PATH = resolve(__dirname, 'license-denylist.allowlist.json');

export interface NoticeEntry {
  name: string;
  version: string;
  license: string;
  repository?: string;
  sourceUrl?: string;
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
      },
      (err: Error, packages: ModuleInfos) => {
        if (err) reject(err);
        else resolvePromise(packages);
      },
    );
  });
}

/** license-checker reports `licenses` as either a string or a string[] (dual/multi-license). */
function normalizeLicenses(licenses: string | string[] | undefined): string {
  if (!licenses) return 'UNKNOWN';
  return Array.isArray(licenses) ? licenses.join(' AND ') : licenses;
}

export function classifyEntries(
  raw: ModuleInfos,
  allowlist: AllowlistEntry[],
): { general: NoticeEntry[]; unresolvedCopyleft: NoticeEntry[] } {
  const allowed = new Set(allowlist.map((entry) => `${entry.name}@${entry.version}`));
  const general: NoticeEntry[] = [];
  const unresolvedCopyleft: NoticeEntry[] = [];

  for (const [key, row] of Object.entries(raw)) {
    const { name, version } = parseNameVersion(key);
    // Skip the root package itself (arkova@...) — not a third-party dep.
    if (name === 'arkova') continue;

    const license = normalizeLicenses(row.licenses);
    const entry: NoticeEntry = { name, version, license, repository: row.repository };

    if (GPL_DENYLIST.test(license)) {
      // Copyleft-family license. Only include it here if it has been
      // through the license-denylist allowlist review — that's the
      // one source of truth for "this copyleft dependency is cleared."
      // The pinned file (loaded separately by main()) is where its full
      // notice text lives; this generator does not fabricate one.
      if (!allowed.has(`${name}@${version}`)) {
        unresolvedCopyleft.push(entry);
      }
      continue;
    }

    general.push(entry);
  }

  general.sort((a, b) => a.name.localeCompare(b.name));
  return { general, unresolvedCopyleft };
}

async function main() {
  const raw = await runLicenseChecker();
  const allowlist = loadAllowlist();
  const pinned = loadPinned();

  const { general, unresolvedCopyleft } = classifyEntries(raw, allowlist);

  if (unresolvedCopyleft.length > 0) {
    console.warn(
      '[generate-third-party-notices] Skipped copyleft dependencies with no license-denylist allowlist entry ' +
      '(resolve via scripts/security/license-denylist.allowlist.json first, then re-run):',
    );
    for (const entry of unresolvedCopyleft) {
      console.warn(`  - ${entry.name}@${entry.version} (${entry.license})`);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    generalDependencies: general,
    copyleftDependencies: pinned,
  };

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `[generate-third-party-notices] Wrote ${general.length} general + ${pinned.length} copyleft ` +
    `entries to ${OUTPUT_PATH}`,
  );
}

if (process.argv[1]?.endsWith('generate-third-party-notices.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
