/**
 * Connector Health Hook (surfaces SCRUM-1146's health dashboard — see this
 * folder's agents.md and `services/worker/src/api/connector-health.ts`).
 *
 * Read-side client for `GET /api/connectors/health`. That endpoint already
 * classifies a connector as `degraded` for a real set of reasons —
 * `cursor_stale`, `changes_list_never_succeeded`, `grant_exceeds_requested`,
 * `vendor_auth_revoked`, `subscription_expiry`, `file_access_not_granted`,
 * `changes_gap`, `fetch_job_failures`, `processing_failure` — but until now
 * nothing in the UI read it. That gap is exactly how the Drive
 * `changes.list` 400-on-every-call incident (2026-05-04 to 2026-09-25, fixed
 * by PR #3054) went unnoticed for five months: the dashboard would have shown
 * `changes_list_never_succeeded` from day one.
 *
 * FAILS CLOSED: any transport failure, non-2xx response, or malformed body
 * resolves every `getHealth()` lookup to `state: 'unknown'` — never
 * `'connected'`. A health check that could not run must never be read as "the
 * connector is fine" (CLAUDE.md §1.5 — state what is measured, not asserted).
 */
import { useCallback, useEffect, useState } from 'react';
import { workerFetch } from '@/lib/workerClient';
import { CONNECTORS_LABELS } from '@/lib/copy';

/** Mirrors `HealthReason` in services/worker/src/api/connector-health.ts. */
export type ConnectorHealthReason =
  | 'vendor_auth_revoked'
  | 'grant_exceeds_requested'
  | 'subscription_expiry'
  | 'cursor_stale'
  | 'changes_list_never_succeeded'
  | 'file_access_not_granted'
  | 'changes_gap'
  | 'folder_mirror_failed'
  | 'fetch_job_failures'
  | 'processing_failure'
  | 'oauth_client_mismatch'
  | 'reconnect_required_scope_change'
  | 'none';

/**
 * `'unknown'` is a FRONTEND-only addition to the backend's
 * `connected | degraded | disconnected` — it means "the health check itself
 * did not run or could not be trusted", never "known and fine".
 */
export type ConnectorHealthState = 'connected' | 'degraded' | 'disconnected' | 'unknown';

export interface ConnectorHealthEntry {
  id: string;
  state: ConnectorHealthState;
  health_reason: ConnectorHealthReason | null;
  last_error: string | null;
  last_event_at: string | null;
  last_renewal_at: string | null;
  next_expires_at: string | null;
}

const UNKNOWN_HEALTH = (id: string): ConnectorHealthEntry => ({
  id,
  state: 'unknown',
  health_reason: null,
  last_error: null,
  last_event_at: null,
  last_renewal_at: null,
  next_expires_at: null,
});

const KNOWN_STATES = new Set(['connected', 'degraded', 'disconnected']);

function isHealthRow(value: unknown): value is {
  id: string;
  state: 'connected' | 'degraded' | 'disconnected';
  health_reason: unknown;
  last_error: unknown;
  last_event_at?: unknown;
  last_renewal_at?: unknown;
  next_expires_at?: unknown;
} {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.state === 'string' && KNOWN_STATES.has(row.state);
}

/**
 * Fetches connector health once (on mount) and exposes a fail-closed lookup.
 * Callers that render multiple connector cards should call this ONCE at the
 * page level and pass the resolved entry down, rather than one fetch per
 * card.
 */
export function useConnectorHealth() {
  const [byId, setById] = useState<Map<string, ConnectorHealthEntry>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await workerFetch('/api/connectors/health', { method: 'GET' });
      if (!response.ok) {
        setError(`HTTP ${response.status}`);
        setById(new Map());
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const rows =
        body && typeof body === 'object' ? (body as { connectors?: unknown }).connectors : undefined;
      if (!Array.isArray(rows)) {
        setError('Malformed connector health response');
        setById(new Map());
        return;
      }
      const next = new Map<string, ConnectorHealthEntry>();
      for (const row of rows) {
        if (!isHealthRow(row)) continue;
        next.set(row.id, {
          id: row.id,
          state: row.state,
          health_reason: (row.health_reason as ConnectorHealthReason | null) ?? null,
          last_error: typeof row.last_error === 'string' ? row.last_error : null,
          last_event_at: typeof row.last_event_at === 'string' ? row.last_event_at : null,
          last_renewal_at: typeof row.last_renewal_at === 'string' ? row.last_renewal_at : null,
          next_expires_at: typeof row.next_expires_at === 'string' ? row.next_expires_at : null,
        });
      }
      setById(next);
    } catch (err) {
      // Network failure, or workerFetch's own thrown "no active session" /
      // timeout errors — fail closed: an empty map means every getHealth()
      // lookup below reports 'unknown', never a stale assumed 'connected'.
      setError(err instanceof Error ? err.message : 'Failed to fetch connector health');
      setById(new Map());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async refresh settles after the effect returns
    void refresh();
  }, [refresh]);

  const getHealth = useCallback(
    (connectorId: string): ConnectorHealthEntry => byId.get(connectorId) ?? UNKNOWN_HEALTH(connectorId),
    [byId],
  );

  return { getHealth, loading, error, refresh };
}

/**
 * Reason -> plain-customer-language copy (§1.3: no jargon, no banned
 * terminology, every string sourced from copy.ts). `grant_exceeds_requested`
 * is worded as the security-relevant condition it is — the connected account
 * granted broader access than Arkova asked for — rather than as an internal
 * "scope" finding.
 */
export function describeConnectorHealthReason(reason: ConnectorHealthReason | null): string {
  switch (reason) {
    case 'vendor_auth_revoked':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_VENDOR_AUTH_REVOKED;
    case 'grant_exceeds_requested':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_GRANT_EXCEEDS_REQUESTED;
    case 'subscription_expiry':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_SUBSCRIPTION_EXPIRY;
    case 'cursor_stale':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_CURSOR_STALE;
    case 'changes_list_never_succeeded':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_CHANGES_LIST_NEVER_SUCCEEDED;
    case 'file_access_not_granted':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_FILE_ACCESS_NOT_GRANTED;
    case 'changes_gap':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_CHANGES_GAP;
    case 'folder_mirror_failed':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_FOLDER_MIRROR_FAILED;
    case 'fetch_job_failures':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_FETCH_JOB_FAILURES;
    case 'processing_failure':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_PROCESSING_FAILURE;
    case 'oauth_client_mismatch':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_OAUTH_CLIENT_MISMATCH;
    case 'reconnect_required_scope_change':
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_RECONNECT_REQUIRED_SCOPE_CHANGE;
    case 'none':
    case null:
    default:
      return CONNECTORS_LABELS.CONNECTOR_HEALTH_REASON_GENERIC;
  }
}
