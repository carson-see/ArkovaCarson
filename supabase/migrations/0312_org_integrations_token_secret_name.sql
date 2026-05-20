-- SCRUM-1101 / SCRUM-1718: keep long-lived OAuth refresh tokens in Secret
-- Manager. org_integrations stores only the Secret Manager resource name.
ALTER TABLE public.org_integrations
  ADD COLUMN IF NOT EXISTS token_secret_name text;

COMMENT ON COLUMN public.org_integrations.token_secret_name IS
  'Secret Manager resource name for long-lived OAuth refresh tokens. Cleartext refresh tokens must not be stored in Postgres.';
