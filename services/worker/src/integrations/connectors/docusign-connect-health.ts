/**
 * SCRUM-3014 — DocuSign Connect listener provisioning failure visibility.
 *
 * `provisionConnectListener()` is invoked fire-and-forget from the DocuSign
 * OAuth callbacks: a failure must NOT break the connect flow, but until this
 * module existed it was also effectively invisible — the callback recorded only
 * `error.message` ("DocuSign Connect create failed"), dropping the HTTP status
 * and the bounded, already-scrubbed `detail` that `DocusignApiError` carries.
 * Production `integration_events` rows proved the gap: four
 * `connect_listener_failed` rows whose entire payload was
 * `{"error":"DocuSign Connect create failed"}` — no status, no vendor errorCode,
 * nothing to diagnose. Meanwhile the org UI still reported "Connected" because
 * nothing marked the connector unhealthy, so completed-envelope webhooks simply
 * never arrived.
 *
 * This module provides the three pieces the callbacks need:
 *   1. `describeConnectFailure` — real status + bounded detail (§1.6A safe).
 *   2. `reportConnectProvisionFailure` — loud + diagnosable: structured log,
 *      Sentry capture, and a `connector_alert_state` row flipped to `degraded`
 *      (the same table the queue digest counts as a "failed connector", so the
 *      operator/org actually sees it).
 *   3. `markDocusignConnectorConnected` — clears that sticky degraded state
 *      when a (re)provision succeeds.
 *
 * Every write here is best-effort: nothing in this module may throw into the
 * OAuth callback path.
 */

import * as Sentry from '@sentry/node';
import { logger } from '../../utils/logger.js';
import { boundedErrorDetail } from '../../utils/byte-safety.js';
import { DocusignApiError } from '../oauth/docusign.js';

/** `connector_alert_state.connector_id` value for DocuSign (= `org_integrations.provider`). */
export const DOCUSIGN_CONNECTOR_ID = 'docusign';

export type DocusignConnectFlow = 'org' | 'member';

export interface ConnectFailureDiagnostics {
  /** Error message — never a raw response body. */
  message: string;
  /** DocuSign HTTP status when the failure came from the Connect API. */
  status: number | null;
  /** Bounded (~500 char), byte-safe, PII-scrubbed vendor error payload. */
  detail: string | null;
}

/**
 * Minimal structural view of the `connector_alert_state` writer. Declared here
 * (rather than reusing a router `DbClient`) so both DocuSign routers and the
 * tests can satisfy it without widening their own overloads.
 */
export interface ConnectorAlertStateDb {
  from(table: string): {
    upsert(
      values: Record<string, unknown>,
      options?: { onConflict?: string },
    ): PromiseLike<{ error?: unknown }>;
  };
}

/**
 * Reduce an unknown provisioning error to the operator-facing diagnostics.
 *
 * `DocusignApiError.detail` is already bounded + scrubbed at construction; it is
 * passed through `boundedErrorDetail` again as defense in depth (§1.6A) so a
 * future caller that constructs the error by hand cannot leak bytes here.
 */
export function describeConnectFailure(error: unknown): ConnectFailureDiagnostics {
  if (error instanceof DocusignApiError) {
    return {
      message: error.message,
      status: error.status,
      detail: error.detail === undefined ? null : boundedErrorDetail(error.detail) ?? null,
    };
  }
  if (error instanceof Error) {
    return { message: error.message, status: null, detail: null };
  }
  return { message: String(error), status: null, detail: null };
}

async function upsertAlertState(args: {
  db: ConnectorAlertStateDb;
  orgId: string;
  lastState: 'connected' | 'degraded';
  lastAlertedAt: string | null;
  now: Date;
}): Promise<void> {
  try {
    const { error } = await args.db.from('connector_alert_state').upsert(
      {
        connector_id: DOCUSIGN_CONNECTOR_ID,
        org_id: args.orgId,
        last_state: args.lastState,
        last_alerted_at: args.lastAlertedAt,
        updated_at: args.now.toISOString(),
      },
      { onConflict: 'connector_id,org_id' },
    );
    if (error) {
      logger.warn(
        { orgId: args.orgId, lastState: args.lastState, error },
        'DocuSign connector alert-state write failed',
      );
    }
  } catch (err) {
    logger.warn(
      {
        orgId: args.orgId,
        lastState: args.lastState,
        message: err instanceof Error ? err.message : String(err),
      },
      'DocuSign connector alert-state write threw',
    );
  }
}

/**
 * Flip the DocuSign connector to `degraded` for this org. The 15-min connector
 * health cron treats `degraded` as sticky (it cannot observe Connect-listener
 * health itself), so the state survives until a successful (re)provision clears
 * it via {@link markDocusignConnectorConnected}.
 */
