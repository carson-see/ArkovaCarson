/**
 * SCRUM-2098 [DS-LISTEN-01] — DocuSign Connect listener config daily drift reconciliation.
 *
 * A DocuSign org admin can silently change or disable the Connect listener
 * (publish URL, event subscriptions, HMAC, payload format) in the DocuSign UI.
 * Any such change silently breaks envelope ingestion — the webhook simply stops
 * arriving (or arrives unsigned / in the wrong shape).
 *
 * This daily job, for each active DocuSign integration, fetches the ACTUAL
 * Connect listener config from DocuSign (GET /connect) and compares it against
 * the EXPECTED config Arkova provisions (see `buildArkovaConnectConfig` in
 * integrations/oauth/docusign.ts — the SAME source `provisionConnectListener`
 * uses, so the two never drift from each other). On any mismatch it fires a
 * Sentry alert describing the drift.
 *
 * Detection only — it does NOT auto-remediate (that is a separate story).
 *
 * Pure function pattern: all I/O injected via ListenerDriftDeps (same approach
 * as docusign-reconciliation.ts / connector-health-alert.ts). The comparison
 * itself is the pure, trivially-unit-testable `detectDrift()`.
 */

import { logger } from '../utils/logger.js';
import type { ActiveIntegration } from './docusign-reconciliation.js';

/**
 * The canonical "expected" Connect listener config Arkova provisions.
 * Derived from the same env/constants as provisionConnectListener so the
 * drift check stays consistent if provisioning changes.
 */
export interface ExpectedConnectConfig {
  /** Webhook URL Arkova publishes to: `${WORKER_PUBLIC_URL}/webhooks/docusign`. */
  urlToPublishTo: string;
  /** Envelope-level events that must be subscribed (e.g. `['Completed']`). */
  requiredEnvelopeEvents: string[];
  /** Connect events that must be subscribed (e.g. `['envelope-completed']`). */
  requiredEvents: string[];
  /** Whether HMAC signing must be enabled. */
  hmacEnabled: boolean;
  /** Required payload/event-data format (e.g. `'json'`). */
  payloadFormat: string;
}

/**
 * A single Connect listener as returned by DocuSign's
 * GET /restapi/v2.1/accounts/{accountId}/connect "getConfigurations" endpoint.
 * Boolean-ish flags are DocuSign's string `'true'`/`'false'` convention.
 */
export interface ActualConnectListener {
  connectId: string;
  name?: string;
  urlToPublishTo?: string;
  allowEnvelopePublish?: string;
  includeHMAC?: string;
  envelopeEvents?: string[];
  events?: string[];
  eventData?: { format?: string; version?: string };
}

export interface DriftInfo {
  integration_id: string;
  org_id: string;
  account_id: string;
  reasons: string[];
}

export interface ListenerDriftDeps {
  listActiveIntegrations(): Promise<ActiveIntegration[]>;

  getAccessToken(integration: ActiveIntegration): Promise<string>;

  getConnectConfigurations(args: {
    baseUri: string;
    accountId: string;
    accessToken: string;
  }): Promise<ActualConnectListener[]>;

  /** Returns the canonical expected config. Pure/synchronous (env-derived). */
  getExpectedConfig(): ExpectedConnectConfig;

  /** Side effect: fire a Sentry alert describing the drift. */
  reportDrift(drift: DriftInfo): void;
}

export interface ListenerDriftResult {
  ok: boolean;
  integrations_checked: number;
  drift_detected: number;
  in_sync: number;
  errors: Array<{ integration_id: string; error: string }>;
  drifts: Array<{ integration_id: string; reasons: string[] }>;
}

const DOCUSIGN_TRUE = 'true';

