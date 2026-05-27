/**
 * SCRUM-2042 — Production wiring for DocuSign reconciliation.
 *
 * Adapts Supabase DB + DocuSign Envelopes API + token store into the
 * ReconciliationDeps interface consumed by the pure reconcileDocusignGaps().
 */

import { db as defaultDb } from '../utils/db.js';
import { refreshDocusignAccessToken } from '../integrations/oauth/docusign.js';
import {
  createGcpSecretManagerRefreshTokenStore,
  type DocusignRefreshTokenStore,
} from '../integrations/connectors/docusign-token-store.js';
import type {
  ReconciliationDeps,
  ActiveIntegration,
  EnvelopeSummary,
} from './docusign-reconciliation.js';

export interface ReconciliationDepOptions {
  db?: { from: (table: string) => any; rpc?: (...args: any[]) => any };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  refreshTokenStore?: DocusignRefreshTokenStore;
}

export function makeReconciliationDeps(
  options: ReconciliationDepOptions = {},
): ReconciliationDeps {
  const db = options.db ?? (defaultDb as any);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const refreshTokenStore =
    options.refreshTokenStore ??
    createGcpSecretManagerRefreshTokenStore({ env, fetchImpl });

  return {
    async listActiveIntegrations(): Promise<ActiveIntegration[]> {
      const { data, error } = await db
        .from('org_integrations')
        .select('id, org_id, account_id, base_uri, token_secret_name')
        .eq('provider', 'docusign')
        .is('revoked_at', null);

      if (error) throw new Error(`integration_list_failed: ${error.message ?? error}`);
      return (data ?? []).filter(
        (row: any) => row.account_id && row.base_uri && row.token_secret_name,
      );
    },

    async getAccessToken(integration: ActiveIntegration): Promise<string> {
      const refreshToken = await refreshTokenStore.get({
        name: integration.token_secret_name,
      });
      if (!refreshToken) {
        throw new Error('refresh_token_not_found');
      }

      const result = await refreshDocusignAccessToken({
        refreshToken,
        deps: { env, fetchImpl },
      });

      if (result.refresh_token && result.refresh_token !== refreshToken) {
        await refreshTokenStore.put({
          name: integration.token_secret_name,
          value: result.refresh_token,
        });
      }

      return result.access_token;
    },

    async listCompletedEnvelopes(args): Promise<EnvelopeSummary[]> {
      let base = args.baseUri;
      while (base.endsWith('/')) base = base.slice(0, -1);
      const url = `${base}/restapi/v2.1/accounts/${encodeURIComponent(args.accountId)}/envelopes?from_date=${encodeURIComponent(args.fromDate)}&status=completed&count=100`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${args.accessToken}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`envelopes_api_${res.status}: ${body.slice(0, 200)}`);
        }
        const json = (await res.json()) as {
          envelopes?: Array<{
            envelopeId?: string;
            status?: string;
            completedDateTime?: string;
          }>;
        };
        return (json.envelopes ?? [])
          .filter((e) => e.envelopeId && e.completedDateTime)
          .map((e) => ({
            envelopeId: e.envelopeId!,
            status: e.status ?? 'completed',
            completedDateTime: e.completedDateTime!,
          }));
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('envelopes_api_timeout');
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }
    },

    async getReceivedEnvelopeIds(
      _integrationId: string,
      envelopeIds: string[],
    ): Promise<Set<string>> {
      if (envelopeIds.length === 0) return new Set();
      const { data, error } = await db
        .from('docusign_webhook_nonces')
        .select('envelope_id')
        .in('envelope_id', envelopeIds);

      if (error) throw new Error(`nonce_lookup_failed: ${error.message ?? error}`);
      return new Set((data ?? []).map((r: { envelope_id: string }) => r.envelope_id));
    },

    async insertGap(gap) {
      const { error } = await db.from('docusign_reconciliation_gaps').insert({
        org_id: gap.org_id,
        integration_id: gap.integration_id,
        account_id: gap.account_id,
        envelope_id: gap.envelope_id,
        envelope_status: gap.envelope_status,
        completed_at: gap.completed_at,
      });

      if (error) {
        if ((error as { code?: string }).code === '23505') {
          return { inserted: false, duplicate: true, error: null };
        }
        const msg =
          typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message: string }).message)
            : String(error);
        return { inserted: false, duplicate: false, error: msg };
      }
      return { inserted: true, duplicate: false, error: null };
    },
  };
}
