/**
 * Drive processing-failure Sentry reporter (P0-2 hardening audit,
 * 2026-09-14 — "Google Drive pipeline failures visible").
 *
 * Before this module, `logger.error(...)` calls in `webhooks/drive.ts`,
 * `drive-changes-runner.ts`, `drive-changes-processor.ts`, and
 * `jobs/drive-file-changed.ts` only wrote structured pino logs —
 * `services/worker/src/utils/logger.ts` has no Sentry transport. The ONLY
 * Drive-adjacent path that ever paged Sentry was the channel-renewal sweep
 * (`alertDriveSubscriptionRenewal`). Meanwhile rule-dispatch (which the
 * connector-health dashboard DOES watch, via `organization_rule_executions`)
 * and document-fetch (the `google_drive.file_changed` job_queue row, which
 * the dashboard does NOT watch) are two independent enqueues with
 * independent failure modes — a rule can read "success" while the fetch job
 * dies. This module is the single choke point every Drive failure site
 * routes through so a real failure is always loud (Sentry) as well as
 * logged (pino), with enough context to act on: org id, integration id,
 * file id, revision id, job id, and error class.
 *
 * Dedup: `runDriveChanges` → `processDriveChanges` is a single, uncaught
 * call chain from the webhook's perspective — every intermediate throw site
 * (rule lookup, changes.list, per-change enqueue) bubbles up to ONE outer
 * catch in `webhooks/drive.ts`. Reporting at both the inner (rich context:
 * file_id/revision_id) and outer (catch-all) sites would double-fire Sentry
 * for the exact same failure. A non-enumerable marker on the error object
 * makes reporting idempotent per error instance — the first (richest) call
 * site wins; the outer catch-all is then a true no-op for anything already
 * reported, and still catches genuinely un-enriched failures (e.g. a token
 * refresh error) that never passed through an inner reporting site.
 *
 * §1.1 / §1.6A: this module never accepts or forwards document bytes — its
 * context type is ids/strings only. The Sentry event it produces still runs
 * through the real `scrubPiiFromEvent` `beforeSend` pipeline (binary-by-type
 * drop, then PII regex scrub) as defense in depth; see
 * `drive-connect-health.test.ts` for a test that proves that pipeline
 * strips bytes even under a simulated misuse.
 */
import * as Sentry from '@sentry/node';

/** `connector_alert_state.connector_id` / Sentry tag value for Google Drive. */
export const GOOGLE_DRIVE_CONNECTOR_ID = 'google_drive';

export type DriveFailureStage =
  | 'watched_folder_lookup'
  | 'token_refresh'
  | 'changes_list'
  | 'enqueue'
  | 'webhook_run_changes'
  | 'file_changed_job';

export interface DriveFailureContext {
  stage: DriveFailureStage;
  orgId: string | null;
  integrationId?: string | null;
  fileId?: string | null;
  revisionId?: string | null;
  jobId?: string | null;
}

// Non-enumerable so it never rides along into a JSON.stringify of the error
// (e.g. a naive `logger.error({ error: err })` call elsewhere) and never
// collides with a legitimate `error.reported` property some other error
// class might already define.
const REPORTED_MARKER = Symbol.for('arkova.drive.sentryReported');

function alreadyReported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[REPORTED_MARKER] === true;
}

function markReported(error: unknown): void {
  if (typeof error !== 'object' || error === null) return;
  try {
    Object.defineProperty(error, REPORTED_MARKER, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    // Frozen/sealed error object — extremely unlikely for a thrown Error,
    // but never let marking failure block reporting.
  }
}

function errorClassOf(error: unknown): string {
  if (error instanceof Error) return error.constructor.name || 'Error';
  return typeof error;
}

/**
 * Report a real Drive pipeline failure to Sentry, once per error instance.
 * Safe to call from multiple layers of the same call chain — see the
 * module doc comment for the dedup contract. Never throws.
 */
export function reportDriveProcessingFailure(error: unknown, context: DriveFailureContext): void {
  if (alreadyReported(error)) return;
  markReported(error);

  const err = error instanceof Error ? error : new Error(String(error));

  try {
    Sentry.captureException(err, {
      level: 'error',
      tags: {
        connector_id: GOOGLE_DRIVE_CONNECTOR_ID,
        stage: context.stage,
      },
      extra: {
        org_id: context.orgId ?? null,
        integration_id: context.integrationId ?? null,
        file_id: context.fileId ?? null,
        revision_id: context.revisionId ?? null,
        job_id: context.jobId ?? null,
        error_class: errorClassOf(error),
      },
    });
  } catch {
    // Sentry itself must never be able to break the Drive pipeline. The
    // caller's own logger.error(...) call (kept at every call site) is the
    // fallback signal if this throws.
  }
}
