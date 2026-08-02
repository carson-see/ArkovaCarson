/**
 * CE Registry drift reconciliation — read-back verification of the CE records
 * we have anchored.
 *
 * WHAT THIS IS FOR. `POST /api/v1/credentials/ctdl/registry-anchor` (L3-A6)
 * anchors a Credential Engine Registry record by fingerprinting the exact bytes
 * we retrieved. That anchor is a claim about a moment in time: "this CTID served
 * exactly these bytes at this instant". Until now nothing ever went back and
 * LOOKED. This job closes that loop: it re-reads each anchored CTID from the
 * PUBLIC registry, re-hashes it, and reports where the registry's current
 * content no longer matches what we anchored.
 *
 * That read-back is the whole product thesis applied to CE's own data — a
 * registry record can be edited, re-published, or withdrawn after the fact, and
 * an anchor is only worth something if somebody can show the difference. It is
 * also the highest-value thing we can prove INSIDE the CE evaluation window,
 * because it needs no CE credential at all: the graph endpoint it reads is
 * public.
 *
 * WHAT THIS IS NOT. This job does not publish, write, or push anything to
 * Credential Engine. It is a strictly read-only consumer, reusing the exact
 * SSRF-hardened fetch primitives already shipped for the import + anchor routes
 * (`fetchRegistryGraph` / `buildRegistryGraphUrl` / `mapSafeFetchError`) — never
 * a second outbound-fetch implementation.
 *
 * §1.6A discipline: retrieved bytes are SHA-256'd in memory and DISCARDED. No
 * finding, audit row, log line, or Sentry event ever carries registry content —
 * only the two hashes, the CTID, and a verdict.
 *
 * R-7 (§1.13) discipline: a verdict is a MEASURED fact about public bytes. It is
 * never an endorsement, never a statement that anything of ours is listed, and
 * never a claim about the correctness of CE's data — only that the bytes at a
 * CTID differ from the bytes we fingerprinted.
 *
 * FLAG: `ENABLE_CE_REGISTRY_DRIFT_CHECK`, default OFF. This introduces new
 * OUTBOUND traffic to a partner's public infrastructure, so it ships dark and is
 * turned on deliberately.
 */

import { createHash } from 'node:crypto';

import { REAL_CTID_PATTERN } from '../ctdl/ctdl-ctid-guard.js';
import {
  DEFAULT_REGISTRY_TIMEOUT_MS,
  RegistryTimeoutError,
  buildRegistryGraphUrl,
  fetchRegistryGraph,
  mapSafeFetchError,
} from '../api/v1/credentials-ctdl-import.js';
import { SafeFetchError, defaultSafeFetchDeps, type SafeFetchDeps } from '../lib/safe-fetch.js';
import { config } from '../config.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

/**
 * Hard ceiling on records reconciled per pass. This job makes one outbound
 * request per record against a PARTNER'S public infrastructure, so the cap is a
 * politeness guarantee as much as a runtime one: a pass can never turn into a
 * burst against Credential Engine no matter what the caller asks for.
 */
export const CE_REGISTRY_DRIFT_MAX_BATCH = 100;

/** Audit event type for a reconciliation finding. */
export const CE_REGISTRY_DRIFT_EVENT_TYPE = 'ce_registry.drift_checked';

export type CeDriftVerdict = 'MATCH' | 'DRIFTED' | 'WITHDRAWN' | 'UNREACHABLE';

/** An anchor that carries a CE Registry snapshot, as stored at anchor time. */
export interface AnchoredCeRecord {
  anchorId: string;
  publicId: string | null;
  orgId: string | null;
  ctid: string;
  /** The envelope SHA-256 recorded when the anchor was created. */
  anchoredSha256: string;
  anchoredAt: string | null;
}

/**
 * What the registry is serving for that CTID right now. Deliberately a closed
 * union: "we could not look" is a first-class outcome, structurally distinct
 * from "we looked and it changed".
 */
export type ObservedRegistryState =
  | { kind: 'fetched'; sha256: string }
  | { kind: 'not_found' }
  | { kind: 'unreachable'; code: string };

export interface CeDriftFinding {
  anchorId: string;
  publicId: string | null;
  orgId: string | null;
  ctid: string;
  verdict: CeDriftVerdict;
  anchoredSha256: string;
  /** Null unless we actually retrieved bytes on this pass. */
  observedSha256: string | null;
  anchoredAt: string | null;
  checkedAt: string;
  detail: string;
}

