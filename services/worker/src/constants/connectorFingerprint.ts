/**
 * Connector-sourced fingerprint re-derivability — BUG-2026-08-13-010
 * (§1.5 / §1.6A).
 *
 * WHY THIS EXISTS
 *
 * Connector-sourced documents (DocuSign / Google Drive, §1.6A carve-out) are
 * fetched server-side and fingerprinted in memory: fetch → SHA-256 → discard.
 * Proven during the 2026-08 full soak: four fetches of the SAME unchanged
 * DocuSign envelope's `/documents/combined` produced four DIFFERENT SHA-256
 * hashes — the source system re-renders the file on every request. So a
 * connector-sourced fingerprint is a snapshot of the bytes AS FETCHED at that
 * moment; re-fetching the "same" document is NOT expected to reproduce it.
 *
 * That is fine for what the anchor actually attests (the exact fetched bytes
 * existed at that time, committed by the anchor receipt), but §1.5 requires the
 * proof surface to say so: what is measured, what is asserted, and what is NOT
 * asserted. Before this module, nothing told a verifier that a fingerprint
 * mismatch against a freshly re-fetched copy is not, by itself, evidence of
 * tampering — nor that this differs from a client-uploaded document (§1.6),
 * where recomputing the fingerprint of the retained file always reproduces it.
 *
 * WHAT IS MEASURED
 *
 * The classification is keyed on `anchors.metadata->>'connector_source'`, which
 * the two server-side connector materialization paths write
 * (`jobs/connector-artifact-drain.ts`, `jobs/rule-action-dispatcher.ts`) from
 * the `connector_artifact.source` CHECK enum / the rule execution's vendor.
 * Only the closed marker set below is recognised — free text never routes here,
 * and the note never echoes the marker, so a spoofed metadata value can only
 * attach the weakening caveat to the spoofer's own record, never a vendor
 * provenance claim (R-7). NOTE the same honesty boundary that applies to
 * `verification_level` / `source_provider` (SCRUM-2481) applies here: the
 * metadata blob is org-writable on some legacy paths (e.g.
 * `bulk_create_anchors` persists client metadata verbatim), so this marker is
 * "recorded classification", not an independently provable fetch event.
 */

/**
 * The server-written `metadata.connector_source` values that mean "Arkova
 * fetched these bytes from a connected third-party source" (§1.6A).
 *
 * Deliberately EXCLUDES `manual_upload` / `batch_upload` (also legal
 * `connector_artifact.source` values): those bytes were supplied by the user,
 * so their fingerprints ARE reproducible from the user's retained file and the
 * fetch-time caveat would be a false weakening. `connector` is the
 * rule-action-dispatcher's vendor fallback marker — still a server-side
 * connector fetch, just with an unresolved vendor.
 */
export const CONNECTOR_FETCH_SOURCE_MARKERS: ReadonlySet<string> = new Set([
  'docusign',
  'google_drive',
  'microsoft_365',
  'connector',
]);

/**
 * Value-level predicate: is this a recognised connector-fetch marker?
 * A closed set, never free text (the value gates a public §1.5 statement).
 */
export function isConnectorFetchSource(value: unknown): value is string {
  return typeof value === 'string' && CONNECTOR_FETCH_SOURCE_MARKERS.has(value);
}

/**
 * Resolve the connector-fetch marker from an anchor's metadata blob.
 * Returns the marker for recognised server-written values, else null.
 */
export function resolveConnectorFetchSource(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  const value = metadata?.connector_source;
  return isConnectorFetchSource(value) ? value : null;
}

