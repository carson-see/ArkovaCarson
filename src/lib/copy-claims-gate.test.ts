/**
 * SCRUM-2377 (CE-06a) — claims-review gate, UI-copy half (CLAUDE.md §1.13 R-7).
 *
 * Credential Engine approved Arkova TO PUBLISH — nothing is LISTED in the
 * Registry, and no proof output is "legally sufficient". This lint-style test
 * scans the ENTIRE copy vocabulary (src/lib/copy.ts source) so no current or
 * future string — from any lane — can ship a Registry-listing or
 * legal-sufficiency overclaim. The safe default status wording is
 * "approved to publish".
 *
 * Worker-side counterpart: services/worker/src/ctdl/ctdl-claims-guard.ts
 * (runtime, fail-closed) + ctdl-claims-lint.test.ts (CTDL/CE source scan).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CE_PUBLICATION_COPY } from './copy';

const COPY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'copy.ts');

/**
 * Banned overclaim phrases. Whitespace-tolerant + case-insensitive so
 * "Listed   in the Registry" and "REGISTRY-LISTED" still trip the gate.
 * Kept in semantic lockstep with PROHIBITED_CLAIM_PATTERNS in
 * services/worker/src/ctdl/ctdl-claims-guard.ts.
 */
const BANNED_OVERCLAIM_PATTERNS: readonly RegExp[] = [
  /listed\s+in\s+the\s+(?:credential\s+)?registry/i,
  /registry[-\s]+listed/i,
  /in\s+the\s+credential\s+registry/i,
  /legally\s+sufficient/i,
];

describe('CE-06a claims gate — src/lib/copy.ts carries no Registry-listing overclaims', () => {
  const copySource = fs.readFileSync(COPY_PATH, 'utf-8');

  it('sanity: the copy vocabulary file exists and is non-trivial', () => {
    expect(copySource.length).toBeGreaterThan(1000);
  });

  it.each(BANNED_OVERCLAIM_PATTERNS.map((p) => [String(p), p] as const))(
    'copy.ts contains no match for %s',
    (_label, pattern) => {
      const match = pattern.exec(copySource);
      // Surface the offending line (not just "failed") for fast triage.
      if (match) {
        const line = copySource.slice(0, match.index).split('\n').length;
        throw new Error(`Banned overclaim phrase at src/lib/copy.ts:${line} (${_label})`);
      }
      expect(match).toBeNull();
    },
  );
});

describe('CE-06a claims gate — safe default publication-status wording', () => {
  it('CE publication status copy says "approved to publish", never "listed"', () => {
    expect(CE_PUBLICATION_COPY.STATUS_APPROVED_TO_PUBLISH.toLowerCase()).toBe(
      'approved to publish',
    );
    for (const value of Object.values(CE_PUBLICATION_COPY)) {
      expect(value.toLowerCase()).not.toContain('listed');
      for (const pattern of BANNED_OVERCLAIM_PATTERNS) {
        expect(value).not.toMatch(pattern);
      }
    }
  });
});
