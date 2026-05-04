-- Migration 0133: Admin management RPCs
--
-- Provides SECURITY DEFINER functions for platform admin operations.
-- These bypass protective triggers (role immutability, org_id protection, platform admin guard).
-- Only callable by service_role (worker).
--
-- ROLLBACK:
-- DROP FUNCTION IF EXISTS admin_set_platform_admin(uuid, boolean);
-- DROP FUNCTION IF EXISTS admin_change_user_role(uuid, text);
-- DROP FUNCTION IF EXISTS admin_set_user_org(uuid, uuid, text);

-- 1. Toggle platform admin flag
CREATE OR REPLACE FUNCTION admin_set_platform_admin(
  p_user_id uuid,
  p_is_admin boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Temporarily disable protective triggers
  ALTER TABLE profiles DISABLE TRIGGER trg_protect_platform_admin;

  UPDATE profiles
  SET is_platform_admin = p_is_admin,
      updated_at = now()
  WHERE id = p_user_id;

  ALTER TABLE profiles ENABLE TRIGGER trg_protect_platform_admin;

  IF NOT FOUND THEN
    ALTER TABLE profiles ENABLE TRIGGER trg_protect_platform_admin;
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION admin_set_platform_admin IS 'Toggle is_platform_admin flag. Bypasses protective trigger. Service role only.';

-- 2. Change user role (bypasses role immutability trigger)
CREATE OR REPLACE FUNCTION admin_change_user_role(
  p_user_id uuid,
  p_new_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Validate role
  IF p_new_role NOT IN ('INDIVIDUAL', 'ORG_ADMIN', 'ORG_MEMBER') THEN
    RAISE EXCEPTION 'Invalid role: %. Must be INDIVIDUAL, ORG_ADMIN, or ORG_MEMBER', p_new_role;
  END IF;

  -- Temporarily disable role immutability + privileged field triggers
  ALTER TABLE profiles DISABLE TRIGGER enforce_role_immutability;
  ALTER TABLE profiles DISABLE TRIGGER protect_privileged_fields;

  UPDATE profiles
  SET role = p_new_role::user_role,
      updated_at = now()
  WHERE id = p_user_id;

  ALTER TABLE profiles ENABLE TRIGGER enforce_role_immutability;
  ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;

  IF NOT FOUND THEN
    ALTER TABLE profiles ENABLE TRIGGER enforce_role_immutability;
    ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION admin_change_user_role IS 'Change user role. Bypasses immutability trigger. Service role only.';

-- 3. Set user organization (bypasses org_id protection)
CREATE OR REPLACE FUNCTION admin_set_user_org(
  p_user_id uuid,
  p_org_id uuid,
  p_org_role text DEFAULT 'member'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Validate org_role
  IF p_org_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'Invalid org_role: %. Must be owner, admin, or member', p_org_role;
  END IF;

  -- Validate org exists if not null
  IF p_org_id IS NOT NULL THEN
    PERFORM 1 FROM organizations WHERE id = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Organization not found: %', p_org_id;
    END IF;
  END IF;

  -- Disable protective triggers
  ALTER TABLE profiles DISABLE TRIGGER protect_privileged_fields;

  UPDATE profiles
  SET org_id = p_org_id,
      updated_at = now()
  WHERE id = p_user_id;

  ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;

  IF NOT FOUND THEN
    ALTER TABLE profiles ENABLE TRIGGER protect_privileged_fields;
    RAISE EXCEPTION 'User not found: %', p_user_id;
  END IF;

  -- Manage org_members junction table
  IF p_org_id IS NOT NULL THEN
    INSERT INTO org_members (user_id, org_id, role)
    VALUES (p_user_id, p_org_id, p_org_role::org_member_role)
    ON CONFLICT (user_id, org_id) DO UPDATE SET role = p_org_role::org_member_role;
  ELSE
    -- Remove from org_members if org is being unset
    DELETE FROM org_members WHERE user_id = p_user_id;
  END IF;
END;
$$;

COMMENT ON FUNCTION admin_set_user_org IS 'Set user organization and org_members role. Bypasses protective triggers. Service role only.';
