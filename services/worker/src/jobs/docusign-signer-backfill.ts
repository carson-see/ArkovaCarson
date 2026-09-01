/**
 * DocuSign signer backfill (record-detail signer rows, follow-on to
 * signer capture / PR #2474 "outbound signer capture").
 *
 * Existing DocuSign-sourced anchors created BEFORE signer capture shipped
 * carry no `metadata._signers`, so the record-detail UI's signer rows render
 * empty for them. This job enriches those anchors in place: for each PAST
 * envelope, GET the envelope's CURRENT recipients from the DocuSign
 * eSignature REST API and stamp `_signers` (+ `_docusign_env` if absent) onto
 * the anchor's existing metadata — merged, never clobbering any other key.
 * The merge is NOT a plain read-modify-write of the metadata snapshot taken
 * at candidate-SELECT time (see WRITE SAFETY below and
 * `docusign-signer-backfill-deps.ts`'s `updateAnchorSigners`) — that snapshot
 * can be stale by write time, and a naive whole-column overwrite from it
 * would silently revert any OTHER key written concurrently in between.
 *
 * Pure function pattern (all I/O injected via DocusignSignerBackfillDeps) —
 * same shape as `docusign-reconciliation.ts` / `docusign-queue-reconciliation.ts`.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * CRITICAL SCOPE BOUNDARY — OUTBOUND ONLY, NEVER INBOUND
 * ═════════════════════════════════════════════════════════════════════════
 * This job backfills ONLY envelopes owned by the org's OWN connected DocuSign
 * account — anchors whose `metadata._direction` is absent or exactly
 * 'outbound'. It MUST NEVER fetch or enrich an anchor whose
 * `metadata._direction === 'inbound'`: an inbound envelope belongs to a
 * FOREIGN DocuSign account the org's OAuth grant does not cover, so calling
 * DocuSign's document/recipients API for it would either be rejected
 * outright or return data the org has no authorization to see, and DocuSign
 * release 26.3 (Demo 2026-09-12 / Prod 2026-09-21) is actively locking down
 * cross-account access regardless. Attempting it is BOTH a permissions
 * violation AND a §1.5 provenance violation: an inbound anchor's fingerprint
 * is DECLARED by a third party, never independently fetched/measured by
 * Arkova — signer identities for it are not ours to go fetch either. (The
 * inbound classification path that would ever produce such a row is
 * separate, later work and does not ship in this PR; this guard exists so
 * the boundary is already enforced before that path lands on top of this
 * one, not because this branch can currently produce an inbound row.)
 *
 * {@link isOutboundBackfillCandidate} is the enforcement point: it is checked
 * for EVERY candidate BEFORE any DocuSign API call (`deps.fetchEnvelopeSigners`
 * is the ONLY function in this module that calls out to DocuSign), and it
 * checks TWO signals, EITHER of which failing skips the row:
 *   1. `metadata._direction` — absent or exactly 'outbound' passes; anything
 *      else (in particular 'inbound', or any unexpected value) fails closed.
 *   2. `fingerprintSource` — a REAL, CHECK-constrained `anchors.fingerprint_source`
 *      column (migration 0376), not metadata, so it cannot be forged via the
 *      metadata blob. Anything other than 'issuer_record_attestation' passes.
 * These two signals are NOT independent evidence against a shared
 * misclassification bug — an anchor materializer that mis-decides "inbound
 * vs outbound" at creation time would set BOTH from that one wrong decision,
 * so a bug there mis-sets both together, not just one. What checking both
 * DOES independently protect against is POST-CREATION drift/tampering of
 * EITHER signal in isolation: `fingerprint_source` is immutable after insert
 * for non-service_role callers (migration 0384's
 * `enforce_anchor_evidence_claim_authority` trigger refuses any later UPDATE
 * that changes it), while `metadata._direction` is intended to get an
 * equivalent non-service_role write-authority guard from a separate,
 * not-yet-merged DocuSign metadata-key write-authority migration — until
 * that lands, `_direction` alone is metadata and is only as tamper-resistant
 * as whatever wrote it. Either signal alone failing skips the row without
 * ever calling `deps.fetchEnvelopeSigners`; the "CRITICAL SAFETY" test block
 * in `docusign-signer-backfill.test.ts` asserts that function is never
 * invoked for such a row.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WRITE SAFETY — idempotency watermark and concurrent-metadata-write safety
 * ═════════════════════════════════════════════════════════════════════════
 * A completed candidate (whether or not it turned up any signers) is marked
 * durably via `metadata._signers_backfilled_at`, set unconditionally by
 * `updateAnchorSigners` on every successful write. This is a SEPARATE
 * completion marker from `metadata._signers` itself: an envelope that
 * legitimately yields zero usable signers (voided/declined before any
 * signature, or every recipient entry failing GUID-shape validation) must
 * still be marked done, or the deps-layer candidate query — whose ONLY
 * filter used to be `_signers IS NULL` — would re-select and re-fetch that
 * same envelope from DocuSign on every future run forever. `_signers` itself
 * is still omitted (never written as `[]`) when there is nothing to persist,
 * per the "omit rather than persist an empty value" convention the record-
 * detail UI and the live webhook path both already follow.
 *
 * The write itself re-reads the anchor's CURRENT metadata immediately before
 * merging, and writes back with a compare-and-swap on that exact snapshot
 * (`.eq('metadata', <just-read value>)`) rather than the possibly-stale
 * metadata captured back at candidate-SELECT time. This bounds the window in
 * which a concurrent writer to some OTHER metadata key could be silently
 * reverted to roughly one query round trip, instead of up to this run's
 * entire duration (candidates are processed sequentially with a pacing
 * delay between DocuSign calls, so that duration is not negligible). If the
 * CAS loses a race, the update matches zero rows, `updated` comes back
 * `false`, and the row is left for the next run to pick up — a no-op, not a
 * clobber or an error. See `docusign-signer-backfill-deps.ts`.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * RATE LIMITING
 * ═════════════════════════════════════════════════════════════════════════
 * DocuSign's anti-polling policy requires >=15 minutes between polls of the
 * SAME object, and gates sustained polling behind app approval. This job
 * satisfies both by construction, not by a timer:
 *   - It is a ONE-TIME backfill per envelope. Once `_signers_backfilled_at`
 *     is written, the deps-layer candidate query's filter (both
 *     `metadata._signers IS NULL` AND `metadata._signers_backfilled_at IS
 *     NULL`) permanently excludes that anchor from every future run — the
 *     field itself is the watermark, so this job is naturally
 *     idempotent/resumable with no separate run-state to track, and no
 *     envelope is EVER polled twice by this job regardless of how often the
 *     cron fires.
 *   - Requests to DIFFERENT envelopes within one run are made SEQUENTIALLY
 *     (never concurrently), with a conservative fixed delay between them
 *     (`options.requestDelayMs`, default `DEFAULT_BACKFILL_REQUEST_DELAY_MS`
 *     = 300ms) — a courtesy pacing for a bulk historical-scan access pattern
 *     the `/recipients` endpoint has not previously seen at volume from
 *     Arkova, layered ON TOP OF (not instead of) the existing per-account
 *     3,000/hour token-bucket + Retry-After handling in
 *     `createDocusignRateLimitedFetch` (`integrations/oauth/docusign-rate-limit.ts`),
 *     which the production wiring threads through as this job's `fetchImpl`.
 *   - A bounded per-org page size (`options.pageSize`, default
 *     `DEFAULT_BACKFILL_PAGE_SIZE` = 50, hard max `MAX_BACKFILL_PAGE_SIZE` =
 *     200) and an overall per-run cap (`options.runLimit`, default
 *     `DEFAULT_BACKFILL_RUN_LIMIT` = 500, hard max `MAX_BACKFILL_RUN_LIMIT` =
 *     2000) bound one run's total candidate processing regardless of how many
 *     orgs/integrations exist — so one run can never hammer DocuSign.
 *
 * 404/403/410 on the recipients fetch (envelope purged, no access, retention
 * window elapsed) are EXPECTED for old envelopes and are skipped + logged,
 * never failing the run. Any other fetch/update error is recorded per-row and
 * the run continues — one bad row never aborts the whole pass.
 */
