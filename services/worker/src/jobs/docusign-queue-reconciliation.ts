/**
 * DS-05 (SCRUM-2365) — DocuSign QUEUE reconciliation.
 *
 * Distinct from SCRUM-2042 `docusign-reconciliation.ts`, which reconciles
 * *webhook delivery* gaps (completed envelopes that never arrived as a Connect
 * webhook) against the `docusign_webhook_nonces` table. THIS job reconciles the
 * *queue*: completed DocuSign envelopes that were received but are missing from
 * the connector-artifact queue (`connector_artifact`, mig 0343) — e.g. because
 * the producer (DS-03) was gated off, the fetch job dead-lettered, or listener
 * drift dropped the materialization. Drift here means "the document is complete
 * at DocuSign but nothing is queued to anchor it."
 *
 * For each active org/member DocuSign integration it:
 *   1. lists completed envelopes in the lookback window (DocuSign Envelopes API),
 *   2. diffs against the artifacts already queued for that org,
 *   3. for each MISSING envelope: writes a bounded audit event, fires a Sentry
 *      drift alert, and idempotently re-materializes it into the correct
 *      (org vs personal) queue.
 *
 * §1.6A: this module NEVER touches document bytes. Materialization is delegated
 * to the injected `materializeMissingEnvelope`, whose production wiring re-drives
 * the single audited producer fetch→SHA-256→discard path. Only envelope ids +
 * bounded metadata cross this boundary — never a fingerprint or raw bytes.
 *
 * Pure + dependency-injected (same shape as SCRUM-2042): every branch is
 * unit-testable without a database, DocuSign API, or Sentry.
 */

import * as Sentry from '@sentry/node';
import { logger } from '../utils/logger.js';

const DEFAULT_LOOKBACK_HOURS = 24;

export interface QueueActiveIntegration {
  id: string;
  org_id: string;
  account_id: string;
  base_uri: string;
  token_secret_name: string;
  /**
   * DS-04/DS-05 queue routing: 'member' ⇒ personal queue (materialize scoped to
   * `owner_user_id`); 'org' ⇒ org policy. member_integrations rows carry an
   * owner; org_integrations rows do not.
   */
  scope: 'org' | 'member';
  owner_user_id: string | null;
}

export interface CompletedEnvelopeRef {
  envelopeId: string;
  status: string;
  completedDateTime: string;
}

export interface QueueReconciliationDeps {
  listActiveIntegrations(): Promise<QueueActiveIntegration[]>;

  getAccessToken(integration: QueueActiveIntegration): Promise<string>;

  listCompletedEnvelopes(args: {
    baseUri: string;
    accountId: string;
    accessToken: string;
    fromDate: string;
  }): Promise<CompletedEnvelopeRef[]>;

  /**
   * Returns the set of envelope external_refs already present in
   * `connector_artifact` for this org+integration, restricted to the candidate
   * envelope ids. The absence of an id ⇒ queue drift.
   */
  getQueuedEnvelopeRefs(
    integration: QueueActiveIntegration,
    envelopeIds: string[],
  ): Promise<Set<string>>;

  /**
   * Idempotently materialize a missing completed envelope into the correct queue.
   * Production wiring re-drives the audited producer path (fetch → SHA-256 →
   * discard → enqueue_connector_artifact), whose 0343 dedupe makes a re-run a
   * no-op. §1.6A: implementations MUST NOT return, log, or persist raw bytes.
   */
  materializeMissingEnvelope(args: {
    integration: QueueActiveIntegration;
    envelope: CompletedEnvelopeRef;
  }): Promise<{ enqueued: boolean; error: string | null }>;

  /** Bounded, PII-scrubbed audit row for a detected drift (ids only). */
  recordDriftAudit(row: {
    org_id: string;
    integration_id: string;
    account_id: string;
    envelope_id: string;
    envelope_status: string;
    completed_at: string;
    scope: 'org' | 'member';
    owner_user_id: string | null;
  }): Promise<{ error: string | null }>;
}

export interface ReconcileDocusignQueueDriftOptions {
  /** Lookback window for completed-envelope polling. Defaults to 24h. */
  lookbackHours?: number;
  /**
   * DS-03/DS-05 flag alignment. When the connector-artifact enqueue is OFF the
   * DS-03 producer computes a fingerprint but writes NO `connector_artifact` row,
   * so a re-materialization can never durably queue the envelope. Re-driving it
   * would re-submit (and falsely count) the same envelope every cron run. When
   * this is false the reconciliation still detects + audits + alerts drift, but
   * suppresses the re-drive and does not count it materialized. Defaults to true
   * (aligned) so the pure unit tests that predate this flag are unaffected.
   */
  enableConnectorArtifactEnqueue?: boolean;
}

