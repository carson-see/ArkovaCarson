-- SCRUM-1106: Correct API key scope defaults/backfill for API v2 least-privilege enforcement.
-- ROLLBACK:
-- UPDATE public.api_keys
--   SET scopes = ARRAY['verify']::text[]
--   WHERE scopes = ARRAY['read:search', 'verify']::text[]
--      OR scopes = ARRAY['read:search']::text[];
-- ALTER TABLE public.api_keys ALTER COLUMN scopes SET DEFAULT ARRAY['verify'];
-- ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_scopes_known_values;
-- NOTIFY pgrst, 'reload schema';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_keys'
      AND column_name = 'scopes'
  ) THEN
    ALTER TABLE public.api_keys
      ALTER COLUMN scopes SET DEFAULT ARRAY['read:search'];
  END IF;
END $$;

-- Backfill: only legacy verify-default keys and empty/null arrays receive the
-- new default scope. Keys with explicit scopes (set by the customer or another
-- migration) are left untouched to avoid silent privilege expansion.
UPDATE public.api_keys
SET scopes = (
  SELECT ARRAY(
    SELECT DISTINCT scope
    FROM unnest(scopes || ARRAY['read:search']) AS scope
    ORDER BY scope
  )
)
WHERE scopes = ARRAY['verify']::text[]
   OR scopes = ARRAY[]::text[]
   OR scopes IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_keys'
      AND column_name = 'scopes'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'api_keys_scopes_known_values'
  ) THEN
    ALTER TABLE public.api_keys
      ADD CONSTRAINT api_keys_scopes_known_values
      CHECK (
        array_length(scopes, 1) >= 1
        AND scopes <@ ARRAY[
          'read:records',
          'read:orgs',
          'read:search',
          'write:anchors',
          'admin:rules',
          'verify',
          'verify:batch',
          'usage:read',
          'keys:manage'
        ]::text[]
      );
  END IF;
END $$;

-- Index idx_api_keys_scopes already created by 0239_api_key_scopes.sql

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'api_keys'
      AND column_name = 'scopes'
  ) THEN
    COMMENT ON COLUMN public.api_keys.scopes IS
      'Scope vocabulary: read:records, read:orgs, read:search, write:anchors, admin:rules. Legacy verify, verify:batch, usage:read, keys:manage remain accepted for v1 compatibility.';
  END IF;
END $$;

ALTER TABLE IF EXISTS public.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.api_keys FORCE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
