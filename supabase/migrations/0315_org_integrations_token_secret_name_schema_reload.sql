-- Jira: SCRUM-1101
-- Purpose: reload PostgREST after the merged 0312 token_secret_name column
-- migration. This is a compensating migration because merged migrations are
-- append-only and must not be edited after landing.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'org_integrations'
      AND column_name = 'token_secret_name'
  ) THEN
    COMMENT ON COLUMN public.org_integrations.token_secret_name IS
      'Secret Manager resource name for long-lived OAuth refresh tokens. Cleartext refresh tokens must not be stored in Postgres.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ROLLBACK:
-- DO $$
-- BEGIN
--   IF EXISTS (
--     SELECT 1
--     FROM information_schema.columns
--     WHERE table_schema = 'public'
--       AND table_name = 'org_integrations'
--       AND column_name = 'token_secret_name'
--   ) THEN
--     COMMENT ON COLUMN public.org_integrations.token_secret_name IS NULL;
--   END IF;
-- END $$;
-- NOTIFY pgrst, 'reload schema';
