/**
 * DS-05 (SCRUM-2365) — Production wiring for DocuSign QUEUE reconciliation.
 *
 * Adapts Supabase + the DocuSign Envelopes API + the connector-artifact queue
 * + the token store into the QueueReconciliationDeps consumed by the pure
 * reconcileDocusignQueueDrift(). Mirrors the SCRUM-2042 deps factory shape.
 *
 * §1.6A: `materializeMissingEnvelope` NEVER handles document bytes here. It
 * re-submits the single audited producer job (`docusign.envelope_completed`),
 * which owns the fetch → SHA-256 → discard → enqueue_connector_artifact path.
 * The 0343 dedupe (org, 'docusign', envelopeId) makes the re-drive idempotent —
 * a re-run of an already-queued envelope is a no-op.
 */

import { z } from 'zod';
import { db as defaultDb } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { submitJob } from '../utils/jobQueue.js';
import { chunkForInFilter } from '../utils/postgrest-filter.js';
import { refreshDocusignAccessToken } from '../integrations/oauth/docusign.js';
import {
  createGcpSecretManagerRefreshTokenStore,
  type DocusignRefreshTokenStore,
} from '../integrations/connectors/docusign-token-store.js';
import { DOCUSIGN_ENVELOPE_COMPLETED_JOB_TYPE } from './docusign-envelope-completed.js';
import type {
  QueueReconciliationDeps,
  QueueActiveIntegration,
  CompletedEnvelopeRef,
} from './docusign-queue-reconciliation.js';

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

interface IntegrationRow {
  id?: unknown;
  org_id?: unknown;
  account_id?: unknown;
  base_uri?: unknown;
  token_secret_name?: unknown;
  user_id?: unknown;
  // org_integrations-only: set on an inheritance-marker row (account_id NULL)
  // pointing at the parent org whose connection the sub-org inherits (SCRUM-2045).
  inherited_from_org_id?: unknown;
}

interface ArtifactRefRow {
  external_ref?: unknown;
}

interface DbClient {
  from(table: 'org_integrations' | 'member_integrations'): DbQuery<IntegrationRow[]>;
  from(table: 'connector_artifact'): DbQuery<ArtifactRefRow[]>;
  from(table: 'integration_events'): DbQuery<null>;
}

function dbErrorMessage(error: DbQueryResult<unknown>['error']): string {
  if (!error) return 'unknown_error';
  if (typeof error === 'string') return error;
  return error.message ?? String(error);
}

// `IN_CHUNK_SIZE = 100` used to live here. Chunk width for a PostgREST `.in()`
// filter is `chunkForInFilter`'s to decide — a hand-picked count is the mistake
// that reached production three times (#1795, #1812, #1853), and envelope ids
// are DocuSign-issued strings, not UUIDs, so a count-only bound was never the
// right measure.

// §1.2 / §1.4: Zod-validate every write path before the persisted mutation.
// Both schemas assert ids-only shapes — no fingerprint, no bytes (§1.6A). A
// malformed input fails closed (the caller returns an error) rather than
// persisting an unvalidated row.

/** Producer re-drive job payload (submitted to job_queue). */
const MaterializeJobPayloadSchema = z.object({
  org_id: z.string().min(1),
  integration_id: z.string().min(1),
  account_id: z.string().min(1),
  envelope_id: z.string().min(1),
  rule_event_id: z.string().min(1),
  document_ids: z.array(z.string()),
  envelope_completed_at: z.string().min(1),
});

/** Bounded drift-audit row (inserted into integration_events). */
const DriftAuditRowSchema = z.object({
  org_id: z.string().min(1),
  integration_id: z.string().min(1),
  account_id: z.string().min(1),
  envelope_id: z.string().min(1),
  envelope_status: z.string().min(1),
  completed_at: z.string().min(1),
  scope: z.enum(['org', 'member']),
  owner_user_id: z.string().nullable(),
});

export interface QueueReconciliationDepOptions {
  db?: DbClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  refreshTokenStore?: DocusignRefreshTokenStore;
}

function toActiveIntegration(
  row: IntegrationRow,
  scope: 'org' | 'member',
): QueueActiveIntegration | null {
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
    scope,
    // DS-04/DS-05: only member connections carry an owning user. org rows → null.
    owner_user_id: scope === 'member' && typeof row.user_id === 'string' ? row.user_id : null,
  };
}

