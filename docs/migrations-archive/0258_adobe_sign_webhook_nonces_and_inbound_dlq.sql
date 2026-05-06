-- SCRUM-1148: Adobe Sign webhook intake hardening
--
-- Adds two operational tables behind the new `/webhooks/adobe-sign` route:
--   1. `adobe_sign_webhook_nonces` — replay protection for AGREEMENT_*
--      events, mirroring the per-vendor pattern from `0256_docusign_webhook_nonces`.
--   2. `webhook_dlq` — inbound-webhook dead-letter queue. Distinct from the
--      existing `webhook_dead_letter_queue` (migration 0052) which tracks
--      OUTBOUND delivery failures keyed by endpoint_url. The new table is
--      keyed by provider + (optional) external_id so a normalization /
--      enqueue failure on an inbound webhook leaves a row on-call can
--      inspect.
--
-- Both tables are service_role-only — never client-readable.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS webhook_dlq;
--   DROP TABLE IF EXISTS adobe_sign_webhook_nonces;

-- =============================================================================
-- 1. adobe_sign_webhook_nonces
-- =============================================================================

CREATE TABLE IF NOT EXISTS adobe_sign_webhook_nonces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  text NOT NULL,
  webhook_id    text,
  payload_hash  text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  -- Adobe re-delivers on any non-2xx; the same agreement event arrives with
  -- an identical body hash. Dedupe on (agreement_id, payload_hash) so a
  -- legitimate later event for the SAME agreement (e.g. RECALLED then
  -- COMPLETED) still gets through.
  UNIQUE (agreement_id, payload_hash)
);

ALTER TABLE adobe_sign_webhook_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE adobe_sign_webhook_nonces FORCE ROW LEVEL SECURITY;

CREATE POLICY adobe_sign_webhook_nonces_service ON adobe_sign_webhook_nonces
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_adobe_sign_webhook_nonces_received_at
  ON adobe_sign_webhook_nonces (received_at);

GRANT ALL ON adobe_sign_webhook_nonces TO service_role;

COMMENT ON TABLE adobe_sign_webhook_nonces IS
  'SCRUM-1148: replay protection for Adobe Sign webhooks. Sweep entries older than 14 days.';

-- =============================================================================
-- 2. webhook_dlq (inbound)
-- =============================================================================

CREATE TABLE IF NOT EXISTS webhook_dlq (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 50),
  external_id   text,            -- vendor-side id (envelope_id, agreement_id, ...)
  webhook_id    text,
  reason        text NOT NULL CHECK (char_length(reason) <= 500),
  payload_hash  text,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE webhook_dlq ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_dlq FORCE ROW LEVEL SECURITY;

CREATE POLICY webhook_dlq_service ON webhook_dlq
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_provider_unresolved
  ON webhook_dlq (provider, created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_dlq_external_id
  ON webhook_dlq (provider, external_id)
  WHERE external_id IS NOT NULL;

GRANT ALL ON webhook_dlq TO service_role;

COMMENT ON TABLE webhook_dlq IS
  'SCRUM-1148: inbound webhook intake failures (HMAC-valid payloads that failed normalization or enqueue). Distinct from webhook_dead_letter_queue (0052), which tracks outbound delivery failures.';

NOTIFY pgrst, 'reload schema';
