/**
 * Public-record ingestion response contract — BUG-020 / BUG-021.
 *
 * ## Why this exists
 *
 * The 2026-08 side-rig cron run (`docs/staging/fullsoak-2026-08/side-rig-cron-coverage.md`)
 * force-ran 42 previously-untested ingestion routes and found that the WHOLE
 * FAMILY reports failure as HTTP 200:
 *
 *     /fetch-ipeds     200  {"inserted":0,"errors":30}
 *     /fetch-fcc       200  {"inserted":0,"errors":26}
 *     /fetch-sec-iapd  200  {"inserted":0,"errors":26}
 *     /fetch-uspto     200  {"status":"download_failed","inserted":0,"errors":0}
 *
 * Each fetcher catches its own transport failure, increments an internal
 * counter, and hands the route a resolved promise — so the route's
 * `try { res.json(result) } catch { 500 }` shape can only ever 500 on a THROW.
 * A Cloud Scheduler job bound to any of these is green forever, and no
 * HTTP-status monitor can tell a healthy run from total failure.
 *
 * A second, independent trap (FD-S1): on a fresh environment `switchboard_flags`
 * held one unrelated row, so `get_flag('ENABLE_PUBLIC_RECORDS_INGESTION')`
 * returned the SQL function's `p_default` (false) and every fetcher no-opped
 * while returning `200 {"inserted":0,"skipped":0,"errors":0}` — indistinguishable
 * from a healthy run with nothing new upstream. A blind exerciser scores 100%
 * false coverage against that state.
 *
 * ## The contract
 *
 * | condition                                  | HTTP | `ingestion_status`    |
 * |--------------------------------------------|------|-----------------------|
 * | flag row ABSENT (misconfiguration)         | 503  | `flag_not_configured` |
 * | switchboard unreadable                     | 503  | `flag_unreadable`     |
 * | flag row present and false (deliberate)    | 200  | `disabled`            |
 * | no item failed                             | 200  | *(body verbatim)*     |
 * | some items landed, some failed             | 207  | `partial_failure`     |
 * | NOTHING landed and something failed        | 502  | `total_failure`       |
 *
 * Rationale for each choice:
 *
 * - **502, not 500, for total failure.** These runs fail because a third-party
 *   registry rejected us (403/404/429/422), not because the worker is broken.
 *   502 Bad Gateway says "the upstream dependency failed" to a human reading a
 *   log line, and is still non-2xx so Cloud Scheduler retries and alerts.
 * - **207, not 200, for partial.** 207 is still 2xx, so Scheduler treats a run
 *   that made real progress as a success and does not retry-storm a
 *   half-ingested page — but the code and body both say the run was not clean.
 * - **200 for a deliberate `disabled`,** because an operator-flipped kill switch
 *   is a correct outcome, not an incident. It is now EXPLICIT in the body
 *   (`ingestion_status: "disabled"`) instead of an all-zeros counter payload.
 * - **503 for an absent flag row,** because "nobody ever configured this
 *   environment" is a misconfiguration, and silently no-opping it is exactly
 *   the FD-S1 false-coverage trap. `Retry-After` is set so a scheduler backs off
 *   rather than hammering.
 * - **A clean run is passed through byte-for-byte** — no envelope, no added
 *   keys. Only a non-clean outcome annotates the body, so existing consumers of
 *   a healthy response are untouched.
 *
 * ## BUG-021 — why the flag state is read here and not via `get_flag()`
 *
 * `get_flag(p_flag_key, p_default boolean DEFAULT false)` collapses "row absent"
 * into `p_default`, so its boolean return CANNOT distinguish "not configured"
 * from "explicitly off". That is fine — even correct — for the fail-closed
 * gates (`middleware/featureGate.ts`, `middleware/partnerProvisioningGate.ts`),
 * which want absent to mean off. It is NOT fine for a caller that must react
 * differently to the two, so this module reads `switchboard_flags` directly
 * (service-role client, RLS-exempt) and returns a three-state answer.
 *
 * Callers that only need a fail direction should keep using `get_flag` — and
 * per CTO ruling the Arkova posture is fail-CLOSED on an absent row: every gate
 * (including `services/edge/src/mcp-kill-switch.ts`) keeps the `false` default,
 * so a fresh, never-seeded switchboard leaves the surface dark until an
 * operator seeds the flag row.
 */

