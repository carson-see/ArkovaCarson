/**
 * One-shot backfill job — project-inception → "now" for an append-only table.
 *
 * SCRUM-1727 (parent SCRUM-1062 GCP-MAX-02). Runs ONCE per table,
 * intentionally NOT on a cron. Triggered by a manual POST to
 * /jobs/bq-export-backfill?table=anchors (or one-time GCP Cloud
 * Scheduler invocation that gets paused after success).
 *
 * Run order at production cutover:
 *   1. ensureTable(target)            — create BQ table
 *   2. runBackfill(table)             — load all rows project-inception
 *                                       → now in batches of BATCH_SIZE
 *   3. Watermark advances each batch  — resumable if interrupted
 *   4. After completion, the 5-min incremental cron (SCRUM-1723) takes
 *      over for new rows from that point forward
 *
 * Distinct from incremental:
 *   - Loops until source is exhausted (incremental does ONE batch per
 *     5 min)
 *   - Logs progress every PROGRESS_LOG_EVERY rows so operators can see
 *     a multi-hour backfill is making forward progress
 *   - On failure mid-loop, watermark holds at the last successful
 *     batch boundary; re-running picks up there
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

import { ensureTable, insertRows, type BqInsertRow } from './bq-export-client.js';
import { BQ_TABLES, type BqTableTarget } from './bq-export-schemas.js';
import {
  markRunFailed,
  markRunStarted,
  markRunSucceeded,
  readWatermark,
  type BqExportTableName,
} from './bq-export-watermark.js';
import { __testing as incrementalTesting } from './bq-export-incremental.js';

const BATCH_SIZE = 5000;
const PROGRESS_LOG_EVERY = 50_000;

const BACKFILLABLE: readonly BqExportTableName[] = ['anchors', 'verifications', 'audit_events'];

export interface BackfillRunResult {
  table: BqExportTableName;
  totalRowsInserted: number;
  finalWatermark: string;
  durationMs: number;
}

function isBackfillable(table: string): table is BqExportTableName {
  return (BACKFILLABLE as readonly string[]).includes(table);
}

function toBqRow(table: BqExportTableName, row: Record<string, unknown>): BqInsertRow {
  const id = String(row.id);
  return {
    insertId: `${table}-${id}`,
    json: { ...row, bq_synced_at: new Date().toISOString() },
  };
}

export async function runBackfill(rawTable: string): Promise<BackfillRunResult> {
  if (!isBackfillable(rawTable)) {
    throw new Error(`backfill: ${rawTable} is not a backfillable table; allowed: ${BACKFILLABLE.join(', ')}`);
  }
  const table = rawTable;

  const target: BqTableTarget = BQ_TABLES[table];
  await ensureTable(target);
  await markRunStarted(table);

  const startedAt = Date.now();
  let totalInserted = 0;
  let cursor = (await readWatermark(table)).lastSyncedAt;
  let lastLogged = 0;

  // Reuse the same column allowlist incremental uses — single source
  // of truth.
  const selectCols = incrementalTesting.selectColumns(table);

  for (;;) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from(table)
      .select(selectCols)
      .gt('created_at', cursor)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      await markRunFailed(table, `backfill source query failed at cursor=${cursor}: ${error.message}`);
      throw new Error(`backfill: ${table} source query failed: ${error.message}`);
    }

    const rows = (data as Record<string, unknown>[] | null) ?? [];
    if (rows.length === 0) break; // exhausted

    const bqRows = rows.map((r) => toBqRow(table, r));
    const insertResult = await insertRows(target, bqRows);

    if (insertResult.errors.length > 0) {
      const reasons = insertResult.errors.slice(0, 5).map((e) => `idx=${e.index}: ${e.reason}`).join(' | ');
      await markRunFailed(table, `backfill BQ insertAll errors at cursor=${cursor}: ${insertResult.errors.length}; first: ${reasons}`);
      throw new Error(`backfill ${table}: ${insertResult.errors.length} insert errors; first: ${reasons}`);
    }

    totalInserted += insertResult.insertedCount;
    const lastRow = rows[rows.length - 1];
    cursor = String(lastRow.created_at);

    // Advance watermark each batch so a mid-loop crash is resumable.
    await markRunSucceeded({
      tableName: table,
      newWatermark: cursor,
      newLastId: lastRow.id ? String(lastRow.id) : null,
    });

    if (totalInserted - lastLogged >= PROGRESS_LOG_EVERY) {
      logger.info(
        { table, totalInserted, cursor, elapsedMs: Date.now() - startedAt },
        'BQ export: backfill progress',
      );
      lastLogged = totalInserted;
    }

    // If this batch was short of BATCH_SIZE, source is effectively exhausted
    // (modulo new rows since loop start; those are the incremental cron's job).
    if (rows.length < BATCH_SIZE) break;
  }

  const finalWatermark = cursor;
  // Re-mark succeeded one more time so last_run_status is unambiguously
  // 'success' at the end of the backfill.
  await markRunSucceeded({ tableName: table, newWatermark: finalWatermark });

  const durationMs = Date.now() - startedAt;
  logger.info(
    { table, totalInserted, finalWatermark, durationMs },
    'BQ export: backfill complete',
  );

  return { table, totalRowsInserted: totalInserted, finalWatermark, durationMs };
}

export const __testing = { BATCH_SIZE, BACKFILLABLE, isBackfillable };
