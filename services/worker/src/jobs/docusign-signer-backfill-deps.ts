/**
 * Production wiring for DocuSign signer backfill.
 *
 * Adapts Supabase (anchors, org_integrations/member_integrations) + the
 * DocuSign eSignature REST API + the refresh-token store into the
 * DocusignSignerBackfillDeps interface consumed by the pure
 * `runDocusignSignerBackfill()` (docusign-signer-backfill.ts). Follows the
 * `makeXxxDeps()` factory pattern `docusign-reconciliation-deps.ts` established.
 */
import { db as defaultDb } from '../utils/db.js';
import {
  refreshDocusignAccessToken,
  fetchDocusignEnvelopeRecipients,
} from '../integrations/oauth/docusign.js';
import { createDocusignRateLimitedFetch } from '../integrations/oauth/docusign-rate-limit.js';
import {
  createGcpSecretManagerRefreshTokenStore,
  type DocusignRefreshTokenStore,
} from '../integrations/connectors/docusign-token-store.js';
import { ENVELOPE_ID_METADATA_KEYS } from './docusign-anchor-reconciliation.js';
import type {
  DocusignSignerBackfillDeps,
  DocusignSignerBackfillIntegration,
  DocusignSignerBackfillCandidate,
} from './docusign-signer-backfill.js';

interface DbQueryResult<T> {
  data: T | null;
  error: { code?: string; message?: string } | string | null;
}

type IntegrationRow = {
  id?: unknown;
  org_id?: unknown;
  account_id?: unknown;
  base_uri?: unknown;
  token_secret_name?: unknown;
};

type AnchorCandidateRow = {
  id?: unknown;
  org_id?: unknown;
  metadata?: unknown;
  fingerprint_source?: unknown;
};

// The PostgREST fluent builder's real type is a moving target across query
// shapes (select vs update, array vs single-row); every sibling *-deps.ts in
// this directory either hand-rolls a narrow chain interface or casts to `any`
// at the call site (confirmation-proof-populate.ts, docusign-envelope-completed.ts).
// This file casts, matching that established precedent, rather than modeling
// the full builder.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export interface DocusignSignerBackfillDepOptions {
  db?: AnyDb;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  refreshTokenStore?: DocusignRefreshTokenStore;
}

function dbErrorMessage(error: DbQueryResult<unknown>['error']): string {
  if (!error) return 'unknown_error';
  if (typeof error === 'string') return error;
  return error.message ?? String(error);
}

