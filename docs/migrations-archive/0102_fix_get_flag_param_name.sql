-- Migration: 0102_fix_get_flag_param_name.sql
-- Description: Fix get_flag RPC parameter name to match worker code (p_flag_key)
-- ROLLBACK: DROP FUNCTION IF EXISTS get_flag(text); CREATE OR REPLACE FUNCTION get_flag(p_flag_id text) ...
--
-- The original function (0021) defines p_flag_id but all worker code calls
-- supabase.rpc('get_flag', { p_flag_key: '...' }). Supabase RPC uses named
-- parameters, so the mismatch causes silent failures.
--
-- PostgreSQL does not allow renaming parameters via CREATE OR REPLACE.
-- Must DROP + CREATE.

DROP FUNCTION IF EXISTS get_flag(text);

CREATE FUNCTION get_flag(p_flag_key text)
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

-- Re-grant permissions (DROP removes them)
GRANT EXECUTE ON FUNCTION get_flag(text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_flag(text) TO service_role;

COMMENT ON FUNCTION get_flag(text) IS 'Safe flag lookup with default — param: p_flag_key';
