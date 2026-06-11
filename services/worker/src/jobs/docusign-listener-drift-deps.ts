/**
 * SCRUM-2098 — production dependencies for DocuSign listener drift checks.
 */

import { z } from 'zod';
import * as Sentry from '@sentry/node';
import { logger } from '../utils/logger.js';
import { buildArkovaConnectConfig } from '../integrations/oauth/docusign.js';
import {
  createGcpSecretManagerRefreshTokenStore,
  type DocusignRefreshTokenStore,
} from '../integrations/connectors/docusign-token-store.js';
import { makeReconciliationDeps } from './docusign-reconciliation-deps.js';
import type {
  ActualConnectListener,
  DriftInfo,
  ExpectedConnectConfig,
  ListenerDriftDeps,
} from './docusign-listener-drift.js';

const CONNECT_API_TIMEOUT_MS = 30_000;

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

function trimTrailingSlashes(value: string): string {
  let trimmed = value;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

export function makeListenerDriftDeps(
  options: ListenerDriftDepOptions = {},
): ListenerDriftDeps {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const refreshTokenStore =
    options.refreshTokenStore ??
    createGcpSecretManagerRefreshTokenStore({ env, fetchImpl });
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
      const base = trimTrailingSlashes(args.baseUri);
      const url = `${base}/restapi/v2.1/accounts/${encodeURIComponent(args.accountId)}/connect`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONNECT_API_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${args.accessToken}` },
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`connect_api_${response.status}: ${text.slice(0, 200)}`);
        }
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
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('connect_api_timeout', { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },

    getExpectedConfig(): ExpectedConnectConfig {
      const config = buildArkovaConnectConfig(env);
      return {
        urlToPublishTo: config.urlToPublishTo,
        requiredEnvelopeEvents: config.envelopeEvents,
        requiredEvents: config.events,
        hmacEnabled: config.hmacEnabled,
        payloadFormat: config.payloadFormat,
        payloadVersion: config.payloadVersion,
      };
    },

    reportDrift(drift: DriftInfo): void {
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
