/**
 * SCRUM-2099 [DS-FAIL-01] — DocuSign Connect Failures API hourly poller.
 *
 * Surgical reconciliation that COMPLEMENTS the 24h Envelopes reconciliation
 * (SCRUM-2042, docusign-reconciliation.ts). Instead of diffing ALL completed
 * envelopes against received webhook nonces (broad + expensive, ~24h latency),
 * this job polls DocuSign's own Connect Failures API hourly — DocuSign already
 * knows which webhook deliveries it failed to push — and maps each failure to
 * a gap row, deduping against the EXISTING docusign_reconciliation_gaps table
 * (UNIQUE(integration_id, envelope_id) → 23505 → duplicate). This catches gaps
 * within ~1h instead of ~24h.
 *
 * Pure function pattern: all I/O injected via ConnectFailuresDeps interface
 * (same approach as docusign-reconciliation.ts). Fires a Sentry warning per
 * NEW gap detected. Also refreshes OAuth tokens to keep idle connections warm.
 */

import * as Sentry from '@sentry/node';
import { logger } from '../utils/logger.js';

/**
 * Default lookback window for the hourly cron. 2h (not 1h) gives a safety
 * overlap so a single missed/slow run never drops a failure between windows.
 */
const DEFAULT_LOOKBACK_HOURS = 2;

export interface ActiveIntegration {
  id: string;
  org_id: string;
  account_id: string;
  base_uri: string;
  token_secret_name: string;
}

/**
 * A Connect failure already mapped to the gap-row shape. DocuSign's raw
 * failure schema (logId/connectId/envelopeId/status/created/error/…) is
 * Zod-parsed and reduced to these safe fields in listConnectFailures —
 * keeping all external-JSON validation in the deps layer (§1.4/§1.7) and
 * ensuring no PII (email/subject/userName/debug log) reaches this function.
 */
export interface ConnectFailureGap {
  envelope_id: string;
  envelope_status: string;
  completed_at: string;
}

export interface ConnectFailuresDeps {
  listActiveIntegrations(): Promise<ActiveIntegration[]>;

  getAccessToken(integration: ActiveIntegration): Promise<string>;

  listConnectFailures(args: {
    baseUri: string;
    accountId: string;
    accessToken: string;
    fromDate: string;
  }): Promise<ConnectFailureGap[]>;

  insertGap(gap: {
    org_id: string;
    integration_id: string;
    account_id: string;
    envelope_id: string;
    envelope_status: string;
    completed_at: string;
  }): Promise<{ inserted: boolean; duplicate: boolean; error: string | null }>;
}

export interface ConnectFailuresResult {
  ok: boolean;
  integrations_checked: number;
  failures_polled: number;
  gaps_inserted: number;
  duplicates_skipped: number;
  errors: Array<{ integration_id: string; error: string }>;
  token_refreshes: number;
}

/**
 * Records a per-integration failure (token refresh or API poll) on the result.
 * Centralised so the two failure sites share one log/error/flag shape.
 */
function recordIntegrationError(
  result: ConnectFailuresResult,
  integrationId: string,
  kind: string,
  err: unknown,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ integrationId, error: msg }, `Connect failures: ${kind} failed`);
  result.errors.push({ integration_id: integrationId, error: `${kind}: ${msg}` });
  result.ok = false;
}

/** Fires a Sentry warning for a NEW gap. Never throws — Sentry is best-effort. */
function alertNewGap(integration: ActiveIntegration, failure: ConnectFailureGap): void {
  try {
    Sentry.captureMessage(
      `DocuSign Connect failure gap: envelope ${failure.envelope_id} reported as a failed webhook delivery`,
      {
        level: 'warning',
        tags: {
          integration_id: integration.id,
          envelope_status: failure.envelope_status,
        },
        extra: {
          org_id: integration.org_id,
          account_id: integration.account_id,
          completed_at: failure.completed_at,
          detected_at: new Date().toISOString(),
          source: 'connect_failures_api',
        },
      },
    );
  } catch (sentryErr) {
    logger.error(
      { error: sentryErr, envelopeId: failure.envelope_id },
      'Connect failures: Sentry alert failed',
    );
  }
}

/**
 * Inserts a single gap row, updating result counters. Duplicates are skipped
 * silently; only genuinely NEW gaps fire a Sentry alert.
 */
async function recordGap(
  deps: ConnectFailuresDeps,
  integration: ActiveIntegration,
  failure: ConnectFailureGap,
  result: ConnectFailuresResult,
): Promise<void> {
  const insertResult = await deps.insertGap({
    org_id: integration.org_id,
    integration_id: integration.id,
    account_id: integration.account_id,
    envelope_id: failure.envelope_id,
    envelope_status: failure.envelope_status,
    completed_at: failure.completed_at,
  });

  if (insertResult.error) {
    logger.error(
      {
        integrationId: integration.id,
        envelopeId: failure.envelope_id,
        error: insertResult.error,
      },
      'Connect failures: gap insert failed',
    );
    result.errors.push({
      integration_id: integration.id,
      error: `gap_insert(${failure.envelope_id}): ${insertResult.error}`,
    });
    result.ok = false;
    return;
  }

  if (insertResult.duplicate) {
    result.duplicates_skipped++;
    return;
  }

  result.gaps_inserted++;
  alertNewGap(integration, failure);
}

/**
 * Polls one integration: refresh token → list Connect failures → record each
 * as a gap. Failures are isolated per integration (logged + recorded, never
 * thrown) so one bad integration never halts the whole sweep.
 */
async function processIntegration(
  deps: ConnectFailuresDeps,
  integration: ActiveIntegration,
  fromDate: string,
  result: ConnectFailuresResult,
): Promise<void> {
  let accessToken: string;
  try {
    accessToken = await deps.getAccessToken(integration);
    result.token_refreshes++;
  } catch (err) {
    recordIntegrationError(result, integration.id, 'token_refresh', err);
    return;
  }

  let failures: ConnectFailureGap[];
  try {
    failures = await deps.listConnectFailures({
      baseUri: integration.base_uri,
      accountId: integration.account_id,
      accessToken,
      fromDate,
    });
  } catch (err) {
    recordIntegrationError(result, integration.id, 'connect_failures_api', err);
    return;
  }

  result.failures_polled += failures.length;
  for (const failure of failures) {
    await recordGap(deps, integration, failure, result);
  }
}

export async function pollDocusignConnectFailures(
  deps: ConnectFailuresDeps,
  lookbackHours: number = DEFAULT_LOOKBACK_HOURS,
): Promise<ConnectFailuresResult> {
  const result: ConnectFailuresResult = {
    ok: true,
    integrations_checked: 0,
    failures_polled: 0,
    gaps_inserted: 0,
    duplicates_skipped: 0,
    errors: [],
    token_refreshes: 0,
  };

  let integrations: ActiveIntegration[];
  try {
    integrations = await deps.listActiveIntegrations();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'Connect failures: failed to list active integrations');
    return { ...result, ok: false, errors: [{ integration_id: '*', error: msg }] };
  }

  const fromDate = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  for (const integration of integrations) {
    result.integrations_checked++;
    await processIntegration(deps, integration, fromDate, result);
  }

  if (result.gaps_inserted > 0) {
    logger.warn(
      {
        gaps_inserted: result.gaps_inserted,
        integrations_checked: result.integrations_checked,
        failures_polled: result.failures_polled,
      },
      'DocuSign Connect failures poll inserted new reconciliation gaps',
    );
  }

  return result;
}
