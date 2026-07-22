/**
 * SCRUM-2904 — DocuSign dual-path anchor reconciliation.
 *
 * A single DocuSign envelope can reach the anchor pipeline through TWO
 * independent mechanisms, and left unreconciled they double-anchor / double-
 * charge the same document:
 *
 *   (A) DECLARED-HASH rules path (rule-action-dispatcher.ts — AUTO_ANCHOR /
 *       FAST_TRACK_ANCHOR). A rule fires on an envelope-completed event and
 *       materializes a PENDING anchor from a fingerprint DECLARED in the trigger
 *       payload (a DocuSign Connect webhook field / client-supplied hash). The
 *       document bytes are never fetched — the hash is ASSERTED, not measured.
 *
 *   (B) SERVER-FETCHED connector path (docusign-envelope-completed.ts →
 *       connector-artifact-drain.ts, §1.6A). The connector fetches the signed
 *       document from DocuSign, computes SHA-256 over the ACTUAL bytes in memory
 *       (bytes discarded — never persisted, logged, or sent to Sentry), enqueues
 *       a connector_artifact, and the drain materializes a PENDING anchor.
 *
 * Why unreconciled is a bug:
 *   - declared hash == fetched-bytes hash → the `(user_id, fingerprint)` unique
 *     index dedupes the anchor ROW, but the two paths charge on DIFFERENT credit
 *     reference keys (rules → execution id; drain → anchor id), so the org can be
 *     DOUBLE-DEBITED for one document.
 *   - declared hash != fetched-bytes hash (multi-document envelope, combined-vs-
 *     per-document hash, stale/placeholder declared hash) → the unique index does
 *     NOT collide and TWO DISTINCT anchors are created for one envelope.
 *
 * PRECEDENCE (single source of truth): the SERVER-FETCHED connector path is
 * AUTHORITATIVE. Its fingerprint is MEASURED over the real signed bytes; the
 * declared hash is merely ASSERTED (and can be spoofed, stale, or scoped to a
 * different document set). So whenever connector ingestion is live for a
 * connector-fetch-capable source, the connector path is the sole anchor writer
 * and the declared-hash path DEFERS.
 *
 * The switch requires the connector path to be able to COMPLETE END-TO-END, so
 * it is gated on BOTH flags together:
 *   - `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE` (config.enableConnectorArtifactEnqueue)
 *     — the producer that enqueues the connector_artifact, AND
 *   - `ENABLE_CONNECTOR_ARTIFACT_DRAIN` (config.enableConnectorArtifactDrain)
 *     — the consumer that materializes + anchors it.
 *
 *   - BOTH ON → connector path owns docusign anchoring; declared-hash path defers.
 *   - EITHER OFF → the connector path CANNOT finish (enqueue with no drain would
 *     pile up `pending` rows nothing anchors; drain with no enqueue has nothing to
 *     drain). Deferring into a path that cannot complete = an envelope that
 *     anchors via NEITHER path = silent data loss, which is worse than the double-
 *     anchor we are fixing. So when either flag is off the declared-hash path MUST
 *     remain the writer. Backward-compatible with today's prod (both default OFF).
 *
 * §1.6A: this module makes a routing decision from flags + coarse ids only. It
 * never touches, fetches, hashes, logs, or alerts document bytes; the envelope
 * id and source string it handles are bounded, non-PII identifiers.
 */

/**
 * Sources that expose an authoritative SERVER-FETCH path (the connector fetches
 * the real bytes and measures the fingerprint). DocuSign is the only one today
 * (Google Drive fetch is the same §1.6A carve-out but not yet wired to the
 * rules path). A source NOT in this set has no fetch mechanism, so the declared-
 * hash path is always its only writer.
 */
export const CONNECTOR_FETCH_SOURCES: ReadonlySet<string> = new Set(['docusign']);

/** Normalize a vendor/source string so both paths resolve the same identity. */
function normalizeSource(source: string | null | undefined): string {
  return typeof source === 'string' ? source.trim().toLowerCase() : '';
}

/**
 * Whether `source` has an authoritative server-fetch mechanism (member of
 * CONNECTOR_FETCH_SOURCES). Case/whitespace-insensitive.
 */
export function isConnectorFetchSource(source: string | null | undefined): boolean {
  const normalized = normalizeSource(source);
  return normalized.length > 0 && CONNECTOR_FETCH_SOURCES.has(normalized);
}

export interface ConnectorAuthorityArgs {
  /** The connector/vendor source that produced the declared-hash trigger. */
  source: string | null | undefined;
  /** config.enableConnectorArtifactEnqueue — the producer (fetch + enqueue). */
  enableConnectorArtifactEnqueue: boolean;
  /** config.enableConnectorArtifactDrain — the consumer (materialize + anchor). */
  enableConnectorArtifactDrain: boolean;
}

