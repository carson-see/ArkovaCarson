-- =============================================================================
-- Migration 0269: Re-enforce security hardening from migration 0160
--
-- Two protections from 0160_security_hardening_critical.sql drifted across
-- later migrations and the RLS test suite (SEC-RECON-3 + SEC-RECON-7) has
-- been catching it in CI. This migration restores both.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. dev_bypass_kyc(uuid) — drop again
-- ─────────────────────────────────────────────────────────────────────────────
-- 0160 dropped this function with the comment "should never exist in
-- production". Migration 0254 (onboarding signup workflow, originally
-- authored as 0248 then renumbered) silently reintroduced it. The
-- function is SECURITY DEFINER, takes no caller-role check, and marks
-- any user as KYC-verified — exactly the flag 0160 forbade.
--
-- A repo-wide grep confirms no worker / src / edge code calls this
-- function. The reintroduction was accidental.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. get_anchor_tx_stats() — restore service-role-only access
-- ─────────────────────────────────────────────────────────────────────────────
-- 0160 + 0180 restricted this RPC to service_role + platform admins (with
-- an internal RAISE EXCEPTION guard). Migration 0215 (emergency dashboard
-- performance) replaced the body with a cached version and re-granted
-- EXECUTE to authenticated, removing the admin guard. The 0160 SEC-RECON-7
-- test catches that anon can now call it.
--
-- A repo-wide grep confirms no worker / src / edge code calls this
-- function — only test files reference it. Restricting to service_role
-- only restores the 0160 invariant without breaking any caller.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
-- Both reversions are themselves security regressions. Re-creating
-- dev_bypass_kyc requires the explicit text in 0254 (lines 786-810);
-- re-granting EXECUTE on get_anchor_tx_stats to authenticated requires
-- the GRANT statement from 0215. Neither is recommended.
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Re-drop dev_bypass_kyc (SEC-RECON-3 enforcement)
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS dev_bypass_kyc(uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Restrict get_anchor_tx_stats to service_role only (SEC-RECON-7
--    enforcement). REVOKE FROM PUBLIC + anon + authenticated covers every
--    caller class except service_role; the existing service_role grant
--    survives this REVOKE since it was made to a specific role, not PUBLIC.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION get_anchor_tx_stats() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_anchor_tx_stats() FROM anon;
REVOKE EXECUTE ON FUNCTION get_anchor_tx_stats() FROM authenticated;

-- Reload PostgREST schema cache so the grant change takes effect immediately.
NOTIFY pgrst, 'reload schema';

COMMIT;
