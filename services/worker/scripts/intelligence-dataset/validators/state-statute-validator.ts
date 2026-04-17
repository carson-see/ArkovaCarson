/**
 * NVI-04 — State statute validator (SCRUM-808)
 *
 * State-statute cites are the single biggest source of fabricated citations
 * in the FCRA dataset — state code structures vary, and it's easy to emit
 * a plausible-looking "Cal. Civ. Code §1786.12" that doesn't actually map
 * to the claim in the quote. This validator checks:
 *
 *   1. Source.jurisdiction matches a known state
 *   2. Label references a canonical state-code format (e.g. "Cal. Civ. Code
 *      §1785", "N.Y. Gen. Bus. Law §380", "Tex. Bus. & Com. Code §20")
 *   3. Label + quote both reference the same section number
 *   4. URL (if present) is on that state's official code host (typically
 *      leginfo.legislature.ca.gov, nysenate.gov, statutes.capitol.texas.gov,
 *      or the commercial authority hosts Justia/Cornell keep for state law)
 */

import type { IntelligenceSource, Jurisdiction } from '../types';
import type { Applicability, Validator, ValidateOpts, VerificationResult } from './types';
import { stamp } from './types';

interface StateCodeAuthority {
  /** State's own official code host. */
  officialDomains: string[];
  /** Canonical code-label patterns (regex source). */
  codeLabelPatterns: RegExp[];
}

/** Per-state code authorities + canonical label patterns. */
const STATE_AUTHORITIES: Partial<Record<Jurisdiction, StateCodeAuthority>> = {
  CA: {
    officialDomains: ['leginfo.legislature.ca.gov', 'oag.ca.gov'],
    codeLabelPatterns: [/Cal\.\s*(?:Civ|Lab|Bus\.?\s*&\s*Prof|Gov|Pen|Educ|Fin)\.?\s*Code\s*§/i, /\bCCPA\b/, /\bCRA\b/],
  },
  NY: {
    officialDomains: ['nysenate.gov', 'codes.findlaw.com', 'op.nysed.gov'],
    codeLabelPatterns: [
      /N\.?\s*Y\.?\s*(?:Gen\.?\s*Bus|Lab|Exec|Educ|Corp|CPLR|Correct(?:ion)?)\.?\s*Law\s*§?/i,
      /NYC\s+Admin\.\s*Code/i,
      /SHIELD\s+Act/i,
      /Article\s+23[-\s]?A/i,
      /NY\s*Exec(?:utive)?\s*Law/i,
      /NY\s+Educ(?:ation)?(?:\s+Law)?/i,
    ],
  },
  NYC: {
    officialDomains: ['nyc.gov'],
    codeLabelPatterns: [/NYC\s+Admin\.\s*Code\s*§/i, /Fair\s+Chance\s+Act/i],
  },
  IL: {
    officialDomains: ['ilga.gov'],
    codeLabelPatterns: [/\d+\s+ILCS\s+\d+\//i, /\bBIPA\b/, /\bPIPA\b/],
  },
  TX: {
    officialDomains: ['statutes.capitol.texas.gov', 'tdi.texas.gov'],
    codeLabelPatterns: [
      /Tex\.?\s*(?:Bus\.?\s*&\s*Com|Lab(?:or)?|Gov|Ins|Fin|Occ|Health(?:\s+&\s+Safety)?)\.?\s*Code/i,
      /TX\s+(?:Bus(?:iness)?|Labor|Gov|Occ)\s*Code/i,
      /\bHB\s?300\b/i, // Texas medical privacy / HB 300
    ],
  },
  MA: {
    officialDomains: ['malegislature.gov'],
    codeLabelPatterns: [
      /M\.?\s*G\.?\s*L\.?\s*c(?:h(?:apter)?|\.)?\s*\d+/i,
      /Mass\.?\s*Gen\.?\s*Laws/i,
      /\bCORI\b/,
      /Chap(?:ter)?\.?\s*\d+[,\s]/i,
    ],
  },
  OR: {
    officialDomains: ['oregonlegislature.gov'],
    codeLabelPatterns: [/ORS\s*§?\s*\d+/i],
  },
  WA: {
    officialDomains: ['app.leg.wa.gov', 'apps.leg.wa.gov'],
    codeLabelPatterns: [/RCW\s*§?\s*\d+/i],
  },
  NJ: {
    officialDomains: ['njleg.state.nj.us'],
    codeLabelPatterns: [
      /N\.?\s*J\.?\s*S\.?\s*A\.?\s*§?\s*\d+/i,
      /NJ\s+Opportunity\s+to\s+Compete\s+Act/i,
    ],
  },
  MN: {
    officialDomains: ['revisor.mn.gov'],
    codeLabelPatterns: [/Minn\.?\s*Stat\.?\s*§/i, /Minnesota\s+Stat(?:ute)?s?\s+§?\s*\d+/i],
  },
  CO: {
    officialDomains: ['leg.colorado.gov'],
    codeLabelPatterns: [
      /C\.?\s*R\.?\s*S\.?\s*§?\s*\d+/i,
      /Colorado\s+Privacy\s+Act/i,
      /\bCPA\b/,
      /\bWPRA\b/i, // Colorado Wage Protection / Recording Act
      /Colo(?:rado)?\s+(?:Rev|Wage)\.?\s*Stat/i,
    ],
  },
  FL: {
    officialDomains: ['flsenate.gov', 'leg.state.fl.us'],
    codeLabelPatterns: [/Fla\.\s*Stat\.?\s*§?\s*\d+/i],
  },
  GA: {
    officialDomains: ['legis.ga.gov'],
    codeLabelPatterns: [/O\.C\.G\.A\.?\s*§?\s*\d+/i],
  },
  OH: {
    officialDomains: ['codes.ohio.gov', 'ohio.gov'],
    codeLabelPatterns: [/Ohio\s+Rev\.?\s*Code\s*§/i, /ORC\s*§?\s*\d+/i],
  },
  PA: {
    officialDomains: ['legis.state.pa.us'],
    codeLabelPatterns: [/\d+\s*Pa\.?\s*(?:C\.S\.|Code)\.?\s*§/i],
  },
  NV: {
    officialDomains: ['leg.state.nv.us'],
    codeLabelPatterns: [/NRS\s*§?\s*\d+/i],
  },
  HI: {
    officialDomains: ['capitol.hawaii.gov'],
    codeLabelPatterns: [/HRS\s*§?\s*\d+/i],
  },
  MT: {
    officialDomains: ['leg.mt.gov'],
    codeLabelPatterns: [/MCA\s*§?\s*\d+/i],
  },
  NM: {
    officialDomains: ['nmonesource.com', 'nmlegis.gov'],
    codeLabelPatterns: [/NMSA\s*§?\s*\d+/i],
  },
  CT: {
    officialDomains: ['cga.ct.gov'],
    codeLabelPatterns: [/Conn\.\s*Gen\.?\s*Stat\.?\s*§/i],
  },
};

/** State + state-like jurisdiction tags. */
const STATE_JURISDICTIONS = Object.keys(STATE_AUTHORITIES);

function isStateSource(source: IntelligenceSource): boolean {
  return STATE_JURISDICTIONS.includes(source.jurisdiction);
}

function extractSectionNumber(text: string): string | null {
  // Prefer §NNNN.NN(x), fall back to "§ NNN". Strip trailing orphan ")" or
  // "," that can get absorbed by the [\w.()-]+ class when the source label
  // uses parenthesized forms like "§12952)" or "§456.057,".
  const m = text.match(/§\s*([\w.()-]+)/) ?? text.match(/\b(\d{2,6}(?:\.\d{1,4})?(?:\([a-z0-9]+\))?)/);
  let raw = m?.[1] ?? null;
  if (!raw) return null;
  // Drop unbalanced trailing punctuation.
  while (raw.length > 1 && /[),.;:]$/.test(raw)) {
    const opens = (raw.match(/\(/g) ?? []).length;
    const closes = (raw.match(/\)/g) ?? []).length;
    if (raw.endsWith(')') && closes > opens) raw = raw.slice(0, -1);
    else if (/[,.;:]$/.test(raw)) raw = raw.slice(0, -1);
    else break;
  }
  return raw;
}