/**
 * THE precedence decision. Returns true when the server-fetched connector path
 * is the authoritative single writer for this source — i.e. the declared-hash
 * rules path MUST DEFER (create no anchor, move no credit) so one document maps
 * to exactly one anchor produced from the measured-bytes fingerprint.
 *
 * True iff ALL: the source has a server-fetch path AND BOTH connector flags are
 * on (the path can complete end-to-end). If EITHER flag is off the connector
 * path cannot finish, so the declared-hash path stays authoritative (returns
 * false) and remains the only writer — never defer into a dead path (data loss).
 */
export function connectorPathIsAuthoritative(args: ConnectorAuthorityArgs): boolean {
  return (
    args.enableConnectorArtifactEnqueue === true &&
    args.enableConnectorArtifactDrain === true &&
    isConnectorFetchSource(args.source)
  );
}

/**
 * A stable per-envelope reconciliation key (`source:envelopeId`, normalized) so
 * both paths resolve the SAME identity for the same envelope regardless of
 * casing/whitespace. Returns null when there is no envelope id — without an
 * envelope identity there is no cross-path key to reconcile on, and the caller
 * must fall back to the fingerprint-level unique index alone.
 */
export function envelopeReconciliationKey(
  source: string | null | undefined,
  envelopeId: string | null | undefined,
): string | null {
  const normalizedEnvelope = typeof envelopeId === 'string' ? envelopeId.trim() : '';
  if (normalizedEnvelope.length === 0) return null;
  return `${normalizeSource(source)}:${normalizedEnvelope}`;
}

/**
 * The metadata keys under which the two paths persist the DocuSign envelope id:
 *   - declared-hash rules path → `source_envelope_id`
 *   - server-fetched connector path → `envelope_id` and `external_ref`
 * The envelope-level guard matches on ALL of them so a lookup finds an existing
 * anchor regardless of which path created it.
 */
export const ENVELOPE_ID_METADATA_KEYS = [
  'source_envelope_id',
  'envelope_id',
  'external_ref',
] as const;

/** A minimal existing-anchor reference returned by the envelope-level guard. */
export interface ExistingEnvelopeAnchor {
  id: string;
  publicId: string | null;
}

/** The subset of the supabase client the envelope-level guard needs. */
export interface EnvelopeAnchorLookupDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
}

/**
 * Belt-and-suspenders envelope-level idempotency guard (SCRUM-2904 pre-mortem
 * #3). The `(user_id, fingerprint)` unique index only catches the EQUAL-hash
 * collision; it cannot stop the flag-flip-mid-flight race where one path creates
 * an anchor with the declared hash and the other creates a SECOND anchor with a
 * DIFFERENT (measured) hash for the SAME envelope. This look-up finds ANY live
 * anchor already created for `(org_id, envelope_id)` — across either path's
 * metadata key — so the caller can REUSE it instead of inserting a duplicate.
 *
 * Org-scoped, non-deleted, non-revoked. Returns null when there is no envelope
 * id (nothing to reconcile on) or no match, so the caller falls back to its
 * normal insert (still protected by the fingerprint unique index). Never throws
 * document bytes/fingerprints into logs — it reads coarse ids only (§1.6A).
 */
export async function findExistingEnvelopeAnchor(args: {
  db: EnvelopeAnchorLookupDb;
  orgId: string;
  envelopeId: string | null | undefined;
}): Promise<ExistingEnvelopeAnchor | null> {
  const envelopeId = typeof args.envelopeId === 'string' ? args.envelopeId.trim() : '';
  if (envelopeId.length === 0) return null;

  // Defensive: the envelope id is interpolated into a PostgREST `.or()` filter,
  // whose grammar is comma/parenthesis-delimited. A value containing `,` `(` `)`
  // would corrupt the filter (split it into bogus conditions) or worse. DocuSign
  // envelope ids are GUIDs and legitimate external_refs are token-shaped, so
  // restrict to a safe charset and BAIL (return null) on anything else — the
  // caller then falls back to the `(user_id, fingerprint)` unique index alone.
  // Fail-safe, not fail-open: a skipped guard never creates a duplicate, it just
  // forgoes the extra cross-hash protection for an unusual id.
  if (!/^[A-Za-z0-9_.:-]+$/.test(envelopeId)) return null;

  // Build an OR across every metadata key the two paths may have used. Values
  // are JSON-encoded envelope ids (bounded, non-PII connector identifiers).
  const orFilter = ENVELOPE_ID_METADATA_KEYS.map(
    (key) => `metadata->>${key}.eq.${envelopeId}`,
  ).join(',');

  const { data, error } = await args.db
    .from('anchors')
    .select('id, public_id')
    .eq('org_id', args.orgId)
    .is('deleted_at', null)
    .neq('status', 'REVOKED')
    .or(orFilter)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `envelope anchor lookup failed: ${(error as { message?: string }).message ?? 'unknown'}`,
    );
  }
  if (!data) return null;
  const row = data as { id?: unknown; public_id?: unknown };
  if (typeof row.id !== 'string') return null;
  return {
    id: row.id,
    publicId: typeof row.public_id === 'string' ? row.public_id : null,
  };
}
