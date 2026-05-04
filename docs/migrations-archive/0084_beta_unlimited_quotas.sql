-- Migration 0084: Beta — Remove all quota limits
-- All users get unlimited anchors and AI credits during beta.
-- TODO: Revert this migration when beta ends and billing is enforced.
--
-- ROLLBACK: Re-apply 0049_entitlement_quota_enforcement.sql

-- Override check_anchor_quota to always return NULL (unlimited)
CREATE OR REPLACE FUNCTION check_anchor_quota()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Beta: all users get unlimited quota
  RETURN NULL;
END;
$$;
