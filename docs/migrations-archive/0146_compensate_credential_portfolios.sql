-- Compensating migration for deleted 0134_credential_portfolios.sql
-- (duplicate PK with 0134_anchor_perf_rpcs.sql)
-- Credential Portfolios (ATT-05) — shareable bundles of verified credentials.
-- All statements idempotent for production safety.
--
-- ROLLBACK: DROP TABLE IF EXISTS credential_portfolios;

CREATE TABLE IF NOT EXISTS credential_portfolios (
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

-- RLS policies (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'portfolio_owner_all' AND tablename = 'credential_portfolios') THEN
    CREATE POLICY "portfolio_owner_all" ON credential_portfolios
      FOR ALL USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'portfolio_public_read' AND tablename = 'credential_portfolios') THEN
    CREATE POLICY "portfolio_public_read" ON credential_portfolios
      FOR SELECT USING (expires_at IS NULL OR expires_at > now());
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_credential_portfolios_public_id ON credential_portfolios (public_id);
CREATE INDEX IF NOT EXISTS idx_credential_portfolios_user_id ON credential_portfolios (user_id);
