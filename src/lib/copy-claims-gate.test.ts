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
 * SINGLE SHARED SOURCE (round-1 review finding 1): the banned phrase set is
 * imported from services/worker/src/ctdl/ctdl-claims-guard.ts
 * (PROHIBITED_CLAIM_PATTERNS) — the worker runtime gate and this UI-copy lint
 * can no longer drift apart. The guard module is dependency-free (pure
 * regexes), so the cross-package import is safe for the frontend test runner.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CE_PUBLICATION_COPY } from './copy';
import {
  PROHIBITED_CLAIM_PATTERNS,
  containsProhibitedClaim,
} from '../../services/worker/src/ctdl/ctdl-claims-guard';

const COPY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'copy.ts');

describe('CE-06a claims gate — src/lib/copy.ts carries no Registry-listing overclaims', () => {
  const copySource = fs.readFileSync(COPY_PATH, 'utf-8');

  it('sanity: the copy vocabulary file exists and is non-trivial', () => {
    expect(copySource.length).toBeGreaterThan(1000);
  });

  it('sanity: the shared pattern set is the worker guard, not a local copy', () => {
    expect(PROHIBITED_CLAIM_PATTERNS.length).toBeGreaterThanOrEqual(4);
  });

  it.each(PROHIBITED_CLAIM_PATTERNS.map((p) => [String(p), p] as const))(
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

  // Round-1 review finding 1: pin that the shared pattern set covers the whole
  // phrase FAMILY, not just the literal wordings — these exact strings bypassed
  // the original pattern list.
  it.each([
    'listed in the CE Registry',
    'listed in the Credential Engine Registry',
    'published in the Registry',
    'listed with Credential Engine',
    'live in the Registry',
    'listed on the Registry',
  ])('the shared pattern set flags the bypass phrase: %s', (bypass) => {
    expect(containsProhibitedClaim(bypass)).toBe(true);
  });
});

describe('CE-06a claims gate — safe default publication-status wording', () => {
  it('CE publication status copy says "approved to publish", never "listed"', () => {
    expect(CE_PUBLICATION_COPY.STATUS_APPROVED_TO_PUBLISH.toLowerCase()).toBe(
      'approved to publish',
    );
    for (const value of Object.values(CE_PUBLICATION_COPY)) {
      expect(value.toLowerCase()).not.toContain('listed');
      for (const pattern of PROHIBITED_CLAIM_PATTERNS) {
        expect(value).not.toMatch(pattern);
      }
    }
  });
});