function toIntegration(row: IntegrationRow): DocusignSignerBackfillIntegration | null {
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

/**
 * Resolve the DocuSign envelope id off a candidate anchor's metadata, trying
 * ENVELOPE_ID_METADATA_KEYS in order — the same key family
 * `findExistingEnvelopeAnchor` (docusign-anchor-reconciliation.ts) matches on,
 * so this job finds candidates regardless of which anchor-creation path
 * (declared-hash rules, or server-fetched connector) produced them.
 */
function extractEnvelopeId(metadata: Record<string, unknown> | null): string {
  if (!metadata) return '';
  for (const key of ENVELOPE_ID_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function toCandidate(row: AnchorCandidateRow): DocusignSignerBackfillCandidate | null {
  if (typeof row.id !== 'string' || typeof row.org_id !== 'string') return null;
  const metadata = row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>) : null;
  return {
    anchorId: row.id,
    orgId: row.org_id,
    envelopeId: extractEnvelopeId(metadata),
    metadata,
    fingerprintSource: typeof row.fingerprint_source === 'string' ? row.fingerprint_source : null,
  };
}

/**
 * ONE indexed point lookup per ENVELOPE_ID_METADATA_KEYS key — never a single
 * `.or()` across all three. Mirrors `findExistingEnvelopeAnchor`'s established
 * reasoning (docusign-anchor-reconciliation.ts): a 3-branch `.or()` across
 * unindexed-together JSONB expressions mis-costs on a multi-million-row org
 * and can exceed statement_timeout, while migration 0381's three per-key
 * partial expression indexes each make a single-key equality/`IS NOT NULL`
 * filter a cheap, plan-stable Index Scan.
 */
async function selectCandidatesForKey(
  db: AnyDb,
  orgId: string,
  key: string,
  limit: number,
): Promise<AnchorCandidateRow[]> {
  const { data, error } = (await db
    .from('anchors')
    .select('id, org_id, metadata, fingerprint_source')
    .eq('org_id', orgId)
    .is('deleted_at', null)
    .eq('metadata->>connector_source', 'docusign')
    .is('metadata->>_signers', null)
    // Separate completion watermark from `_signers` itself (see the WRITE
    // SAFETY section in docusign-signer-backfill.ts): a candidate that was
    // already processed and legitimately yielded zero signers has
    // `_signers_backfilled_at` set but `_signers` still absent. Without this
    // second filter such a row stays a "candidate" forever and is re-fetched
    // from DocuSign on every run. NOTE: `_signers_backfilled_at` needs to be
    // added to migration 0423's guarded metadata-key family once that
    // (separate, not-yet-merged) migration lands — see agents.md.
    .is('metadata->>_signers_backfilled_at', null)
    .not(`metadata->>${key}`, 'is', null)
    .limit(limit)) as DbQueryResult<AnchorCandidateRow[]>;

  if (error) throw new Error(`candidate_query_failed(${key}): ${dbErrorMessage(error)}`);
  return data ?? [];
}

export function makeDocusignSignerBackfillDeps(
  options: DocusignSignerBackfillDepOptions = {},
): DocusignSignerBackfillDeps {
  const db: AnyDb = options.db ?? defaultDb;
  const env = options.env ?? process.env;
  const fetchImplBase = options.fetchImpl ?? fetch;
  const refreshTokenStore =
    options.refreshTokenStore ?? createGcpSecretManagerRefreshTokenStore({ env, fetchImpl: fetchImplBase });

  // ONE rate-limited fetch shared by BOTH token refresh and the recipients
  // fetch (mirrors docusign-envelope-completed.ts's makeDocusignEnvelopeJobDeps),
  // so this job's DocuSign API usage draws from the SAME per-account
  // 3,000/hour token-bucket + Retry-After handling as the live envelope-
  // completed job, not a separate untracked budget. `tokenRefreshAccountId`
  // attributes the token endpoint (which carries no /accounts/{id} path
  // segment) to the right account bucket for the duration of that one call;
  // the recipients endpoint's own URL already contains the account id, so
  // createDocusignRateLimitedFetch's accountIdFromFetchInput picks it up with
  // no extra plumbing.
  let tokenRefreshAccountId: string | undefined;
  const docusignFetch = createDocusignRateLimitedFetch({
    fetchImpl: fetchImplBase,
    get accountId() {
      return tokenRefreshAccountId;
    },
  });

  return {
    async listActiveIntegrations(): Promise<DocusignSignerBackfillIntegration[]> {
      // tenant-isolation suppressed: service-role cron enumerating DocuSign
      // integrations across ALL orgs to backfill each tenant's own anchors —
      // same rationale as docusign-reconciliation-deps.ts's listActiveIntegrations.
      // Every downstream read/write is scoped by the row's own org_id.
      // eslint-disable-next-line arkova/missing-org-filter
      const { data: orgData, error: orgError } = (await db
        .from('org_integrations')
        .select('id, org_id, account_id, base_uri, token_secret_name')
        .eq('provider', 'docusign')
        .is('revoked_at', null)) as DbQueryResult<IntegrationRow[]>;
      if (orgError) throw new Error(`integration_list_failed: ${dbErrorMessage(orgError)}`);

      // member_integrations is not in the multi-tenant table set the lint rule
      // watches (docusign-reconciliation-deps.ts's listActiveIntegrations
      // needs no suppression here either) — no eslint-disable required.
      const { data: memberData, error: memberError } = (await db
        .from('member_integrations')
        .select('id, org_id, account_id, base_uri, token_secret_name')
        .eq('provider', 'docusign')
        .is('revoked_at', null)) as DbQueryResult<IntegrationRow[]>;
      if (memberError) throw new Error(`member_integration_list_failed: ${dbErrorMessage(memberError)}`);

      const allRows = [...(orgData ?? []), ...(memberData ?? [])];
      return allRows.flatMap((row) => {
        const integration = toIntegration(row);
        return integration ? [integration] : [];
      });
    },

    async getAccessToken(integration: DocusignSignerBackfillIntegration): Promise<string> {
      const refreshToken = await refreshTokenStore.get({ name: integration.token_secret_name });
      if (!refreshToken) throw new Error('refresh_token_not_found');

      tokenRefreshAccountId = integration.account_id;
      let result;
      try {
        result = await refreshDocusignAccessToken({ refreshToken, deps: { env, fetchImpl: docusignFetch } });
      } finally {
        tokenRefreshAccountId = undefined;
      }

      if (result.refresh_token && result.refresh_token !== refreshToken) {
        await refreshTokenStore.put({ name: integration.token_secret_name, value: result.refresh_token });
      }
      return result.access_token;
    },

    async listCandidateAnchors({ orgId, limit }): Promise<DocusignSignerBackfillCandidate[]> {
      const seen = new Map<string, AnchorCandidateRow>();
      for (const key of ENVELOPE_ID_METADATA_KEYS) {
        if (seen.size >= limit) break;
        const rows = await selectCandidatesForKey(db, orgId, key, limit);
        for (const row of rows) {
          if (typeof row.id !== 'string') continue;
          if (!seen.has(row.id)) seen.set(row.id, row);
        }
      }
      return [...seen.values()]
        .slice(0, limit)
        .flatMap((row) => {
          const candidate = toCandidate(row);
          return candidate ? [candidate] : [];
        });
    },

    async fetchEnvelopeSigners({ baseUri, accountId, envelopeId, accessToken }) {
      return fetchDocusignEnvelopeRecipients({
        baseUri,
        accountId,
        envelopeId,
        accessToken,
        deps: { env, fetchImpl: docusignFetch },
      });
    },

    async updateAnchorSigners({ anchorId, orgId, signers, docusignEnv }) {
      // The `metadata` snapshot the caller passes in was captured back at
      // candidate-SELECT time and can be MINUTES stale by now (candidates in
      // one run are processed sequentially with a pacing delay between
      // DocuSign calls — see RATE LIMITING in docusign-signer-backfill.ts).
      // Deliberately ignored here as the merge base: re-read the row's
      // CURRENT metadata immediately before merging instead, so this write's
      // exposure to a concurrent writer of some OTHER key shrinks to roughly
      // one query round trip rather than up to this run's entire duration.
      const { data: freshRow, error: readError } = (await db
        .from('anchors')
        .select('metadata')
        .eq('id', anchorId)
        .eq('org_id', orgId)
        .maybeSingle()) as DbQueryResult<{ metadata: unknown }>;
      if (readError) throw new Error(`anchor_reread_failed: ${dbErrorMessage(readError)}`);
      if (!freshRow) return { updated: false }; // deleted/moved between SELECT and here — no-op.

      const fresh =
        freshRow.metadata && typeof freshRow.metadata === 'object' && !Array.isArray(freshRow.metadata)
          ? (freshRow.metadata as Record<string, unknown>)
          : {};

      // Already completed by a concurrent run (backfill or, for `_signers`,
      // the live webhook path) — no-op, not an error. Checked against the
      // FRESH read, not the stale candidate snapshot.
      if (fresh['_signers_backfilled_at'] != null || fresh['_signers'] != null) {
        return { updated: false };
      }

      const merged: Record<string, unknown> = {
        ...fresh,
        // `_signers` itself is only ever written when non-empty — omit
        // rather than persist `[]` (CLAUDE.md §6, matches the live webhook
        // path's own "absent, never []" convention). The completion
        // watermark below is written unconditionally either way.
        ...(signers.length > 0 ? { _signers: signers } : {}),
        _signers_backfilled_at: new Date().toISOString(),
        // Never overwrite an existing _docusign_env — a concurrent write may
        // have set it from a more authoritative source.
        ...('_docusign_env' in fresh ? {} : { _docusign_env: docusignEnv }),
      };

      // Org-scoped (§1.6A/agents.md DO rule: every service_role write filters
      // .eq('org_id', ...)). `.eq('metadata', fresh)` is a compare-and-swap on
      // the EXACT value just read: Postgres `jsonb =` is a deep-equality
      // comparison, so if ANY key changed — not just `_signers` — between the
      // read above and this UPDATE, the WHERE clause matches zero rows and
      // `updated` comes back false instead of silently reverting whatever
      // that concurrent writer set. The two `.is(...)` guards are redundant
      // with the CAS in principle (both were confirmed null by the read that
      // produced `fresh`) but are kept as cheap, self-documenting belt-and-
      // suspenders. A row this loses a race on is left for the next run to
      // pick up — a no-op, not a clobber.
      //
      // True DB-side atomicity (`metadata = COALESCE(metadata,'{}'::jsonb) ||
      // jsonb_build_object(...)` in a SECURITY DEFINER RPC) would remove even
      // this narrow read-then-write window, but needs a new migration —
      // deferred (see connector-artifact-drain.ts's `markFailed` for the
      // same accepted tradeoff on the same bug class) so this PR does not
      // touch supabase/migrations/ and stays T2.
      const { data, error } = (await db
        .from('anchors')
        .update({ metadata: merged })
        .eq('id', anchorId)
        .eq('org_id', orgId)
        .eq('metadata', fresh)
        .is('metadata->>_signers', null)
        .is('metadata->>_signers_backfilled_at', null)
        .select('id')
        .maybeSingle()) as DbQueryResult<{ id: string }>;

      if (error) throw new Error(`anchor_update_failed: ${dbErrorMessage(error)}`);
      return { updated: data != null };
    },

    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}
