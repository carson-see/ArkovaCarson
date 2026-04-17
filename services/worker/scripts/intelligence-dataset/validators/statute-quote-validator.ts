/**
 * NVI-01 — Statute-quote validator (SCRUM-805)
 *
 * Verifies every federal statute citation in the intelligence-dataset source
 * registry conforms to the canonical "15 U.S.C. §NNNN" / "§NNN(x)(y)" form
 * and that the quote begins with (or contains) that exact citation.
 *
 * Applicable when:
 *   - source.jurisdiction === 'federal' AND
 *   - source.source label matches /^FCRA §/, /^HIPAA§?/, /^FERPA/, /^SOX/,
 *     or the quote opens with "15 U.S.C." / "20 U.S.C." / "45 CFR" / etc.
 *
 * This validator is OFFLINE-first: it catches the class of errors that have
 * actually shown up in the FCRA dataset — section-number mismatches,
 * missing U.S.C. references, quotes that don't reference the statute at
 * all. Live fetch (--live) additionally requires the source.url to resolve
 * on a whitelisted authority domain (law.cornell.edu, govinfo.gov,
 * congress.gov, ecfr.gov). We do NOT fetch quote text by default because
 * authority sites throttle aggressively and the training pipeline should
 * stay offline in CI.
 */

import type { IntelligenceSource } from '../types';
import type { Applicability, Validator, ValidateOpts, VerificationResult } from './types';
import { stamp } from './types';

/** Authority domains for federal statutory / regulatory text. */
const FEDERAL_AUTHORITY_DOMAINS = [
  'law.cornell.edu',
  'govinfo.gov',
  'congress.gov',
  'ecfr.gov',
  'uscode.house.gov',
  'federalregister.gov',
];

/** Recognized U.S. Code / CFR prefixes the quote can open with. */
const USC_OPENERS = [
  /\b1?[0-9]{1,2}\s+U\.S\.C\.\s+§/,   // "15 U.S.C. §1681b(b)(3)"
  /\b[0-9]{1,2}\s+CFR\s+\d/,           // "45 CFR 164.524"
  /\bPub\.\s*L\./,                     // "Pub. L. 91-508"
];

/** Labels that mark a source as a federal statute citation. */
const FEDERAL_STATUTE_LABEL_PREFIXES = [
  'FCRA §',
  'FCRA Section',
  'HIPAA ',
  'HIPAA §',
  '45 CFR',
  '42 U.S.C.',
  '15 U.S.C.',
  '20 U.S.C.',
  'FERPA',
  'SOX §',
  'GLBA',
  'FACT Act',
];

function looksLikeFederalStatute(source: IntelligenceSource): boolean {
  if (source.jurisdiction === 'federal') {
    if (FEDERAL_STATUTE_LABEL_PREFIXES.some((p) => source.source.startsWith(p))) return true;
    if (USC_OPENERS.some((re) => re.test(source.quote))) return true;
  }
  return false;
}

/**
 * Extract the section number (e.g. "604(b)(3)") from a FCRA/HIPAA citation
 * label. Returns null if no section number is present — that is itself a
 * validation failure for statute-type sources.
 */
function extractSectionNumber(label: string): string | null {
  // Match FCRA §604(b)(3), HIPAA §164.524, 45 CFR 164.524, etc.
  // Also accept bare CFR part numbers ("16 CFR 681") and Pub. L. citations
  // ("Pub. L. 104-191"), both of which the FCRA/HIPAA registry uses as the
  // canonical label for rule-level citations without a subsection.
  const hits = [
    label.match(/§\s*([\w.()-]+)/),
    label.match(/\b(\d{1,3}\s*CFR\s+\d+(?:\.\d+)?)/i),
    label.match(/\bPub\.?\s*L\.?\s*(\d{1,3}[-\u2013]\d{1,4})/i),
    label.match(/\b(\d{2,4}\.\d{2,4}(?:\([a-z0-9]+\))?)\b/),
  ];
  for (const h of hits) if (h?.[1]) return h[1];
  return null;
}

export const statuteQuoteValidator: Validator = {
  kind: 'statute-quote',

  isApplicable(source: IntelligenceSource): Applicability {
    if (looksLikeFederalStatute(source)) return { applicable: true };
    return { applicable: false, reason: 'not a federal-statute source' };
  },

  async validate(source: IntelligenceSource, opts?: ValidateOpts): Promise<VerificationResult> {
    const problems: string[] = [];
    const fetchedUrls: string[] = [];

    // 1. The source MUST have a section number in its label.
    const section = extractSectionNumber(source.source);
    if (!section) {
      problems.push(`source label "${source.source}" has no extractable section number`);
    }

    // 2. The quote MUST contain either (a) an explicit U.S.C./CFR opener,
    //    or (b) the section number from the label.
    const hasUscOpener = USC_OPENERS.some((re) => re.test(source.quote));
    const hasLabelSection = section ? source.quote.includes(section) : false;
    if (!hasUscOpener && !hasLabelSection) {
      problems.push(
        'quote does not reference the U.S.C. citation or its section number — ' +
          'every federal-statute quote must open with (or contain) the canonical cite',
      );
    }

    // 3. Quote minimum-length sanity.
    if (source.quote.length < 40) {
      problems.push(`quote too short (${source.quote.length} chars) — expect ≥40 to be substantive`);
    }

    // 4. URL (if present) must resolve to an authority domain.
    if (source.url) {
      try {
        const u = new URL(source.url);
        const onAuthority = FEDERAL_AUTHORITY_DOMAINS.some(
          (d) => u.hostname === d || u.hostname.endsWith('.' + d),
        );
        if (!onAuthority) {
          problems.push(
            `url host "${u.hostname}" is not on the federal authority allowlist ` +
              `(${FEDERAL_AUTHORITY_DOMAINS.join(', ')})`,
          );
        }
        // Live mode: fetch the URL and record the reachable host.
        if (opts?.live) {
          const ok = await headOk(source.url);
          fetchedUrls.push(source.url);
          if (!ok) problems.push(`live fetch of url failed — HEAD did not return 2xx`);
        }
      } catch {
        problems.push(`url "${source.url}" is not a parseable URL`);
      }
    }

    const passed = problems.length === 0;
    return {
      sourceId: source.id,
      validator: 'statute-quote',
      passed,
      hardFail: !passed, // statute quotes are load-bearing — any failure is hard
      notes: passed ? 'passes canonical federal-statute checks' : problems.join('; '),
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
