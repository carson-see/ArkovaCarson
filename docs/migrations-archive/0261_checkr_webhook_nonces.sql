-- Migration 0261: SCRUM-1030 / SCRUM-1151 — Checkr webhook replay protection
--
-- PURPOSE
-- -------
-- Mirrors the per-vendor nonce table pattern from
-- `0256_docusign_webhook_nonces` and `0258_adobe_sign_webhook_nonces_and_inbound_dlq`.
-- Checkr's Webhook v1 retries on any non-2xx response, so without dedupe
-- a transient downstream slowdown produces duplicate `report.completed`
-- events in the rules engine.
--
-- We dedupe on (`report_id`, `payload_hash`) so a legitimate redelivery
-- with the SAME body returns 200 + `duplicate=true`, but a new event for
-- the same report (e.g. a status change after the initial complete) still
-- gets through with a different body hash.
--
-- JIRA: SCRUM-1030, SCRUM-1151
-- EPIC: SCRUM-1010 (CIBA)
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS checkr_webhook_nonces;

CREATE TABLE IF NOT EXISTS checkr_webhook_nonces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id     text NOT NULL,
  payload_hash  text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (report_id, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_checkr_webhook_nonces_received_at
  ON checkr_webhook_nonces (received_at);

ALTER TABLE checkr_webhook_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE checkr_webhook_nonces FORCE ROW LEVEL SECURITY;

CREATE POLICY checkr_webhook_nonces_service ON checkr_webhook_nonces
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON checkr_webhook_nonces TO service_role;

COMMENT ON TABLE checkr_webhook_nonces IS
  'SCRUM-1030/1151: replay protection for Checkr Webhook v1 deliveries. Sweep entries older than 14 days.';

NOTIFY pgrst, 'reload schema';
