/**
 * SCRUM-2910 (BUG-2026-07-17-009 / -010, P0) — fraud-filter coverage guard.
 *
 * The render-time regression guard (`scrum-2910-fraud-strings-absent.test.tsx`)
 * proves the *currently mounted* surfaces don't leak fraud metadata. This suite
 * is the complementary STATIC guard: it fails if ANY component that iterates a
 * `metadata` object for rendering omits the `isFraudMetadataKey` filter — the
 * one shared predicate that hides `fraud_*` / camelCase `fraudSignals` keys.
 *
 * Why static, not render-based: a NEW metadata renderer (or a future re-mount of
 * `MetadataDisplay`, which is exported from the verification barrel but not
 * currently mounted) can reintroduce the P0 fraud-metadata leak without ever
 * touching the enumerated render tests. This guard scans the source tree instead
 * of a fixed component list, so it catches the leak at the moment the unfiltered
 * iterator is written.
 *
 * Detector: any non-test file under `src/components` that iterates
 * `Object.entries(metadata)` / `Object.entries(meta)` / `Object.keys(metadata)`
 * — i.e. renders a freeform metadata blob — MUST reference `isFraudMetadataKey`
 * (directly, or via a wrapper predicate defined in the same file that itself
 * calls it). A file may opt out only by being listed in ALLOWLIST with a reason.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const COMPONENTS_DIR = path.join(process.cwd(), 'src/components');

/**
 * Signals that a file iterates a freeform `metadata`/`meta` blob for rendering.
 * Matches `Object.entries(metadata)` in any consuming form (`.filter`, `.map`,
 * `for...of`) and `Object.keys(metadata)` only when it is actually iterated
 * (`.map`/`.forEach`/`.filter`/`.reduce`/`.flatMap`) — NOT a `.length` guard,
 * which is payload construction, not rendering.
 */
const METADATA_ITERATION =
  /Object\.entries\(\s*(metadata|meta)\b|Object\.keys\(\s*(metadata|meta)\s*\)\s*\.(map|forEach|filter|reduce|flatMap)\b/;

/** The shared fraud-key predicate every metadata surface must apply. */
const FRAUD_FILTER = /isFraudMetadataKey/;

/**
 * Files that iterate a `metadata`-named local that is NOT a user-facing freeform
 * blob (e.g. a typed config object) may opt out here with a documented reason.
 * Empty by design — every current match is a real render surface.
 */
const ALLOWLIST: Record<string, string> = {};

/** The known render surfaces that MUST always be covered (rename/delete tripwire). */
const REQUIRED_SURFACES = [
  'records/RecordsList.tsx',
  'verification/PublicVerification.tsx',
  'verification/MetadataDisplay.tsx',
  'anchor/AssetDetailView.tsx',
  'credentials/CredentialRenderer.tsx',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (
      (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('.stories.')
    ) {
      out.push(full);
    }
  }
  return out;
}

function rel(full: string): string {
  return path.relative(COMPONENTS_DIR, full).split(path.sep).join('/');
}

describe('SCRUM-2910 — every metadata renderer applies the fraud filter', () => {
  const files = walk(COMPONENTS_DIR);

  it('finds the component tree (sanity: guard is not vacuously green)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('every file that iterates a metadata blob references isFraudMetadataKey', () => {
    const offenders: string[] = [];
    for (const full of files) {
      const source = fs.readFileSync(full, 'utf8');
      if (!METADATA_ITERATION.test(source)) continue;
      const relPath = rel(full);
      if (relPath in ALLOWLIST) continue;
      if (!FRAUD_FILTER.test(source)) offenders.push(relPath);
    }
    expect(
      offenders,
      `These files render a freeform metadata blob without the isFraudMetadataKey ` +
        `filter — a P0 fraud-metadata leak (SCRUM-2910). Add the filter or an ` +
        `ALLOWLIST entry with a reason:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('detects the known render surfaces (rename/delete tripwire)', () => {
    // If a required surface is renamed or deleted, this list drifts — forcing a
    // conscious update of the guard rather than a silent loss of coverage.
    const covered = REQUIRED_SURFACES.filter((s) => {
      const full = path.join(COMPONENTS_DIR, s);
      if (!fs.existsSync(full)) return false;
      const source = fs.readFileSync(full, 'utf8');
      return METADATA_ITERATION.test(source) && FRAUD_FILTER.test(source);
    });
    expect(covered.sort()).toEqual([...REQUIRED_SURFACES].sort());
  });
});
