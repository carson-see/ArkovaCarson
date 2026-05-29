/**
 * SCRUM-2099 [DS-FAIL-01] — Production wiring for the DocuSign Connect
 * Failures hourly poller.
 *
 * Adapts Supabase DB + DocuSign Connect Failures API + token store into the
 * ConnectFailuresDeps interface consumed by pollDocusignConnectFailures().
 *
 * The three integration-management methods (listActiveIntegrations,
 * getAccessToken, insertGap) are IDENTICAL to the SCRUM-2042 reconciliation
 * deps, so they are reused verbatim from makeReconciliationDeps() rather than
 * duplicated — single source of truth for the org/member integration query,
 * the refresh-token rotation, and the docusign_reconciliation_gaps insert
 * (incl. 23505 → duplicate dedup).
 *
 * Only listConnectFailures is new: it calls DocuSign's pull-based
 *   GET /restapi/v2.1/accounts/{accountId}/connect/failures?from_date=...
 * (the "listEventFailureLogs" endpoint), Zod-parses the ConnectLogs response,
 * and maps each ConnectLog → the gap-row shape. No PII (email / subject /
 * userName / connectDebugLog) is read or propagated.
 */

import { z } from 'zod';
import { db as defaultDb } from '../utils/db.js';
import {
  createGcpSecretManagerRefreshTokenStore,
  type DocusignRefreshTokenStore,
} from '../integrations/connectors/docusign-token-store.js';
import {
  makeReconciliationDeps,
  type ReconciliationDepOptions,
} from './docusign-reconciliation-deps.js';
import type {
  ConnectFailuresDeps,
  ConnectFailureGap,
} from './docusign-connect-failures.js';

const CONNECT_FAILURES_TIMEOUT_MS = 30_000;
const MAX_FAILURES = 1000;

/**
 * Zod schema for the DocuSign Connect Failures API response (ConnectLogs).
 *
 * Verified against the DocuSign eSignature REST API reference
 * (connect/connectevents/listfailures → ConnectLogs / ConnectLog). The
 * wrapper exposes `failures: ConnectLog[]`. Each ConnectLog carries far more
 * (email, subject, userName, connectDebugLog, …) — we intentionally pick ONLY
 * the non-PII fields needed for a gap row. `.passthrough()` tolerates unknown
 * fields without failing the parse; we never read them.
 */
const ConnectFailureLog = z
  .object({
    envelopeId: z.string().trim().min(1).max(100).optional(),
    status: z.string().trim().min(1).max(100).optional(),
    created: z.string().trim().min(1).max(100).optional(),
    lastTry: z.string().trim().min(1).max(100).optional(),
  })
  .passthrough();

const ConnectFailuresResponse = z
  .object({
    failures: z.array(ConnectFailureLog).max(MAX_FAILURES).optional(),
    totalRecords: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export interface ConnectFailuresDepOptions extends ReconciliationDepOptions {
  refreshTokenStore?: DocusignRefreshTokenStore;
}

export function makeConnectFailuresDeps(
  options: ConnectFailuresDepOptions = {},
): ConnectFailuresDeps {
  const db = options.db ?? (defaultDb as unknown as ReconciliationDepOptions['db']);
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const refreshTokenStore =
    options.refreshTokenStore ??
    createGcpSecretManagerRefreshTokenStore({ env, fetchImpl });

  // Reuse the SCRUM-2042 reconciliation deps for the shared methods —
  // listActiveIntegrations / getAccessToken / insertGap are identical.
  const shared = makeReconciliationDeps({ db, env, fetchImpl, refreshTokenStore });

  return {
    listActiveIntegrations: shared.listActiveIntegrations,
    getAccessToken: shared.getAccessToken,
    insertGap: shared.insertGap,

    async listConnectFailures(args): Promise<ConnectFailureGap[]> {
      let base = args.baseUri;
      while (base.endsWith('/')) base = base.slice(0, -1);

      const url =
        `${base}/restapi/v2.1/accounts/${encodeURIComponent(args.accountId)}` +
        `/connect/failures?from_date=${encodeURIComponent(args.fromDate)}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONNECT_FAILURES_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${args.accessToken}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`connect_failures_api_${res.status}: ${body.slice(0, 200)}`);
        }

        const json = await res.json();
        const parsed = ConnectFailuresResponse.parse(json);

        const gaps: ConnectFailureGap[] = [];
        for (const failure of parsed.failures ?? []) {
          // Skip failures with no envelope id — nothing to reconcile against.
          if (!failure.envelopeId) continue;
          // completed_at is NOT NULL in docusign_reconciliation_gaps. Connect
          // failure timestamps live in `created` (or `lastTry`); fall back to
          // now() so a missing timestamp never drops an otherwise-valid gap.
          const completedAt = failure.created ?? failure.lastTry ?? new Date().toISOString();
          gaps.push({
            envelope_id: failure.envelopeId,
            envelope_status: failure.status ?? 'completed',
            completed_at: completedAt,
          });
        }
        return gaps;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new Error('connect_failures_api_timeout', { cause: err });
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
