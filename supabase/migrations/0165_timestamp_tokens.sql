-- Migration 0162: Timestamp Tokens (Phase III — PH3-ESIG-02)
-- RFC 3161 timestamp tokens from Qualified Trust Service Providers.
-- Provides legally recognized proof of signing time under eIDAS.
--
-- ROLLBACK: ALTER TABLE signatures DROP CONSTRAINT IF EXISTS fk_signatures_tst; ALTER TABLE signatures DROP CONSTRAINT IF EXISTS fk_signatures_archive_tst; DROP TABLE IF EXISTS timestamp_tokens;

CREATE TABLE timestamp_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id),

  -- What was timestamped
  signature_id    uuid REFERENCES signatures(id),           -- null for standalone/archive timestamps
  message_imprint text NOT NULL,                            -- SHA-256 hash that was timestamped (hex)
  hash_algorithm  text NOT NULL DEFAULT 'SHA-256',

  -- TST data
  tst_data        bytea NOT NULL,                           -- raw DER-encoded TimeStampToken
  tst_serial      text NOT NULL,                            -- TSA serial number
  tst_gen_time    timestamptz NOT NULL,                     -- genTime from TST

  -- Provider info
  tsa_name        text NOT NULL,                            -- e.g., 'DigiCert SHA2 Assured ID Timestamping CA'
  tsa_url         text NOT NULL,                            -- TSA endpoint URL
  tsa_cert_fingerprint text NOT NULL,                       -- TSA signing cert fingerprint
  qtsp_qualified  boolean NOT NULL DEFAULT false,           -- is this a qualified TSA per eIDAS?

  -- Token type
  token_type      text NOT NULL DEFAULT 'SIGNATURE'
                  CHECK (token_type IN ('SIGNATURE', 'ARCHIVE', 'CONTENT')),

  -- Cost tracking
  cost_usd        numeric(10, 4),                           -- per-token cost for billing
  provider_ref    text,                                     -- provider transaction reference

  -- Verification
  verified_at     timestamptz,                              -- last successful verification
  verification_status text DEFAULT 'UNVERIFIED'
                  CHECK (verification_status IN ('UNVERIFIED', 'VALID', 'INVALID', 'EXPIRED')),

  -- Audit
  created_at      timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb DEFAULT '{}'::jsonb
);

-- Indexes
CREATE INDEX idx_tst_org ON timestamp_tokens(org_id);
CREATE INDEX idx_tst_signature ON timestamp_tokens(signature_id);
CREATE INDEX idx_tst_gen_time ON timestamp_tokens(tst_gen_time DESC);
CREATE INDEX idx_tst_provider ON timestamp_tokens(tsa_name);

-- RLS
ALTER TABLE timestamp_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE timestamp_tokens FORCE ROW LEVEL SECURITY;

-- Members can view their org's timestamp tokens
CREATE POLICY tst_select ON timestamp_tokens FOR SELECT
  USING (org_id IN (
    SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()
  ));

-- Worker-only inserts via service_role (no user INSERT policy)
CREATE POLICY tst_service ON timestamp_tokens FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Grant access
GRANT SELECT ON timestamp_tokens TO authenticated;
GRANT ALL ON timestamp_tokens TO service_role;

-- Now add FK constraints from signatures to timestamp_tokens
ALTER TABLE signatures
  ADD CONSTRAINT fk_signatures_tst
    FOREIGN KEY (timestamp_token_id) REFERENCES timestamp_tokens(id);

ALTER TABLE signatures
  ADD CONSTRAINT fk_signatures_archive_tst
    FOREIGN KEY (archive_timestamp_id) REFERENCES timestamp_tokens(id);
