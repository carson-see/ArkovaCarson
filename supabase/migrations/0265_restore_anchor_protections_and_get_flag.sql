-- Migration 0265: Restore chain data / legal_hold protections + get_flag function
--
-- Migration 0180 (PostgREST v12 JWT fix) accidentally removed chain_data and
-- legal_hold protections from protect_anchor_status_transition(). It also
-- dropped get_flag(text) due to overload ambiguity. This migration restores
-- both with clean single signatures.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS get_flag(text);
--   -- Then restore protect_anchor_status_transition from 0180

-- ═══════════════════════════════════════════════════════════════════
-- 1. Restore get_flag with a clean single signature
-- ═══════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS get_flag(text);
DROP FUNCTION IF EXISTS get_flag(text, boolean);

CREATE OR REPLACE FUNCTION get_flag(p_flag_key text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  flag_value boolean;
BEGIN
  SELECT value INTO flag_value
  FROM switchboard_flags
  WHERE id = p_flag_key;

  RETURN COALESCE(flag_value, false);
END;
$$;

REVOKE ALL ON FUNCTION get_flag(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_flag(text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_flag(text) TO service_role;

-- ═══════════════════════════════════════════════════════════════════
-- 2. Restore protect_anchor_status_transition with chain data +
--    legal_hold protections (accidentally removed in 0180)
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION protect_anchor_status_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF get_caller_role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status != 'PENDING' THEN
      RAISE EXCEPTION 'New anchors must start in PENDING status';
    END IF;
    RETURN NEW;
  END IF;

  -- Block status changes by non-service-role
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    RAISE EXCEPTION 'Only the system can change anchor status (current: %, requested: %)',
      OLD.status, NEW.status;
  END IF;

  -- Block chain data modifications
  IF OLD.chain_tx_id IS DISTINCT FROM NEW.chain_tx_id
    OR OLD.chain_block_height IS DISTINCT FROM NEW.chain_block_height
    OR OLD.chain_timestamp IS DISTINCT FROM NEW.chain_timestamp
  THEN
    RAISE EXCEPTION 'Cannot modify chain data'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Block legal_hold modifications
  IF OLD.legal_hold IS DISTINCT FROM NEW.legal_hold THEN
    RAISE EXCEPTION 'Cannot modify legal_hold'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
