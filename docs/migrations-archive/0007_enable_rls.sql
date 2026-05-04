-- Migration: 0007_enable_rls.sql
-- Description: Enable RLS on all tables and revoke public grants
-- Rollback: See individual GRANT statements to restore

-- =============================================================================
-- ENABLE ROW LEVEL SECURITY ON ALL TABLES
-- =============================================================================

-- Organizations
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

-- Profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles FORCE ROW LEVEL SECURITY;

-- Anchors
ALTER TABLE anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE anchors FORCE ROW LEVEL SECURITY;

-- Audit Events
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- REVOKE PUBLIC GRANTS (Least Privilege)
-- =============================================================================

-- Revoke all public access to tables
REVOKE ALL ON organizations FROM public;
REVOKE ALL ON profiles FROM public;
REVOKE ALL ON anchors FROM public;
REVOKE ALL ON audit_events FROM public;

-- Revoke public access to sequences
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM public;

-- Revoke public execute on functions (except trigger functions needed internally)
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM public;

-- =============================================================================
-- GRANT ACCESS TO AUTHENTICATED ROLE
-- =============================================================================

-- The 'authenticated' role is used by Supabase for logged-in users
-- Actual row access is controlled by RLS policies (defined in subsequent migrations)

GRANT SELECT, INSERT, UPDATE, DELETE ON organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON anchors TO authenticated;
GRANT SELECT, INSERT ON audit_events TO authenticated;

-- Grant usage on sequences for INSERT operations
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- =============================================================================
-- GRANT ACCESS TO SERVICE ROLE (for admin operations)
-- =============================================================================

-- Service role bypasses RLS - use with caution
GRANT ALL ON organizations TO service_role;
GRANT ALL ON profiles TO service_role;
GRANT ALL ON anchors TO service_role;
GRANT ALL ON audit_events TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Comments
COMMENT ON TABLE organizations IS 'RLS enabled. Public access revoked. Access via authenticated role only.';
COMMENT ON TABLE profiles IS 'RLS enabled and forced. Public access revoked.';
COMMENT ON TABLE anchors IS 'RLS enabled and forced. Public access revoked.';
COMMENT ON TABLE audit_events IS 'RLS enabled and forced. Append-only (UPDATE/DELETE blocked).';
