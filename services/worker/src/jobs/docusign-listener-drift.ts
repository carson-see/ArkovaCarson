/**
 * SCRUM-2098 — DocuSign Connect listener config drift reconciliation.
 *
 * Detects DocuSign-side listener drift that can stop completed-envelope webhooks
 * from reaching Arkova. Detection only: no auto-remediation or DocuSign writes.
 */

import { logger } from '../utils/logger.js';
import type { ActiveIntegration } from './docusign-reconciliation.js';

export interface ExpectedConnectConfig {
  urlToPublishTo: string;
  requiredEnvelopeEvents: string[];
  requiredEvents: string[];
  hmacEnabled: boolean;
  payloadFormat: string;
  payloadVersion: string;
}

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
  getExpectedConfig(): ExpectedConnectConfig;
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

function normalizeUrl(url: string | undefined): string {
  if (!url) return '';
  let normalized = url.trim();
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

export function detectDrift(
  listeners: ActualConnectListener[],
  expected: ExpectedConnectConfig,
): string[] {
  const expectedUrl = normalizeUrl(expected.urlToPublishTo);
  const match = listeners.find((listener) => normalizeUrl(listener.urlToPublishTo) === expectedUrl);

  if (!match) {
    return [
      `No Connect listener found publishing to the expected Arkova webhook URL (${expected.urlToPublishTo}).`,
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
      `HMAC signing is not enabled (includeHMAC=${String(match.includeHMAC)}, expected "true").`,
    );
  }

  // DocuSign has TWO event vocabularies and a listener uses ONE of them:
  //   - SIM (deliveryMode "SIM")  -> `events: ["envelope-completed"]`
  //   - legacy/aggregate          -> `envelopeEvents: ["Completed"]`
  // Requiring BOTH reported permanent drift on the live production listener,
  // which is SIM-mode and carries no `envelopeEvents` at all (prod
  // 2026-08-01T19:55:40Z, integration a900d40f) — while that same listener was
  // demonstrably delivering completed envelopes. An hourly false positive
  // buries the real signal, so coverage is satisfied by EITHER vocabulary and
  // only a listener subscribed to neither is drifted.
  const coveredBySim = expected.requiredEvents.every(
    (required) => (match.events ?? []).includes(required),
  );
  const coveredByLegacy = expected.requiredEnvelopeEvents.every(
    (required) => (match.envelopeEvents ?? []).includes(required),
  );
  if (!coveredBySim && !coveredByLegacy) {
    reasons.push(
      'Listener is not subscribed to completed-envelope notifications '
      + `(events=${JSON.stringify(match.events ?? [])}, `
      + `envelopeEvents=${JSON.stringify(match.envelopeEvents ?? [])}; expected `
      + `${JSON.stringify(expected.requiredEvents)} or `
      + `${JSON.stringify(expected.requiredEnvelopeEvents)}).`,
    );
  }

  // DocuSign omits `eventData.format` when it is the default (JSON for
  // restv2.1), so an ABSENT format is not drift — only an explicitly different
  // one is. The VERSION check below is deliberately NOT relaxed the same way:
  // an absent version really does mean the listener is not pinned to
  // restv2.1, which changes the payload shape the webhook parser expects.
  if (match.eventData?.format !== undefined && match.eventData.format !== expected.payloadFormat) {
    reasons.push(
      `Wrong payload format (eventData.format=${String(match.eventData.format)}, expected "${expected.payloadFormat}").`,
    );
  }

  if (match.eventData?.version !== expected.payloadVersion) {
    reasons.push(
      `Wrong payload version (eventData.version=${String(match.eventData?.version)}, expected "${expected.payloadVersion}").`,
    );
  }

  return reasons;
}

function recordError(
  result: ListenerDriftResult,
  integrationId: string,
  kind: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ integrationId, error: message }, `DocuSign listener drift ${kind} failed`);
  result.errors.push({ integration_id: integrationId, error: `${kind}: ${message}` });
  result.ok = false;
}

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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'DocuSign listener drift integration listing failed');
    return { ...result, ok: false, errors: [{ integration_id: '*', error: message }] };
  }

  const expected = deps.getExpectedConfig();

  for (const integration of integrations) {
    result.integrations_checked++;

    let accessToken: string;
    try {
      accessToken = await deps.getAccessToken(integration);
    } catch (error) {
      recordError(result, integration.id, 'token_refresh', error);
      continue;
    }

    let listeners: ActualConnectListener[];
    try {
      listeners = await deps.getConnectConfigurations({
        baseUri: integration.base_uri,
        accountId: integration.account_id,
        accessToken,
      });
    } catch (error) {
      recordError(result, integration.id, 'connect_api', error);
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
    } catch (error) {
      logger.error({ error, integrationId: integration.id }, 'DocuSign listener drift report failed');
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
