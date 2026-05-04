-- Migration 0290: Microsoft Graph webhook replay protection
--
-- SCRUM-1138 R2 closeout: backs the `microsoft_graph_webhook_nonces` table
-- referenced by `services/worker/src/api/v1/webhooks/microsoft-graph.ts`.
-- Graph retries any non-2xx response, so a duplicate item (same
-- subscription_id + resource_id + change_type) must be detectable and ack'd.
--
-- The nonce table sits behind RLS-enabled tables but writes only via the
-- service_role from the worker. INSERT-only — no UPDATE/DELETE policies.
--
-- ROLLBACK: DROP TABLE IF EXISTS public.microsoft_graph_webhook_nonces;

CREATE TABLE IF NOT EXISTS public.microsoft_graph_webhook_nonces (
  subscription_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subscription_id, resource_id, change_type)
);

-- Defense-in-depth: matches the pattern used by docusign_webhook_nonces and
-- checkr_webhook_nonces. Service role is the ONLY writer (worker only).
ALTER TABLE public.microsoft_graph_webhook_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.microsoft_graph_webhook_nonces FORCE ROW LEVEL SECURITY;

-- No SELECT/UPDATE/DELETE policies — service_role bypasses RLS.
-- Authenticated users have no business reading webhook nonces.

-- 90-day retention: nonces are duplicate-detection only, not audit. Older
-- rows are pruned by the standard housekeeping cron (a follow-on operator
-- step keyed off received_at). The PK + index keeps the working set small.
CREATE INDEX IF NOT EXISTS idx_msgraph_nonces_received_at
  ON public.microsoft_graph_webhook_nonces (received_at);

NOTIFY pgrst, 'reload schema';