import { logger } from '../utils/logger.js';
import { resolveDocusignEnvironment, type DocusignEnvironmentTag } from '../integrations/oauth/docusign.js';
import type { DocusignCapturedSignerT } from '../integrations/connectors/schemas.js';

/** anchors.fingerprint_source value that a (separate, not-yet-merged) inbound
 * declared-hash materialization path is the only intended writer of. An
 * anchor this job may touch can never legitimately carry it — see the
 * CRITICAL SCOPE BOUNDARY section above. */
const INBOUND_FINGERPRINT_SOURCE = 'issuer_record_attestation';

const DEFAULT_BACKFILL_PAGE_SIZE = 50;
const MAX_BACKFILL_PAGE_SIZE = 200;
const DEFAULT_BACKFILL_RUN_LIMIT = 500;
const MAX_BACKFILL_RUN_LIMIT = 2000;
const DEFAULT_BACKFILL_REQUEST_DELAY_MS = 300;

export interface DocusignSignerBackfillIntegration {
  id: string;
  org_id: string;
  account_id: string;
  base_uri: string;
  token_secret_name: string;
}

/**
 * One anchor selected by the deps-layer candidate query, PRIOR to the
 * outbound/inbound safety guard. `metadata`/`fingerprintSource` are both
 * required by {@link isOutboundBackfillCandidate} — never drop either when
 * populating this from a DB row.
 */
