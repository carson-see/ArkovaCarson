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
 *
 * One value today, an enum by design (mirrors PROOF_AVAILABILITY): a future
 * class (e.g. for retained-bytes uploads) is additive per §1.8. The class is
 * only ever EMITTED when it is measured; absence means "no re-derivability
 * statement", never "re-derivable".
 */
export const FINGERPRINT_REDERIVABILITY = {
  FETCH_TIME_SNAPSHOT: 'fetch_time_snapshot',
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
 */
export function connectorFingerprintRederivabilityFields(): FingerprintRederivabilityFields {
  return {
    fingerprint_rederivability: FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT,
    fingerprint_rederivability_note:
      FINGERPRINT_REDERIVABILITY_NOTE[FINGERPRINT_REDERIVABILITY.FETCH_TIME_SNAPSHOT],
  };
}

/**
 * Does this anchor's metadata prove an actual server-side connector FETCH
 * (§1.6A) produced the fingerprint — the ONLY basis on which a
 * `FETCH_TIME_SNAPSHOT` ("Measured: Arkova computed…") claim is honest?
 *
 * `connector_source` ALONE is NOT sufficient and keying the measurement claim
 * on it was a §1.5 / R-7 over-claim: TWO paths write `connector_source='docusign'`
 * — the server-fetch drain (`jobs/connector-artifact-drain.ts`, §1.6A: fetches
 * + hashes the real bytes → MEASURED) and the declared-hash rules dispatcher
 * (`jobs/rule-action-dispatcher.ts`, which anchors a hash DocuSign DECLARED in
 * the trigger payload and never fetches anything → ASSERTED, see
 * `jobs/docusign-anchor-reconciliation.ts`). Emitting FETCH_TIME_SNAPSHOT for
 * the latter tells a verifier Arkova computed a fingerprint it never computed.
 *
 * The discriminator is `connector_artifact_id`: the drain stamps it on every
 * anchor it materializes from a fetched `connector_artifact` row; the declared-
 * hash dispatcher never does. It is a service_role-only, write-authority-guarded
 * key (mig 0384 / R1 guard family), so a client cannot forge it. Requiring BOTH
 * a recognised fetch marker AND this stamp means the measurement claim rides
 * positive proof of the fetch, not an ambiguous source string.
 *
 * The declared-hash path's OWN honest re-derivability class (`DECLARED_UNVERIFIED`)
 * is tracked separately (SCRUM-3825); until it ships, a declared anchor emits NO
 * re-derivability statement — silence is not a claim (§1.5).
 */
export function isServerFetchedConnectorAnchor(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (resolveConnectorFetchSource(metadata) === null) return false;
  const artifactId = metadata?.connector_artifact_id;
  return typeof artifactId === 'string' && artifactId.length > 0;
}

/**
 * The re-derivability field pair for an anchor's metadata, gated on ACTUAL
 * server-fetch evidence ({@link isServerFetchedConnectorAnchor}). Returns the
 * indivisible class+note pair for a genuinely fetched connector anchor, and an
 * EMPTY object (omit — never null, frozen schema §6/§1.8) for everything else,
 * including the declared-hash rules path. This is the ONE gate every emission
 * site must route through so the "Measured" claim can never outrun the fetch
 * that justifies it.
 */
export function connectorFingerprintRederivabilityFieldsFor(
  metadata: Record<string, unknown> | null | undefined,
): FingerprintRederivabilityFields | Record<string, never> {
  return isServerFetchedConnectorAnchor(metadata)
    ? connectorFingerprintRederivabilityFields()
    : {};
}
