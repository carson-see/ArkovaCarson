/**
 * DocuSign signer backfill (record-detail signer rows, follow-on to
 * docusign-bilateral-2026-08 / PR #2474 "outbound signer capture").
 *
 * Existing DocuSign-sourced anchors created BEFORE signer capture shipped
 * carry no `metadata._signers`, so the record-detail UI's signer rows render
 * empty for them. This job enriches those anchors in place: for each PAST
 * envelope, GET the envelope's CURRENT recipients from the DocuSign
 * eSignature REST API and stamp `_signers` (+ `_docusign_env` if absent) onto
 * the anchor's existing metadata — merged, never clobbering any other key
 * (enforced by the deps-layer write, which spreads the existing metadata
 * first; see `docusign-signer-backfill-deps.ts`).
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
 * `metadata._direction === 'inbound'` (docusign-bilateral-2026-08 F1/PR-4 —
 * flag-OFF, staging-only as of this writing, gated by ENABLE_DOCUSIGN_INBOUND
 * default false): an inbound envelope belongs to a FOREIGN DocuSign account
 * the org's OAuth grant does not cover, so calling DocuSign's document/
 * recipients API for it would either be rejected outright or return data the
 * org has no authorization to see, and DocuSign release 26.3
 * (Demo 2026-09-12 / Prod 2026-09-21) is actively locking down cross-account
 * access regardless. Attempting it is BOTH a permissions violation AND a
 * §1.5 provenance violation: an inbound anchor's fingerprint is DECLARED by a
 * third party, never independently fetched/measured by Arkova (see
 * `FINGERPRINT_REDERIVABILITY.DECLARED_UNVERIFIED` in
 * `constants/connectorFingerprint.ts`) — signer identities for it are not
 * ours to go fetch either.
 *
 * {@link isOutboundBackfillCandidate} is the enforcement point: it is checked
 * for EVERY candidate BEFORE any DocuSign API call (`deps.fetchEnvelopeSigners`
 * is the ONLY function in this module that calls out to DocuSign), and it
 * checks TWO INDEPENDENT signals so a bug or omission in one does not
 * silently reopen the boundary:
 *   1. `metadata._direction` — absent or exactly 'outbound' passes; anything
 *      else (in particular 'inbound', or any unexpected value) fails closed.
 *   2. `fingerprintSource` — a REAL, CHECK-constrained `anchors.fingerprint_source`
 *      column (migration 0376/0384), not metadata, so it cannot be forged via
 *      the metadata blob. Anything other than 'issuer_record_attestation'
 *      passes; 'issuer_record_attestation' is the value ONLY the inbound
 *      declared-hash materialization path stamps
 *      (`jobs/connector-artifact-drain.ts`'s `isInboundDeclaredHash` branch) —
 *      an anchor this job may legitimately touch can never carry it.
 * A candidate fails the guard (is treated as inbound, skipped, never fetched)
 * if EITHER signal says so. See the "CRITICAL SAFETY" test block in
 * `docusign-signer-backfill.test.ts` for the test asserting
 * `fetchEnvelopeSigners` is never invoked for such a row.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * RATE LIMITING
 * ═════════════════════════════════════════════════════════════════════════
 * DocuSign's anti-polling policy requires >=15 minutes between polls of the
 * SAME object, and gates sustained polling behind app approval. This job
 * satisfies both by construction, not by a timer:
 *   - It is a ONE-TIME backfill per envelope. Once `_signers` is written, the
 *     deps-layer candidate query's `metadata._signers IS NULL` filter
 *     permanently excludes that anchor from every future run — the field
 *     itself is the watermark, so this job is naturally idempotent/resumable
 *     with no separate run-state to track, and no envelope is EVER polled
 *     twice by this job regardless of how often the cron fires.
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

/** anchors.fingerprint_source value stamped ONLY by the inbound declared-hash
 * materialization path (jobs/connector-artifact-drain.ts). An anchor this job
 * may touch can never legitimately carry it — see the CRITICAL SCOPE
 * BOUNDARY section above. */
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
    metadata: Record<string, unknown> | null;
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
  /** Never fetched or enriched — the critical safety exclusion. */
  anchorsSkippedInbound: number;
  anchorsSkippedNoEnvelopeId: number;
  /** 404/403/410 — purged/no-access/retention. Expected for old envelopes. */
  anchorsSkippedNotFound: number;
  /** The update guard tripped (already enriched, e.g. by a concurrent run) — a no-op, not an error. */
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

      if (signers.length === 0) {
        // Nothing to write. Matches CLAUDE.md §6 (omit rather than persist an
        // empty array) and the live webhook path's own "absent, never []"
        // convention — an envelope can genuinely have zero completed signers
        // captured (e.g. void/decline before any signature).
        await deps.sleep(requestDelayMs);
        continue;
      }

      try {
        const updateResult = await deps.updateAnchorSigners({
          anchorId: candidate.anchorId,
          orgId: candidate.orgId,
          metadata: candidate.metadata,
          signers,
          docusignEnv,
        });
        if (updateResult.updated) {
          result.anchorsUpdated += 1;
        } else {
          // The write-side guard found _signers already present (a concurrent
          // run/webhook won the race) — a no-op, not a failure.
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
