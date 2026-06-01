/**
 * CpeMetadataSection (SCRUM-1857 + SCRUM-1858 / CPE-R1-2, CPE-R1-3)
 *
 * Renders structured CPE (Continuing Professional Education) metadata for a
 * credential, on both the authenticated detail view and the public
 * verification view.
 *
 * Privacy / disclosure rules (hard requirements):
 *  - Fields are rendered from an EXPLICIT allowlist, never by iterating the
 *    raw metadata object. This guarantees internal fields — most importantly
 *    `extraction_confidence` and `extraction_source` — can never leak into the
 *    rendered output (SCRUM-1858).
 *  - Detail view: the section renders ONLY when the viewer holds the
 *    `credential_source_import` entitlement (passed in read-only by the caller
 *    via {@link useHasCredentialImportEntitlement}). It is a CSI-gated feature.
 *  - Public view: entitlement gating does NOT apply (public verification is
 *    cross-tenant by design — anyone with the link may view), but the same
 *    internal-field redaction applies.
 *
 * All user-visible copy comes from {@link CPE_COMPLIANCE_COPY} (banned-term
 * free per CLAUDE.md §1.3).
 *
 * @see SCRUM-1847, SCRUM-1857, SCRUM-1858
 */

import { AlertTriangle, GraduationCap } from 'lucide-react';
import { getEvidenceLevelLabel } from '@/lib/sourceProvenance';
import { NasbaStatusBadge } from './NasbaStatusBadge';
import { CPE_COMPLIANCE_COPY, type NasbaStatus } from './cpeComplianceCopy';

/**
 * The CPE metadata shape the UI consumes. Mirrors the worker `CpeMetadata`
 * (services/worker/src/compliance/professional-education.ts) for the extracted
 * fields, plus the display-only fields the detail/public views derive from the
 * parent anchor (`provider`, `title`, `completion_date`, `evidence_level`).
 *
 * Kept structurally compatible (not a direct import) because the worker type
 * lives outside the frontend tsconfig rootDir and `database.types.ts` is locked.
 */
export interface CpeMetadataView {
  credit_hours?: number | null;
  field_of_study?: string | null;
  delivery_method?: string | null;
  nasba_status?: NasbaStatus | null;
  nasba_lookup_date?: string | null;
  sponsor_id?: string | null;
  reporting_period_start?: string | null;
  reporting_period_end?: string | null;
  /** Internal extraction signal — MUST NOT be rendered on any surface. */
  extraction_confidence?: number | null;
  /** Internal extraction signal — MUST NOT be rendered on any surface. */
  extraction_source?: string | null;
  requires_manual_review?: boolean;
  // Display-only, derived from the parent anchor:
  provider?: string | null;
  title?: string | null;
  completion_date?: string | null;
  evidence_level?: string | null;
}

export interface CpeMetadataSectionProps {
  /** Parsed `cpe_metadata` for the anchor, or null when none is present. */
  cpeMetadata?: CpeMetadataView | null;
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

/**
 * Format a YYYY-MM-DD / ISO date as a UTC human date (no off-by-one).
 * Returns null for an unparseable date so the caller can drop the row instead
 * of rendering the literal "Invalid Date" from a malformed upstream blob.
 */
function formatDate(dateStr: string): string | null {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatCreditHours(hours: number): string {
  // "7" → "7.0 CPE credits" — CPE credits are conventionally shown to 1 decimal.
  return `${hours.toFixed(1)} CPE credits`;
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

export function CpeMetadataSection({
  cpeMetadata,
  hasImportEntitlement = false,
  publicView = false,
}: Readonly<CpeMetadataSectionProps>) {
  // Gate: detail view requires the CSI entitlement; public view never does.
  if (!publicView && !hasImportEntitlement) return null;
  if (!cpeMetadata) return null;

  const labels = CPE_COMPLIANCE_COPY.FIELD_LABELS;

  // EXPLICIT allowlist — never iterate the raw object. extraction_confidence
  // and extraction_source are intentionally never read here.
  const rows: DisplayRow[] = [];

  if (isPresent(cpeMetadata.provider)) {
    rows.push({ key: 'provider', label: labels.provider, value: String(cpeMetadata.provider) });
  }
  if (typeof cpeMetadata.credit_hours === 'number') {
    rows.push({
      key: 'credit_hours',
      label: labels.credit_hours,
      value: formatCreditHours(cpeMetadata.credit_hours),
    });
  }
  if (isPresent(cpeMetadata.field_of_study)) {
    rows.push({
      key: 'field_of_study',
      label: labels.field_of_study,
      value: String(cpeMetadata.field_of_study),
    });
  }
  if (isPresent(cpeMetadata.delivery_method)) {
    rows.push({
      key: 'delivery_method',
      label: labels.delivery_method,
      value: String(cpeMetadata.delivery_method),
    });
  }
  if (isPresent(cpeMetadata.completion_date)) {
    // Drop the row entirely on an unparseable date — never surface "Invalid Date".
    const formatted = formatDate(String(cpeMetadata.completion_date));
    if (formatted) {
      rows.push({
        key: 'completion_date',
        label: labels.completion_date,
        value: formatted,
      });
    }
  }
  if (isPresent(cpeMetadata.evidence_level)) {
    rows.push({
      key: 'evidence_level',
      label: labels.evidence_level,
      value: formatEvidenceLevel(String(cpeMetadata.evidence_level)),
    });
  }

  const showReviewBanner = cpeMetadata.requires_manual_review === true;
  const nasbaStatus = cpeMetadata.nasba_status ?? null;

  return (
    <section
      aria-label={CPE_COMPLIANCE_COPY.SECTION_TITLE}
      className="rounded-xl border border-[#3c494e]/20 bg-[#192028] p-4 sm:p-5 space-y-4"
    >
      {/* Header: title + NASBA badge */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <GraduationCap className="h-4 w-4 text-[#00d4ff]" />
          <h3 className="text-sm font-semibold uppercase tracking-widest text-[#dce3ed]">
            {CPE_COMPLIANCE_COPY.SECTION_TITLE}
          </h3>
        </div>
        {nasbaStatus && <NasbaStatusBadge status={nasbaStatus} />}
      </div>

      {/* Course title (prominent) */}
      {isPresent(cpeMetadata.title) && (
        <p className="text-base font-bold leading-tight text-[#dce3ed] break-words">
          {cpeMetadata.title}
        </p>
      )}

      {/* Review banner */}
      {showReviewBanner && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p className="text-xs leading-relaxed text-amber-300">
            {CPE_COMPLIANCE_COPY.REVIEW_BANNER}
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
