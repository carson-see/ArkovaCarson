/**
 * Quarantine for public records whose anchor insert keeps failing
 * (defense-in-depth from the 2026-08-17 poison-record incident —
 * docs/staging/fullsoak-2026-08/prod-repair-poison-record-2026-08-17.md).
 *
 * The failure mode this closes: `publicRecordAnchor.ts` fetches unanchored
 * records ordered `created_at` ASCENDING. A row whose per-row insert fails
 * with a non-transient, non-23505 error (the incident's PGRST102 lone
 * surrogate; any future poison class) is re-fetched at the HEAD of the queue
 * every run and retried forever — 16 days, in the incident — while
 * `insertAnchorSerialFallback` logs one line per run and moves on.
 *
 * Design constraints and the choice made:
 *   - An in-memory skip list is useless across runs (fresh process / other
 *     Cloud Run instance every tick), so the state must be durable.
 *   - No schema change: `public_records` has no status/attempts column, and a
 *     migration would force this PR to T3 during a change freeze. `metadata`
 *     (jsonb) is the one mutable, already-fetched column that fits, and prod
 *     already treats it as operationally mutable (the incident repair itself
 *     edited `metadata.abstract`). A dedicated quarantine column + partial
 *     index is the better long-term home — flagged as a follow-up in the PR
 *     body — but the metadata marker is correct and reversible today
 *     (`metadata - 'anchor_insert_quarantined_at'` un-quarantines a row).
 *   - Failures are COUNTED (threshold 3) rather than quarantined on first
 *     sight, so a transient PostgREST blip cannot side-line a healthy row.
 *     The counter lives in the same metadata object; each failed run
 *     increments it, so the threshold spans runs — exactly the cross-run
 *     memory the serial fallback lacked.
 *
 * Read-modify-write caveat: the metadata merge uses the record as fetched at
 * the top of the run. A concurrent writer to the same row's metadata (e.g.
 * the embedder) could interleave; the write is last-wins for the whole jsonb
 * value. Accepted: this executes only on the failure path of a row that is
 * demonstrably NOT progressing through the pipeline, and losing one counter
 * increment merely delays quarantine by one 10-minute cycle.
 *
 * Only the Postgres error CODE is persisted (never `error.message`) — a
 * PostgREST message can echo the offending payload back verbatim, and
 * `public_records.metadata` feeds public projections.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';

/** Serial insert failures tolerated before a record is quarantined. */
export const ANCHOR_INSERT_QUARANTINE_THRESHOLD = 3;

/** metadata key: cross-run count of non-23505 serial insert failures. */
export const ANCHOR_INSERT_FAILURE_COUNT_KEY = 'anchor_insert_failure_count';
/** metadata key: Postgres/PostgREST error CODE of the latest failure (never the message). */
export const ANCHOR_INSERT_LAST_CODE_KEY = 'anchor_insert_last_pg_code';
/** metadata key: ISO timestamp set when the threshold is reached. */
export const ANCHOR_INSERT_QUARANTINED_AT_KEY = 'anchor_insert_quarantined_at';

/**
 * The PostgREST filter column every unanchored-record read must pair with
 * `.is(<this>, null)`: the anchoring fetches (`publicRecordAnchor.ts`) so a
 * quarantined row stops re-poisoning the queue head, and the throughput
 * monitor's oldest-unlinked probe (`pipelineThroughputMonitor.ts`) so a
 * quarantined row does not age into a permanent condition-B fatal alert —
 * which would recreate the very alert storm (SCRUM-3156) this exists to end.
 */
export const ANCHOR_INSERT_QUARANTINE_FILTER_COLUMN =
  `metadata->${ANCHOR_INSERT_QUARANTINED_AT_KEY}`;

/**
 * Identity key joining a failed `PipelineAnchorInsert` back to its
 * `public_records` row. The insert carries `pipeline_source` + `source_id`
 * (record `id` deliberately never leaves the record), and `(source,
 * source_id)` is the record's upstream identity. NUL separator so
 * `('a','bc')` and `('ab','c')` cannot collide.
 */
