/**
 * CleMetadataSection (SCRUM-1869 / CLE-R1)
 *
 * Renders structured CLE (Continuing Legal Education) metadata for a credential,
 * on both the authenticated detail view and the public verification view.
 *
 * Mirrors CpeMetadataSection (SCRUM-1857/1858), with CLE-specific shape:
 *  - Total `credit_hours` and `ethics_hours` render on SEPARATE rows. Ethics
 *    hours is a FIRST-CLASS field — never inferred from the total, never
 *    defaulted to 0. When `ethics_hours` is null the worker sets
 *    `requires_manual_review = true` (see cleMetadataView / the worker
 *    CleMetadataSchema), which surfaces the ethics-specific review banner.
 *  - Jurisdiction renders as a US state abbreviation badge.
 *  - Provider approval status renders via {@link CleProviderBadge}.
 *
 * Privacy / disclosure rules (hard requirements):
 *  - Fields are rendered from an EXPLICIT allowlist, never by iterating the raw
 *    metadata object. This guarantees internal fields — most importantly
 *    `extraction_confidence` and `extraction_source` — can never leak into the
 *    rendered output.
 *  - Detail view: the section renders ONLY when the viewer holds the
 *    `credential_source_import` entitlement (passed in read-only by the caller
 *    via {@link useHasCredentialImportEntitlement}). It is a CSI-gated feature.
 *  - Public view: entitlement gating does NOT apply (public verification is
 *    cross-tenant by design — anyone with the link may view), but the same
 *    internal-field redaction applies.
 *
 * All user-visible copy comes from {@link CLE_COMPLIANCE_COPY} (banned-term free
 * per CLAUDE.md §1.3).
 *
 * @see SCRUM-1869, SCRUM-1865
 */

import { AlertTriangle, Scale } from 'lucide-react';
import { getEvidenceLevelLabel } from '@/lib/sourceProvenance';
import { CleProviderBadge } from './CleProviderBadge';
import { CLE_COMPLIANCE_COPY, type CleProviderApprovalStatus } from './cleComplianceCopy';

/**
 * The CLE metadata shape the UI consumes. Mirrors the worker `CleMetadata`
 * (services/worker/src/compliance/professional-education.ts) for the extracted
 * fields, plus the display-only fields the detail/public views derive from the
 * parent anchor (`completion_date`, `evidence_level`).
 *
 * Kept structurally compatible (not a direct import) because the worker type
 * lives outside the frontend tsconfig rootDir and `database.types.ts` is locked.
 */
export interface CleMetadataView {
  credit_hours?: number | null;
  /**
   * Ethics hours — FIRST-CLASS field. Never inferred from `credit_hours`,
   * never defaulted to 0. `null` is a meaningful "not confirmed" signal that
   * forces requires_manual_review upstream.
   */
  ethics_hours?: number | null;
  /** US state abbreviation (e.g. "CA", "NY"), or a `US-XX` code. */
  jurisdiction?: string | null;
  delivery_format?: string | null;
  provider_approval_status?: CleProviderApprovalStatus | null;
  approved_provider_name?: string | null;
  provider_lookup_date?: string | null;
  course_id?: string | null;
  reporting_period_start?: string | null;
  reporting_period_end?: string | null;
  /** Internal extraction signal — MUST NOT be rendered on any surface. */
  extraction_confidence?: number | null;
  /** Internal extraction signal — MUST NOT be rendered on any surface. */
  extraction_source?: string | null;
  requires_manual_review?: boolean;
  // Display-only, derived from the parent anchor:
  course_title?: string | null;
  completion_date?: string | null;
  evidence_level?: string | null;
}

