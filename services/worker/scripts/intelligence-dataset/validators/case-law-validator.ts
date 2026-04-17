/**
 * NVI-02 — Case-law citation validator (SCRUM-806)
 *
 * Verifies every federal / state case cite resolves to a real published
 * opinion. The FCRA dataset carries cites like "Safeco v. Burr (2007)",
 * "Syed v. M.I. Windows & Doors (9th Cir. 2017)", and circuit splits such
 * as "Long v. Southeastern Pennsylvania Transp. Auth." — each must have a
 * canonical reporter cite and a reachable authority URL (CourtListener,
 * supreme.justia.com, openjurist, or the circuit's own .uscourts.gov
 * domain).
 *
 * Applicable when the source.source label contains a v./v.s/In re/etc.
 * case-name pattern, OR the label carries a reporter cite ("551 U.S. 47").
 *
 * Offline checks: canonical case-name format, reporter-cite pattern, year
 * within plausible range, URL on authority allowlist.
 *
 * Live checks (opt-in): HEAD the URL.
 */

import type { IntelligenceSource } from '../types';
import type { Applicability, Validator, ValidateOpts, VerificationResult } from './types';
import { stamp } from './types';

/** Case-law authority domains. */
const CASE_LAW_DOMAINS = [
  'courtlistener.com',
  'supreme.justia.com',
  'law.justia.com',
  'scholar.google.com',
  'openjurist.org',
  'supremecourt.gov',
  'uscourts.gov',
  'caselaw.findlaw.com',
];

/** "Name v. Name" or "In re Name" patterns, including party-name quirks. */
const CASE_NAME_RE = /\b(In\s+re\s+[A-Z][\w.,' -]+|[A-Z][\w.,'\- ]+?\s+v\.?\s+[A-Z][\w.,'\- ]+)/;

/** US reporter cites: "551 U.S. 47", "853 F.3d 492", "42 Cal.4th 807". */
const REPORTER_CITE_RE = /\b\d{1,4}\s+(?:U\.S\.|S\.\s*Ct\.|F\.\s*(?:2d|3d|Supp\.?\s*(?:2d|3d)?)|Cal\.\s*\d?(?:th|st|nd|rd)?|N\.Y\.\s*\d?(?:th|st|nd|rd)?|P\.\s*(?:2d|3d))\s+\d{1,5}/;

/** Year in parens, e.g. "(2007)", "(9th Cir. 2017)". */
const YEAR_RE = /\((?:[\w. ]+,?\s*)?(19|20)\d{2}\)/;

function looksLikeCaseCite(source: IntelligenceSource): boolean {
  if (CASE_NAME_RE.test(source.source)) return true;
  if (REPORTER_CITE_RE.test(source.source)) return true;
  // Some sources keep the case name in the quote, not the label
  if (CASE_NAME_RE.test(source.quote.slice(0, 200)) && /\(19|20/.test(source.quote.slice(0, 400))) {
    return true;
  }
  return false;
}

export const caseLawValidator: Validator = {
  kind: 'case-law',

  isApplicable(source: IntelligenceSource): Applicability {
    if (looksLikeCaseCite(source)) return { applicable: true };
    return { applicable: false, reason: 'not a case-law source' };
  },

  async validate(source: IntelligenceSource, opts?: ValidateOpts): Promise<VerificationResult> {
    const problems: string[] = [];
    const fetchedUrls: string[] = [];

    // 1. Label must have a case name.
    if (!CASE_NAME_RE.test(source.source) && !CASE_NAME_RE.test(source.quote.slice(0, 200))) {
      problems.push('no canonical case name ("X v. Y" or "In re X") in source label or quote opener');
    }

    // 2. A year reference is required — distinguishes a cite from a statute.
    const yearMatch = source.source.match(YEAR_RE) ?? source.quote.match(YEAR_RE);
    if (!yearMatch) {
      problems.push('no decision year in parentheses — case cites must include "(YYYY)"');
    } else {
      const year = parseInt(yearMatch[0].match(/\d{4}/)![0], 10);
      const currentYear = new Date(stamp(opts)).getFullYear();
      if (year < 1789 || year > currentYear) {
        problems.push(`decision year ${year} out of plausible range [1789, ${currentYear}]`);
      }
    }

    // 3. Reporter cite recommended (warn if absent rather than hard-fail —
    //    circuit slip opinions sometimes predate reporter publication).
    const hasReporter = REPORTER_CITE_RE.test(source.source) || REPORTER_CITE_RE.test(source.quote);
    // Reporter is soft — we'll record as a problem but flag hardFail=false for this one.
    let reporterMissing = false;
    if (!hasReporter) {
      problems.push('no reporter cite detected (e.g. "551 U.S. 47", "853 F.3d 492") — recommended');
      reporterMissing = true;
    }

    // 4. URL (if present) must resolve to a case-law authority.
    if (source.url) {
      try {
        const u = new URL(source.url);
        const onAuthority = CASE_LAW_DOMAINS.some(
          (d) => u.hostname === d || u.hostname.endsWith('.' + d),
        );
        if (!onAuthority) {
          problems.push(
            `url host "${u.hostname}" is not on the case-law authority allowlist ` +
              `(${CASE_LAW_DOMAINS.join(', ')})`,
          );
        }
        if (opts?.live) {
          const ok = await headOk(source.url);
          fetchedUrls.push(source.url);
          if (!ok) problems.push(`live fetch of url failed — HEAD did not return 2xx`);
        }
      } catch {
        problems.push(`url "${source.url}" is not a parseable URL`);
      }
    }

    // A case-cite fails hard if EVERY check fails OR the case name is missing
    // OR the decision year is missing. Reporter-only miss is a soft warning.
    const onlySoftProblem =
      problems.length === 1 && reporterMissing;
    const passed = problems.length === 0;
    const hardFail = !passed && !onlySoftProblem;

    return {
      sourceId: source.id,
      validator: 'case-law',
      passed,
      hardFail,
      notes: passed ? 'passes case-cite structural checks' : problems.join('; '),
      verifiedAt: stamp(opts),
      fetchedUrls: fetchedUrls.length ? fetchedUrls : undefined,
    };
  },
};

async function headOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}
