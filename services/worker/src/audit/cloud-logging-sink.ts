/**
 * Cloud Logging sink for audit_events (GCP-MAX-03 / SCRUM-1063).
 *
 * Pipes Postgres audit_events rows → Google Cloud Logging so the audit
 * trail lives in a separate system with immutable retention (required by
 * SOC 2 CC7.1 — system monitoring).
 *
 * Why not stream direct from Postgres? Cloud Logging's REST API can be
 * temporarily unavailable; dropping audit events on a transient failure
 * is a SOC 2 finding waiting to happen. We buffer in `cloud_logging_queue`
 * (migration 0235) + drain on a cron. The drain deletes queue rows only
 * on confirmed write.
 *
 * Log name: `projects/<project>/logs/arkova-audit-events`
 * Auth: service account on Cloud Run needs `roles/logging.logWriter`.
 */

import { getGcpAccessToken, hasGcpCredential } from '../utils/gcp-auth.js';
import { logger } from '../utils/logger.js';

export interface AuditLogEntry {
  /** audit_events.id — deduplicates retries against Cloud Logging */
  id: string;
  event_type: string;
  event_category: string;
  actor_id: string | null;
  actor_email: string | null;
  org_id: string | null;
  target_type: string | null;
  target_id: string | null;
  /** JSONB from Postgres, already stringified. Parsed here for structuredPayload. */
  details: string | null;
  created_at: string;
}

/**
 * Write a batch of audit entries to Cloud Logging.
 *
 * Returns the set of audit_events.id values that were successfully written.
 * The drain cron uses this set to scope the DELETE + avoids double-inserts
 * on partial-failure retries (Cloud Logging's insertId de-dupes within a
 * rolling window but we belt-and-suspenders with our own set).
 */
export async function writeAuditBatch(entries: AuditLogEntry[]): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  if (!hasGcpCredential()) {
    throw new Error(
      'GCP credential missing — cannot write to Cloud Logging. Set GCP_SA_KEY_JSON locally or run on Cloud Run.',
    );
  }

  const projectId = process.env.GCP_PROJECT_ID ?? 'arkova1';
  const logName =
    process.env.GCP_LOGGING_LOG_NAME ?? `projects/${projectId}/logs/arkova-audit-events`;

  const token = await getGcpAccessToken();

  const body = {
    logName,
    resource: { type: 'generic_task', labels: { project_id: projectId, job: 'arkova-worker', task_id: 'audit-sink' } },
    entries: entries.map((e) => ({
      // insertId = our audit_events.id ensures idempotent writes; Cloud
      // Logging dedupes by (logName, insertId, timestamp).
      insertId: e.id,
      timestamp: e.created_at,
      severity: severityFor(e.event_type, e.event_category),
      jsonPayload: {
        event_type: e.event_type,
        event_category: e.event_category,
        actor_id: e.actor_id,
        actor_email: e.actor_email,
        org_id: e.org_id,
        target_type: e.target_type,
        target_id: e.target_id,
        details: safeParseDetails(e.details),
        audit_event_id: e.id,
      },
      labels: {
        org_id: e.org_id ?? 'global',
        event_category: e.event_category,
      },
    })),
  };

  const res = await fetch('https://logging.googleapis.com/v2/entries:write', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    // Don't log the full payload (org ids + audit data are sensitive). Just
    // the status + a clipped error snippet.
    logger.warn(
      { status: res.status, attempted: entries.length, bodyPreview: text.slice(0, 300) },
      'Cloud Logging write failed — retrying next cron tick',
    );
    return new Set();
  }

  // Cloud Logging returns `{}` on success; every entry in the batch is
  // committed atomically. Rare partial-failure modes log via GCP alerting.
  return new Set(entries.map((e) => e.id));
}

function severityFor(eventType: string, category: string): string {
  // REVOKED / SUPERSEDED / DELETION → WARNING for faster ops triage. Most
  // lifecycle events map to INFO; FAILED events map to ERROR. Expand this
  // table as auditor feedback comes in.
  const upper = eventType.toUpperCase();
  if (upper.includes('FAILED') || upper.includes('ERROR')) return 'ERROR';
  if (upper.includes('REVOKED') || upper.includes('SUPERSEDED') || upper.includes('DELETED')) {
    return 'WARNING';
  }
  if (category === 'ANCHOR' || category === 'ORG') return 'INFO';
  return 'DEFAULT';
}

function safeParseDetails(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // details is meant to be JSON but CIBA Sprint 3 left it as a text column;
    // if a caller sent a non-JSON string, pass it through verbatim rather
    // than failing the whole batch.
    return { raw };
  }
}
