/**
 * Webhook delivery history + failed-delivery (DLQ) hooks (WH-03 / SCRUM-2398)
 * and the signed test ping action (WH-02 / SCRUM-2397).
 *
 * Data paths (why they differ):
 *  - Delivery history: DIRECT Supabase read of `webhook_delivery_logs`.
 *    RLS policy `webhook_delivery_logs_read_org` scopes rows to endpoints of
 *    the caller's org AND requires `is_org_admin()`, so per-org isolation is
 *    enforced by the database, not this hook. Only delivery METADATA columns
 *    are selected — never `payload` or `response_body` (§1.6: no document
 *    contents/fingerprints in the browser view).
 *  - Failed deliveries (dead-letter queue): `webhook_dead_letter_queue` has
 *    service_role-only RLS, so the browser cannot read it directly. Listing
 *    goes through the worker's JWT-authed self-service endpoint, which
 *    returns an allowlisted metadata projection.
 *  - Replay / dismiss / test ping: mutating actions with side effects
 *    (signed outbound HTTP), so they run on the worker
 *    (`/api/v1/webhooks/self-service/*`) which re-checks ORG_ADMIN and
 *    reuses the production signing + SSRF guards.
 */

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { workerFetch } from '@/lib/workerClient';
import { WEBHOOK_LABELS } from '@/lib/copy';

/** Delivery metadata row shown in the history table. No payload, ever. */
export interface WebhookDelivery {
  id: string;
  event_type: string;
  status: string;
  response_status: number | null;
  attempt_number: number;
  created_at: string;
  delivered_at: string | null;
  endpoint_url: string;
}

export interface WebhookDlqEntry {
  id: string;
  endpoint_url: string;
  event_type: string;
  event_id: string;
  error_message: string;
  last_attempt: number;
  failed_at: string;
}

export interface ReplayResult {
  replayed: boolean;
  ok: boolean;
  delivery_id: string | null;
  status_code: number | null;
}

export interface TestPingResult {
  success: boolean;
  status_code: number;
  event_id: string;
}

/** Metadata-only column list — deliberately excludes payload/response_body. */
const DELIVERY_SELECT =
  'id, event_type, status, response_status, attempt_number, created_at, delivered_at, webhook_endpoints(url)';

const DELIVERY_LIMIT = 50;

interface DeliveryRowWithEndpoint {
  id: string;
  event_type: string;
  status: string;
  response_status: number | null;
  attempt_number: number;
  created_at: string;
  delivered_at: string | null;
  webhook_endpoints: { url: string } | null;
}

async function parseWorkerError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? '';
}

/**
 * Recent delivery attempts across all of the org's endpoints, newest first,
 * plus the replay action.
 */
export function useWebhookDeliveries(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const fetchDeliveries = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: dbError } = await supabase
      .from('webhook_delivery_logs')
      .select(DELIVERY_SELECT)
      .order('created_at', { ascending: false })
      .limit(DELIVERY_LIMIT);

    if (dbError) {
      // Generic copy only — never surface raw RLS/Postgres text (§1.4).
      setError(WEBHOOK_LABELS.DELIVERIES_ERROR);
      setDeliveries([]);
    } else {
      const rows = (data ?? []) as unknown as DeliveryRowWithEndpoint[];
      setDeliveries(
        rows.map((row) => ({
          id: row.id,
          event_type: row.event_type,
          status: row.status,
          response_status: row.response_status,
          attempt_number: row.attempt_number,
          created_at: row.created_at,
          delivered_at: row.delivered_at,
          endpoint_url: row.webhook_endpoints?.url ?? '',
        })),
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) await fetchDeliveries();
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, fetchDeliveries]);

  /**
   * Replay a delivery via the worker (WH-03). The worker's replayDelivery
   * always inserts a NEW delivery-log row and never mutates the original —
   * so repeated replays are individually recorded, auditable attempts, not
   * duplicate mutations. Throws a user-friendly Error on failure.
   */
  const replay = useCallback(async (deliveryId: string): Promise<ReplayResult> => {
    const res = await workerFetch(
      `/api/v1/webhooks/self-service/deliveries/${encodeURIComponent(deliveryId)}/replay`,
      { method: 'POST' },
    );

    if (!res.ok) {
      const code = await parseWorkerError(res);
      if (code === 'endpoint_inactive') {
        throw new Error(WEBHOOK_LABELS.REPLAY_ENDPOINT_INACTIVE);
      }
      throw new Error(WEBHOOK_LABELS.REPLAY_ERROR);
    }

    return (await res.json()) as ReplayResult;
  }, []);

  return { deliveries, loading, error, refresh: fetchDeliveries, replay };
}

/**
 * Failed deliveries that exhausted all retries (the dead-letter queue),
 * fetched through the worker self-service endpoint (metadata only), plus the
 * dismiss action.
 */
export function useWebhookDlq(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const [entries, setEntries] = useState<WebhookDlqEntry[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await workerFetch('/api/v1/webhooks/self-service/dlq');
      if (!res.ok) {
        setError(WEBHOOK_LABELS.FAILED_ERROR);
        setEntries([]);
      } else {
        const body = (await res.json()) as { entries?: WebhookDlqEntry[] };
        setEntries(body.entries ?? []);
      }
    } catch {
      setError(WEBHOOK_LABELS.FAILED_ERROR);
      setEntries([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      if (!cancelled) await fetchEntries();
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, fetchEntries]);

  /** Dismiss (resolve) a failed-delivery entry, then refetch the list. */
  const dismiss = useCallback(
    async (entryId: string): Promise<void> => {
      const res = await workerFetch(
        `/api/v1/webhooks/self-service/dlq/${encodeURIComponent(entryId)}/resolve`,
        { method: 'POST' },
      );
      if (!res.ok) {
        throw new Error(WEBHOOK_LABELS.DISMISS_ERROR);
      }
      await fetchEntries();
    },
    [fetchEntries],
  );

  return { entries, loading, error, refresh: fetchEntries, dismiss };
}

/**
 * WH-02: fire a signed test event at an endpoint. The worker signs the ping
 * with the endpoint's secret using the SAME HMAC scheme as production
 * deliveries and records the attempt in the delivery log. Throws a
 * user-friendly Error on transport/authz failure; a non-2xx from the
 * RECEIVER is a successful call with `success: false`.
 */
export async function sendWebhookTestPing(endpointId: string): Promise<TestPingResult> {
  const res = await workerFetch(
    `/api/v1/webhooks/self-service/${encodeURIComponent(endpointId)}/test`,
    { method: 'POST' },
  );

  if (!res.ok) {
    const code = await parseWorkerError(res);
    if (code === 'endpoint_inactive') {
      throw new Error(WEBHOOK_LABELS.TEST_PING_INACTIVE);
    }
    throw new Error(WEBHOOK_LABELS.TEST_PING_ERROR);
  }

  return (await res.json()) as TestPingResult;
}
