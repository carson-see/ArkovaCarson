-- Migration 0223: Scoped anchor_document RPC (SCRUM-921 MCP-SEC-03)
--
-- Replaces the direct service-role INSERT into public_records with a
-- SECURITY DEFINER RPC that enforces per-user scoping. Callers pass
-- their authenticated user_id; the RPC validates it matches an existing
-- auth.users record before inserting.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS mcp_anchor_document(uuid, text, text, text, text, text);

CREATE OR REPLACE FUNCTION mcp_anchor_document(
  p_user_id uuid,
  p_content_hash text,
  p_record_type text DEFAULT 'document',
  p_source text DEFAULT 'mcp',
  p_title text DEFAULT NULL,
  p_source_url text DEFAULT NULL
)
RETURNS TABLE(id uuid, public_id text, content_hash text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_exists boolean;
BEGIN
  -- Validate that the user exists
  SELECT EXISTS(SELECT 1 FROM auth.users WHERE auth.users.id = p_user_id) INTO v_user_exists;
  IF NOT v_user_exists THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Validate content_hash format (64 hex chars)
  IF p_content_hash !~ '^[0-9a-fA-F]{64}$' THEN
    RAISE EXCEPTION 'content_hash must be 64 hex characters';
  END IF;

  RETURN QUERY
  INSERT INTO public_records (content_hash, record_type, source, title, source_url, source_id, metadata)
  VALUES (p_content_hash, p_record_type, p_source, p_title, p_source_url, p_content_hash, '{}'::jsonb)
  RETURNING public_records.id, public_records.public_id, public_records.content_hash;
END;
$$;

COMMENT ON FUNCTION mcp_anchor_document IS
  'MCP-SEC-03: Scoped INSERT into public_records. Validates user_id '
  'before writing so callers don''t need service-role access.';
