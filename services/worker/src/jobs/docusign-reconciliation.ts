/**
 * SCRUM-2042 — DocuSign retry exhaustion reconciliation (SOC 2 CC7.2).
 *
 * Polls the DocuSign Envelopes API for completed envelopes in the last 24h,
 * diffs against received webhook nonces, and inserts gap rows for envelopes
 * that were never delivered. Fires a Sentry alert per gap detected.
 *
 * Also refreshes OAuth tokens to prevent 30-day expiry on idle connections.
 *
 * Pure function pattern: all I/O injected via ReconciliationDeps interface
 * (same approach as nonce-sweep.ts / connector-health-alert.ts).
 */

import * as Sentry from '@sentry/node';
import { logger } from '../utils/logger.js';

const DEFAULT_LOOKBACK_HOURS = 24;

export interface ActiveIntegration {
  id: string;
  org_id: string;
  account_id: string;
  base_uri: string;
  token_secret_name: string;
}

export interface EnvelopeSummary {
  envelopeId: string;
  status: string;
  completedDateTime: string;
}

export interface ReconciliationDeps {
  listActiveIntegrations(): Promise<ActiveIntegration[]>;

  getAccessToken(integration: ActiveIntegration): Promise<string>;

  listCompletedEnvelopes(args: {
    baseUri: string;
    accountId: string;
    accessToken: string;
    fromDate: string;
  }): Promise<EnvelopeSummary[]>;

  getReceivedEnvelopeIds(
    integrationId: string,
    envelopeIds: string[],
  ): Promise<Set<string>>;

  insertGap(gap: {
    org_id: string;
    integration_id: string;
    account_id: string;
    envelope_id: string;
    envelope_status: string;
    completed_at: string;
  }): Promise<{ inserted: boolean; duplicate: boolean; error: string | null }>;
}

export interface ReconciliationResult {
  ok: boolean;
  integrations_checked: number;
  envelopes_polled: number;
  gaps_detected: number;
  gaps_inserted: number;
  duplicates_skipped: number;
  errors: Array<{ integration_id: string; error: string }>;
  token_refreshes: number;
}

export async function reconcileDocusignGaps(
  deps: ReconciliationDeps,
  lookbackHours: number = DEFAULT_LOOKBACK_HOURS,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    ok: true,
    integrations_checked: 0,
    envelopes_polled: 0,
    gaps_detected: 0,
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
    logger.error({ error: msg }, 'Reconciliation: failed to list active integrations');
    return { ...result, ok: false, errors: [{ integration_id: '*', error: msg }] };
  }

  const fromDate = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();

  for (const integration of integrations) {
    result.integrations_checked++;

    let accessToken: string;
    try {
      accessToken = await deps.getAccessToken(integration);
      result.token_refreshes++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { integrationId: integration.id, error: msg },
        'Reconciliation: token refresh failed',
      );
      result.errors.push({ integration_id: integration.id, error: `token_refresh: ${msg}` });
      result.ok = false;
      continue;
    }

    let envelopes: EnvelopeSummary[];
    try {
      envelopes = await deps.listCompletedEnvelopes({
        baseUri: integration.base_uri,
        accountId: integration.account_id,
        accessToken,
        fromDate,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { integrationId: integration.id, error: msg },
        'Reconciliation: Envelopes API poll failed',
      );
      result.errors.push({ integration_id: integration.id, error: `envelopes_api: ${msg}` });
      result.ok = false;
      continue;
    }

    result.envelopes_polled += envelopes.length;
    if (envelopes.length === 0) continue;

    const envelopeIds = envelopes.map((e) => e.envelopeId);
    let receivedIds: Set<string>;
    try {
      receivedIds = await deps.getReceivedEnvelopeIds(integration.id, envelopeIds);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { integrationId: integration.id, error: msg },
        'Reconciliation: nonce lookup failed',
      );
      result.errors.push({ integration_id: integration.id, error: `nonce_lookup: ${msg}` });
      result.ok = false;
      continue;
    }

    const gaps = envelopes.filter((e) => !receivedIds.has(e.envelopeId));
    result.gaps_detected += gaps.length;

    for (const gap of gaps) {
      const insertResult = await deps.insertGap({
        org_id: integration.org_id,
        integration_id: integration.id,
        account_id: integration.account_id,
        envelope_id: gap.envelopeId,
        envelope_status: gap.status,
        completed_at: gap.completedDateTime,
      });

      if (insertResult.error) {
        logger.error(
          { integrationId: integration.id, envelopeId: gap.envelopeId, error: insertResult.error },
          'Reconciliation: gap insert failed',
        );
        result.errors.push({
          integration_id: integration.id,
          error: `gap_insert(${gap.envelopeId}): ${insertResult.error}`,
        });
        result.ok = false;
        continue;
      }

      if (insertResult.duplicate) {
        result.duplicates_skipped++;
        continue;
      }

      result.gaps_inserted++;

      try {
        Sentry.captureMessage(
          `DocuSign reconciliation gap: envelope ${gap.envelopeId} completed but never delivered`,
          {
            level: 'warning',
            tags: {
              integration_id: integration.id,
              envelope_status: gap.status,
            },
            extra: {
              org_id: integration.org_id,
              account_id: integration.account_id,
              completed_at: gap.completedDateTime,
              detected_at: new Date().toISOString(),
            },
          },
        );
      } catch (sentryErr) {
        logger.error(
          { error: sentryErr, envelopeId: gap.envelopeId },
          'Reconciliation: Sentry alert failed',
        );
      }
    }
  }

  if (result.gaps_inserted > 0) {
    logger.warn(
      {
        gaps_inserted: result.gaps_inserted,
        integrations_checked: result.integrations_checked,
        envelopes_polled: result.envelopes_polled,
      },
      'DocuSign reconciliation detected undelivered envelopes',
    );
  }

  return result;
}
