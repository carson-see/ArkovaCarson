-- SCRUM-1242 (AUDIT-0424-26): replay protection for ATS + Drive webhooks.
--
-- PURPOSE
-- -------
-- Mirrors the per-vendor nonce table pattern from
-- `0256_docusign_webhook_nonces`, `0258_adobe_sign_webhook_nonces_and_inbound_dlq`,
-- and `0261_checkr_webhook_nonces`. Without these tables a captured ATS or
-- Drive webhook can be replayed against the worker — Drive doesn't carry an
-- HMAC, and the per-channel `X-Goog-Message-Number` is the only monotonic
-- guarantee. ATS uses HMAC but a captured request can be re-delivered
-- verbatim and the worker would re-process the candidate match.
--
-- ATS nonce key: (provider, integration_id, signature) — signature uniquely
-- identifies a delivery for a given (provider, integration). Re-delivery of
-- the same body with the same secret produces the same signature; a new
-- event for the same candidate (different body) produces a different
-- signature and is allowed through.
--
-- Drive nonce key: (channel_id, message_number) — Google's monotonic
-- per-channel counter is the canonical replay-detection signal. Drive
-- doesn't carry HMAC, so we cannot dedupe on body hash.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS ats_webhook_nonces;
--   DROP TABLE IF EXISTS drive_webhook_nonces;

-- =============================================================================
-- ATS webhook nonces
-- =============================================================================

CREATE TABLE IF NOT EXISTS ats_webhook_nonces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL CHECK (provider IN ('greenhouse', 'lever', 'generic')),
  integration_id  uuid NOT NULL,
  signature       text NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, integration_id, signature)
);

CREATE INDEX IF NOT EXISTS idx_ats_webhook_nonces_received_at
  ON ats_webhook_nonces (received_at);

ALTER TABLE ats_webhook_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE ats_webhook_nonces FORCE ROW LEVEL SECURITY;

CREATE POLICY ats_webhook_nonces_service ON ats_webhook_nonces
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON ats_webhook_nonces TO service_role;

COMMENT ON TABLE ats_webhook_nonces IS
  'SCRUM-1242 / AUDIT-0424-26: replay protection for ATS webhook deliveries (Greenhouse / Lever / generic). Dedupes on (provider, integration_id, signature). Sweep entries older than 14 days.';

-- =============================================================================
-- Drive webhook nonces
-- =============================================================================

CREATE TABLE IF NOT EXISTS drive_webhook_nonces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      text NOT NULL,
  message_number  bigint NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, message_number)
);

CREATE INDEX IF NOT EXISTS idx_drive_webhook_nonces_received_at
  ON drive_webhook_nonces (received_at);

ALTER TABLE drive_webhook_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE drive_webhook_nonces FORCE ROW LEVEL SECURITY;

CREATE POLICY drive_webhook_nonces_service ON drive_webhook_nonces
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT ALL ON drive_webhook_nonces TO service_role;

COMMENT ON TABLE drive_webhook_nonces IS
  'SCRUM-1242 / AUDIT-0424-26: replay protection for Drive push notifications. Dedupes on (channel_id, message_number) — Google''s monotonic per-channel counter. Sweep entries older than 14 days.';

NOTIFY pgrst, 'reload schema';