export async function markDocusignConnectorDegraded(args: {
  db: ConnectorAlertStateDb;
  orgId: string;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  await upsertAlertState({
    db: args.db,
    orgId: args.orgId,
    lastState: 'degraded',
    // Seeds the health cron's 1h re-fire cooldown so this alert is not
    // immediately duplicated on the next tick.
    lastAlertedAt: now.toISOString(),
    now,
  });
}

/** Clear the sticky degraded state after a successful Connect (re)provision. */
export async function markDocusignConnectorConnected(args: {
  db: ConnectorAlertStateDb;
  orgId: string;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  await upsertAlertState({
    db: args.db,
    orgId: args.orgId,
    lastState: 'connected',
    lastAlertedAt: null,
    now,
  });
}

/**
 * Make a Connect-listener provisioning failure loud and diagnosable without
 * making it fatal: structured log (status + bounded detail), Sentry capture,
 * and a degraded connector-health row. Returns the diagnostics so the caller
 * can persist them on its `integration_events` row.
 */
export async function reportConnectProvisionFailure(args: {
  db: ConnectorAlertStateDb;
  error: unknown;
  orgId: string;
  integrationId?: string | null;
  flow: DocusignConnectFlow;
  now?: Date;
}): Promise<ConnectFailureDiagnostics> {
  const diagnostics = describeConnectFailure(args.error);
  const integrationId = args.integrationId ?? null;

  logger.error(
    {
      orgId: args.orgId,
      integrationId,
      flow: args.flow,
      message: diagnostics.message,
      docusignStatus: diagnostics.status,
      docusignDetail: diagnostics.detail,
    },
    'DocuSign Connect listener provisioning failed',
  );

  try {
    Sentry.captureException(
      args.error instanceof Error ? args.error : new Error(diagnostics.message),
      {
        level: 'error',
        tags: {
          connector_id: DOCUSIGN_CONNECTOR_ID,
          stage: 'connect_provision',
          flow: args.flow,
          docusign_status: String(diagnostics.status ?? 'none'),
        },
        extra: {
          org_id: args.orgId,
          integration_id: integrationId,
          docusign_status: diagnostics.status,
          // Bounded + scrubbed by construction; never a raw response body.
          docusign_detail: diagnostics.detail,
        },
      },
    );
  } catch (err) {
    logger.warn(
      { message: err instanceof Error ? err.message : String(err) },
      'Failed to dispatch DocuSign Connect provisioning failure to Sentry',
    );
  }

  await markDocusignConnectorDegraded({ db: args.db, orgId: args.orgId, now: args.now });

  return diagnostics;
}

/** `integration_events` event-type pair for one Connect-provisioning flow. */
export interface ConnectProvisionEventTypes {
  provisioned: string;
  failed: string;
}

/**
 * Writes one `integration_events` row for the calling router's org/integration.
 * Supplied by the router so this module stays free of router-local db typing.
 */
export type ConnectProvisionEventRecorder = (event: {
  eventType: string;
  status: 'success' | 'error';
  /** Scalar-only so the row stays `Json`-assignable and can never carry bytes. */
  details: Record<string, string | number | boolean | null>;
}) => Promise<void>;

/** Shape of a resolved `provisionConnectListener()` call. */
export interface ConnectProvisionOutcome {
  connectId: string;
  action: string;
}

/**
 * Settle a fire-and-forget `provisionConnectListener()` promise: clear or set
 * the sticky connector-health state and record the matching
 * `integration_events` row. Shared by the org and member OAuth callbacks (and
 * the reprovision endpoint) so the two flows cannot drift apart — they differ
 * only in their event-type names and `flow` tag.
 *
 * NEVER rejects: both callers already redirected the browser, so a rejection
 * here would surface as an unhandled rejection in the worker. A throw from the
 * SUCCESS-path event write deliberately falls through to the failure path,
 * matching the `.then(...).catch(...)` chain this replaced.
 */
export async function settleConnectProvisioning(args: {
  db: ConnectorAlertStateDb;
  provisioning: PromiseLike<ConnectProvisionOutcome>;
  orgId: string;
  integrationId?: string | null;
  flow: DocusignConnectFlow;
  eventTypes: ConnectProvisionEventTypes;
  recordEvent: ConnectProvisionEventRecorder;
  now?: Date;
}): Promise<void> {
  try {
    const result = await args.provisioning;
    await markDocusignConnectorConnected({ db: args.db, orgId: args.orgId, now: args.now });
    await args.recordEvent({
      eventType: args.eventTypes.provisioned,
      status: 'success',
      details: { connect_id: result.connectId, action: result.action },
    });
  } catch (provisionError) {
    const diagnostics = await reportConnectProvisionFailure({
      db: args.db,
      error: provisionError,
      orgId: args.orgId,
      integrationId: args.integrationId,
      flow: args.flow,
      now: args.now,
    });
    try {
      await args.recordEvent({
        eventType: args.eventTypes.failed,
        status: 'error',
        details: {
          error: diagnostics.message,
          docusign_status: diagnostics.status,
          docusign_detail: diagnostics.detail,
        },
      });
    } catch (eventError) {
      logger.warn(
        {
          orgId: args.orgId,
          flow: args.flow,
          message: eventError instanceof Error ? eventError.message : String(eventError),
        },
        'Failed to record Connect provisioning failure event',
      );
    }
  }
}
