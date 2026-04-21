/**
 * EDGAR Form ADV Parser — NPH-15 / SCRUM-727 alternative data source.
 *
 * The SEC IAPD API (`api.adviserinfo.sec.gov`) now returns 403 on all
 * endpoints (WAF protection, confirmed 2026-04-14). Form ADV filings are
 * still reachable via EDGAR, which doesn't sit behind the same WAF.
 *
 * Investment advisers file Form ADV with the SEC; each firm has a CIK on
 * EDGAR and filings of form type `ADV`, `ADV/A`, `ADV-W`, `ADV-E`, or
 * `ADV-NR`. This module is the pure parser layer — turns the structured
 * EDGAR submission JSON into the same `IapdAdviser` shape our existing
 * `public_records` pipeline already knows how to anchor.
 *
 * Network I/O, rate-limit sequencing, and cron wiring live in the
 * companion fetcher (follow-up). Keeping the parser pure means we can
 * TDD against stable fixtures and swap the upstream source later without
 * touching pipeline code.
 */

/** Form types on EDGAR that correspond to investment adviser registration. */
export const FORM_ADV_TYPES = ['ADV', 'ADV/A', 'ADV-W', 'ADV-E', 'ADV-NR'] as const;
export type FormAdvType = (typeof FORM_ADV_TYPES)[number];

/** SIC code for "Investment Advice" services on EDGAR. */
export const SIC_INVESTMENT_ADVICE = '6282';

/**
 * Normalised investment-adviser record — matches the shape the existing
 * `secIapdFetcher` writes into `public_records`, so downstream anchoring
 * remains unchanged regardless of which upstream surfaced the data.
 */
export interface FormAdvAdviser {
  /** SEC CRD number when available, EDGAR CIK otherwise (always unique). */
  crdNumber: string;
  /** Legal firm name from the most recent ADV filing. */
  organizationName: string;
  /** SEC File Number (e.g. "801-12345") when parseable from ADV. */
  secNumber?: string;
  city?: string;
  state?: string;
  country?: string;
  /** Normalised to one of: `Approved`, `Terminated`, `Pending`, `Unknown`. */
  registrationStatus: 'Approved' | 'Terminated' | 'Pending' | 'Unknown';
  /** ISO date of the latest ADV filing observed. */
  lastFilingDate?: string;
  /** EDGAR submissions URL for the firm (stable; safe to anchor). */
  sourceUrl: string;
}

/**
 * Subset of the EDGAR submissions endpoint response we rely on.
 *
 * Reference: `https://data.sec.gov/submissions/CIK{10-digit-zero-padded}.json`.
 * EDGAR returns a large envelope; only the fields used below are typed.
 */
export interface EdgarSubmissionEnvelope {
  cik: string;
  name: string;
  sicDescription?: string;
  sic?: string;
  addresses?: {
    mailing?: { city?: string; stateOrCountry?: string; stateOrCountryDescription?: string };
    business?: { city?: string; stateOrCountry?: string; stateOrCountryDescription?: string };
  };
  filings?: {
    recent?: {
      form?: string[];
      filingDate?: string[];
      accessionNumber?: string[];
      primaryDocDescription?: string[];
    };
  };
  /** Optional — when EDGAR embeds the IARD CRD in `formerNames` or a custom field. */
  crdNumber?: string;
}

/** Is this EDGAR submission from an investment adviser? */
export function isInvestmentAdviser(envelope: EdgarSubmissionEnvelope): boolean {
  if (envelope.sic === SIC_INVESTMENT_ADVICE) return true;
  const forms = envelope.filings?.recent?.form ?? [];
  return forms.some((f) => (FORM_ADV_TYPES as readonly string[]).includes(f));
}

/**
 * Returns the most recent ADV-family filing in the submission envelope,
 * or `null` when the firm has never filed ADV.
 */
export function mostRecentAdvFiling(
  envelope: EdgarSubmissionEnvelope,
): { form: FormAdvType; filingDate: string; accessionNumber: string } | null {
  const recent = envelope.filings?.recent;
  const forms = recent?.form ?? [];
  const dates = recent?.filingDate ?? [];
  const accessions = recent?.accessionNumber ?? [];

  let bestIdx = -1;
  let bestDate = '';
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    if (!(FORM_ADV_TYPES as readonly string[]).includes(form)) continue;
    const date = dates[i] ?? '';
    if (date > bestDate) {
      bestDate = date;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  return {
    form: forms[bestIdx] as FormAdvType,
    filingDate: dates[bestIdx],
    accessionNumber: accessions[bestIdx],
  };
}

/**
 * Map the latest ADV form type to a registration status bucket.
 *
 * `ADV-W` = notice of withdrawal → Terminated.
 * Everything else (ADV / ADV-E / ADV-NR / ADV/A) → Approved.
 *
 * The real IAPD API would give us a stronger signal (`Approved`,
 * `Pending`, `Under Review`, etc.); EDGAR submissions only reveal the
 * filing history, so we conservatively bucket the outcome from the form
 * type and let anchoring carry the raw evidence.
 */
export function registrationStatusFromLatestForm(form: FormAdvType): FormAdvAdviser['registrationStatus'] {
  if (form === 'ADV-W') return 'Terminated';
  if (form === 'ADV-E' || form === 'ADV-NR') return 'Pending';
  return 'Approved';
}

/**
 * Pad a numeric CIK to the 10-digit zero-padded form EDGAR URLs use.
 * Accepts either the numeric string ("320193") or already-padded form.
 */
export function padCik(cik: string): string {
  const digits = cik.replace(/[^0-9]/g, '');
  return digits.padStart(10, '0');
}

/**
 * Canonical EDGAR submissions URL for a firm, safe for anchoring.
 */
export function edgarSubmissionsUrl(cik: string): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${padCik(cik)}&type=ADV&dateb=&owner=include&count=40`;
}

/**
 * Turn an EDGAR submission envelope into the normalised adviser record.
 * Returns `null` when the firm is not an investment adviser — lets
 * callers `.map(...).filter(Boolean)` without catching.
 */
export function parseEdgarSubmission(envelope: EdgarSubmissionEnvelope): FormAdvAdviser | null {
  if (!isInvestmentAdviser(envelope)) return null;

  const latest = mostRecentAdvFiling(envelope);
  const biz = envelope.addresses?.business ?? envelope.addresses?.mailing;

  return {
    crdNumber: envelope.crdNumber ?? padCik(envelope.cik),
    organizationName: envelope.name,
    city: biz?.city,
    state: biz?.stateOrCountry,
    country: biz?.stateOrCountryDescription,
    registrationStatus: latest ? registrationStatusFromLatestForm(latest.form) : 'Unknown',
    lastFilingDate: latest?.filingDate,
    sourceUrl: edgarSubmissionsUrl(envelope.cik),
  };
}

/**
 * Deduplicate a batch of advisers by CRD number, keeping the record with
 * the most recent `lastFilingDate`. EDGAR pagination occasionally
 * surfaces the same firm twice across different SIC searches — this
 * stops both copies from racing into `public_records`.
 */
export function dedupeAdvisers(advisers: readonly FormAdvAdviser[]): FormAdvAdviser[] {
  const byCrd = new Map<string, FormAdvAdviser>();
  for (const a of advisers) {
    const prev = byCrd.get(a.crdNumber);
    if (!prev) {
      byCrd.set(a.crdNumber, a);
      continue;
    }
    const prevDate = prev.lastFilingDate ?? '';
    const nextDate = a.lastFilingDate ?? '';
    if (nextDate > prevDate) byCrd.set(a.crdNumber, a);
  }
  return [...byCrd.values()];
}