/**
 * Re-derivability class for how a record's fingerprint relates to its source.
 *
 * - `fetch_time_snapshot` — the fingerprint commits the exact bytes retrieved
 *   from a connected third-party source at fetch time. Re-fetching the source
 *   document is NOT expected to reproduce it (source systems may regenerate
 *   the file per request).
 * - `declared_unverified` (docusign-bilateral-2026-08, INBOUND / Recipient
 *   Connect path — flag ENABLE_DOCUSIGN_INBOUND, default false, not going
 *   live this cycle): the fingerprint was NEVER fetched or hashed by Arkova
 *   at all. It is the per-document `sha256` DECLARED on a DocuSign Connect
 *   notification for an envelope Arkova did not send (a different, foreign
 *   DocuSign account owns it) — Arkova cannot call the document-fetch API for
 *   a foreign-owned envelope (DocuSign 26.3 is locking down cross-account
 *   fetch regardless), so there is no bytes-in-hand measurement to make. This
 *   is strictly WEAKER evidence than `fetch_time_snapshot` (which is at least
 *   a real Arkova-side hash of real bytes) and MUST NEVER be confused with it
 *   — conflating the two would let a forged/self-signed "inbound" delivery
 *   read as if Arkova had independently verified the document (the exact R-7
 *   claims-gate failure mode this class exists to prevent).
 *
 * An enum by design (mirrors PROOF_AVAILABILITY): additive per §1.8. A class
 * is only ever EMITTED when it is measured; absence means "no re-derivability
 * statement", never "re-derivable".
 */
export const FINGERPRINT_REDERIVABILITY = {
  FETCH_TIME_SNAPSHOT: 'fetch_time_snapshot',
  DECLARED_UNVERIFIED: 'declared_unverified',
} as const;

export type FingerprintRederivability =
  (typeof FINGERPRINT_REDERIVABILITY)[keyof typeof FINGERPRINT_REDERIVABILITY];

/**
 * The measured / asserted / NOT-asserted statement that accompanies the class
 * (Constitution §1.5). Part of the public API response; written for a
 * developer/relying-party audience (same register as PROOF_AVAILABILITY_NOTE).
 *
 * Two failure modes are both claims problems and both deliberately avoided:
 * the text must never read as "this record is weaker / unverifiable" (the
 * exact fetched bytes ARE committed by the anchor receipt), and it must never
 * name a vendor or echo metadata (the marker is org-writable on legacy paths —
 * a fixed, vendor-neutral statement cannot be turned into a provenance claim).
 *
 * NOTE FOR COUNSEL: drafted by engineering. Reviewed against §1.5 and the R-7
 * claims gate but not yet counsel-reviewed. Rendered verbatim from this one
 * export, so a reword is a single-constant change.
 */
export const FINGERPRINT_REDERIVABILITY_NOTE: Record<FingerprintRederivability, string> = {
  [FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT]:
    'Measured: this record is marked as connector-sourced — Arkova computed its '
    + 'fingerprint from the document bytes retrieved from a third-party document '
    + 'source connected by the securing organization, at the time this record was '
    + 'created (not from a client-side upload). '
    + 'Asserted: the exact bytes retrieved at that time produced this fingerprint, '
    + 'and that fingerprint is committed by the referenced anchor receipt. '
    + 'Not asserted: that retrieving the same document from the source system '
    + 'again will reproduce this fingerprint. Source systems may regenerate the '
    + 'document file on each retrieval, so a freshly retrieved copy can carry a '
    + 'different fingerprint while presenting identical content. A mismatch '
    + 'between this fingerprint and a re-retrieved copy is therefore not, by '
    + 'itself, evidence that this record is invalid or that the document was '
    + 'altered; reproducing this fingerprint requires the exact bytes as '
    + 'originally retrieved. This differs from a client-uploaded document, where '
    + 'recomputing the fingerprint of the same retained file always reproduces it.',
  [FINGERPRINT_REDERIVABILITY.DECLARED_UNVERIFIED]:
    'Measured: nothing — Arkova did NOT retrieve or hash this document. This '
    + 'record originates from a DocuSign notification describing an envelope '
    + 'owned by a different, third-party DocuSign account, not one connected by '
    + 'the securing organization. '
    + 'Asserted: the fingerprint shown is the per-document checksum DocuSign '
    + "declared in that notification — DocuSign's assertion, relayed by Arkova, "
    + 'not a value Arkova independently computed. '
    + 'Not asserted: that this fingerprint was measured from real document bytes '
    + 'by Arkova, that Arkova has ever had access to the underlying document, or '
    + 'that retrieving the document from any source would reproduce this value. '
    + 'This is a materially weaker evidence class than a connector-fetched '
    + 'record (Arkova performs no independent measurement here at all) and must '
    + 'not be read as equivalent to one.',
};