export interface DocusignSignerBackfillCandidate {
  anchorId: string;
  orgId: string;
  /** Resolved from one of ENVELOPE_ID_METADATA_KEYS by the deps layer; empty when none present. */
  envelopeId: string;
  /** The anchor's full existing metadata blob — merged, never clobbered, on write. */
  metadata: Record<string, unknown> | null;
  /** anchors.fingerprint_source — second, independently-typed inbound signal. */
  fingerprintSource: string | null;
}

export interface DocusignSignerBackfillDeps {
  listActiveIntegrations(): Promise<DocusignSignerBackfillIntegration[]>;
  getAccessToken(integration: DocusignSignerBackfillIntegration): Promise<string>;
  listCandidateAnchors(args: {
    orgId: string;
    limit: number;
  }): Promise<DocusignSignerBackfillCandidate[]>;
  /** The ONLY function in this job that calls the DocuSign API. */
  fetchEnvelopeSigners(args: {
    baseUri: string;
    accountId: string;
    envelopeId: string;
    accessToken: string;
  }): Promise<DocusignCapturedSignerT[]>;
  updateAnchorSigners(args: {
    anchorId: string;
    orgId: string;
    /**
     * The candidate-SELECT-time metadata snapshot. Informational for the
     * caller/tests only — the production implementation
     * (`docusign-signer-backfill-deps.ts`) deliberately does NOT use this as
     * its merge base, since it can be stale by write time; it re-reads the
     * anchor's current metadata immediately before merging instead. See the
     * WRITE SAFETY section above.
     */
    metadata: Record<string, unknown> | null;
    /** May be empty — a legitimately signer-less envelope still gets marked done (see WRITE SAFETY). `_signers` itself is only ever persisted when non-empty. */
    signers: DocusignCapturedSignerT[];
    docusignEnv: DocusignEnvironmentTag;
  }): Promise<{ updated: boolean }>;
  sleep(ms: number): Promise<void>;
}

export interface DocusignSignerBackfillOptions {
  /** Max candidate anchors selected PER integration/org per run. Default 50, hard max 200. */
  pageSize?: number;
  /** Max anchors processed across ALL integrations in one run. Default 500, hard max 2000. */
  runLimit?: number;
  /** Delay (ms) between per-envelope DocuSign API calls within a run. Default 300. */
  requestDelayMs?: number;
}

export interface DocusignSignerBackfillResult {
  ok: boolean;
  integrationsChecked: number;
  anchorsScanned: number;
  anchorsUpdated: number;
  /**
   * Fetched successfully but yielded ZERO usable signers (voided/declined
   * before any signature, or every recipient entry failed GUID-shape
   * validation) — `_signers` is deliberately never written as `[]`, but the
   * anchor IS durably marked done via `_signers_backfilled_at` so it is not
   * re-fetched from DocuSign on every future run. See the WRITE SAFETY
   * section in the file header.
   */
  anchorsMarkedNoSigners: number;
  /** Never fetched or enriched — the critical safety exclusion. */
  anchorsSkippedInbound: number;
  anchorsSkippedNoEnvelopeId: number;
  /** 404/403/410 — purged/no-access/retention. Expected for old envelopes. */
  anchorsSkippedNotFound: number;
  /** The write-side CAS guard found the row already completed or concurrently changed (e.g. by another run) — a no-op, not an error. */
  anchorsAlreadyEnriched: number;
  errors: Array<{ anchor_id?: string; integration_id?: string; error: string }>;
}

