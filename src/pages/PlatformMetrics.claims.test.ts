/**
 * R-7 / §1.5 ratchet — the public traction figures on `/about` and `/developers`
 * are CLAIMS, and a claim must be sourced and dated.
 *
 * Both pages hardcoded `1.39M+` "Records Secured" as a bare JSX literal. By
 * 2026-08 prod held at least 3,300,000 SECURED anchors (bounded COUNT on the
 * prod project, 2026-08-23 — see `PLATFORM_METRICS` in `src/lib/copy.ts`), so
 * the number understated reality by ~2M. Understating is the harmless direction;
 * the real defect is structural — an undated literal duplicated across two files
 * has no owner, no source, and no expiry, so it silently rots in whichever
 * direction the business moves. Next time it may overstate.
 *
 * This suite is the ratchet, and it reads the SOURCE rather than rendering:
 * a figure that is currently behind a flag or in a collapsed section is still a
 * published claim the moment someone shows it. Same rationale as the sibling
 * `DevelopersPage.claims.test.ts` (R-1 pricing ratchet).
 *
 * The invariants pinned here are deliberately about SHAPE, not about one magic
 * number — a value pinned by equality would just be a second copy of the literal
 * to update. What must hold forever: one shared source, a floor marker, an
 * explicit as-of date, and no bare count literal left in a page.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PLATFORM_METRICS, PLATFORM_METRICS_AS_OF } from '@/lib/copy';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(HERE, file), 'utf8');

const PAGES = [
  ['AboutPage.tsx', read('AboutPage.tsx')],
  ['DevelopersPage.tsx', read('DevelopersPage.tsx')],
] as const;

/** The stale literal this ratchet exists to keep out, in every spelling. */
const STALE_FIGURES = ['1.39M', '1,390,000', '1390000'];

/** Metric values carry `.`, `+` and `%`, so they must be quoted before reuse in a pattern. */
const escapeRegExp = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('public traction claims — R-7 ratchet', () => {
  describe.each(PAGES)('%s', (_name, source) => {
    it('carries no stale hardcoded records-secured figure', () => {
      for (const stale of STALE_FIGURES) {
        expect(source).not.toContain(stale);
      }
    });

    it('sources its metrics from the shared PLATFORM_METRICS constant', () => {
      expect(source).toContain('PLATFORM_METRICS');
    });

    it('renders the as-of qualifier next to the figures', () => {
      expect(source).toContain('PLATFORM_METRICS_AS_OF');
    });

    /**
     * The point of the shared constant is that no page re-states a count inline.
     * Any `>1.2M+<`-shaped JSX text node is a bare claim that escaped the source
     * of truth. Matches the rendered-text position only, so a Tailwind class or
     * an import path can never trip it.
     */
    it('states no records count as a bare JSX literal', () => {
      const bareCounts = source.match(/>\s*\d+(?:\.\d+)?\s*[MK]\+?\s*</g) ?? [];
      expect(bareCounts).toEqual([]);
    });

    /**
     * Companion to the check above, which only recognises an `M`/`K`-suffixed
     * figure. Two of the four tiles (`21`, `87.2%`) carry neither suffix, so
     * re-typing one of THOSE inline would slip straight past it — and the
     * single-source rule is meant to cover every tile, not just the count.
     *
     * Derived from `PLATFORM_METRICS` rather than a second list of magic
     * numbers: whatever the source of truth currently claims must not ALSO
     * appear as a JSX text node in a page. Changing a value in `copy.ts`
     * therefore moves this assertion with it, for free.
     */
    it('re-states no current metric value as a bare JSX literal', () => {
      const inlined = Object.values(PLATFORM_METRICS)
        .map((metric) => metric.value)
        .filter((value) => new RegExp(`>\\s*${escapeRegExp(value)}\\s*<`).test(source));

      expect(inlined).toEqual([]);
    });
  });
});

describe('PLATFORM_METRICS — the single source of truth', () => {
  it('states the records-secured figure as a floor, not a point estimate', () => {
    // A trailing `+` is what makes the claim survivable: prod grows, and a
    // conservative floor stays true where an exact number goes stale same-day.
    // The prod count is also only cheaply available as a bounded/estimated
    // value, so a point estimate would assert precision we do not have.
    expect(PLATFORM_METRICS.RECORDS_SECURED.value).toMatch(/^\d+(\.\d+)?[MK]\+$/);
  });

  it('is not the known-stale figure', () => {
    for (const stale of STALE_FIGURES) {
      expect(PLATFORM_METRICS.RECORDS_SECURED.value).not.toContain(stale);
    }
  });

  it('carries an explicit as-of date for the records-secured claim', () => {
    expect(PLATFORM_METRICS.RECORDS_SECURED.asOf).toMatch(/^\d{4}-\d{2}$/);
  });

  it('exposes a user-visible as-of label that names the same period', () => {
    expect(PLATFORM_METRICS_AS_OF).toBeTruthy();
    const [, month] = PLATFORM_METRICS.RECORDS_SECURED.asOf.split('-');
    const monthName = new Date(Date.UTC(2000, Number(month) - 1, 1))
      .toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    expect(PLATFORM_METRICS_AS_OF).toContain(monthName);
    expect(PLATFORM_METRICS_AS_OF).toContain(
      PLATFORM_METRICS.RECORDS_SECURED.asOf.slice(0, 4),
    );
  });

  /**
   * Ratchet, not a wipe: the other three tiles are carried forward from the
   * original GEO-16 block. Their measurement dates were never recorded, so they
   * are explicitly `asOf: null` rather than being given a date they did not
   * earn — dating an unverified figure would be the same defect in a new place.
   */
  it('keeps the remaining traction tiles', () => {
    for (const key of ['PUBLIC_RECORDS_INDEXED', 'DOCUMENT_TYPES', 'EXTRACTION_F1'] as const) {
      expect(PLATFORM_METRICS[key].value).toBeTruthy();
      expect(PLATFORM_METRICS[key].label).toBeTruthy();
    }
  });

  it('marks every unverified figure as undated rather than inventing a date', () => {
    for (const metric of Object.values(PLATFORM_METRICS)) {
      expect(metric.asOf === null || /^\d{4}-\d{2}$/.test(metric.asOf)).toBe(true);
    }
  });
});