import type { Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';
import { isIngestionFailureStatus } from '../utils/pipeline.js';

/** Default switchboard flag gating the public-record ingestion family. */
export const INGESTION_FLAG_KEY = 'ENABLE_PUBLIC_RECORDS_INGESTION';

/** Seconds advertised in `Retry-After` when a run is refused on flag state. */
const FLAG_RETRY_AFTER_SECONDS = 300;

export type IngestionStatus =
  | 'ok'
  | 'partial_failure'
  | 'total_failure'
  | 'disabled'
  | 'flag_not_configured'
  | 'flag_unreadable';

export type IngestionFlagState = 'enabled' | 'disabled' | 'not_configured' | 'unreadable';

export interface IngestionTally {
  inserted: number;
  skipped: number;
  errors: number;
  /** False when the payload carried none of the counters this module knows. */
  recognized: boolean;
}

const INSERTED_KEYS = ['inserted', 'totalInserted', 'insertedCount', 'succeeded'] as const;
const SKIPPED_KEYS = ['skipped', 'totalSkipped', 'skippedCount'] as const;
const ERROR_KEYS = ['errors', 'totalErrors', 'errorCount', 'failed'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sum of every finite number found at `keys`; `null` when none were present. */
function readCounter(record: Record<string, unknown>, keys: readonly string[]): number | null {
  let found: number | null = null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      found = (found ?? 0) + value;
    }
  }
  return found;
}

/**
 * Reduce a fetcher's return value to inserted / skipped / errors.
 *
 * Handles the shapes the family actually returns:
 *   - `{inserted, skipped, errors}`                     (most fetchers)
 *   - `{totalInserted, totalSkipped, totalErrors, ...}` (multi-state fetchers)
 *   - `{total, succeeded, failed}`                      (the embedder)
 *   - `{results: [...]}`                                (per-source fan-out)
 *   - `{status: 'download_failed', errors: 0}`          (masked hard failure)
 *
 * Nested arrays are only summed when the top level carried NO counters, so a
 * payload that reports both an aggregate and its per-item breakdown
 * (`fetchMultipleStateBills`) is not double counted.
 */
export function tallyIngestionResult(result: unknown): IngestionTally {
  const empty: IngestionTally = { inserted: 0, skipped: 0, errors: 0, recognized: false };

  if (Array.isArray(result)) {
    return result.reduce<IngestionTally>((acc, entry) => {
      const part = tallyIngestionResult(entry);
      return {
        inserted: acc.inserted + part.inserted,
        skipped: acc.skipped + part.skipped,
        errors: acc.errors + part.errors,
        recognized: acc.recognized || part.recognized,
      };
    }, empty);
  }

  if (!isRecord(result)) return empty;

  const inserted = readCounter(result, INSERTED_KEYS);
  const skipped = readCounter(result, SKIPPED_KEYS);
  const errors = readCounter(result, ERROR_KEYS);

  const tally: IngestionTally = {
    inserted: inserted ?? 0,
    skipped: skipped ?? 0,
    errors: errors ?? 0,
    recognized: inserted !== null || skipped !== null || errors !== null,
  };

  // Only descend when this level said nothing — otherwise the aggregate wins.
  if (!tally.recognized) {
    for (const value of Object.values(result)) {
      if (!Array.isArray(value)) continue;
      const nested = tallyIngestionResult(value);
      if (!nested.recognized) continue;
      tally.inserted += nested.inserted;
      tally.skipped += nested.skipped;
      tally.errors += nested.errors;
      tally.recognized = true;
    }
  }

  // A declared failure outranks a zeroed error counter (the /fetch-uspto mask).
  if (isIngestionFailureStatus(result.status)) {
    tally.errors = Math.max(tally.errors, 1);
    tally.recognized = true;
  }

  return tally;
}

/** Map a tally onto the contract. Nothing failed → ok; nothing landed → total. */
export function classifyIngestion(tally: IngestionTally): IngestionStatus {
  if (tally.errors <= 0) return 'ok';
  // `skipped` counts as progress: an already-ingested static statute set
  // legitimately inserts 0 and skips N, and that is not a total failure.
  if (tally.inserted > 0 || tally.skipped > 0) return 'partial_failure';
  return 'total_failure';
}

export function httpStatusForIngestion(status: IngestionStatus): number {
  switch (status) {
    case 'ok':
    case 'disabled':
      return 200;
    case 'partial_failure':
      return 207;
    case 'total_failure':
      return 502;
    case 'flag_not_configured':
    case 'flag_unreadable':
      return 503;
  }
}

/**
 * Write the ingestion result under the contract above.
 *
 * A clean run is forwarded verbatim at 200. Anything else annotates the body
 * with `ingestion_status` / `ingestion_errors` / `ingestion_inserted` AND logs
 * at error level, so both a scheduler and a human learn the truth.
 */
