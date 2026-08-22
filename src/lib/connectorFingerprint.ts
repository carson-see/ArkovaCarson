/**
 * Connector-Sourced Fingerprint Utilities (BUG-2026-08-13-010, §1.5 / §1.6A)
 *
 * Detects whether an anchor was materialized from a connected third-party
 * source (server-side fetch → fingerprint → discard, the §1.6A carve-out).
 * For those records the fingerprint is a snapshot of the bytes AS RETRIEVED
 * at securing time: source systems may regenerate the file on every download,
 * so a fresh download is NOT expected to reproduce the fingerprint. UI keyed
 * on this helper states that caveat (src/lib/copy.ts
 * CONNECTOR_FINGERPRINT_LABELS); client-uploaded documents must never show it
 * — recomputing the fingerprint of the retained file always reproduces it.
 *
 * Mirrors the worker's closed marker set
 * (services/worker/src/constants/connectorFingerprint.ts). Kept structural,
 * not imported across the FE/worker boundary — same convention as
 * src/lib/proofAvailability.ts.
 */

/**
 * Server-written `metadata.connector_source` values that mean "Arkova fetched
 * these bytes from a connected source". Deliberately EXCLUDES
 * `manual_upload` / `batch_upload` (user-supplied bytes — reproducible from
 * the retained file) and matches exact lower-case markers only.
 */
export const CONNECTOR_FETCH_SOURCE_MARKERS: readonly string[] = [
  'docusign',
  'google_drive',
  'microsoft_365',
  'connector',
];

/**
 * True when the anchor's metadata carries a recognised connector-fetch
 * marker. Closed set — free text, case variants, and non-strings never match
 * (the answer keys a §1.5 statement).
 */
export function isConnectorSourcedAnchorMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  const value = metadata?.connector_source;
  return typeof value === 'string' && CONNECTOR_FETCH_SOURCE_MARKERS.includes(value);
}
