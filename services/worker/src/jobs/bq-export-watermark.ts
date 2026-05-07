/**
 * Watermark read/advance helpers for the BigQuery export jobs.
 *
 * SCRUM-1723 (incremental sync) and SCRUM-1727 (one-shot backfill) read
 * + advance per-table watermarks in `public.bq_export_watermarks`. The
 * snapshot job (SCRUM-1724) records run status here too, even though it
 * doesn't use last_synced_at for incrementing — the run-status row is
 * the operational marker for "did the daily snapshot complete?".
 *
 * Failure semantics:
 *   - If a sync run starts: status = 'running' with optimistic UPDATE
 *   - If it succeeds: status = 'success' AND last_synced_at advances
 *   - If it fails: status = 'failed', last_run_error captured, watermark
 *     does NOT advance (re-run picks up the same window)
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

export type BqExportTableName =
  | 'anchors'
  | 'verifications'
  | 'audit_events'
  | 'organizations'
  | 'api_keys';

export interface Watermark {
  tableName: BqExportTableName;
  lastSyncedAt: string;
  lastSyncedId: string | null;
  lastRunStatus: 'pending' | 'running' | 'success' | 'failed';
  lastRunError: string | null;
}

export async function readWatermark(tableName: BqExportTableName): Promise<Watermark> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('bq_export_watermarks')
    .select('table_name, last_synced_at, last_synced_id, last_run_status, last_run_error')
    .eq('table_name', tableName)
    .single();

  if (error || !data) {
    throw new Error(`bq_export_watermarks: missing or unreadable row for ${tableName}: ${error?.message ?? 'no row'}`);
  }

  return {
    tableName,
    lastSyncedAt: String(data.last_synced_at),
    lastSyncedId: data.last_synced_id ?? null,
    lastRunStatus: data.last_run_status,
    lastRunError: data.last_run_error,
  };
}

export async function markRunStarted(tableName: BqExportTableName): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('bq_export_watermarks')
    .update({ last_run_status: 'running', last_run_error: null })
    .eq('table_name', tableName);

  if (error) {
    throw new Error(`bq_export_watermarks: failed to mark run started for ${tableName}: ${error.message}`);
  }
}

export interface AdvanceArgs {
  tableName: BqExportTableName;
  newWatermark: string;
  newLastId?: string | null;
}

export async function markRunSucceeded(args: AdvanceArgs): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('bq_export_watermarks')
    .update({
      last_synced_at: args.newWatermark,
      last_synced_id: args.newLastId ?? null,
      last_run_status: 'success',
      last_run_error: null,
    })
    .eq('table_name', args.tableName);

  if (error) {
    throw new Error(`bq_export_watermarks: failed to advance watermark for ${args.tableName}: ${error.message}`);
  }
  logger.info(
    { tableName: args.tableName, newWatermark: args.newWatermark },
    'BQ export: watermark advanced',
  );
}

export async function markRunFailed(tableName: BqExportTableName, errorMessage: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('bq_export_watermarks')
    .update({
      last_run_status: 'failed',
      // Truncate at 4KB to avoid filling the row with a giant stack.
      last_run_error: errorMessage.slice(0, 4096),
    })
    .eq('table_name', tableName);

  if (error) {
    // Best-effort — even logging this fail-to-record-failure is useful
    // operationally. Don't throw inside the failure-recording path.
    logger.error(
      { tableName, errorMessage, dbError: error.message },
      'BQ export: failed to record run failure on watermark',
    );
  }
}
