-- =============================================================================
-- Migration 0271: Restore get_flag(text) — third time
--
-- Migration 0180 (PostgREST v12 jwt fix, 2026-04-09) dropped get_flag(text)
-- with the comment "drop conflicting get_flag overload (PostgREST v12 can't
-- disambiguate)" but never re-created the surviving version. A repo-wide
-- grep across all migrations confirms no 2-arg get_flag exists anywhere
-- in the migration history — the "conflicting overload" 0180 was guarding
-- against does not exist. The DROP left the codebase with no get_flag
-- function at all.
--
-- The P7-S14 RLS test suite catches this with PGRST202 ("function not
-- found") on every call. The src/ frontend also hits this — `getFlag`
-- helpers in the codebase have been silently returning the safe default
-- (false) for every flag since 0180 landed, including for flags that
-- callers expected to be true (e.g., ENABLE_NEW_CHECKOUTS).
--
-- This migration restores the 0171 body verbatim. If a 2-arg overload is
-- later introduced and creates a real ambiguity, that's the migration
-- where the disambiguation work should happen — not as a one-sided drop.
--
-- ROLLBACK
-- --------
-- DROP FUNCTION IF EXISTS get_flag(text);
-- (Same as 0180 did — but don't, that's exactly the bug we're fixing.)
-- =============================================================================

BEGIN;

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

COMMENT ON FUNCTION get_flag(text) IS
  'Safe flag lookup — returns flag value or false if not found. '
  'Restored in 0271 after 0180 incorrectly dropped it.';

NOTIFY pgrst, 'reload schema';

COMMIT;
