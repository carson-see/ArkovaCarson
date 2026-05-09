-- Migration: 0010_rls_anchors.sql
-- Description: RLS policies for anchors table
-- Rollback: DROP POLICY IF EXISTS anchors_select_own ON anchors; DROP POLICY IF EXISTS anchors_select_org ON anchors; DROP POLICY IF EXISTS anchors_insert_own ON anchors; DROP POLICY IF EXISTS anchors_update_own ON anchors;

-- =============================================================================
-- SELECT POLICIES
-- =============================================================================

-- INDIVIDUAL users can only see their own anchors
CREATE POLICY anchors_select_own ON anchors
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
  );

-- ORG_ADMIN users can also see all anchors in their organization
CREATE POLICY anchors_select_org ON anchors
  FOR SELECT
  TO authenticated
  USING (
    org_id = get_user_org_id()
    AND is_org_admin()
  );

-- =============================================================================
-- INSERT POLICY: Authenticated users can create anchors
-- =============================================================================

CREATE POLICY anchors_insert_own ON anchors
  FOR INSERT
  TO authenticated
  WITH CHECK (
    -- Must be creating for self
    user_id = auth.uid()
    -- Status must be PENDING (cannot insert as SECURED or REVOKED)
    AND status = 'PENDING'
    -- org_id must match user's org (or be NULL for INDIVIDUAL)
    AND (
      org_id IS NULL
      OR org_id = get_user_org_id()
    )
  );

-- =============================================================================
-- UPDATE POLICY: Users can update their own anchors (limited fields)
-- =============================================================================

CREATE POLICY anchors_update_own ON anchors
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    -- Cannot change user_id
    -- Cannot directly change status to SECURED (that's a system operation)
  );

-- =============================================================================
-- TRIGGER: Protect anchor status transitions
-- =============================================================================

CREATE OR REPLACE FUNCTION protect_anchor_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  jwt_role text;
BEGIN
  -- Get the current role from JWT claims
  jwt_role := current_setting('request.jwt.claims', true)::json->>'role';

  -- Service role can do anything
  IF jwt_role = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Users cannot change user_id
  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Cannot change anchor owner'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot set status to SECURED directly (only system can)
  IF OLD.status != 'SECURED' AND NEW.status = 'SECURED' THEN
    RAISE EXCEPTION 'Cannot set status to SECURED directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot modify chain data
  IF OLD.chain_tx_id IS DISTINCT FROM NEW.chain_tx_id
     OR OLD.chain_block_height IS DISTINCT FROM NEW.chain_block_height
     OR OLD.chain_timestamp IS DISTINCT FROM NEW.chain_timestamp THEN
    RAISE EXCEPTION 'Cannot modify chain data directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Users cannot modify legal_hold
  IF OLD.legal_hold IS DISTINCT FROM NEW.legal_hold THEN
    RAISE EXCEPTION 'Cannot modify legal_hold directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER protect_anchor_fields
  BEFORE UPDATE ON anchors
  FOR EACH ROW
  EXECUTE FUNCTION protect_anchor_status_transition();

-- =============================================================================
-- DELETE POLICY: Soft delete only (no hard delete for users)
-- =============================================================================

-- No DELETE policy - anchors use soft delete (deleted_at)
-- Hard deletes are admin-only operations

-- Comments
COMMENT ON POLICY anchors_select_own ON anchors IS 'Users can view their own anchors';
COMMENT ON POLICY anchors_select_org ON anchors IS 'ORG_ADMIN can view all anchors in their organization';
COMMENT ON POLICY anchors_insert_own ON anchors IS 'Users can create anchors for themselves with status PENDING';
COMMENT ON POLICY anchors_update_own ON anchors IS 'Users can update their own anchors (protected fields blocked by trigger)';
