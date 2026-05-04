-- SCRUM-1106: API key scopes — additive migration
-- ROLLBACK: ALTER TABLE api_keys DROP COLUMN IF EXISTS scopes;

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scopes text[] NOT NULL DEFAULT ARRAY['read:search'];

COMMENT ON COLUMN api_keys.scopes IS
  'Scope vocabulary: read:records, read:orgs, read:search, write:anchors, admin:rules. Default read:search for backward compat.';

CREATE INDEX IF NOT EXISTS idx_api_keys_scopes ON api_keys USING gin (scopes);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
