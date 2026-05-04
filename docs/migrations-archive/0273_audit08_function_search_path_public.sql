-- Migration 0264: AUDIT-08 / SCRUM-1189 — pin search_path = public on
-- 13 mutable-search-path functions flagged by the Supabase advisor
-- `function_search_path_mutable`.
--
-- CLAUDE.md §1.4 mandates: "SECURITY DEFINER functions must SET
-- search_path = public." Several of these are SECURITY INVOKER trigger
-- functions, but a mutable search_path is still a defense-in-depth
-- concern (a malicious schema in the caller's path could shadow
-- public.* objects), so we pin the lot.
--
-- ALTER FUNCTION ... SET search_path = public preserves the function
-- body (vs CREATE OR REPLACE), which avoids re-running their CREATE
-- TRIGGER bindings and keeps the migration purely metadata.
--
-- ROLLBACK:
--   ALTER FUNCTION public.sanitize_metadata_for_public(jsonb) RESET search_path;
--   ALTER FUNCTION public.protect_privileged_profile_fields() RESET search_path;
--   ALTER FUNCTION public.reject_audit_modification() RESET search_path;
--   ALTER FUNCTION public.update_agents_updated_at() RESET search_path;
--   ALTER FUNCTION public.prevent_attestation_claim_modification() RESET search_path;
--   ALTER FUNCTION public.generate_anchor_public_id(text) RESET search_path;
--   ALTER FUNCTION public.update_attestation_updated_at() RESET search_path;
--   ALTER FUNCTION public.trigger_set_updated_at() RESET search_path;
--   ALTER FUNCTION public.check_role_immutability() RESET search_path;
--   ALTER FUNCTION public.enforce_lowercase_email() RESET search_path;
--   ALTER FUNCTION public.generate_public_id() RESET search_path;
--   ALTER FUNCTION public.auto_generate_public_id() RESET search_path;
--   ALTER FUNCTION public.update_review_queue_updated_at() RESET search_path;

BEGIN;

ALTER FUNCTION public.sanitize_metadata_for_public(jsonb) SET search_path = public;
ALTER FUNCTION public.protect_privileged_profile_fields() SET search_path = public;
ALTER FUNCTION public.reject_audit_modification() SET search_path = public;
ALTER FUNCTION public.update_agents_updated_at() SET search_path = public;
ALTER FUNCTION public.prevent_attestation_claim_modification() SET search_path = public;
ALTER FUNCTION public.generate_anchor_public_id(text) SET search_path = public;
ALTER FUNCTION public.update_attestation_updated_at() SET search_path = public;
ALTER FUNCTION public.trigger_set_updated_at() SET search_path = public;
ALTER FUNCTION public.check_role_immutability() SET search_path = public;
ALTER FUNCTION public.enforce_lowercase_email() SET search_path = public;
ALTER FUNCTION public.generate_public_id() SET search_path = public;
ALTER FUNCTION public.auto_generate_public_id() SET search_path = public;
ALTER FUNCTION public.update_review_queue_updated_at() SET search_path = public;

-- Refresh PostgREST schema cache so the new attribute is picked up.
NOTIFY pgrst, 'reload schema';

COMMIT;