export function sendIngestionResult(res: Response, route: string, result: unknown): void {
  const tally = tallyIngestionResult(result);

  if (!tally.recognized) {
    // Not a shape this module knows. Do not invent a failure — but say so, so
    // a fetcher whose return type drifts cannot quietly leave the contract.
    logger.warn(
      { route, resultKeys: isRecord(result) ? Object.keys(result) : typeof result },
      'Ingestion result shape not recognised — response contract not applied',
    );
    res.status(200).json(result ?? {});
    return;
  }

  const status = classifyIngestion(tally);
  if (status === 'ok') {
    res.status(200).json(result);
    return;
  }

  logger.error(
    { route, ingestion_status: status, ...tally },
    `Ingestion run did not complete cleanly: ${route}`,
  );

  const body = isRecord(result) ? { ...result } : { result };
  res.status(httpStatusForIngestion(status)).json({
    ...body,
    ingestion_status: status,
    ingestion_inserted: tally.inserted,
    ingestion_skipped: tally.skipped,
    ingestion_errors: tally.errors,
  });
}

/**
 * Three-state switchboard read — the BUG-021 fix.
 *
 * Reads `switchboard_flags` directly rather than through `get_flag()`, because
 * that function folds "row absent" into its `p_default` and therefore cannot
 * report the misconfiguration this gate exists to surface.
 */
export async function readIngestionFlagState(
  client: SupabaseClient,
  flagKey: string,
): Promise<IngestionFlagState> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service-role admin query
    const { data, error } = await (client as any)
      .from('switchboard_flags')
      .select('enabled')
      .eq('flag_key', flagKey)
      .maybeSingle();

    if (error) {
      logger.error({ error, flagKey }, 'Switchboard flag read failed');
      return 'unreadable';
    }
    if (!data) return 'not_configured';
    return data.enabled === true ? 'enabled' : 'disabled';
  } catch (error) {
    logger.error({ error, flagKey }, 'Switchboard flag read threw');
    return 'unreadable';
  }
}

export interface IngestionRouteOptions<T> {
  /** Route slug used in logs and in the response body. */
  route: string;
  /** The fetcher invocation. Only called once the flag state permits it. */
  run: () => Promise<T>;
  /** Service-role client used for the switchboard read. */
  client: SupabaseClient;
  /** Switchboard flag gating this route. Defaults to the ingestion flag. */
  flagKey?: string;
}

/**
 * Run one ingestion route end to end under the contract.
 *
 * Order matters: the flag state is resolved BEFORE the fetcher runs, so an
 * unconfigured environment is refused loudly instead of producing a run that
 * looks healthy because it never started.
 */
export async function runIngestionRoute<T>(
  res: Response,
  options: IngestionRouteOptions<T>,
): Promise<void> {
  const { route, run, client } = options;
  const flagKey = options.flagKey ?? INGESTION_FLAG_KEY;

  const flagState = await readIngestionFlagState(client, flagKey);

  if (flagState === 'not_configured' || flagState === 'unreadable') {
    const status: IngestionStatus =
      flagState === 'not_configured' ? 'flag_not_configured' : 'flag_unreadable';
    logger.error(
      { route, flagKey, flagState },
      flagState === 'not_configured'
        ? `Ingestion refused: no ${flagKey} row in switchboard_flags — this environment was never configured`
        : `Ingestion refused: ${flagKey} could not be read from switchboard_flags`,
    );
    res.setHeader('Retry-After', String(FLAG_RETRY_AFTER_SECONDS));
    res.status(httpStatusForIngestion(status)).json({
      ingestion_status: status,
      flag_key: flagKey,
      route,
      message:
        flagState === 'not_configured'
          ? `No ${flagKey} row exists in switchboard_flags. Ingestion is not disabled — it is unconfigured, and a run would have been a silent no-op.`
          : `Could not read ${flagKey} from switchboard_flags.`,
      retry_after_seconds: FLAG_RETRY_AFTER_SECONDS,
    });
    return;
  }

  if (flagState === 'disabled') {
    logger.info({ route, flagKey }, 'Ingestion skipped — switchboard flag is off');
    res.status(200).json({
      ingestion_status: 'disabled' satisfies IngestionStatus,
      flag_key: flagKey,
      route,
      inserted: 0,
      skipped: 0,
      errors: 0,
    });
    return;
  }

  try {
    const result = await run();
    sendIngestionResult(res, route, result);
  } catch (error) {
    logger.error({ error, jobName: route }, `${route} failed`);
    res.status(500).json({ error: 'Processing failed' });
  }
}
