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

/**
 * Minimal structural shape of the Supabase query builder this module uses.
 * The full SupabaseClient generic types are impractical to thread through a
 * test-injectable shim, so we model only the `from`/`rpc` surface. Each query
 * chain is a thenable PostgrestBuilder; we model it loosely and narrow the
 * awaited `{ data, error }` results at each call site.
 */
type PostgrestLikeBuilder = {
  select: (cols: string) => PostgrestLikeBuilder;
  eq: (col: string, val: unknown) => PostgrestLikeBuilder;
  is: (col: string, val: unknown) => PostgrestLikeBuilder;
  in: (col: string, vals: readonly unknown[]) => PostgrestLikeBuilder;
  insert: (row: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
  then: Promise<{ data: unknown; error: unknown }>['then'];
};

type SupabaseQueryDb = {
  from: (table: string) => PostgrestLikeBuilder;
  rpc?: (...args: unknown[]) => unknown;
};

export interface ReconciliationDepOptions {
  db?: SupabaseQueryDb;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  refreshTokenStore?: DocusignRefreshTokenStore;
}

/** Row shape returned by the integration listing queries. */
interface IntegrationRow {
  id: string;
  org_id: string;
  account_id: string | null;
  base_uri: string | null;
  token_secret_name: string | null;
}

export function makeReconciliationDeps(
  options: ReconciliationDepOptions = {},
): ReconciliationDeps {
  const db = options.db ?? (defaultDb as unknown as SupabaseQueryDb);
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
      const { data: orgData, error: orgError } = (await db
        .from('org_integrations')
        .select('id, org_id, account_id, base_uri, token_secret_name')
        .eq('provider', 'docusign')
        .is('revoked_at', null)) as { data: IntegrationRow[] | null; error: { message?: string } | null };

      if (orgError) throw new Error(`integration_list_failed: ${orgError.message ?? orgError}`);

      // SCRUM-2044: Member-level integrations (member_integrations is not in the
      // multi-tenant table set; same cross-tenant cron rationale applies).
      const { data: memberData, error: memberError } = (await db
        .from('member_integrations')
        .select('id, org_id, account_id, base_uri, token_secret_name')
        .eq('provider', 'docusign')
        .is('revoked_at', null)) as { data: IntegrationRow[] | null; error: { message?: string } | null };

      if (memberError) throw new Error(`member_integration_list_failed: ${memberError.message ?? memberError}`);

      const allRows: IntegrationRow[] = [...(orgData ?? []), ...(memberData ?? [])];
      return allRows.filter(
        (row): row is ActiveIntegration =>
          Boolean(row.account_id && row.base_uri && row.token_secret_name),
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
      const { data, error } = (await db
        .from('docusign_webhook_nonces')
        .select('envelope_id')
        .in('envelope_id', envelopeIds)) as {
        data: Array<{ envelope_id: string }> | null;
        error: { message?: string } | null;
      };

      if (error) throw new Error(`nonce_lookup_failed: ${error.message ?? error}`);
      return new Set((data ?? []).map((r) => r.envelope_id));
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
