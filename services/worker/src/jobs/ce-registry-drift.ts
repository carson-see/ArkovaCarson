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
}

const EMPTY_RESULT: CeRegistryDriftResult = {
  skipped: true, checked: 0, match: 0, drifted: 0, withdrawn: 0, unreachable: 0,
};

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
    return { ...EMPTY_RESULT };
  }

  const limit = clampLimit(options.limit);
  const records = (await deps.loadAnchoredRecords(limit)).slice(0, limit);
  const result: CeRegistryDriftResult = { ...EMPTY_RESULT, skipped: false };

  for (const record of records) {
    const observed = await observeSafely(deps, record);
    const finding = decideCeRegistryDrift(record, observed, deps.now());

    result.checked += 1;
    result[VERDICT_COUNTER[finding.verdict]] += 1;

    // MATCH is the expected steady state; recording every one would bury the
    // findings that matter under noise. Only exceptions are reported.
    if (finding.verdict !== 'MATCH') await reportSafely(deps, finding);
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

async function reportSafely(deps: CeRegistryDriftDeps, finding: CeDriftFinding): Promise<void> {
  try {
    await deps.reportFinding(finding);
  } catch (error) {
    // A reporting failure must not abandon the remaining records.
    logger.error(
      { anchor_id: finding.anchorId, verdict: finding.verdict, error },
      'Failed to record CE registry drift finding',
    );
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
 * Load anchors carrying a CE Registry snapshot. Keyed on the metadata written
 * by the registry-anchor route; an anchor missing either the CTID or the
 * recorded hash is skipped rather than guessed at.
 *
 * ORDERED NEWEST-FIRST DELIBERATELY. There is no index on
 * `metadata->>'ce_registry_ctid'`, and `anchors` is a multi-million-row table,
 * so the planner walks the `created_at` ordering and filters. CE registry
 * anchors are a small, recent cohort, so descending order reaches them almost
 * immediately; ascending order would walk the entire historical table first.
 * If this cohort ever grows large enough to care about oldest-first
 * reconciliation, the right fix is a partial index on the metadata key (a
 * migration, hence out of scope for a flag-dark job) — not a re-ordering here.
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
