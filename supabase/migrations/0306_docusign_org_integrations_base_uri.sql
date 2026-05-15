-- SCRUM-1655 / SCRUM-1648: DocuSign OAuth callback persists the
-- account base URI discovered from /oauth/userinfo so document-fetch jobs
-- can call the correct DocuSign REST shard for the connected account.
-- Rollback:
-- ALTER TABLE public.org_integrations
--   DROP COLUMN IF EXISTS base_uri;
ALTER TABLE public.org_integrations
  ADD COLUMN IF NOT EXISTS base_uri text;

COMMENT ON COLUMN public.org_integrations.base_uri IS
  'DocuSign/connector REST API base URI discovered during OAuth userinfo; used by retryable document-fetch jobs.';
