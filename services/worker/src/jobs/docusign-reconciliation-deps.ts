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

interface DbQueryResult<T> {
  data: T | null;
  error: { code?: string; message?: string } | string | null;
}

interface DbQuery<T> extends PromiseLike<DbQueryResult<T>> {
  select(columns?: string): DbQuery<T>;
  eq(field: string, value: unknown): DbQuery<T>;
  is(field: string, value: unknown): DbQuery<T>;
  in(field: string, values: readonly unknown[]): DbQuery<T>;
  insert(value: Record<string, unknown>): PromiseLike<DbQueryResult<null>>;
}

type IntegrationRow = {
  id?: unknown;
  org_id?: unknown;
  account_id?: unknown;
  base_uri?: unknown;
  token_secret_name?: unknown;
};

type NonceRow = {
  envelope_id?: unknown;
};

interface DbClient {
  from(table: 'org_integrations' | 'member_integrations'): DbQuery<IntegrationRow[]>;
  from(table: 'docusign_webhook_nonces'): DbQuery<NonceRow[]>;
  from(table: 'docusign_reconciliation_gaps'): DbQuery<null>;
}

function dbErrorMessage(error: DbQueryResult<unknown>['error']): string {
  if (!error) return 'unknown_error';
  if (typeof error === 'string') return error;
  return error.message ?? String(error);
}

function dbErrorCode(error: DbQueryResult<unknown>['error']): string | null {
  if (!error || typeof error === 'string') return null;
  return error.code ?? null;
}

export interface ReconciliationDepOptions {
  db?: DbClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  refreshTokenStore?: DocusignRefreshTokenStore;
}

function toActiveIntegration(row: IntegrationRow): ActiveIntegration | null {
  if (
    typeof row.id !== 'string' ||
    typeof row.org_id !== 'string' ||
    typeof row.account_id !== 'string' ||
    typeof row.base_uri !== 'string' ||
    typeof row.token_secret_name !== 'string'
  ) {
    return null;
  }

  return {
    id: row.id,
    org_id: row.org_id,
    account_id: row.account_id,
    base_uri: row.base_uri,
    token_secret_name: row.token_secret_name,
  };
}

export function makeReconciliationDeps(
  options: ReconciliationDepOptions = {},
): ReconciliationDeps {
  const db = options.db ?? (defaultDb as unknown as DbClient);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const refreshTokenStore =
    options.refreshTokenStore ??
    createGcpSecretManagerRefreshTokenStore({ env, fetchImpl });

  return {
    async listActiveIntegrations(): Promise<ActiveIntegration[]> {
      // Org-level integrations (existing).
      // tenant-isolation suppressed: this is a service-role cron (invoked from
      // src/routes/cron.ts) that intentionally enumerates DocuSign integrations
      // across ALL orgs to reconcile each tenant's envelopes. There is no
      // per-org caller context; each row carries its own org_id which scopes all
      // downstream work. Org-agnostic by design (SCRUM-2042 reconciliation job).
      // eslint-disable-next-line arkova/missing-org-filter
      const { data: orgData, error: orgError } = await db
        .from('org_integrations')
        .select('id, org_id, account_id, base_uri, token_secret_name')
        .eq('provider', 'docusign')
        .is('revoked_at', null);

      if (orgError) throw new Error(`integration_list_failed: ${dbErrorMessage(orgError)}`);

      // SCRUM-2044: Member-level integrations (member_integrations is not in the
      // multi-tenant table set; same cross-tenant cron rationale applies).
      const { data: memberData, error: memberError } = await db
        .from('member_integrations')
        .select('id, org_id, account_id, base_uri, token_secret_name')
        .eq('provider', 'docusign')
        .is('revoked_at', null);

      if (memberError) throw new Error(`member_integration_list_failed: ${dbErrorMessage(memberError)}`);

      const allRows = [...(orgData ?? []), ...(memberData ?? [])];
      return allRows.flatMap((row) => {
        const integration = toActiveIntegration(row);
        return integration ? [integration] : [];
      });
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

      const MAX_PAGES = 10;
      const allEnvelopes: EnvelopeSummary[] = [];
      let nextUrl: string | null =
        `${base}/restapi/v2.1/accounts/${encodeURIComponent(args.accountId)}/envelopes?from_date=${encodeURIComponent(args.fromDate)}&status=completed&count=100`;

      for (let page = 0; page < MAX_PAGES && nextUrl; page++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        try {
          const res = await fetchImpl(nextUrl, {
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
            nextUri?: string;
          };

          const pageEnvelopes = (json.envelopes ?? [])
            .filter((e) => e.envelopeId && e.completedDateTime)
            .map((e) => ({
              envelopeId: e.envelopeId!,
              status: e.status ?? 'completed',
              completedDateTime: e.completedDateTime!,
            }));
          allEnvelopes.push(...pageEnvelopes);

          if (json.nextUri) {
            if (json.nextUri.startsWith('http')) {
              const nextOrigin = new URL(json.nextUri).origin;
              const expectedOrigin = new URL(base).origin;
              nextUrl = nextOrigin === expectedOrigin ? json.nextUri : null;
            } else {
              nextUrl = `${base}${json.nextUri}`;
            }
          } else {
            nextUrl = null;
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            throw new Error('envelopes_api_timeout', { cause: err });
          }
          throw err;
        } finally {
          clearTimeout(timeout);
        }
      }

      return allEnvelopes;
    },

    async getReceivedEnvelopeIds(
      _integrationId: string,
      envelopeIds: string[],
    ): Promise<Set<string>> {
      if (envelopeIds.length === 0) return new Set();
      // tenant-isolation suppressed: docusign_webhook_nonces is a GLOBAL
      // replay-protection nonce table with NO org_id column (schema keyed on
      // envelope_id, event_id, generated_at — see baseline migration). There is
      // no tenant column to filter on; the lookup is already scoped to a known,
      // bounded set of envelope_ids derived from one integration's envelopes.
      // eslint-disable-next-line arkova/missing-org-filter
      const { data, error } = await db
        .from('docusign_webhook_nonces')
        .select('envelope_id')
        .in('envelope_id', envelopeIds);

      if (error) throw new Error(`nonce_lookup_failed: ${dbErrorMessage(error)}`);
      return new Set((data ?? [])
        .map((row) => row.envelope_id)
        .filter((value): value is string => typeof value === 'string'));
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
        if (dbErrorCode(error) === '23505') {
          return { inserted: false, duplicate: true, error: null };
        }
        return { inserted: false, duplicate: false, error: dbErrorMessage(error) };
      }
      return { inserted: true, duplicate: false, error: null };
    },
  };
}