/**
 * Pure decision function — no I/O, clock-injected, never throws.
 *
 * The one rule that makes this job's output worth anything: a failure to LOOK is
 * never reported as a CHANGE. `UNREACHABLE` and `DRIFTED` are separate verdicts
 * and are counted separately, so a registry outage or a network blip can never
 * be read as "Credential Engine altered a record".
 */
export function decideCeRegistryDrift(
  anchored: AnchoredCeRecord,
  observed: ObservedRegistryState,
  checkedAt: Date,
): CeDriftFinding {
  const base = {
    anchorId: anchored.anchorId,
    publicId: anchored.publicId,
    orgId: anchored.orgId,
    ctid: anchored.ctid,
    anchoredSha256: anchored.anchoredSha256,
    anchoredAt: anchored.anchoredAt,
    checkedAt: checkedAt.toISOString(),
  };

  if (observed.kind === 'unreachable') {
    return {
      ...base,
      verdict: 'UNREACHABLE',
      observedSha256: null,
      detail: `Registry record could not be retrieved (${observed.code}) — NOT evidence of a change.`,
    };
  }

  if (observed.kind === 'not_found') {
    return {
      ...base,
      verdict: 'WITHDRAWN',
      observedSha256: null,
      detail: 'Registry no longer serves a record at this CTID. The anchored snapshot remains valid evidence of what it served at anchor time.',
    };
  }

  // Hex digests are case-insensitive as VALUES; compare normalized, report as
  // stored so the audit trail keeps exactly what each side recorded.
  const matches = observed.sha256.toLowerCase() === anchored.anchoredSha256.toLowerCase();
  return {
    ...base,
    verdict: matches ? 'MATCH' : 'DRIFTED',
    observedSha256: observed.sha256,
    detail: matches
      ? 'Registry content is byte-identical to the anchored snapshot.'
      : 'Registry content changed after the snapshot was anchored.',
  };
}

export interface CeRegistryDriftDeps {
  enabled: boolean;
  now: () => Date;
  loadAnchoredRecords: (limit: number) => Promise<AnchoredCeRecord[]>;
  observeRegistryState: (record: AnchoredCeRecord) => Promise<ObservedRegistryState>;
  reportFinding: (finding: CeDriftFinding) => Promise<void>;
}

export interface CeRegistryDriftResult {
  skipped: boolean;
  checked: number;
  match: number;
  drifted: number;
  withdrawn: number;
  unreachable: number;
  /**
   * The loader returned a full batch, so more anchored records exist than this
   * pass could reconcile. Surfaced because the job's entire value is
   * COMPLETENESS of the read-back: a coverage gap that is invisible is worse
   * than one that is reported. There is no cursor yet — see the module header.
   */
  truncated: boolean;
  /** The load itself failed (e.g. statement timeout). NOT the same as "nothing to check". */
  loadFailed: boolean;
  /**
   * Findings that were decided but could NOT be persisted.
   *
   * `reportSafely` deliberately swallows a reporting failure so one bad insert
   * cannot abandon the remaining records — but swallowing it silently would make
   * a pass that persisted three drift findings and a pass that persisted NONE
   * return byte-identical results, at HTTP 200 either way. That is the same
   * success-indistinguishable-from-nothing shape this job's `loadFailed` field
   * exists to close, one layer down. Counted so it is visible in the result and
   * the summary log line, not only in a stray error log.
   */
  reportFailures: number;
}

const ZERO_COUNTS = {
  checked: 0, match: 0, drifted: 0, withdrawn: 0, unreachable: 0,
  truncated: false, loadFailed: false, reportFailures: 0,
} as const;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return CE_REGISTRY_DRIFT_MAX_BATCH;
  return Math.max(1, Math.min(Math.floor(limit), CE_REGISTRY_DRIFT_MAX_BATCH));
}

type VerdictCounter = 'match' | 'drifted' | 'withdrawn' | 'unreachable';

const VERDICT_COUNTER: Record<CeDriftVerdict, VerdictCounter> = {
  MATCH: 'match',
  DRIFTED: 'drifted',
  WITHDRAWN: 'withdrawn',
  UNREACHABLE: 'unreachable',
};

/**
 * Reconcile a bounded batch of anchored CE records against the live registry.
 *
 * Sequential by design: one partner-facing request at a time, so a pass is a
 * trickle rather than a burst. Per-record failures are isolated — one bad
 * record surfaces as `UNREACHABLE` and the pass continues, because a job that
 * aborts halfway leaves a silently partial picture, which is worse than a
 * complete one containing known gaps.
 */
