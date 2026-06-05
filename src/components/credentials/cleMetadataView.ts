/**
 * cleMetadataView (SCRUM-1869 / CLE-R1)
 *
 * Pure helper that converts a raw `cle_metadata` JSON blob (from the anchor row
 * or the public-verification RPC) into the typed {@link CleMetadataView} the UI
 * renders, merging in display-only fields derived from the parent anchor
 * (course_title / completion_date / evidence_level).
 *
 * Defense in depth (mirrors cpeMetadataView): this reads an EXPLICIT allowlist
 * of metadata keys. Internal extraction signals — `extraction_confidence` and
 * `extraction_source` — are intentionally NOT copied across, so even if an
 * upstream RPC over-shares, the confidence score can never reach the rendered
 * view. The render component (CleMetadataSection) applies the same allowlist as
 * a second layer.
 *
 * Ethics hours is FIRST-CLASS: a present numeric value is preserved exactly; a
 * missing/null value is preserved as `null` (NEVER defaulted to 0) and forces
 * `requires_manual_review = true` per SCRUM-1869 AC — matching the worker
 * CleMetadataSchema normalization.
 *
 * @see SCRUM-1869
 */

import type { CleMetadataView } from './CleMetadataSection';
import type { CleProviderApprovalStatus } from './cleComplianceCopy';

const PROVIDER_APPROVAL_STATES: readonly CleProviderApprovalStatus[] = [
  'approved',
  'not_approved',
  'unknown',
];

/** US state / DC abbreviations (mirrors worker US_STATE_CODES). */
const US_STATE_CODES: ReadonlySet<string> = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
]);

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function providerStatus(value: unknown): CleProviderApprovalStatus | null {
  return typeof value === 'string'
    && (PROVIDER_APPROVAL_STATES as readonly string[]).includes(value)
    ? (value as CleProviderApprovalStatus)
    : null;
}

/**
 * Validate a jurisdiction as a US state abbreviation. Accepts a bare code
 * ("CA") or the ISO-style `US-CA` form the cross-reference layer emits; returns
 * the bare two-letter code, or null when not a recognized state.
 */
function jurisdiction(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  const bare = trimmed.startsWith('US-') ? trimmed.slice(3) : trimmed;
  return US_STATE_CODES.has(bare) ? bare : null;
}

export interface CleDisplayExtras {
  course_title?: string | null;
  completion_date?: string | null;
  evidence_level?: string | null;
}

/**
 * Build a {@link CleMetadataView} from raw metadata + anchor-derived extras.
 * Returns null when there is no CLE metadata to show.
 */
export function extractCleMetadataView(
  raw: Record<string, unknown> | null | undefined,
  extras: CleDisplayExtras = {},
): CleMetadataView | null {
  if (!raw || typeof raw !== 'object') return null;

  // Ethics hours: first-class. Preserve a present number; otherwise null
  // (never 0). A null/absent value means "not confirmed".
  const ethicsHours = num(raw.ethics_hours);
  const ethicsUnconfirmed = ethicsHours === null;

  const view: CleMetadataView = {
    credit_hours: num(raw.credit_hours),
    ethics_hours: ethicsHours,
    jurisdiction: jurisdiction(raw.jurisdiction),
    delivery_format: str(raw.delivery_format),
    provider_approval_status: providerStatus(raw.provider_approval_status),
    approved_provider_name: str(raw.approved_provider_name),
    provider_lookup_date: str(raw.provider_lookup_date),
    course_id: str(raw.course_id),
    requires_manual_review: false, // set below, once content is established
    // Display-only extras from the anchor (not from the extracted metadata):
    course_title: str(extras.course_title) ?? str(raw.course_title),
    completion_date: str(extras.completion_date) ?? str(raw.completion_date),
    evidence_level: str(extras.evidence_level) ?? str(raw.evidence_level),
    // NOTE: extraction_confidence and extraction_source are deliberately
    // NOT carried across — they are internal-only.
  };

  // Does the blob carry any genuine CLE signal? An explicit worker
  // requires_manual_review flag also counts as content (a flagged-but-empty
  // extraction is still a CLE record that needs review). The ethics-null
  // escalation below does NOT count on its own — otherwise every unrelated
  // object would masquerade as a (review-needed) CLE record.
  const hasContent =
    view.credit_hours != null ||
    view.ethics_hours != null ||
    view.jurisdiction != null ||
    view.delivery_format != null ||
    view.provider_approval_status != null ||
    view.approved_provider_name != null ||
    view.course_title != null ||
    view.completion_date != null ||
    view.evidence_level != null ||
    raw.requires_manual_review === true;

  if (!hasContent) return null;

  // requires_manual_review is true if the worker flagged it OR ethics hours is
  // unconfirmed (SCRUM-1869 AC: null ethics_hours → manual review).
  view.requires_manual_review = raw.requires_manual_review === true || ethicsUnconfirmed;

  return view;
}
