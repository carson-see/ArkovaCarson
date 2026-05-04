-- Migration 0265: AUDIT-06 / SCRUM-1187 — payment_ledger view to SECURITY INVOKER.
--
-- PG15+ views default to SECURITY DEFINER (Supabase advisor
-- `security_definer_view`, ERROR-level). Migration 0100 created
-- `payment_ledger`; migration 0160 restricted SELECT to service_role +
-- the platform-admin wrapper `get_payment_ledger`, but the view itself
-- still runs with creator privileges, bypassing RLS on the underlying
-- billing_events / x402_payments / ai_usage_events tables.
--
-- Pinning to SECURITY INVOKER means callers get the RLS view of the
-- caller. Since the only callers post-0160 are service_role (RLS-bypass
-- regardless) and the SECURITY DEFINER `get_payment_ledger` wrapper
-- (also runs as service_role), the runtime behavior is unchanged — but
-- the advisor finding clears, and any future regression that re-grants
-- the view to authenticated will fail-safe instead of leaking.
--
-- Reference: https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view
--
-- ROLLBACK:
--   ALTER VIEW public.payment_ledger SET (security_invoker = false);

BEGIN;

ALTER VIEW public.payment_ledger SET (security_invoker = true);

NOTIFY pgrst, 'reload schema';

COMMIT;
