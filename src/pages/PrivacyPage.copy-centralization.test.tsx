/**
 * Public privacy copy is centralized in copy.ts (§1.3).
 *
 * Why this exists, specifically:
 *
 * `src/lib/copy-internal-scaffolding.test.ts` walks the string VALUES exported
 * from copy.ts and fails on internal scaffolding — bracketed editorial notes,
 * `(counsel-required)`, "do not assert", and friends. That guard is only as
 * wide as copy.ts is. Any user-visible string written inline in a component is
 * outside its reach, so the exact defect it was built for — an internal counsel
 * instruction rendering verbatim on the PUBLIC, unauthenticated /privacy page —
 * can recur one file over and the guard stays green.
 *
 * At the time this was written the leak surface was real, not hypothetical:
 * `JURISDICTION_NOTICES` carried `regulator` / `rights` / `transferBasis` /
 * `breachTimeline` as inline literals across its 13 jurisdictions (only the
 * eu-us entry's `transferBasis` had been migrated), and
 * `PrivacyPage` wrote nearly every section body as inline JSX prose. Both
 * render on /privacy.
 *
 * So the rule enforced here is coverage, not phrasing: everything /privacy
 * renders inside <main> must come from copy.ts, which is what puts it under the
 * scaffolding guard. The two tests are deliberately different in kind —
 *
 *   1. RENDERED coverage — no string reaches the reader that copy.ts does not
 *      own. Catches prose wherever it hides, including markup we have not
 *      thought of.
 *   2. SOURCE shape — the jurisdiction table's copy fields are references, not
 *      literals. Catches a regression at the line someone would actually type,
 *      with a message that names the field.
 *
 * A census of today's strings would pass today and rot tomorrow; a detector
 * finds the sites a census misses. Neither test pins WORDING — that is the
 * scaffolding guard's job and legal counsel's, not this file's.
 */

import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as copy from '@/lib/copy';
import { PrivacyPage } from './PrivacyPage';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 4th private copy.ts leaf walker in the repo — the siblings are
 * copy-internal-scaffolding.test.ts (path-tracking), copy-scrum-2938-
 * terminology-s2.test.ts (path-tracking, skips function exports), and
 * copy-professional-education-overclaim.test.ts (values-only, INVOKES function
 * exports with sample counts). This one neither skips nor invokes: it silently
 * drops function-valued exports, which is deliberate here — a formatter-
 * produced string on /privacy SHOULD surface as residue, because a function's
 * output is not a static value the scaffolding guard can scan. Extract a shared
 * walker only with those semantics reconciled (rule of three is met; the
 * semantic split is why it hasn't happened).
 */
function collectStringValues(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const child of Object.values(value)) collectStringValues(child, out);
}

/** Every string copy.ts exports, longest first so greedy removal can't leave a
 *  shorter value's text stranded inside a longer one it is a substring of. */
const COPY_VALUES: string[] = (() => {
  const out: string[] = [];
  collectStringValues(copy, out);
  return [...new Set(out)].filter((s) => s.trim().length > 0).sort((a, b) => b.length - a.length);
})();

function renderPrivacyMain(): string {
  const { container } = render(
    <MemoryRouter>
      <PrivacyPage />
    </MemoryRouter>,
  );
  // <main> only. The page's header/footer chrome is shared navigation, not
  // privacy copy, and is out of scope for this migration — see
  // src/pages/agents.md.
  return container.querySelector('main')?.textContent ?? '';
}

/** Strip every copy.ts value from `text`; what survives came from somewhere else. */
function residueAfterRemovingCopy(text: string): string {
  return COPY_VALUES.reduce((residue, value) => residue.replaceAll(value, ' '), text);
}

describe('public /privacy copy is centralized in copy.ts (§1.3)', () => {
  it('sanity: the page renders substantive text and the copy vocabulary loaded', () => {
    expect(renderPrivacyMain().length).toBeGreaterThan(2000);
    expect(COPY_VALUES.length).toBeGreaterThan(500);
  });

  /**
   * The load-bearing assertion. Every word /privacy shows a reader must be a
   * copy.ts value, because copy.ts is the only surface the scaffolding guard
   * scans. Residue is reported verbatim so a failure names the leaked prose
   * rather than just a count.
   */
  it('renders no user-visible prose that copy.ts does not own', () => {
    const residue = residueAfterRemovingCopy(renderPrivacyMain());

    // Punctuation and whitespace glue between copy values is expected; words
    // are not. 3+ letters skips stray "a"/"of" fragments left by adjacency.
    const leaked = [...residue.matchAll(/[A-Za-z]{3,}/g)].map((m) => m[0]);

    expect(leaked).toEqual([]);
  });

  /**
   * Source-shape guard for the jurisdiction table. The rendered test above
   * already covers these strings; this one fails at the line a future edit
   * would touch, naming the offending field — a detector at the point of the
   * mistake, not just at its symptom.
   */
  it('every jurisdiction notice sources its copy fields from PRIVACY_NOTICE_LABELS', () => {
    const source = fs.readFileSync(
      path.join(HERE, '../components/compliance/JurisdictionPrivacyNotices.tsx'),
      'utf-8',
    );

    const start = source.indexOf('const JURISDICTION_NOTICES');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n];', start);
    expect(end).toBeGreaterThan(start); // -1 would silently widen the slice to EOF
    const table = source.slice(start, end);

    // `regulatorUrl` (an href) is not copy and is deliberately absent from
    // this list.
    const COPY_FIELDS = /^\s*(regulator|rights|transferBasis|breachTimeline):\s*(.+?),?\s*$/gm;

    const inlineLiterals = [...table.matchAll(COPY_FIELDS)]
      .filter(([, , value]) => !value.includes('PRIVACY_NOTICE_LABELS.'))
      .map(([, field, value]) => `${field}: ${value}`);

    expect(inlineLiterals).toEqual([]);
  });
});