export async function reconcileCeRegistryDrift(
  deps: CeRegistryDriftDeps,
  options: { limit?: number } = {},
): Promise<CeRegistryDriftResult> {
  if (!deps.enabled) {
    logger.info('CE registry drift check disabled via ENABLE_CE_REGISTRY_DRIFT_CHECK — skipping');
    return { ...ZERO_COUNTS, skipped: true };
  }

  const limit = clampLimit(options.limit);
  const result: CeRegistryDriftResult = { ...ZERO_COUNTS, skipped: false };

  // A failed LOAD must never look like "nothing to reconcile". This folder's
  // agents.md records a 70-hour prod outage whose root cause was exactly that
  // conflation: an all-chunks-failed read was indistinguishable downstream from
  // an empty result, and the silent-success path hid the outage.
  let records: AnchoredCeRecord[];
  try {
    records = await deps.loadAnchoredRecords(limit);
  } catch (error) {
    logger.error({ error }, 'CE registry drift load failed — reconciled NOTHING this pass');
    return { ...result, loadFailed: true };
  }

  // NOTE the direction of error here: `records` is already post-filter (the
  // production loader drops rows whose metadata lacks a usable CTID/digest), so
  // a saturated query whose rows were then filtered reads as NOT truncated.
  // Under-reporting only, and only for malformed metadata — but stated rather
  // than assumed away, because a coverage gap this job cannot see is the one
  // thing it exists to prevent. A cursor (see the module header) retires it.
  result.truncated = records.length >= limit;
  records = records.slice(0, limit);
  if (records.length === 0) {
    logger.warn('CE registry drift pass found no anchored CE records — verify this is expected');
  }

  for (const record of records) {
    const observed = await observeSafely(deps, record);
    const finding = decideCeRegistryDrift(record, observed, deps.now());

    result.checked += 1;
    result[VERDICT_COUNTER[finding.verdict]] += 1;

    // MATCH is the expected steady state; recording every one would bury the
    // findings that matter under noise. Only exceptions are reported.
    if (finding.verdict !== 'MATCH' && !(await reportSafely(deps, finding))) {
      result.reportFailures += 1;
    }
  }

  logger.info({ ...result }, 'CE registry drift reconciliation pass complete');
  return result;
}

async function observeSafely(
  deps: CeRegistryDriftDeps,
  record: AnchoredCeRecord,
): Promise<ObservedRegistryState> {
  try {
    return await deps.observeRegistryState(record);
  } catch (error) {
    // Value-free: the message may be network-layer text, never registry content.
    logger.warn(
      { anchor_id: record.anchorId, error: error instanceof Error ? error.name : 'unknown' },
      'CE registry drift observation failed — recording as UNREACHABLE',
    );
    return { kind: 'unreachable', code: 'observation_failed' };
  }
}

