-- =============================================================================
-- Migration 0065: Account Deletion Support (PII-02 — GDPR Art. 17)
-- Date: 2026-03-16
-- Finding: PII-02 (CRITICAL) — No right-to-erasure mechanism
--
-- PURPOSE
-- -------
-- 1. Add deleted_at column to profiles for soft-delete.
-- 2. Add RLS policy to block access to deleted profiles.
-- 3. Create delete_own_account() RPC for user-initiated deletion.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add deleted_at to profiles
-- ---------------------------------------------------------------------------

ALTER TABLE profiles
ADD COLUMN IF NOT EXISTS deleted_at timestamptz DEFAULT NULL;

-- Index for filtering out deleted profiles
CREATE INDEX IF NOT EXISTS idx_profiles_deleted_at ON profiles (deleted_at)
WHERE deleted_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Block access to soft-deleted profiles
-- ---------------------------------------------------------------------------
-- Amend existing SELECT policy to exclude deleted profiles.
-- The existing policy name may vary; we drop and recreate a comprehensive one.

-- Don't break existing policies — add a restrictive policy instead.
-- Supabase uses permissive policies by default. We add a restrictive policy
-- that ensures deleted profiles are invisible to all authenticated users.
CREATE POLICY profiles_hide_deleted ON profiles
  AS RESTRICTIVE
  FOR SELECT
  TO authenticated
  USING (deleted_at IS NULL);

-- ---------------------------------------------------------------------------
-- 3. delete_own_account() — user-initiated account deletion
-- ---------------------------------------------------------------------------
-- Called from the frontend. Triggers anonymization + soft delete.
-- The auth user deletion must happen server-side via service_role.

CREATE OR REPLACE FUNCTION delete_own_account()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_anonymize_result jsonb;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Check not already deleted
  IF EXISTS (SELECT 1 FROM profiles WHERE id = v_user_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Account already deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Anonymize PII in audit trail (GDPR Art. 17) before soft-delete
  SELECT anonymize_user_data(v_user_id) INTO v_anonymize_result;

  -- Soft-delete the profile
  UPDATE profiles SET deleted_at = now() WHERE id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Log the deletion as an audit event (no PII — actor_id only)
  INSERT INTO audit_events (
    event_type, event_category, actor_id, target_type, target_id, details
  ) VALUES (
    'ACCOUNT_DELETED', 'SYSTEM', v_user_id,
    'profile', v_user_id::text,
    jsonb_build_object('gdpr_article', '17', 'initiated_by', 'user')::text
  );

  RETURN jsonb_build_object(
    'success', true,
    'message', 'Account deleted. Personal data has been anonymized.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION delete_own_account() TO authenticated;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
-- ALTER TABLE profiles DROP COLUMN IF EXISTS deleted_at;
-- DROP INDEX IF EXISTS idx_profiles_deleted_at;
-- DROP POLICY IF EXISTS profiles_hide_deleted ON profiles;
-- DROP FUNCTION IF EXISTS delete_own_account();
-- ---------------------------------------------------------------------------
