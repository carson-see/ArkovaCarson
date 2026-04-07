-- =============================================================================
-- Migration 0171: Restore get_flag function
-- Date: 2026-04-07
--
-- PURPOSE
-- -------
-- Migration 0119 dropped get_flag(text) to resolve overload ambiguity,
-- expecting a two-arg version to handle calls. However, no two-arg version
-- existed, leaving get_flag completely unavailable. This restores the
-- single-arg version from 0102 with the correct parameter name (p_flag_key).
--
-- ROLLBACK: DROP FUNCTION IF EXISTS get_flag(text);
-- =============================================================================

CREATE OR REPLACE FUNCTION get_flag(p_flag_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_value boolean;
  v_default boolean;
BEGIN
  SELECT value, default_value INTO v_value, v_default
  FROM switchboard_flags
  WHERE id = p_flag_key;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  RETURN COALESCE(v_value, v_default);
END;
$$;

GRANT EXECUTE ON FUNCTION get_flag(text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_flag(text) TO service_role;

COMMENT ON FUNCTION get_flag(text) IS 'Safe flag lookup — returns flag value or false if not found';
