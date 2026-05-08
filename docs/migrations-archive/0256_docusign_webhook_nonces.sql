-- SCRUM-1101: DocuSign Connect webhook replay protection
--
-- DocuSign retries Connect deliveries on any non-2xx response. Without a
-- per-event nonce table the worker would enqueue the same envelope-completed
-- event multiple times whenever an upstream component (rules engine, fetch
-- job) is briefly slow. We dedupe on the (envelope_id, event_id, generated_at)
-- triple — DocuSign guarantees these together identify a unique delivery.
--
-- Pattern mirrors `kyb_webhook_nonces` (migration 0250) but is split per vendor
-- so we don't need a `provider` column or risk cross-vendor nonce collisions.

CREATE TABLE IF NOT EXISTS docusign_webhook_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  envelope_id text NOT NULL,
  event_id text NOT NULL,
  generated_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (envelope_id, event_id, generated_at)
);

ALTER TABLE docusign_webhook_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE docusign_webhook_nonces FORCE ROW LEVEL SECURITY;

-- service_role only — never client-readable
CREATE POLICY docusign_webhook_nonces_service ON docusign_webhook_nonces
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Cleanup index for the 14-day TTL sweep
CREATE INDEX idx_docusign_webhook_nonces_received_at
  ON docusign_webhook_nonces (received_at);

COMMENT ON TABLE docusign_webhook_nonces IS
  'SCRUM-1101: replay protection for DocuSign Connect webhooks. Dedupes on (envelope_id, event_id, generated_at). Sweep entries older than 14 days; HMAC freshness window already rejects older deliveries.';

GRANT ALL ON docusign_webhook_nonces TO service_role;

NOTIFY pgrst, 'reload schema';

-- ROLLBACK: DROP TABLE docusign_webhook_nonces;
