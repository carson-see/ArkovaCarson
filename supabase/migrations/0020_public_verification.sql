-- Migration: 0020_public_verification.sql
-- Description: Public verification ID and view support
-- Rollback: DROP INDEX IF EXISTS idx_anchors_public_id; ALTER TABLE anchors DROP COLUMN IF EXISTS public_id;

-- =============================================================================
-- ADD PUBLIC ID TO ANCHORS
-- =============================================================================
-- Non-guessable public ID for verification links

-- Generate cryptographically secure public ID
CREATE OR REPLACE FUNCTION generate_public_id()
RETURNS text AS $$
DECLARE
  chars text := 'abcdefghjkmnpqrstuvwxyz23456789'; -- No ambiguous chars
  result text := '';
  i integer;
BEGIN
  FOR i IN 1..12 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Add public_id column to anchors
ALTER TABLE anchors
  ADD COLUMN IF NOT EXISTS public_id text UNIQUE;

-- Create index for public_id lookups
CREATE INDEX IF NOT EXISTS idx_anchors_public_id ON anchors(public_id) WHERE public_id IS NOT NULL;

-- Auto-generate public_id on SECURED status
CREATE OR REPLACE FUNCTION auto_generate_public_id()
RETURNS TRIGGER AS $$
BEGIN
  -- Generate public_id when anchor becomes SECURED
  IF NEW.status = 'SECURED' AND OLD.status != 'SECURED' AND NEW.public_id IS NULL THEN
    NEW.public_id := generate_public_id();

    -- Ensure uniqueness (retry if collision)
    WHILE EXISTS (SELECT 1 FROM anchors WHERE public_id = NEW.public_id AND id != NEW.id) LOOP
      NEW.public_id := generate_public_id();
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER generate_public_id_on_secured
  BEFORE UPDATE ON anchors
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_public_id();

-- =============================================================================
-- PUBLIC VERIFICATION FUNCTION
-- =============================================================================
-- Returns redacted anchor info for public verification

CREATE OR REPLACE FUNCTION get_public_anchor(p_public_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'public_id', a.public_id,
    'fingerprint', a.fingerprint,
    'status', a.status,
    'filename', a.filename,
    'file_size', a.file_size,
    'secured_at', a.chain_timestamp,
    'network_receipt', a.chain_tx_id,
    'verified', a.status = 'SECURED'
  )
  INTO v_result
  FROM anchors a
  WHERE a.public_id = p_public_id
    AND a.status = 'SECURED'
    AND a.deleted_at IS NULL;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object('error', 'Anchor not found or not verified');
  END IF;

  RETURN v_result;
END;
$$;

-- Allow anonymous access to public verification
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO anon;
GRANT EXECUTE ON FUNCTION get_public_anchor(text) TO authenticated;

-- Comments
COMMENT ON FUNCTION generate_public_id IS 'Generates non-guessable public ID';
COMMENT ON FUNCTION get_public_anchor IS 'Returns redacted anchor info for public verification';
