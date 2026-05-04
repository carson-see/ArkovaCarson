-- INFRA-002: Webhook idempotency table
-- Prevents duplicate webhook processing for x402 payments and Stripe events.
-- Before processing: INSERT ... ON CONFLICT DO NOTHING.
-- If insert succeeds → process. If conflict → return cached response.
-- Cleanup job removes entries older than 7 days.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS webhook_idempotency;

CREATE TABLE IF NOT EXISTS webhook_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,           -- 'stripe' | 'x402' | 'cron' etc.
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_status INT,            -- HTTP status code of the original response
  response_body JSONB,            -- Optional cached response for replay
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for cleanup job (delete entries older than 7 days)
CREATE INDEX idx_webhook_idempotency_cleanup
  ON webhook_idempotency (processed_at);

-- RLS: service_role only (worker manages webhooks)
ALTER TABLE webhook_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_idempotency FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE webhook_idempotency IS 'INFRA-002: Prevents duplicate webhook processing with idempotency keys';