export function makeQueueReconciliationDeps(
  options: QueueReconciliationDepOptions = {},
): QueueReconciliationDeps {
  const db = options.db ?? (defaultDb as unknown as DbClient);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const refreshTokenStore =
    options.refreshTokenStore ??
    createGcpSecretManagerRefreshTokenStore({ env, fetchImpl });

  return {
    async listActiveIntegrations(): Promise<QueueActiveIntegration[]> {
      // tenant-isolation suppressed: service-role cron enumerating DocuSign
      // integrations across ALL orgs; each row carries its own org_id that
      // scopes downstream work (same rationale as SCRUM-2042).
      // eslint-disable-next-line arkova/missing-org-filter
      const { data: orgData, error: orgError } = await db
        .from('org_integrations')
        .select('id, org_id, account_id, base_uri, token_secret_name, inherited_from_org_id')
        .eq('provider', 'docusign')
        .is('revoked_at', null);
      if (orgError) throw new Error(`integration_list_failed: ${dbErrorMessage(orgError)}`);

      const { data: memberData, error: memberError } = await db
        .from('member_integrations')
        .select('id, org_id, account_id, base_uri, token_secret_name, user_id')
        .eq('provider', 'docusign')
        .is('revoked_at', null);
      if (memberError) {
        throw new Error(`member_integration_list_failed: ${dbErrorMessage(memberError)}`);
      }

      const allOrgRows = orgData ?? [];

      // Cross-org attribution (DS-SUBORG-01 / SCRUM-2045): a sub-org can INHERIT
      // its parent's DocuSign connection via an inheritance-marker row (account_id
      // NULL, inherited_from_org_id = parent). DS-03 + the webhook key that org's
      // envelopes under the CHILD org_id. So when we enumerate a parent's own
      // connection here we must re-attribute it to the inheriting child, or the
      // drift diff runs against the wrong org and re-materializes every run
      // (cross-org false drift + double-materialize). Build parent-org → markers.
      const markersByParent = new Map<string, IntegrationRow[]>();
      for (const row of allOrgRows) {
        const parentId = row.inherited_from_org_id;
        const accountId = row.account_id;
        // A marker is a row with NO own account that points at a parent org.
        if (typeof parentId === 'string' && (accountId === null || accountId === undefined)) {
          const list = markersByParent.get(parentId) ?? [];
          list.push(row);
          markersByParent.set(parentId, list);
        }
      }

      const orgRows: QueueActiveIntegration[] = [];
      for (const row of allOrgRows) {
        // Own connections only (markers themselves have no account/credentials and
        // are consumed as attribution for their parent, never polled directly).
        const base = toActiveIntegration(row, 'org');
        if (!base) continue;

        const markers = typeof row.org_id === 'string' ? markersByParent.get(row.org_id) : undefined;
        if (markers && markers.length > 0) {
          if (markers.length > 1) {
            // Ambiguous inherited attribution — mirror the webhook and refuse to
            // poll this account at all rather than risk a cross-tenant leak.
            logger.error(
              {
                parentOrgId: row.org_id,
                childOrgIds: markers.map((m) => m.org_id),
              },
              'Queue reconciliation: ambiguous inherited sub-org attribution — skipping account',
            );
            continue;
          }
          const marker = markers[0];
          // Re-attribute to the child org (org_id + marker id) while keeping the
          // parent's polling credentials. The marker id is the same integration_id
          // DS-03/the webhook stamped, so a re-materialization resolves back to the
          // parent connection and the 0343 dedupe makes it a genuine no-op.
          orgRows.push({
            ...base,
            id: typeof marker.id === 'string' ? marker.id : base.id,
            org_id: typeof marker.org_id === 'string' ? marker.org_id : base.org_id,
          });
          continue;
        }

        orgRows.push(base);
      }

      const memberRows = (memberData ?? []).flatMap((row) => {
        const i = toActiveIntegration(row, 'member');
        return i ? [i] : [];
      });
      return [...orgRows, ...memberRows];
    },

    async getAccessToken(integration: QueueActiveIntegration): Promise<string> {
      const refreshToken = await refreshTokenStore.get({ name: integration.token_secret_name });
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

    async listCompletedEnvelopes(args): Promise<CompletedEnvelopeRef[]> {
      let base = args.baseUri;
      while (base.endsWith('/')) base = base.slice(0, -1);

      const MAX_PAGES = 10;
      const all: CompletedEnvelopeRef[] = [];
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
            envelopes?: Array<{ envelopeId?: string; status?: string; completedDateTime?: string }>;
            nextUri?: string;
          };
          const pageEnvelopes = (json.envelopes ?? [])
            .filter((e) => e.envelopeId && e.completedDateTime)
            .map((e) => ({
              envelopeId: e.envelopeId!,
              status: e.status ?? 'completed',
              completedDateTime: e.completedDateTime!,
            }));
          all.push(...pageEnvelopes);

          if (json.nextUri) {
            if (json.nextUri.startsWith('http')) {
              const nextOrigin = new URL(json.nextUri).origin;
              const expectedOrigin = new URL(base).origin;
              if (nextOrigin === expectedOrigin) {
                nextUrl = json.nextUri;
              } else {
                // SSRF guard: a nextUri pointing off the integration's own base
                // origin is not followed. Log it so the early pagination stop
                // (which under-reports drift for this account) leaves an operator
                // signal instead of silently truncating.
                logger.warn(
                  { expectedOrigin, nextOrigin, accountId: args.accountId },
                  'Queue reconciliation: nextUri origin mismatch — stopping pagination early',
                );
                nextUrl = null;
              }
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
      return all;
    },

    async getQueuedEnvelopeRefs(
      integration: QueueActiveIntegration,
      envelopeIds: string[],
    ): Promise<Set<string>> {
      if (envelopeIds.length === 0) return new Set();

      // A busy DocuSign account can surface up to MAX_PAGES*100 completed
      // envelopes for one integration, and pushing the whole candidate set
      // through a single PostgREST `.in()` would blow the request line —
      // failing the lookup, marking the run failed, and leaving Scheduler to
      // retry without ever reconciling a gap.
      //
      // This used to chunk by a hand-picked `IN_CHUNK_SIZE`. `chunkForInFilter`
      // owns the width now: envelope ids are DocuSign-issued strings, not
      // UUIDs, so a count-only bound was never the right measure. Each chunk
      // carries the same org_id/source scope; results are unioned.
      const found = new Set<string>();
      for (const { values: chunk } of chunkForInFilter(envelopeIds)) {
        const { data, error } = await db
          .from('connector_artifact')
          .select('external_ref')
          .eq('org_id', integration.org_id)
          .eq('source', 'docusign')
          .in('external_ref', chunk);

        if (error) throw new Error(`queued_ref_lookup_failed: ${dbErrorMessage(error)}`);
        for (const row of data ?? []) {
          if (typeof row.external_ref === 'string') found.add(row.external_ref);
        }
      }
      return found;
    },

    async materializeMissingEnvelope({ integration, envelope }) {
      // §1.6A: re-drive the single audited producer job. It owns the byte path
      // (fetch → SHA-256 → discard → enqueue_connector_artifact); the 0343 dedupe
      // makes a re-run of an already-queued envelope a no-op. No bytes here.
      try {
        // §1.2/§1.4: validate the persisted job payload shape before submit.
        const payload = MaterializeJobPayloadSchema.parse({
          org_id: integration.org_id,
          integration_id: integration.id,
          account_id: integration.account_id,
          envelope_id: envelope.envelopeId,
          // Synthetic reconciliation marker — the producer requires a non-empty
          // rule_event_id but a recon re-drive has no originating rule event.
          rule_event_id: `recon:${envelope.envelopeId}`,
          document_ids: [],
          envelope_completed_at: envelope.completedDateTime,
        });
        const jobId = await submitJob({
          type: DOCUSIGN_ENVELOPE_COMPLETED_JOB_TYPE,
          max_attempts: 5,
          priority: 10,
          payload,
        });
        if (!jobId) {
          return { enqueued: false, error: 'job_submit_returned_null' };
        }
        return { enqueued: true, error: null };
      } catch (err) {
        return { enqueued: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async recordDriftAudit(row) {
      // Bounded, PII-scrubbed audit breadcrumb — ids only (§1.6A). No fingerprint,
      // no bytes. Uses the existing integration_events audit table.
      //
      // §1.2/§1.4: validate the ids-only row shape before the persisted insert.
      // A malformed audit row fails closed (returns an error) rather than writing
      // an unvalidated breadcrumb.
      const parsed = DriftAuditRowSchema.safeParse(row);
      if (!parsed.success) {
        const msg = `drift_audit_validation_failed: ${parsed.error.message}`;
        logger.error(
          { integrationId: row.integration_id, envelopeId: row.envelope_id },
          'Queue reconciliation: drift audit row failed validation',
        );
        return { error: msg };
      }
      const validRow = parsed.data;
      // FK safety: integration_events.integration_id has a FK to org_integrations(id)
      // ONLY. A member drift row's integration_id is a member_integrations id, which
      // would violate that FK at runtime — so for member scope we NULL the FK column
      // and carry the member integration id inside the ids-only details JSON instead.
      const isMemberScope = validRow.scope === 'member';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- integration_events audit insert
      const { error } = await (db as any).from('integration_events').insert({
        org_id: validRow.org_id,
        integration_id: isMemberScope ? null : validRow.integration_id,
        provider: 'docusign',
        event_type: 'queue_drift_detected',
        status: 'success',
        details: {
          account_id: validRow.account_id,
          envelope_id: validRow.envelope_id,
          envelope_status: validRow.envelope_status,
          completed_at: validRow.completed_at,
          queue_scope: validRow.scope,
          ...(isMemberScope ? { member_integration_id: validRow.integration_id } : {}),
          ...(isMemberScope && validRow.owner_user_id
            ? { owner_user_id: validRow.owner_user_id }
            : {}),
        },
      });
      if (error) {
        logger.error(
          { integrationId: row.integration_id, envelopeId: row.envelope_id, error },
          'Queue reconciliation: drift audit insert failed',
        );
        return { error: dbErrorMessage(error) };
      }
      return { error: null };
    },
  };
}
