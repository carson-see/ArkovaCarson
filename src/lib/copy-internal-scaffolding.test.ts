/**
 * Shipped copy carries no internal scaffolding.
 *
 * The defect this exists for: `PRIVACY_NOTICE_LABELS.DPF_DESCRIPTION` ended
 * with the literal text
 *
 *   "[Counsel review required — do not assert a specific transfer mechanism
 *    until confirmed.]"
 *
 * That is an instruction to Arkova staff. It was rendered verbatim, unescaped
 * and unfiltered, by `JurisdictionPrivacyNotices` on `/privacy` — an
 * UNAUTHENTICATED public route. An EU prospect running diligence on our
 * transatlantic transfer basis read our internal legal to-do list.
 *
 * The caution itself was CORRECT and is preserved: Arkova does not hold an
 * active DPF self-certification (SCRUM-2283 removed that false claim) and
 * CLAUDE.md §1.13 R-7 forbids asserting external status we do not hold. The
 * bug was never the position — it was that the drafting note shipped with it.
 *
 * Why a general guard rather than a one-line fix: this class recurs because a
 * bracketed note is invisible in review — it reads like an editorial aside in
 * the source, and nothing distinguishes "note to self" from "copy" once it is
 * inside a string that a component renders. Reviewers miss it; a scanner does
 * not. So the rule is structural, not phrase-based: shipped copy contains no
 * square-bracketed segments and no staff-directive markers, whatever they say.
 *
 * Scope: string VALUES exported from copy.ts, walked recursively — the same
 * technique as copy-scrum-2938-terminology-s2.test.ts. Source COMMENTS are
 * deliberately out of scope: copy.ts carries legitimate engineering commentary
 * about what is counsel-required and why, and that commentary is exactly what
 * should stay in the file. Only what reaches a user is scanned.
 */

import { describe, expect, it } from 'vitest';
import * as copy from './copy';

type StringLeaf = { path: string; value: string };

function collectStringLeaves(value: unknown, path: string, out: StringLeaf[]): void {
  if (typeof value === 'string') {
    out.push({ path, value });
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    collectStringLeaves(child, path === '' ? key : `${path}.${key}`, out);
  }
}

const LEAVES: StringLeaf[] = (() => {
  const out: StringLeaf[] = [];
  collectStringLeaves(copy, '', out);
  return out;
})();

/**
 * Square-bracketed segments in shipped copy.
 *
 * There are currently zero legitimate uses in copy.ts, and a bracket is the
 * house style for an editorial note, so the blanket rule is both true today
 * and the cheapest thing to enforce. If a genuine bracketed string is ever
 * needed (a footnote marker, a substitution token), add its path to
 * ALLOWED_BRACKET_PATHS with a reason — an allowlist entry is a decision on
 * the record, which is the point.
 */
const BRACKETED_SEGMENT = /\[[^\]]*\]/;
const ALLOWED_BRACKET_PATHS = new Set<string>([]);

/**
 * Directive-to-staff markers, bracketed or not. `(counsel-required)` is the
 * companion form of the same defect: it tagged the public "Cross-Border
 * Transfer Basis" value as an open internal ticket rather than stating a
 * position.
 */
const STAFF_DIRECTIVE_MARKERS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'code-comment task marker', pattern: /\b(TODO|FIXME|TBD|XXX|HACK|WIP)\b/ },
  { label: 'counsel-required tag', pattern: /\(\s*counsel[-\s]required\s*\)/i },
  { label: 'review-required instruction', pattern: /\b(counsel|legal)\s+review\s+required\b/i },
  { label: 'instruction to the author', pattern: /\bdo not (assert|ship|publish|use|merge)\b/i },
  { label: 'internal-note marker', pattern: /\b(internal note|for internal use|note to self|placeholder pending)\b/i },
];

describe('shipped copy carries no internal scaffolding', () => {
  it('sanity: the walker sees the whole copy vocabulary', () => {
    expect(LEAVES.length).toBeGreaterThan(500);
    expect(LEAVES.some((l) => l.path.startsWith('PRIVACY_NOTICE_LABELS.'))).toBe(true);
  });

  it('no copy string contains a square-bracketed editorial segment', () => {
    const offenders = LEAVES.filter(
      (l) => !ALLOWED_BRACKET_PATHS.has(l.path) && BRACKETED_SEGMENT.test(l.value),
    ).map((l) => `${l.path}: ${BRACKETED_SEGMENT.exec(l.value)?.[0]}`);

    expect(offenders).toEqual([]);
  });

  it.each(STAFF_DIRECTIVE_MARKERS)('no copy string contains a $label', ({ pattern }) => {
    const offenders = LEAVES.filter((l) => pattern.test(l.value)).map(
      (l) => `${l.path}: ${JSON.stringify(l.value.slice(0, 120))}`,
    );

    expect(offenders).toEqual([]);
  });

  it('sanity: the guard would catch the exact string that shipped to /privacy', () => {
    const shipped =
      'The lawful basis for transatlantic personal data transfers is under review by legal counsel. [Counsel review required — do not assert a specific transfer mechanism until confirmed.]';

    expect(BRACKETED_SEGMENT.test(shipped)).toBe(true);
    expect(STAFF_DIRECTIVE_MARKERS.some((m) => m.pattern.test(shipped))).toBe(true);
    expect(
      STAFF_DIRECTIVE_MARKERS.some((m) =>
        m.pattern.test('Under review by legal counsel — mechanism to be confirmed (counsel-required)'),
      ),
    ).toBe(true);
  });

  /**
   * The R-7 half of the fix: removing the drafting note must not become an
   * excuse to upgrade the claim. Arkova holds no DPF self-certification and no
   * confirmed EU→US transfer mechanism, so the public notice may state that
   * the basis is under review — it may NOT name a mechanism.
   */
  it('the EU–US transfer notice still asserts no mechanism it does not hold', () => {
    const { DPF_DESCRIPTION, DPF_TRANSFER_BASIS } = copy.PRIVACY_NOTICE_LABELS as Record<
      string,
      string
    >;

    for (const value of [DPF_DESCRIPTION, DPF_TRANSFER_BASIS]) {
      expect(value).toBeDefined();
      // No claimed certification / adequacy / executed instrument.
      expect(value).not.toMatch(/self-certif/i);
      expect(value).not.toMatch(/\bdata privacy framework\b/i);
      expect(value).not.toMatch(/\bDPF\b/);
      expect(value).not.toMatch(/\badequacy (decision|list)\b/i);
      expect(value).not.toMatch(/\b(executed|in place|certified|approved)\b/i);
      expect(value).not.toMatch(/standard contractual clauses/i);
    }

    // ...and it still tells the reader the honest position.
    expect(DPF_DESCRIPTION.toLowerCase()).toContain('under review');
    expect(DPF_TRANSFER_BASIS.toLowerCase()).toContain('under');
  });
});