/** @returns true if the finding was persisted, false if it was lost. */
async function reportSafely(deps: CeRegistryDriftDeps, finding: CeDriftFinding): Promise<boolean> {
  try {
    await deps.reportFinding(finding);
    return true;
  } catch (error) {
    // A reporting failure must not abandon the remaining records — but it must
    // not vanish either. The caller counts the `false` into `reportFailures`.
    logger.error(
      { anchor_id: finding.anchorId, verdict: finding.verdict, error },
      'Failed to record CE registry drift finding',
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Production wiring.
// ---------------------------------------------------------------------------

interface AnchorMetadataRow {
  id: string;
  public_id: string | null;
  org_id: string | null;
  metadata: Record<string, unknown> | null;
}

function toAnchoredRecord(row: AnchorMetadataRow, anchoredAt: string | null): AnchoredCeRecord | null {
  const metadata = row.metadata ?? {};
  const ctid = metadata.ce_registry_ctid;
  const sha256 = metadata.ce_envelope_sha256;
  if (typeof ctid !== 'string' || typeof sha256 !== 'string') return null;
  // The CTID is caller-supplied text at the anchor route and is interpolated
  // into the registry URL path. Both sibling callers of `buildRegistryGraphUrl`
  // gate on REAL_CTID_PATTERN before fetching; this one must too, or a crafted
  // value ('../', '?', '#') would steer a SCHEDULED outbound request to an
  // arbitrary path on the registry host long after the original request.
  if (!REAL_CTID_PATTERN.test(ctid)) return null;
  return {
    anchorId: row.id,
    publicId: row.public_id,
    orgId: row.org_id,
    ctid,
    anchoredSha256: sha256,
    anchoredAt,
  };
}

/**
 * Load anchors carrying a CE Registry snapshot.
 *
 * ⚠ REQUIRES A PARTIAL INDEX BEFORE THIS JOB MAY BE ENABLED. There is no index
 * on `metadata->>'ce_registry_ctid'`, and `anchors` is a ~3M-row table.
 *
 * An earlier version of this comment claimed that ordering newest-first let the
 * scan "reach the CE cohort almost immediately". That is WRONG, and the error is
 * worth recording so nobody re-derives it: with `LIMIT 100` and far fewer than
 * 100 matching rows, Postgres CANNOT stop early — it must walk the whole
 * `idx_anchors_active_created` index and heap-fetch (and detoast) `metadata` for
 * every row before it can conclude the limit is unsatisfiable. Scan direction is
 * irrelevant to the total work. This repo has already taken a 14-day prod
 * anchoring outage from exactly this shape hitting the 60s PostgREST
 * `statement_timeout` (see `check-confirmations.ts`).
 *
 * The prerequisite is a partial expression index, following the pattern already
 * in this schema for `pipeline_source`
 * (`0342_cpe_cle_dashboard_partial_index.sql`):
 *
 *   CREATE INDEX CONCURRENTLY idx_anchors_ce_registry_ctid
 *     ON anchors ((metadata->>'ce_registry_ctid'))
 *     WHERE deleted_at IS NULL AND metadata->>'ce_registry_ctid' IS NOT NULL;
 *
 * That is a migration (T3), deliberately out of scope for this flag-dark PR —
 * but it is a HARD PREREQUISITE, not a nice-to-have. Do not set
 * `ENABLE_CE_REGISTRY_DRIFT_CHECK=true` before it exists.
 */
export async function loadAnchoredCeRecords(limit: number): Promise<AnchoredCeRecord[]> {
  const { data, error } = await db
    .from('anchors')
    .select('id, public_id, org_id, metadata, created_at')
    .not('metadata->>ce_registry_ctid', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return ((data ?? []) as unknown as (AnchorMetadataRow & { created_at: string | null })[])
    .map((row) => toAnchoredRecord(row, row.created_at))
    .filter((record): record is AnchoredCeRecord => record !== null);
}

/**
 * Re-read the CTID from the public registry and hash the exact bytes served.
 *
 * §1.6A: the response text is hashed in memory and never returned, logged, or
 * persisted — only the digest leaves this function.
 */
export function createRegistryObserver(
  fetchDeps: SafeFetchDeps = defaultSafeFetchDeps(),
  timeoutMs: number = DEFAULT_REGISTRY_TIMEOUT_MS,
): (record: AnchoredCeRecord) => Promise<ObservedRegistryState> {
  return async (record) => {
    try {
      const fetched = await fetchRegistryGraph(buildRegistryGraphUrl(record.ctid), fetchDeps, timeoutMs);
      if (fetched.status === 404) return { kind: 'not_found' };
      if (fetched.status < 200 || fetched.status >= 300) {
        return { kind: 'unreachable', code: `registry_http_${fetched.status}` };
      }
      return { kind: 'fetched', sha256: createHash('sha256').update(fetched.text, 'utf8').digest('hex') };
    } catch (error) {
      if (error instanceof RegistryTimeoutError) return { kind: 'unreachable', code: 'registry_timeout' };
      if (error instanceof SafeFetchError) {
        return { kind: 'unreachable', code: mapSafeFetchError(error).code };
      }
      return { kind: 'unreachable', code: 'observation_failed' };
    }
  };
}

/**
 * Persist a finding as an audit event. Carries only bounded, already-public
 * values: the CTID, the two digests, and the verdict.
 */
export async function recordCeDriftFinding(finding: CeDriftFinding): Promise<void> {
  const { error } = await db.from('audit_events').insert({
    event_type: CE_REGISTRY_DRIFT_EVENT_TYPE,
    event_category: 'VERIFICATION',
    org_id: finding.orgId,
    target_type: 'anchor',
    target_id: finding.anchorId,
    details: JSON.stringify({
      ce_registry_ctid: finding.ctid,
      verdict: finding.verdict,
      anchored_sha256: finding.anchoredSha256,
      observed_sha256: finding.observedSha256,
      anchored_at: finding.anchoredAt,
      checked_at: finding.checkedAt,
      detail: finding.detail,
    }),
  });
  if (error) throw error;
}

/** Cron entry point. Flag-gated OFF by default. */
export function runCeRegistryDriftCheck(
  options: { limit?: number } = {},
): Promise<CeRegistryDriftResult> {
  return reconcileCeRegistryDrift(
    {
      enabled: config.enableCeRegistryDriftCheck,
      now: () => new Date(),
      loadAnchoredRecords: loadAnchoredCeRecords,
      observeRegistryState: createRegistryObserver(),
      reportFinding: recordCeDriftFinding,
    },
    options,
  );
}