export function pipelineSourceKey(source: string, sourceId: string): string {
  return `${source}\u0000${sourceId}`;
}

/** One non-23505 failure out of `insertAnchorSerialFallback`. */
export interface SerialInsertFailure {
  fingerprint: string;
  sourceKey: string;
  pgCode: string | null;
}

/** The slice of a pipeline record this module needs. */
export interface QuarantineCandidateRecord {
  id: string;
  metadata: Record<string, unknown> | null;
}

export interface QuarantineResult {
  /** Failures whose counter was durably incremented. */
  counted: number;
  /** Of those, how many crossed the threshold and were quarantined. */
  quarantined: number;
}

/**
 * Durably registers serial-insert failures against their `public_records`
 * rows and quarantines any row that reaches the threshold.
 *
 * Best-effort by design: this runs inside the anchoring job's failure path,
 * so it logs and continues on its own errors — a broken quarantine write must
 * never fail a run that still anchored every healthy record. The structured
 * `event` fields are the searchable markers
 * (`public_record_anchor_insert_failure` / `public_record_anchor_quarantined`).
 */
export async function quarantineFailedSerialInserts(
  client: SupabaseClient,
  failures: readonly SerialInsertFailure[],
  recordsBySourceKey: ReadonlyMap<string, QuarantineCandidateRecord>,
): Promise<QuarantineResult> {
  let counted = 0;
  let quarantined = 0;

  for (const failure of failures) {
    const record = recordsBySourceKey.get(failure.sourceKey);
    if (!record) {
      logger.warn(
        { event: 'public_record_anchor_insert_failure_unmapped', fingerprint: failure.fingerprint, pgCode: failure.pgCode },
        'Serial insert failure could not be mapped back to a public record — no quarantine counter written',
      );
      continue;
    }

    const meta = record.metadata ?? {};
    const prior = typeof meta[ANCHOR_INSERT_FAILURE_COUNT_KEY] === 'number'
      ? (meta[ANCHOR_INSERT_FAILURE_COUNT_KEY] as number)
      : 0;
    const failureCount = prior + 1;
    const shouldQuarantine = failureCount >= ANCHOR_INSERT_QUARANTINE_THRESHOLD;
    const nowIso = new Date().toISOString();

    const metadata: Record<string, unknown> = {
      ...meta,
      [ANCHOR_INSERT_FAILURE_COUNT_KEY]: failureCount,
      [ANCHOR_INSERT_LAST_CODE_KEY]: failure.pgCode ?? 'unknown',
      ...(shouldQuarantine ? { [ANCHOR_INSERT_QUARANTINED_AT_KEY]: nowIso } : {}),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (client as any)
      .from('public_records')
      .update({ metadata, updated_at: nowIso })
      .eq('id', record.id);

    if (error) {
      logger.error(
        { event: 'public_record_quarantine_write_failed', error, recordId: record.id, fingerprint: failure.fingerprint },
        'Failed to persist anchor-insert failure counter — row will be retried without quarantine credit',
      );
      continue;
    }

    counted += 1;
    if (shouldQuarantine) {
      quarantined += 1;
      logger.error(
        {
          event: 'public_record_anchor_quarantined',
          recordId: record.id,
          fingerprint: failure.fingerprint,
          pgCode: failure.pgCode,
          failureCount,
          threshold: ANCHOR_INSERT_QUARANTINE_THRESHOLD,
        },
        'Public record QUARANTINED after repeated anchor insert failures — excluded from future anchoring runs; clear metadata.anchor_insert_quarantined_at to retry',
      );
    } else {
      logger.error(
        {
          event: 'public_record_anchor_insert_failure',
          recordId: record.id,
          fingerprint: failure.fingerprint,
          pgCode: failure.pgCode,
          failureCount,
          threshold: ANCHOR_INSERT_QUARANTINE_THRESHOLD,
        },
        'Public record anchor insert failed serially — will be quarantined at the threshold',
      );
    }
  }

  return { counted, quarantined };
}
