-- SCRUM-2043 — Dual HMAC key rotation for DocuSign Connect (SOC 2 CC6.1)
--
-- Adds per-integration HMAC key storage so webhook HMAC verification can
-- use org-level keys instead of the single global env var. Supports
-- zero-downtime rotation: store [old_key, new_key] → DocuSign sends both
-- signatures → verify against either → retire old key.
--
-- Schema: jsonb array of {key, created_at, label?}. Null means "use the
-- global DOCUSIGN_CONNECT_HMAC_SECRET env var" (backward compat).
--
-- ROLLBACK:
--   ALTER TABLE public.org_integrations DROP COLUMN IF EXISTS hmac_keys;

BEGIN;

ALTER TABLE public.org_integrations
  ADD COLUMN IF NOT EXISTS hmac_keys jsonb;

COMMENT ON COLUMN public.org_integrations.hmac_keys IS
  'SCRUM-2043: JSONB array of HMAC keys for DocuSign Connect webhook verification. Supports zero-downtime dual-key rotation. Null = fallback to DOCUSIGN_CONNECT_HMAC_SECRET env var.';

NOTIFY pgrst, 'reload schema';

COMMIT;
