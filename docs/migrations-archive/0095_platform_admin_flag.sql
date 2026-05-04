-- =============================================================================
-- Migration 0095: Add is_platform_admin flag to profiles
-- Story: DB-AUDIT SEC-3 — Hardcoded admin email whitelist
-- Date: 2026-03-23
--
-- PURPOSE
-- -------
-- Platform admin status is determined by comparing emails against a hardcoded
-- list in the codebase. Adding/removing an admin requires a code deploy.
--
-- Fix: Add is_platform_admin boolean column to profiles table. Check this flag
-- instead of the hardcoded email list. Admin promotion/demotion becomes a DB
-- update, not a code change. Seed existing admins.
--
-- CHANGES
-- -------
-- 1. Add is_platform_admin boolean column (default false)
-- 2. Protect column with trigger (only service_role can set)
-- 3. Seed existing platform admins
-- =============================================================================

-- 1. Add column
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

-- 2. Create trigger to prevent non-service-role from setting is_platform_admin
CREATE OR REPLACE FUNCTION protect_platform_admin_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only service_role can change is_platform_admin
  -- Regular users attempting to set this via profile update will be blocked
  IF NEW.is_platform_admin IS DISTINCT FROM OLD.is_platform_admin THEN
    IF current_setting('role') != 'service_role' THEN
      NEW.is_platform_admin := OLD.is_platform_admin;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_platform_admin ON profiles;
CREATE TRIGGER trg_protect_platform_admin
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION protect_platform_admin_flag();

-- 3. Seed existing platform admins
UPDATE profiles SET is_platform_admin = true
WHERE email IN ('carson@arkova.ai', 'sarah@arkova.ai');

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_profiles_platform_admin
  ON profiles (is_platform_admin)
  WHERE is_platform_admin = true;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP TRIGGER IF EXISTS trg_protect_platform_admin ON profiles;
-- DROP FUNCTION IF EXISTS protect_platform_admin_flag();
-- DROP INDEX IF EXISTS idx_profiles_platform_admin;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS is_platform_admin;