/** Normalize a publish URL for comparison: trim trailing slashes + lowercase host-insensitively-safe trim. */
function normalizeUrl(url: string | undefined): string {
  if (!url) return '';
  let u = url.trim();
  while (u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

/**
 * PURE comparison: given the account's actual Connect listeners and the expected
 * config, return a list of human-readable drift reasons. Empty array === in sync.
 *
 * Algorithm:
 *  1. Find the listener whose urlToPublishTo matches Arkova's expected URL
 *     (trailing-slash-insensitive). If none → single "missing listener" reason
 *     (we cannot meaningfully diff event/HMAC/format of a listener that is not ours).
 *  2. Otherwise diff the matching listener against expectations:
 *     - allowEnvelopePublish must be 'true'      (listener enabled)
 *     - includeHMAC must be 'true' (when expected) (deliveries signed)
 *     - every required envelope event subscribed
 *     - every required Connect event subscribed
 *     - eventData.format must equal the expected payload format
 */
export function detectDrift(
  listeners: ActualConnectListener[],
  expected: ExpectedConnectConfig,
): string[] {
  const expectedUrl = normalizeUrl(expected.urlToPublishTo);
  const match = listeners.find((l) => normalizeUrl(l.urlToPublishTo) === expectedUrl);

  if (!match) {
    return [
      `No Connect listener found publishing to the expected Arkova webhook URL (${expected.urlToPublishTo}); ingestion of completed envelopes will silently stop.`,
    ];
  }

  const reasons: string[] = [];

  if (match.allowEnvelopePublish !== DOCUSIGN_TRUE) {
    reasons.push(
      `Connect listener is disabled (allowEnvelopePublish=${String(match.allowEnvelopePublish)}, expected "true").`,
    );
  }

  if (expected.hmacEnabled && match.includeHMAC !== DOCUSIGN_TRUE) {
    reasons.push(
      `HMAC signing is not enabled (includeHMAC=${String(match.includeHMAC)}, expected "true"); webhook deliveries cannot be authenticated.`,
    );
  }

  const envelopeEvents = match.envelopeEvents ?? [];
  for (const required of expected.requiredEnvelopeEvents) {
    if (!envelopeEvents.includes(required)) {
      reasons.push(
        `Missing required envelope event "${required}" (subscribed: [${envelopeEvents.join(', ')}]).`,
      );
    }
  }

  const events = match.events ?? [];
  for (const required of expected.requiredEvents) {
    if (!events.includes(required)) {
      reasons.push(
        `Missing required Connect event "${required}" (subscribed: [${events.join(', ')}]).`,
      );
    }
  }

  const actualFormat = match.eventData?.format;
  if (actualFormat !== expected.payloadFormat) {
    reasons.push(
      `Wrong payload format (eventData.format=${String(actualFormat)}, expected "${expected.payloadFormat}").`,
    );
  }

  return reasons;
}

/**
 * Orchestration: for each active DocuSign integration, fetch the live Connect
 * listeners, diff against the expected config via detectDrift(), and report any
 * drift to Sentry. One bad integration never starves the rest.
 */
export async function reconcileListenerDrift(
  deps: ListenerDriftDeps,
): Promise<ListenerDriftResult> {
  const result: ListenerDriftResult = {
    ok: true,
    integrations_checked: 0,
    drift_detected: 0,
    in_sync: 0,
    errors: [],
    drifts: [],
  };

  let integrations: ActiveIntegration[];
  try {
    integrations = await deps.listActiveIntegrations();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'Listener drift: failed to list active integrations');
    return { ...result, ok: false, errors: [{ integration_id: '*', error: msg }] };
  }

  const expected = deps.getExpectedConfig();

  for (const integration of integrations) {
    result.integrations_checked++;

    let accessToken: string;
    try {
      accessToken = await deps.getAccessToken(integration);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { integrationId: integration.id, error: msg },
        'Listener drift: token refresh failed',
      );
      result.errors.push({ integration_id: integration.id, error: `token_refresh: ${msg}` });
      result.ok = false;
      continue;
    }

    let listeners: ActualConnectListener[];
    try {
      listeners = await deps.getConnectConfigurations({
        baseUri: integration.base_uri,
        accountId: integration.account_id,
        accessToken,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { integrationId: integration.id, error: msg },
        'Listener drift: Connect API fetch failed',
      );
      result.errors.push({ integration_id: integration.id, error: `connect_api: ${msg}` });
      result.ok = false;
      continue;
    }

    const reasons = detectDrift(listeners, expected);

    if (reasons.length === 0) {
      result.in_sync++;
      continue;
    }

    result.drift_detected++;
    result.drifts.push({ integration_id: integration.id, reasons });

    try {
      deps.reportDrift({
        integration_id: integration.id,
        org_id: integration.org_id,
        account_id: integration.account_id,
        reasons,
      });
    } catch (sentryErr) {
      logger.error(
        { error: sentryErr, integrationId: integration.id },
        'Listener drift: Sentry alert failed',
      );
    }
  }

  if (result.drift_detected > 0) {
    logger.warn(
      {
        drift_detected: result.drift_detected,
        integrations_checked: result.integrations_checked,
        in_sync: result.in_sync,
      },
      'DocuSign Connect listener drift detected',
    );
  }

  return result;
}
