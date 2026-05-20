-- SCRUM-1101 follow-up: reload PostgREST after the merged 0312 token_secret_name
-- column migration. This is a compensating migration because merged migrations
-- are append-only and must not be edited after landing.

COMMENT ON COLUMN public.org_integrations.token_secret_name IS
  'Secret Manager resource name for long-lived OAuth refresh tokens. Cleartext refresh tokens must not be stored in Postgres.';

NOTIFY pgrst, 'reload schema';

-- Rollback:
-- COMMENT ON COLUMN public.org_integrations.token_secret_name IS NULL;
-- NOTIFY pgrst, 'reload schema';
