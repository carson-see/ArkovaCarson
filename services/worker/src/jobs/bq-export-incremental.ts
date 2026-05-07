/**
 * Incremental sync job — append-only tables → BigQuery.
 *
 * SCRUM-1723 (parent SCRUM-1062 GCP-MAX-02). Runs on a 5-min cron via
 * Cloud Scheduler hitting POST /jobs/bq-export-incremental.
 *
 * For each of (anchors, verifications, audit_events):
 *   1. Read watermark from public.bq_export_watermarks
 *   2. Mark run started
 *   3. Query source rows where created_at > watermark, ordered by
 *      created_at ASC, LIMIT BATCH_SIZE
 *   4. Map to BQ rows; insertAll with insertId = source.id (best-effort
 *      dedup within BQ's ~1 min window)
 *   5. On success: advance watermark to MAX(created_at) of inserted rows
 *   6. On failure: mark failed with error message; watermark does NOT
 *      advance, so the next run re-attempts the same window
 *
 * AT-LEAST-ONCE semantics: combined with insertId-based dedup + monotonic
 * watermark advancement, duplicates are best-effort suppressed but the
 * sync is "at-least-once, eventually consistent".
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

import { ensureTable, insertRows, type BqInsertRow } from './bq-export-client.js';
import {
  AUDIT_EVENTS_COLUMN_ALLOWLIST,
  BQ_TABLES,
  type BqTableTarget,
} from './bq-export-schemas.js';
import {
  markRunFailed,
  markRunStarted,
  markRunSucceeded,
  readWatermark,
  type BqExportTableName,
} from './bq-export-watermark.js';

const BATCH_SIZE = 5000;

const APPEND_TABLES: BqExportTableName[] = ['anchors', 'verifications', 'audit_events'];

export interface IncrementalRunResult {
  table: BqExportTableName;
  rowsScanned: number;
  rowsInserted: number;
  newWatermark: string | null;
  errors: number;
}

/** Source-column allowlist for each append-only table. */
function selectColumns(table: BqExportTableName): string {
  if (table === 'audit_events') return AUDIT_EVENTS_COLUMN_ALLOWLIST.join(', ');
  // anchors + verifications — no PII columns; explicit list still beats *
  // because it makes drift visible at PR review time.
  if (table === 'anchors') {
    return [
      'id', 'public_id', 'org_id', 'credential_type', 'fingerprint', 'status',
      'chain_block_height', 'chain_tx_id', 'chain_confirmations',
      'parent_anchor_id', 'version_number', 'metadata',
      'revoked_at', 'revoked_by', 'issued_at', 'created_at', 'updated_at',
    ].join(', ');
  }
  if (table === 'verifications') {
    return [
      'id', 'anchor_id', 'org_id', 'public_id', 'result', 'verified_via',
      'verifier_ip_hash', 'created_at',
    ].join(', ');
  }
  return '*'; // unreachable; types prevent it
}

function toBqRow(table: BqExportTableName, row: Record<string, unknown>): BqInsertRow {
  const id = String(row.id);
  return {
    insertId: `${table}-${id}`,
    json: { ...row, bq_synced_at: new Date().toISOString() },
  };
}

async function runOneTable(table: BqExportTableName): Promise<IncrementalRunResult> {
  const target: BqTableTarget = BQ_TABLES[table];
  const watermark = await readWatermark(table);

  // Make sure the BQ table exists. Idempotent — first run creates it.
  await ensureTable(target);

  await markRunStarted(table);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const queryRes = await (db as any)
    .from(table)
    .select(selectColumns(table))
    .gt('created_at', watermark.lastSyncedAt)
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (queryRes.error) {
    await markRunFailed(table, `source query failed: ${queryRes.error.message}`);
    throw new Error(`incremental sync: source query for ${table} failed: ${queryRes.error.message}`);
  }

  const rows = (queryRes.data as Record<string, unknown>[] | null) ?? [];
  if (rows.length === 0) {
    // No new rows. Mark success without advancing watermark — semantically
    // a no-op run that confirms the cron is firing.
    await markRunSucceeded({
      tableName: table,
      newWatermark: watermark.lastSyncedAt,
      newLastId: watermark.lastSyncedId,
    });
    return { table, rowsScanned: 0, rowsInserted: 0, newWatermark: null, errors: 0 };
  }

  const bqRows = rows.map((r) => toBqRow(table, r));
  const insertResult = await insertRows(target, bqRows);

  if (insertResult.errors.length > 0) {
    const reasons = insertResult.errors.slice(0, 5).map((e) => `idx=${e.index}: ${e.reason}`).join(' | ');
    await markRunFailed(table, `BQ insertAll errors: ${insertResult.errors.length} rows; first: ${reasons}`);
    throw new Error(`incremental sync: ${table} had ${insertResult.errors.length} insert errors; first: ${reasons}`);
  }

  // Advance watermark to MAX(created_at) of inserted rows. Rows are
  // ordered ASC, so the last row has the max.
  const lastRow = rows[rows.length - 1];
  const newWatermark = String(lastRow.created_at);
  const newLastId = lastRow.id ? String(lastRow.id) : null;

  await markRunSucceeded({ tableName: table, newWatermark, newLastId });

  logger.info(
    { table, rowsInserted: insertResult.insertedCount, newWatermark },
    'BQ export: incremental sync succeeded',
  );

  return {
    table,
    rowsScanned: rows.length,
    rowsInserted: insertResult.insertedCount,
    newWatermark,
    errors: 0,
  };
}

/**
 * Entry point — called by the /jobs/bq-export-incremental HTTP route.
 * Runs each append-only table independently; one table's failure does
 * not abort the others.
 */
export async function runIncremental(): Promise<IncrementalRunResult[]> {
  const results: IncrementalRunResult[] = [];
  for (const table of APPEND_TABLES) {
    try {
      const r = await runOneTable(table);
      results.push(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ table, err: msg }, 'BQ export: incremental sync failed for table');
      results.push({ table, rowsScanned: 0, rowsInserted: 0, newWatermark: null, errors: 1 });
    }
  }
  return results;
}

/** Exported for tests only. */
export const __testing = { runOneTable, BATCH_SIZE, APPEND_TABLES, selectColumns };