/** The public field pair. Always produced together — see below. */
export interface FingerprintRederivabilityFields {
  fingerprint_rederivability: FingerprintRederivability;
  fingerprint_rederivability_note: string;
}

/**
 * Produce the class AND its note as one indivisible value (same "a class never
 * travels without its meaning" construction as proofAvailabilityFields — a
 * §1.5 statement must not be separable from the class it explains).
 *
 * Callers must gate on `resolveConnectorFetchSource(...)` first; records that
 * did not measure a connector marker must OMIT both fields entirely (never
 * null — frozen schema, CLAUDE.md §6).
 *
 * `rederivabilityClass` defaults to FETCH_TIME_SNAPSHOT — every call site that
 * existed before docusign-bilateral-2026-08 (the introduction of
 * DECLARED_UNVERIFIED) keeps its exact prior behavior unchanged. Pass
 * DECLARED_UNVERIFIED explicitly only for a record resolved via
 * `resolveFingerprintRederivabilityClass` below as the INBOUND declared-hash
 * path (never guess it from anything else — see that function).
 */
export function connectorFingerprintRederivabilityFields(
  rederivabilityClass: FingerprintRederivability = FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT,
): FingerprintRederivabilityFields {
  return {
    fingerprint_rederivability: rederivabilityClass,
    fingerprint_rederivability_note: FINGERPRINT_REDERIVABILITY_NOTE[rederivabilityClass],
  };
}

/**
 * docusign-bilateral-2026-08: resolve WHICH re-derivability class applies,
 * given the same connector-source marker AND the record's own
 * `fingerprint_source` (migration 0376 R19 CHECK enum — already a real,
 * independently-loaded `anchors` column, not something threaded through
 * metadata for this purpose). Only `fingerprint_source ===
 * 'issuer_record_attestation'` on an already-recognised connector-fetch
 * source downgrades the class to DECLARED_UNVERIFIED — that value is set
 * (only) by the connector-artifact drain's inbound declared-hash branch
 * (jobs/connector-artifact-drain.ts `defaultMaterializeAnchor`), itself keyed
 * off the webhook classifier's `_direction: 'inbound'` metadata marker
 * (services/worker/src/api/v1/webhooks/docusign.ts). Every other case
 * (including `document_bytes` or unclassified/null) keeps the existing
 * FETCH_TIME_SNAPSHOT behavior — fail toward the class that claims LESS
 * about what Arkova did only when the inbound marker is unambiguously
 * present, never the reverse.
 *
 * Deliberately NOT keyed off raw `_direction` metadata directly: that would
 * require every call site to load and pass full anchor metadata just for
 * this one check, and — same "re-validate at emission" discipline as
 * `isConnectorFetchSource` itself — `fingerprint_source` is the narrower,
 * already-typed, already-CHECK-constrained value, so re-deriving from it here
 * cannot be widened by an unrelated free-text metadata key.
 *
 * Returns null when `connectorSource` is not a recognised marker (mirrors
 * `resolveConnectorFetchSource` — callers must still gate emission on that).
 */
export function resolveFingerprintRederivabilityClass(
  connectorSource: unknown,
  fingerprintSource: unknown,
): FingerprintRederivability | null {
  if (!isConnectorFetchSource(connectorSource)) return null;
  return fingerprintSource === 'issuer_record_attestation'
    ? FINGERPRINT_REDERIVABILITY.DECLARED_UNVERIFIED
    : FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT;
}
