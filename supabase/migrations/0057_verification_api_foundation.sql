-- Migration 0057: Verification API Foundation (P4.5-TS-12 + P4.5-TS-03)
-- Adds ENABLE_VERIFICATION_API flag and API keys infrastructure.

-- =====================================================================
-- 1. Feature flag: ENABLE_VERIFICATION_API (P4.5-TS-12)
-- =====================================================================

INSERT INTO switchboard_flags (flag_key, enabled, description)
VALUES (
  'ENABLE_VERIFICATION_API',
  false,
  'Gates all /api/v1/* verification endpoints. When false, returns HTTP 503.'
)
ON CONFLICT (flag_key) DO NOTHING;

-- =====================================================================
-- 2. API Keys table (P4.5-TS-03)
-- =====================================================================

-- Rate limit tier enum
DO $$ BEGIN
  CREATE TYPE api_key_rate_limit_tier AS ENUM ('free', 'paid', 'custom');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_prefix text NOT NULL,              -- First 8 chars for identification (e.g., "ak_live_")
  key_hash text NOT NULL,                -- HMAC-SHA256 hash — raw key NEVER stored
  name text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['verify'],
  rate_limit_tier api_key_rate_limit_tier NOT NULL DEFAULT 'free',
  last_used_at timestamptz,
  expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  revoked_at timestamptz,
  revocation_reason text,

  -- Constraints
  CONSTRAINT api_keys_prefix_length CHECK (length(key_prefix) >= 8),
  CONSTRAINT api_keys_hash_not_empty CHECK (length(key_hash) > 0),
  CONSTRAINT api_keys_name_not_empty CHECK (length(trim(name)) > 0)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON api_keys(org_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(org_id, is_active) WHERE is_active = true;

-- RLS
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

-- Org members can SELECT their own org's keys (uses get_user_org_id() like other tables)
CREATE POLICY api_keys_select_own_org ON api_keys
  FOR SELECT
  TO authenticated
  USING (org_id = get_user_org_id());

-- service_role has full access (INSERT/UPDATE/DELETE happen via worker)
CREATE POLICY api_keys_service_role_all ON api_keys
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- =====================================================================
-- 3. API Key Usage table (P4.5-TS-03)
-- =====================================================================

CREATE TABLE IF NOT EXISTS api_key_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  month text NOT NULL,                   -- Format: YYYY-MM
  request_count integer NOT NULL DEFAULT 0,
  last_request_at timestamptz,

  -- Composite unique: one row per key per month
  CONSTRAINT api_key_usage_unique_key_month UNIQUE (api_key_id, month)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_api_key_usage_org_month ON api_key_usage(org_id, month);

-- RLS
ALTER TABLE api_key_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_usage FORCE ROW LEVEL SECURITY;

-- Org members can read their own org's usage
CREATE POLICY api_key_usage_select_own_org ON api_key_usage
  FOR SELECT
  TO authenticated
  USING (org_id = get_user_org_id());

-- service_role has full access
CREATE POLICY api_key_usage_service_role_all ON api_key_usage
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ROLLBACK:
-- DROP TABLE IF EXISTS api_key_usage;
-- DROP TABLE IF EXISTS api_keys;
-- DROP TYPE IF EXISTS api_key_rate_limit_tier;
-- DELETE FROM switchboard_flags WHERE flag_key = 'ENABLE_VERIFICATION_API';