export const stateStatuteValidator: Validator = {
  kind: 'state-statute',

  isApplicable(source: IntelligenceSource): Applicability {
    if (isStateSource(source)) return { applicable: true };
    return { applicable: false, reason: 'not a state source' };
  },

  async validate(source: IntelligenceSource, opts?: ValidateOpts): Promise<VerificationResult> {
    const problems: string[] = [];
    const fetchedUrls: string[] = [];
    const state = source.jurisdiction;
    const authority = STATE_AUTHORITIES[state as Jurisdiction];

    if (!authority) {
      return {
        sourceId: source.id,
        validator: 'state-statute',
        passed: false,
        hardFail: true,
        notes: `state "${state}" has no authority definition — add one to state-statute-validator.ts before citing`,
        verifiedAt: stamp(opts),
      };
    }

    // 1. Label must match one of the canonical code patterns for this state.
    const matchedPattern = authority.codeLabelPatterns.some((re) => re.test(source.source));
    if (!matchedPattern) {
      problems.push(
        `source label does not match any canonical ${state} code pattern ` +
          `(${authority.codeLabelPatterns.map((r) => r.source).join(', ')})`,
      );
    }

    // 2. Section numbers in the label and quote must agree (when both have one).
    const labelSection = extractSectionNumber(source.source);
    const quoteSection = extractSectionNumber(source.quote);
    if (labelSection && quoteSection && labelSection !== quoteSection) {
      problems.push(
        `section-number mismatch — label references "${labelSection}", quote references "${quoteSection}"`,
      );
    }
    if (!labelSection && !quoteSection) {
      problems.push('no section number detected in label or quote');
    }

    // 3. URL (if present) must be on the state's authority domain or a
    //    recognized legal-authority mirror.
    const fallbackMirrors = ['law.cornell.edu', 'codes.findlaw.com', 'law.justia.com'];
    if (source.url) {
      try {
        const host = new URL(source.url).hostname;
        const onOfficial = authority.officialDomains.some(
          (d) => host === d || host.endsWith('.' + d),
        );
        const onMirror = fallbackMirrors.some((d) => host === d || host.endsWith('.' + d));
        if (!onOfficial && !onMirror) {
          problems.push(
            `url host "${host}" is not on ${state}'s official domains ` +
              `(${authority.officialDomains.join(', ')}) or recognized mirrors`,
          );
        }
        if (opts?.live) {
          const ok = await headOk(source.url);
          fetchedUrls.push(source.url);
          if (!ok) problems.push('live fetch of url failed — HEAD did not return 2xx');
        }
      } catch {
        problems.push(`url "${source.url}" is not a parseable URL`);
      }
    }

    const passed = problems.length === 0;
    return {
      sourceId: source.id,
      validator: 'state-statute',
      passed,
      hardFail: !passed,
      notes: passed ? `passes ${state} state-statute checks` : problems.join('; '),
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
