-- Credential Portfolios (ATT-05)
-- Shareable bundles of verified attestations + anchored documents
-- ROLLBACK: DROP TABLE IF EXISTS credential_portfolios;

CREATE TABLE credential_portfolios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text UNIQUE NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL,
  attestation_ids uuid[] DEFAULT '{}',
  anchor_ids uuid[] DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE credential_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_portfolios FORCE ROW LEVEL SECURITY;

-- RLS: owner can CRUD
CREATE POLICY "portfolio_owner_all" ON credential_portfolios
  FOR ALL USING (auth.uid() = user_id);

-- RLS: public can read active (non-expired) portfolios
CREATE POLICY "portfolio_public_read" ON credential_portfolios
  FOR SELECT USING (
    expires_at IS NULL OR expires_at > now()
  );

-- Index for public_id lookups
CREATE INDEX idx_credential_portfolios_public_id ON credential_portfolios (public_id);
CREATE INDEX idx_credential_portfolios_user_id ON credential_portfolios (user_id);
