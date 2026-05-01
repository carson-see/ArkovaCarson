-- SCRUM-1581: canonical API key scope vocabulary.
-- Aligns the database CHECK constraint with services/worker/src/api/apiScopes.ts
-- and the frontend picker/display vocabulary.
--
-- ROLLBACK:
-- ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_known_values;
-- ALTER TABLE public.api_keys
--   ADD CONSTRAINT api_keys_scopes_known_values
--   CHECK (
--     coalesce(array_length(scopes, 1), 0) >= 1
--     AND scopes <@ ARRAY[
--       'read:records',
--       'read:orgs',
--       'read:search',
--       'write:anchors',
--       'admin:rules',
--       'verify',
--       'verify:batch',
--       'usage:read',
--       'keys:manage'
--     ]::text[]
--   );
-- COMMENT ON COLUMN public.api_keys.scopes IS
--   'Scope vocabulary: read:records, read:orgs, read:search, write:anchors, admin:rules. Legacy verify, verify:batch, usage:read, keys:manage remain accepted for v1 compatibility.';
-- NOTIFY pgrst, 'reload schema';

DO $$
DECLARE
  canonical_scopes CONSTANT text[] := ARRAY[
    'read:records',
    'read:orgs',
    'read:search',
    'write:anchors',
    'admin:rules',
    'verify',
    'verify:batch',
    'usage:read',
    'keys:manage',
    'compliance:read',
    'compliance:write',
    'oracle:read',
    'oracle:write',
    'anchor:write',
    'anchor:read',
    'attestations:write',
    'attestations:read',
    'webhooks:manage',
    'agents:manage',
    'keys:read'
  ];
  legacy_agent_scopes CONSTANT text[] := ARRAY['attest', 'oracle', 'batch', 'usage'];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_keys'
      AND column_name = 'scopes'
  ) THEN
    ALTER TABLE public.api_keys
      DROP CONSTRAINT IF EXISTS api_keys_scopes_known_values;

    EXECUTE format(
      'ALTER TABLE public.api_keys
        ADD CONSTRAINT api_keys_scopes_known_values
        CHECK (
          coalesce(array_length(scopes, 1), 0) >= 1
          AND scopes <@ %L::text[]
        )',
      canonical_scopes
    );

    COMMENT ON COLUMN public.api_keys.scopes IS
      'Canonical scope vocabulary: read:records, read:orgs, read:search, write:anchors, admin:rules, compliance:read, compliance:write, oracle:read, oracle:write, anchor:read, anchor:write, attestations:read, attestations:write, webhooks:manage, agents:manage, keys:read. Legacy verify, verify:batch, usage:read, keys:manage remain accepted for v1 compatibility.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agents'
      AND column_name = 'allowed_scopes'
  ) THEN
    UPDATE public.agents
    SET allowed_scopes = (
      SELECT ARRAY(
        SELECT DISTINCT mapped_scope
        FROM unnest(allowed_scopes) AS existing_scope(scope)
        CROSS JOIN LATERAL (
          SELECT CASE scope
            WHEN 'attest' THEN 'attestations:write'
            WHEN 'oracle' THEN 'oracle:read'
            WHEN 'batch' THEN 'verify:batch'
            WHEN 'usage' THEN 'usage:read'
            ELSE scope
          END AS mapped_scope
        ) mapped
        ORDER BY mapped_scope
      )
    )
    WHERE allowed_scopes && legacy_agent_scopes;

    ALTER TABLE public.agents
      ALTER COLUMN allowed_scopes SET DEFAULT ARRAY['verify'];

    ALTER TABLE public.agents
      DROP CONSTRAINT IF EXISTS agents_allowed_scopes_known_values;

    EXECUTE format(
      'ALTER TABLE public.agents
        ADD CONSTRAINT agents_allowed_scopes_known_values
        CHECK (
          coalesce(array_length(allowed_scopes, 1), 0) >= 1
          AND allowed_scopes <@ %L::text[]
        )',
      canonical_scopes
    );

    COMMENT ON COLUMN public.agents.allowed_scopes IS
      'Canonical API key scopes this agent may hold. Historical attest/oracle/batch/usage aliases were normalized in migration 0285.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
