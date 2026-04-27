-- SCRUM-1284 (R3-11) — REVOKE ALL on matviews from anon/authenticated.
--
-- Supabase advisor `materialized_view_in_api` flagged two matviews readable via
-- the auto-generated REST API by `anon` and `authenticated`:
--   * public.mv_anchor_status_counts
--   * public.mv_public_records_source_counts
--
-- Materialized views ignore RLS — anything granted to a role is fully visible.
-- These two were missed in SCRUM-1208 because the redo probe ran as service_role,
-- which bypasses RLS, so the auto-API leak was never observed.
--
-- Worker callers use `service_role` (which retains access) so this REVOKE is a
-- no-op for production reads. Public anon polling and authenticated-user polling
-- — neither of which should be hitting raw matviews — are now blocked.
--
-- We REVOKE ALL (not just SELECT) so the relacl carries no anon/authenticated
-- entries at all. INSERT/UPDATE/DELETE/etc. on a matview are no-ops, but leaving
-- them in the grant table reads as a footgun in audit traces.
--
-- Applied to prod via Supabase MCP `apply_migration` 2026-04-27. Verified:
--   * `pg_class.relacl` for both views contains only postgres + service_role.
--   * Supabase advisor `materialized_view_in_api` returns zero hits.
--
-- Reference: https://supabase.com/docs/guides/database/database-linter?lint=0011_materialized_view_in_api
--
-- ROLLBACK:
--   GRANT SELECT ON public.mv_anchor_status_counts TO anon, authenticated;
--   GRANT SELECT ON public.mv_public_records_source_counts TO anon, authenticated;

BEGIN;

REVOKE ALL ON public.mv_anchor_status_counts FROM anon, authenticated;
REVOKE ALL ON public.mv_public_records_source_counts FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