/**
 * THE enforcement point for the critical scope boundary. Checked for EVERY
 * candidate before any DocuSign API call. Fails closed: only an explicit
 * 'outbound' or absent `_direction`, AND a `fingerprintSource` that is not
 * the inbound-declared-hash marker, together pass.
 */
export function isOutboundBackfillCandidate(
  candidate: Pick<DocusignSignerBackfillCandidate, 'metadata' | 'fingerprintSource'>,
): boolean {
  const metadata = candidate.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : null;
  const direction = metadata ? metadata['_direction'] : undefined;
  const directionOk = direction === undefined || direction === null || direction === 'outbound';
  const fingerprintOk = candidate.fingerprintSource !== INBOUND_FINGERPRINT_SOURCE;
  return directionOk && fingerprintOk;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function docusignErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), max);
}

const EMPTY_RESULT: DocusignSignerBackfillResult = {
  ok: true,
  integrationsChecked: 0,
  anchorsScanned: 0,
  anchorsUpdated: 0,
  anchorsMarkedNoSigners: 0,
  anchorsSkippedInbound: 0,
  anchorsSkippedNoEnvelopeId: 0,
  anchorsSkippedNotFound: 0,
  anchorsAlreadyEnriched: 0,
  errors: [],
};

export async function runDocusignSignerBackfill(
  deps: DocusignSignerBackfillDeps,
  options: DocusignSignerBackfillOptions = {},
): Promise<DocusignSignerBackfillResult> {
  const pageSize = clampInt(options.pageSize, DEFAULT_BACKFILL_PAGE_SIZE, MAX_BACKFILL_PAGE_SIZE);
  const runLimit = clampInt(options.runLimit, DEFAULT_BACKFILL_RUN_LIMIT, MAX_BACKFILL_RUN_LIMIT);
  const requestDelayMs = options.requestDelayMs ?? DEFAULT_BACKFILL_REQUEST_DELAY_MS;

  const result: DocusignSignerBackfillResult = { ...EMPTY_RESULT, errors: [] };

  let integrations: DocusignSignerBackfillIntegration[];
  try {
    integrations = await deps.listActiveIntegrations();
  } catch (err) {
    const msg = errMsg(err);
    logger.error({ error: msg }, 'DocuSign signer backfill: failed to list active integrations');
    return { ...result, ok: false, errors: [{ error: `list_integrations: ${msg}` }] };
  }

  let processedThisRun = 0;

  for (const integration of integrations) {
    if (processedThisRun >= runLimit) break;
    result.integrationsChecked += 1;

    let accessToken: string;
    try {
      accessToken = await deps.getAccessToken(integration);
    } catch (err) {
      const msg = errMsg(err);
      logger.error(
        { integrationId: integration.id, error: msg },
        'DocuSign signer backfill: token refresh failed — skipping this integration',
      );
      result.errors.push({ integration_id: integration.id, error: `token_refresh: ${msg}` });
      result.ok = false;
      continue;
    }

    const remainingBudget = runLimit - processedThisRun;
    if (remainingBudget <= 0) break;
    const limit = Math.min(pageSize, remainingBudget);

    let candidates: DocusignSignerBackfillCandidate[];
    try {
      candidates = await deps.listCandidateAnchors({ orgId: integration.org_id, limit });
    } catch (err) {
      const msg = errMsg(err);
      logger.error(
        { integrationId: integration.id, error: msg },
        'DocuSign signer backfill: candidate scan failed',
      );
      result.errors.push({ integration_id: integration.id, error: `candidate_scan: ${msg}` });
      result.ok = false;
      continue;
    }

    result.anchorsScanned += candidates.length;

    // Derived ONCE per integration from its own resolved base_uri — matches
    // processDocusignEnvelopeCompletedJob's R7 convention (never trust
    // anything asserted by metadata for this).
    const docusignEnv = resolveDocusignEnvironment(integration.base_uri);

    for (const candidate of candidates) {
      if (processedThisRun >= runLimit) break;
      processedThisRun += 1;

      // ═══ CRITICAL SAFETY GATE — checked before ANYTHING else touches this
      // candidate. See the CRITICAL SCOPE BOUNDARY section in the file header. ═══
      if (!isOutboundBackfillCandidate(candidate)) {
        result.anchorsSkippedInbound += 1;
        logger.warn(
          { anchorId: candidate.anchorId, orgId: candidate.orgId },
          'DocuSign signer backfill: skipped an INBOUND-classified anchor — never fetched or enriched (out of scope by design, never a bug to "fix")',
        );
        continue;
      }

      if (!candidate.envelopeId) {
        result.anchorsSkippedNoEnvelopeId += 1;
        continue;
      }

      let signers: DocusignCapturedSignerT[];
      try {
        signers = await deps.fetchEnvelopeSigners({
          baseUri: integration.base_uri,
          accountId: integration.account_id,
          envelopeId: candidate.envelopeId,
          accessToken,
        });
      } catch (err) {
        const status = docusignErrorStatus(err);
        if (status === 404 || status === 403 || status === 410) {
          result.anchorsSkippedNotFound += 1;
          logger.info(
            { anchorId: candidate.anchorId, envelopeId: candidate.envelopeId, status },
            'DocuSign signer backfill: envelope not found/no access/purged — skipping (expected for old envelopes)',
          );
        } else {
          const msg = errMsg(err);
          logger.error(
            { anchorId: candidate.anchorId, envelopeId: candidate.envelopeId, error: msg },
            'DocuSign signer backfill: recipients fetch failed',
          );
          result.errors.push({ anchor_id: candidate.anchorId, error: msg });
          result.ok = false;
        }
        await deps.sleep(requestDelayMs);
        continue;
      }

      // `signers` may legitimately be empty (void/decline before any
      // signature, or every recipient entry failed GUID-shape validation).
      // updateAnchorSigners is called EITHER WAY: `_signers` itself is still
      // never persisted as `[]` (CLAUDE.md §6 — omit rather than persist an
      // empty value, matching the live webhook path's own "absent, never []"
      // convention), but the completion watermark
      // (`metadata._signers_backfilled_at`) MUST be written regardless of
      // whether any signers were found — otherwise a zero-signer envelope has
      // no completion marker at all and `listCandidateAnchors` (whose ONLY
      // filter used to be `_signers IS NULL`) re-selects and re-fetches it
      // from DocuSign every single future run, forever. See the WRITE SAFETY
      // section in the file header.
      try {
        const updateResult = await deps.updateAnchorSigners({
          anchorId: candidate.anchorId,
          orgId: candidate.orgId,
          metadata: candidate.metadata,
          signers,
          docusignEnv,
        });
        if (updateResult.updated) {
          if (signers.length > 0) {
            result.anchorsUpdated += 1;
          } else {
            result.anchorsMarkedNoSigners += 1;
          }
        } else {
          // The write-side CAS guard found the row already completed, or lost
          // a race against a concurrent metadata write (a concurrent
          // run/webhook, or an unrelated writer) — a no-op, not a failure.
          // The row stays a candidate (if not yet marked done) and is picked
          // up again on the next run.
          result.anchorsAlreadyEnriched += 1;
        }
      } catch (err) {
        const msg = errMsg(err);
        logger.error(
          { anchorId: candidate.anchorId, error: msg },
          'DocuSign signer backfill: anchor metadata update failed',
        );
        result.errors.push({ anchor_id: candidate.anchorId, error: msg });
        result.ok = false;
      }

      await deps.sleep(requestDelayMs);
    }
  }

  logger.info(
    {
      integrationsChecked: result.integrationsChecked,
      anchorsScanned: result.anchorsScanned,
      anchorsUpdated: result.anchorsUpdated,
      anchorsMarkedNoSigners: result.anchorsMarkedNoSigners,
      anchorsSkippedInbound: result.anchorsSkippedInbound,
      anchorsSkippedNoEnvelopeId: result.anchorsSkippedNoEnvelopeId,
      anchorsSkippedNotFound: result.anchorsSkippedNotFound,
      anchorsAlreadyEnriched: result.anchorsAlreadyEnriched,
      errorCount: result.errors.length,
    },
    'DocuSign signer backfill run complete',
  );

  return result;
}