export interface CleMetadataSectionProps {
  /** Parsed `cle_metadata` for the anchor, or null when none is present. */
  cleMetadata?: CleMetadataView | null;
  /**
   * Whether the viewer holds the `credential_source_import` entitlement.
   * Required for the detail view; ignored on the public view. Resolved
   * read-only by the caller (see useHasCredentialImportEntitlement).
   */
  hasImportEntitlement?: boolean;
  /** Render the public-verification variant (no entitlement gate). */
  publicView?: boolean;
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

/** Format a YYYY-MM-DD / ISO date as a UTC human date (no off-by-one). */
function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatCreditHours(hours: number): string {
  // "7" → "7.0 CLE credits" — CLE credits are conventionally shown to 1 decimal.
  return `${hours.toFixed(1)} CLE credits`;
}

function formatEthicsHours(hours: number): string {
  return `${hours.toFixed(1)} ethics credits`;
}

/** Display a US-state jurisdiction as a bare two-letter abbreviation. */
function formatJurisdiction(value: string): string {
  // Worker emits ISO-style `US-CA`; the badge shows just the state abbr ("CA").
  // Federal CLE jurisdictions keep their suffix ("FEDERAL").
  const trimmed = value.trim().toUpperCase();
  return trimmed.startsWith('US-') ? trimmed.slice(3) : trimmed;
}

function formatEvidenceLevel(level: string): string {
  const mapped = getEvidenceLevelLabel(level);
  if (mapped) return mapped;
  // Fallback: humanize an unknown snake_case value.
  return level
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface DisplayRow {
  key: string;
  label: string;
  value: string;
}

export function CleMetadataSection({
  cleMetadata,
  hasImportEntitlement = false,
  publicView = false,
}: Readonly<CleMetadataSectionProps>) {
  // Gate: detail view requires the CSI entitlement; public view never does.
  if (!publicView && !hasImportEntitlement) return null;
  if (!cleMetadata) return null;

  const labels = CLE_COMPLIANCE_COPY.FIELD_LABELS;

  // EXPLICIT allowlist — never iterate the raw object. extraction_confidence
  // and extraction_source are intentionally never read here.
  const rows: DisplayRow[] = [];

  if (isPresent(cleMetadata.approved_provider_name)) {
    rows.push({
      key: 'approved_provider_name',
      label: labels.approved_provider_name,
      value: String(cleMetadata.approved_provider_name),
    });
  }
  // Total credit hours — ALWAYS its own row.
  if (typeof cleMetadata.credit_hours === 'number') {
    rows.push({
      key: 'credit_hours',
      label: labels.credit_hours,
      value: formatCreditHours(cleMetadata.credit_hours),
    });
  }
  // Ethics hours — SEPARATE first-class row. Only rendered when actually a
  // number; null/undefined means "not confirmed" (drives the review banner)
  // and is intentionally NOT shown as 0.
  if (typeof cleMetadata.ethics_hours === 'number') {
    rows.push({
      key: 'ethics_hours',
      label: labels.ethics_hours,
      value: formatEthicsHours(cleMetadata.ethics_hours),
    });
  }
  if (isPresent(cleMetadata.jurisdiction)) {
    rows.push({
      key: 'jurisdiction',
      label: labels.jurisdiction,
      value: formatJurisdiction(String(cleMetadata.jurisdiction)),
    });
  }
  if (isPresent(cleMetadata.delivery_format)) {
    rows.push({
      key: 'delivery_format',
      label: labels.delivery_format,
      value: String(cleMetadata.delivery_format),
    });
  }
  if (isPresent(cleMetadata.completion_date)) {
    rows.push({
      key: 'completion_date',
      label: labels.completion_date,
      value: formatDate(String(cleMetadata.completion_date)),
    });
  }
  if (isPresent(cleMetadata.evidence_level)) {
    rows.push({
      key: 'evidence_level',
      label: labels.evidence_level,
      value: formatEvidenceLevel(String(cleMetadata.evidence_level)),
    });
  }

  const showReviewBanner = cleMetadata.requires_manual_review === true;
  const providerStatus = cleMetadata.provider_approval_status ?? null;

  return (
    <section
      aria-label={CLE_COMPLIANCE_COPY.SECTION_TITLE}
      className="rounded-xl border border-[#3c494e]/20 bg-[#192028] p-4 sm:p-5 space-y-4"
    >
      {/* Header: title + provider approval badge */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-[#00d4ff]" />
          <h3 className="text-sm font-semibold uppercase tracking-widest text-[#dce3ed]">
            {CLE_COMPLIANCE_COPY.SECTION_TITLE}
          </h3>
        </div>
        {providerStatus && <CleProviderBadge status={providerStatus} />}
      </div>

      {/* Course title (prominent) */}
      {isPresent(cleMetadata.course_title) && (
        <p className="text-base font-bold leading-tight text-[#dce3ed] break-words">
          {cleMetadata.course_title}
        </p>
      )}

      {/* Review banner (ethics-specific language) */}
      {showReviewBanner && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p className="text-xs leading-relaxed text-amber-300">
            {CLE_COMPLIANCE_COPY.REVIEW_BANNER}
          </p>
        </div>
      )}

      {/* Field grid */}
      {rows.length > 0 && (
        <dl className="grid gap-3 sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.key} className="rounded-lg bg-[#242b32] px-4 py-3">
              <dt className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-[#859398]">
                {row.label}
              </dt>
              <dd className="text-sm text-[#dce3ed]">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
