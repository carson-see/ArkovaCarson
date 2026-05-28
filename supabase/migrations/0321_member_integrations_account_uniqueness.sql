-- SCRUM-2044 — Enforce global uniqueness on active member DocuSign accounts
--
-- A single DocuSign account_id must be connected to at most one active
-- member integration across all orgs/users. Without this, the webhook
-- handler's member_integrations lookup returns multiple rows for the same
-- account_id, triggering the ambiguity guard and rejecting the webhook.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS member_integrations_unique_active_account;

BEGIN;

CREATE UNIQUE INDEX member_integrations_unique_active_account
  ON public.member_integrations (provider, account_id)
  WHERE (revoked_at IS NULL);

COMMENT ON INDEX public.member_integrations_unique_active_account IS
  'SCRUM-2044: Prevents the same provider account from being actively connected by multiple members. Webhook routing queries by (provider, account_id) — ambiguity would reject the webhook.';

NOTIFY pgrst, 'reload schema';

COMMIT;