export interface QueueReconciliationResult {
  ok: boolean;
  integrations_checked: number;
  envelopes_polled: number;
  drift_detected: number;
  materialized: number;
  alerts_fired: number;
  errors: Array<{ integration_id: string; error: string }>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function reconcileDocusignQueueDrift(
  deps: QueueReconciliationDeps,
  options: ReconcileDocusignQueueDriftOptions = {},
): Promise<QueueReconciliationResult> {
  const lookbackHours = options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  // Default true so the re-drive behaves as before unless a caller explicitly
  // passes the (off) flag from config.
  const enableConnectorArtifactEnqueue = options.enableConnectorArtifactEnqueue ?? true;
  const result: QueueReconciliationResult = {
    ok: true,
    integrations_checked: 0,
    envelopes_polled: 0,
    drift_detected: 0,
    materialized: 0,
    alerts_fired: 0,
    errors: [],
  };

  let integrations: QueueActiveIntegration[];
  try {
    integrations = await deps.listActiveIntegrations();
  } catch (err) {
    const msg = errMsg(err);
    logger.error({ error: msg }, 'Queue reconciliation: failed to list active integrations');
    return { ...result, ok: false, errors: [{ integration_id: '*', error: msg }] };
  }

  const fromDate = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  for (const integration of integrations) {
    result.integrations_checked++;
    // Per-org isolation: one integration's failure never starves the rest.
    try {
      await reconcileOneIntegration(
        deps,
        integration,
        fromDate,
        result,
        enableConnectorArtifactEnqueue,
      );
    } catch (err) {
      const msg = errMsg(err);
      logger.error(
        { integrationId: integration.id, error: msg },
        'Queue reconciliation: integration failed',
      );
      result.errors.push({ integration_id: integration.id, error: msg });
      result.ok = false;
    }
  }

  if (result.materialized > 0) {
    logger.warn(
      {
        drift_detected: result.drift_detected,
        materialized: result.materialized,
        integrations_checked: result.integrations_checked,
      },
      'DocuSign queue reconciliation re-materialized missing envelopes',
    );
  }

  return result;
}

async function reconcileOneIntegration(
  deps: QueueReconciliationDeps,
  integration: QueueActiveIntegration,
  fromDate: string,
  result: QueueReconciliationResult,
  enableConnectorArtifactEnqueue: boolean,
): Promise<void> {
  const accessToken = await deps.getAccessToken(integration);

  const envelopes = await deps.listCompletedEnvelopes({
    baseUri: integration.base_uri,
    accountId: integration.account_id,
    accessToken,
    fromDate,
  });
  result.envelopes_polled += envelopes.length;
  if (envelopes.length === 0) return;

  const envelopeIds = envelopes.map((e) => e.envelopeId);
  const queued = await deps.getQueuedEnvelopeRefs(integration, envelopeIds);

  const drift = envelopes.filter((e) => !queued.has(e.envelopeId));
  result.drift_detected += drift.length;

  for (const envelope of drift) {
    await handleDrift(deps, integration, envelope, result, enableConnectorArtifactEnqueue);
  }
}

async function handleDrift(
  deps: QueueReconciliationDeps,
  integration: QueueActiveIntegration,
  envelope: CompletedEnvelopeRef,
  result: QueueReconciliationResult,
  enableConnectorArtifactEnqueue: boolean,
): Promise<void> {
  // Bounded audit row — ids only, never a fingerprint or bytes (§1.6A).
  const audit = await deps.recordDriftAudit({
    org_id: integration.org_id,
    integration_id: integration.id,
    account_id: integration.account_id,
    envelope_id: envelope.envelopeId,
    envelope_status: envelope.status,
    completed_at: envelope.completedDateTime,
    scope: integration.scope,
    owner_user_id: integration.owner_user_id,
  });
  if (audit.error) {
    logger.error(
      { integrationId: integration.id, envelopeId: envelope.envelopeId, error: audit.error },
      'Queue reconciliation: drift audit write failed',
    );
    result.errors.push({
      integration_id: integration.id,
      error: `drift_audit(${envelope.envelopeId}): ${audit.error}`,
    });
    result.ok = false;
  }

  // Drift alert — aggregate/id context only.
  try {
    Sentry.captureMessage(
      `DocuSign queue drift: envelope ${envelope.envelopeId} completed but not queued`,
      {
        level: 'warning',
        tags: {
          integration_id: integration.id,
          queue_scope: integration.scope,
        },
        extra: {
          org_id: integration.org_id,
          account_id: integration.account_id,
          completed_at: envelope.completedDateTime,
          detected_at: new Date().toISOString(),
        },
      },
    );
    result.alerts_fired++;
  } catch (sentryErr) {
    logger.error(
      { error: errMsg(sentryErr), envelopeId: envelope.envelopeId },
      'Queue reconciliation: Sentry alert failed',
    );
  }

  // Flag-alignment guard (SCRUM-2365): if the connector-artifact enqueue is OFF,
  // the DS-03 producer writes no durable `connector_artifact` row, so re-driving
  // would re-submit (and falsely count) the same envelope every cron run. Detect +
  // audit + alert the drift above, but suppress the re-drive here. Not an error —
  // the drain is intentionally dormant until ENABLE_CONNECTOR_ARTIFACT_ENQUEUE ships.
  if (!enableConnectorArtifactEnqueue) {
    logger.warn(
      { integrationId: integration.id, envelopeId: envelope.envelopeId },
      'Queue reconciliation: drift detected but re-materialization suppressed — ENABLE_CONNECTOR_ARTIFACT_ENQUEUE disabled',
    );
    return;
  }

  // Idempotent re-materialization into the correct (org vs personal) queue.
  const outcome = await deps.materializeMissingEnvelope({ integration, envelope });
  if (outcome.error || !outcome.enqueued) {
    logger.error(
      { integrationId: integration.id, envelopeId: envelope.envelopeId, error: outcome.error },
      'Queue reconciliation: re-materialization failed',
    );
    result.errors.push({
      integration_id: integration.id,
      error: `materialize(${envelope.envelopeId}): ${outcome.error ?? 'not_enqueued'}`,
    });
    result.ok = false;
    return;
  }
  result.materialized++;
}
