/**
 * Cloud Logging drain job (GCP-MAX-03 / SCRUM-1063).
 *
 * Cron at 1-minute cadence. Reads `cloud_logging_queue`, pulls the matching
 * audit_events rows, writes them to Cloud Logging, deletes the queue rows
 * that made it through. Batches in chunks of 100 — Cloud Logging accepts
 * up to 1000 entries per call but smaller batches recover faster from
 * transient failures.
 *
 * Failure modes:
 *   - Missing GCP creds → early return, log once per boot (not per tick).
 *   - Cloud Logging 5xx → increment retry_count, keep rows. Next tick retries.
 *   - Individual row errors after 10 retries → logged + skipped (manual
 *     remediation per SOC 2 runbook).
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { writeAuditBatch, type AuditLogEntry } from '../audit/cloud-logging-sink.js';
import { hasGcpCredential } from '../utils/gcp-auth.js';

const BATCH_SIZE = 100;
const MAX_BATCHES_PER_TICK = 10; // up to 1000 entries per minute

export interface CloudLoggingDrainResult {
  entries_attempted: number;
  entries_written: number;
  rows_deleted: number;
  batches_processed: number;
  errored: boolean;
}

let credWarningLogged = false;

export async function runCloudLoggingDrain(): Promise<CloudLoggingDrainResult> {
  const result: CloudLoggingDrainResult = {
    entries_attempted: 0,
    entries_written: 0,
    rows_deleted: 0,
    batches_processed: 0,
    errored: false,
  };

  if (process.env.ENABLE_CLOUD_LOGGING_SINK === 'false') {
    // Explicit disable for local dev / environments where we don't have GCP.
    return result;
  }

  if (!hasGcpCredential()) {
    if (!credWarningLogged) {
      logger.warn(
        'Cloud Logging drain: no GCP credential available. Audit queue will build up. ' +
          'Set GCP_SA_KEY_JSON (dev) or deploy on Cloud Run (prod).',
      );
      credWarningLogged = true;
    }
    return result;
  }

  for (let b = 0; b < MAX_BATCHES_PER_TICK; b++) {
    const batch = await claimBatch();
    if (batch.length === 0) break;

    result.batches_processed += 1;
    result.entries_attempted += batch.length;

    try {
      const writtenIds = await writeAuditBatch(batch);
      result.entries_written += writtenIds.size;

      // Successful writes → delete from queue.
      if (writtenIds.size > 0) {
        const { error: delErr, count } = await db
          .from('cloud_logging_queue')
          .delete({ count: 'exact' })
          .in('audit_id', [...writtenIds]);
        if (delErr) {
          logger.error(
            { error: delErr, writtenIds: writtenIds.size },
            'Cloud Logging drain: failed to delete queue rows after successful write. Next tick will double-write (Cloud Logging dedups by insertId).',
          );
          result.errored = true;
        } else {
          result.rows_deleted += count ?? 0;
        }
      }

      // Unwritten rows → increment retry_count.
      const unwritten = batch.filter((e) => !writtenIds.has(e.id)).map((e) => e.id);
      if (unwritten.length > 0) {
        await bumpRetryCounts(unwritten);
      }
    } catch (err) {
      logger.error({ error: err, batchSize: batch.length }, 'Cloud Logging drain: batch threw');
      result.errored = true;
      await bumpRetryCounts(batch.map((e) => e.id));
      break; // Stop the tick; next minute retries. Avoid hot-looping on a persistent failure.
    }
  }

  return result;
}

async function claimBatch(): Promise<AuditLogEntry[]> {
  // Oldest-first, under retry cap. Using the service_role client bypasses
  // RLS — the table is locked down (migration 0235).
  const { data: queueRows, error: qErr } = await db
    .from('cloud_logging_queue')
    .select('audit_id')
    .lt('retry_count', 10)
    .order('enqueued_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (qErr) {
    logger.error({ error: qErr }, 'Cloud Logging drain: queue read failed');
    return [];
  }
  const rows = (queueRows as Array<{ audit_id: string }> | null) ?? [];
  if (rows.length === 0) return [];

  const auditIds = rows.map((r) => r.audit_id);

  const { data: audit, error: aErr } = await db
    .from('audit_events')
    .select('id, event_type, event_category, actor_id, actor_email, org_id, target_type, target_id, details, created_at')
    .in('id', auditIds);
  if (aErr) {
    logger.error({ error: aErr, count: auditIds.length }, 'Cloud Logging drain: audit_events read failed');
    return [];
  }
  return (audit as AuditLogEntry[] | null) ?? [];
}

async function bumpRetryCounts(auditIds: string[], errorMsg?: string): Promise<void> {
  if (auditIds.length === 0) return;
  // Read-modify-write via supabase-js: fetch current retry_count, write
  // count+1. Race tolerated — the 10-retry ceiling is a soft alert, not a
  // correctness boundary. For a 100-row batch this is 100 UPDATEs per tick
  // only during a Cloud Logging outage; acceptable.
  //
  // A dedicated SQL RPC would be marginally faster but adds migration
  // surface area. Revisit if outage-volume alerts cite this codepath.
  for (const id of auditIds) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error: readErr } = await (db as any)
      .from('cloud_logging_queue')
      .select('retry_count')
      .eq('audit_id', id)
      .maybeSingle();
    if (readErr || !data) continue;
    const next = Math.min(((data as { retry_count: number }).retry_count ?? 0) + 1, 99);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any)
      .from('cloud_logging_queue')
      .update({ retry_count: next, last_error: errorMsg?.slice(0, 1000) ?? null })
      .eq('audit_id', id);
  }
}
