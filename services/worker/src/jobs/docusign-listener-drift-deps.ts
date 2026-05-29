/**
 * SCRUM-2098 [DS-LISTEN-01] — Production wiring for DocuSign Connect listener
 * drift reconciliation.
 *
 * Adapts Supabase DB + DocuSign Connect API (GET /connect "getConfigurations")
 * + token store + Sentry into the ListenerDriftDeps interface consumed by the
 * pure reconcileListenerDrift().
 *
 * Reuses makeReconciliationDeps (docusign-reconciliation-deps.ts) for
 * listActiveIntegrations + getAccessToken so the two jobs see the same set of
 * active integrations and token-refresh behavior (single source, no drift).
 *
 * The expected config comes from buildArkovaConnectConfig() — the SAME helper
 * provisionConnectListener uses — so the drift check never diverges from what
 * Arkova actually provisions.
 */

import { z } from 'zod';
import * as Sentry from '@sentry/node';

import { logger } from '../utils/logger.js';
import { buildArkovaConnectConfig } from '../integrations/oauth/docusign.js';
import {
  createGcpSecretManagerRefreshTokenStore,
  type DocusignRefreshTokenStore,
} from '../integrations/connectors/docusign-token-store.js';
import type {
  ListenerDriftDeps,
  ActualConnectListener,
  ExpectedConnectConfig,
  DriftInfo,
} from './docusign-listener-drift.js';
import { makeReconciliationDeps } from './docusign-reconciliation-deps.js';

const CONNECT_API_TIMEOUT_MS = 30_000;

/**
 * Zod shape for DocuSign's GET /connect "getConfigurations" response. We parse
 * defensively (`.passthrough()`, optional fields) because DocuSign returns a
 * large object and may add fields; we only need the drift-relevant ones. A
 * missing/empty body is treated as "no listeners configured".
 */
const ConnectListenerSchema = z
  .object({
    connectId: z.string().or(z.number()).transform(String),
    name: z.string().optional(),
    urlToPublishTo: z.string().optional(),
    allowEnvelopePublish: z.string().optional(),
    includeHMAC: z.string().optional(),
    envelopeEvents: z.array(z.string()).optional(),
    events: z.array(z.string()).optional(),
    eventData: z
      .object({ format: z.string().optional(), version: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ConnectConfigurationsResponseSchema = z
  .object({
    configurations: z.array(ConnectListenerSchema).default([]),
  })
  .passthrough();

export interface ListenerDriftDepOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?: { from: (table: string) => any; rpc?: (...args: any[]) => any };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  refreshTokenStore?: DocusignRefreshTokenStore;
}

export function makeListenerDriftDeps(
  options: ListenerDriftDepOptions = {},
): ListenerDriftDeps {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const refreshTokenStore =
    options.refreshTokenStore ??
    createGcpSecretManagerRefreshTokenStore({ env, fetchImpl });
  // listActiveIntegrations + getAccessToken are identical to the SCRUM-2042
  // reconciliation job; reuse that factory so both jobs share one active-
  // integration query and token-refresh path (no duplicated wiring to drift).
  const shared = makeReconciliationDeps({
    db: options.db,
    env,
    fetchImpl,
    refreshTokenStore,
  });

  return {
    listActiveIntegrations: shared.listActiveIntegrations,
    getAccessToken: shared.getAccessToken,

    async getConnectConfigurations(args): Promise<ActualConnectListener[]> {
      let base = args.baseUri;
      while (base.endsWith('/')) base = base.slice(0, -1);
      const url = `${base}/restapi/v2.1/accounts/${encodeURIComponent(args.accountId)}/connect`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONNECT_API_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${args.accessToken}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`connect_api_${res.status}: ${body.slice(0, 200)}`);
        }

        // DocuSign may return null/empty body when no listeners exist.
        const text = await res.text();
        if (!text) return [];
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error('connect_api_invalid_json');
        }

        const parsed = ConnectConfigurationsResponseSchema.safeParse(json);
        if (!parsed.success) {
          throw new Error(`connect_api_schema_mismatch: ${parsed.error.message}`);
        }
        return parsed.data.configurations as ActualConnectListener[];
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('connect_api_timeout', { cause: err });
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }
    },

    getExpectedConfig(): ExpectedConnectConfig {
      const cfg = buildArkovaConnectConfig(env);
      return {
        urlToPublishTo: cfg.urlToPublishTo,
        requiredEnvelopeEvents: cfg.envelopeEvents,
        requiredEvents: cfg.events,
        hmacEnabled: cfg.hmacEnabled,
        payloadFormat: cfg.payloadFormat,
      };
    },

    reportDrift(drift: DriftInfo): void {
      // No tokens/secrets/PII in the event — only org/account/integration ids
      // and the human-readable drift reasons.
      Sentry.captureMessage(
        `DocuSign Connect listener drift detected for integration ${drift.integration_id}: ${drift.reasons.length} issue(s)`,
        {
          level: 'warning',
          tags: {
            integration_id: drift.integration_id,
            org_id: drift.org_id,
          },
          extra: {
            account_id: drift.account_id,
            reasons: drift.reasons,
            detected_at: new Date().toISOString(),
          },
        },
      );
      logger.warn(
        { integrationId: drift.integration_id, reasons: drift.reasons },
        'DocuSign Connect listener drift',
      );
    },
  };
}
