/**
 * cpeMetadataView (SCRUM-1847 / CPE-R1)
 *
 * Pure helper that converts a raw `cpe_metadata` JSON blob (from the anchor row
 * or the public-verification RPC) into the typed {@link CpeMetadataView} the UI
 * renders, merging in display-only fields derived from the parent anchor
 * (provider / title / completion_date / evidence_level).
 *
 * Defense in depth: this reads an EXPLICIT allowlist of metadata keys. Internal
 * extraction signals — `extraction_confidence` and `extraction_source` — are
 * intentionally NOT copied across, so even if an upstream RPC over-shares, the
 * confidence score can never reach the rendered view (SCRUM-1858). The render
 * component (CpeMetadataSection) applies the same allowlist as a second layer.
 *
 * @see SCRUM-1847, SCRUM-1858
 */

import type { CpeMetadataView } from './CpeMetadataSection';
import type { NasbaStatus } from './cpeComplianceCopy';

const NASBA_STATES: readonly NasbaStatus[] = ['confirmed', 'not_found', 'unknown'];

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Coerce to a finite number, optionally enforcing a minimum. A value below
 * `min` is rejected to `null` — used to reject a non-sensical negative
 * `credit_hours` from a malformed upstream blob (so the UI never renders
 * "-3.0 CPE credits"). Defaults to no lower bound.
 */
function num(value: unknown, min = -Infinity): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min
    ? value
    : null;
}

function nasba(value: unknown): NasbaStatus | null {
  return typeof value === 'string' && (NASBA_STATES as readonly string[]).includes(value)
    ? (value as NasbaStatus)
    : null;
}

export interface CpeDisplayExtras {
  provider?: string | null;
  title?: string | null;
  completion_date?: string | null;
  evidence_level?: string | null;
}

/**
 * Build a {@link CpeMetadataView} from raw metadata + anchor-derived extras.
 * Returns null when there is no CPE metadata to show.
 */
export function extractCpeMetadataView(
  raw: Record<string, unknown> | null | undefined,
  extras: CpeDisplayExtras = {},
): CpeMetadataView | null {
  if (!raw || typeof raw !== 'object') return null;

  const view: CpeMetadataView = {
    // credit_hours must be >= 0 — reject a negative (malformed) value to null so
    // the renderer never shows "-3.0 CPE credits".
    credit_hours: num(raw.credit_hours, 0),
    field_of_study: str(raw.field_of_study),
    delivery_method: str(raw.delivery_method),
    nasba_status: nasba(raw.nasba_status),
    nasba_lookup_date: str(raw.nasba_lookup_date),
    requires_manual_review: raw.requires_manual_review === true,
    // Display-only extras from the anchor (not from the extracted metadata):
    provider: str(extras.provider) ?? str(raw.provider),
    title: str(extras.title) ?? str(raw.title),
    completion_date: str(extras.completion_date) ?? str(raw.completion_date),
    evidence_level: str(extras.evidence_level) ?? str(raw.evidence_level),
    // NOTE: extraction_confidence and extraction_source are deliberately
    // NOT carried across — they are internal-only (SCRUM-1858).
  };

  // If nothing meaningful is present, treat as "no CPE metadata".
  const hasContent =
    view.credit_hours != null ||
    view.field_of_study != null ||
    view.delivery_method != null ||
    view.nasba_status != null ||
    view.title != null ||
    view.provider != null ||
    view.completion_date != null ||
    view.evidence_level != null ||
    view.requires_manual_review === true;

  return hasContent ? view : null;
}
