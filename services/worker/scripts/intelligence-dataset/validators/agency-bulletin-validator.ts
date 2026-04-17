/**
 * NVI-03 — Agency bulletin + enforcement-action validator (SCRUM-807)
 *
 * Covers agency-origin authorities: CFPB bulletins and consent orders, FTC
 * enforcement actions, HHS OCR breach reports, Department of Education /
 * FPCO letters. Each must have:
 *
 *   - a recognizable "issued by <agency>" label
 *   - an issuance identifier (bulletin number, consent-order docket,
 *     press-release date)
 *   - a URL on the issuing agency's own domain
 *
 * Agency URLs are the single most common place a citation has silently
 * broken — agencies reorganize their sites and the old path 404s. Live
 * mode is the teeth here; structural checks alone only catch obvious
 * shape problems.
 */

import type { IntelligenceSource } from '../types';
import type { Applicability, Validator, ValidateOpts, VerificationResult } from './types';
import { stamp } from './types';

interface Agency {
  name: string;
  domains: string[];
  labelPrefixes: string[];
  /** Patterns we expect in the bulletin identifier (regex source). */
  identifiers: RegExp[];
}

const AGENCIES: Agency[] = [
  {
    name: 'CFPB',
    domains: ['consumerfinance.gov'],
    labelPrefixes: ['CFPB', 'Consumer Financial Protection Bureau'],
    identifiers: [/Bulletin\s+\d{4}-\d{1,2}/i, /Consent\s+Order/i, /Compliance\s+Aid/i],
  },
  {
    name: 'FTC',
    domains: ['ftc.gov'],
    labelPrefixes: ['FTC', 'Federal Trade Commission'],
    identifiers: [/Docket\s+No\.?\s+[\w\-/]+/i, /File\s+No\.?\s+\w+/i, /Consent\s+Order/i, /Staff\s+Report/i],
  },
  {
    name: 'HHS OCR',
    domains: ['hhs.gov'],
    labelPrefixes: ['HHS OCR', 'HHS', 'OCR'],
    identifiers: [/Resolution\s+Agreement/i, /Corrective\s+Action\s+Plan/i, /Breach\s+Notification/i, /Transaction\s+No\.?/i],
  },
  {
    name: 'DoE FPCO',
    domains: ['ed.gov', 'studentprivacy.ed.gov'],
    labelPrefixes: ['FPCO', 'Family Policy Compliance Office', 'DoE', 'Department of Education'],
    identifiers: [/Letter\s+to\s+[A-Z]/i, /Dear\s+Colleague/i, /Technical\s+Assistance/i],
  },
  {
    name: 'EEOC',
    domains: ['eeoc.gov'],
    labelPrefixes: ['EEOC', 'Equal Employment Opportunity'],
    identifiers: [/Guidance/i, /Enforcement\s+Guidance/i, /Notice\s+Concerning/i],
  },
];

function matchAgency(source: IntelligenceSource): Agency | null {
  for (const a of AGENCIES) {
    if (a.labelPrefixes.some((p) => source.source.toLowerCase().includes(p.toLowerCase()))) {
      return a;
    }
    if (source.url) {
      try {
        const host = new URL(source.url).hostname;
        if (a.domains.some((d) => host === d || host.endsWith('.' + d))) return a;
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

export const agencyBulletinValidator: Validator = {
  kind: 'agency-bulletin',

  isApplicable(source: IntelligenceSource): Applicability {
    if (matchAgency(source)) return { applicable: true };
    return { applicable: false, reason: 'source is not attributed to a recognized agency' };
  },

  async validate(source: IntelligenceSource, opts?: ValidateOpts): Promise<VerificationResult> {
    const problems: string[] = [];
    const fetchedUrls: string[] = [];

    const agency = matchAgency(source);
    if (!agency) {
      return {
        sourceId: source.id,
        validator: 'agency-bulletin',
        passed: false,
        hardFail: true,
        notes: 'could not identify issuing agency — validator should not have been called',
        verifiedAt: stamp(opts),
      };
    }

    // 1. Bulletin identifier must match one of the agency's expected patterns
    //    (somewhere in the label, quote, or tags).
    const haystack = [source.source, source.quote, source.tags.join(' ')].join(' | ');
    const hasIdentifier = agency.identifiers.some((re) => re.test(haystack));
    if (!hasIdentifier) {
      problems.push(
        `no ${agency.name}-style issuance identifier found — ` +
          `expected one of: ${agency.identifiers.map((r) => r.source).join(', ')}`,
      );
    }

    // 2. URL is STRONGLY preferred. An agency source with no URL is only
    //    acceptable if it carries a concrete issuance identifier (bulletin
    //    number, docket, consent-order name). URL-less sources with no
    //    identifier were almost always hand-transcribed without verification.
    //    We still warn (soft) whenever the URL is absent so NVI dashboards
    //    can flag the backlog of sources needing URL backfill.
    let urlMissingSoft = false;
    if (!source.url) {
      if (!hasIdentifier) {
        problems.push('no url and no issuance identifier — add one or the other');
      } else {
        urlMissingSoft = true;
      }
    } else {
      try {
        const host = new URL(source.url).hostname;
        const onAuthority = agency.domains.some((d) => host === d || host.endsWith('.' + d));
        if (!onAuthority) {
          problems.push(
            `url host "${host}" is not on ${agency.name}'s domain(s) ` +
              `(${agency.domains.join(', ')})`,
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

    // 3. Quote sanity.
    if (source.quote.length < 30) {
      problems.push(`quote too short (${source.quote.length} chars) — agency bulletins should quote substantive text`);
    }

    const passed = problems.length === 0 && !urlMissingSoft;
    // A URL-less source that has a valid issuance identifier is NOT a hard
    // failure — it's in the backlog to backfill, not a training blocker.
    const onlySoftProblem = !passed && problems.length === 0 && urlMissingSoft;
    return {
      sourceId: source.id,
      validator: 'agency-bulletin',
      passed,
      hardFail: !passed && !onlySoftProblem,
      notes: passed
        ? `passes ${agency.name} agency-bulletin checks`
        : (onlySoftProblem
            ? `soft warning: ${agency.name} source has identifier but no url — backfill url when available`
            : problems.join('; ')),
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
