-- Migration 0056: Anchor Recipients Table (UF-03)
-- Creates a recipient tracking system for credentials issued to individuals.
-- Recipient emails are stored as HMAC-SHA256 hashes for privacy.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS link_recipient_on_signup CASCADE; DROP FUNCTION IF EXISTS get_my_credentials CASCADE; DROP TABLE IF EXISTS anchor_recipients CASCADE;

-- =============================================================================
-- TABLE: anchor_recipients
-- =============================================================================

CREATE TABLE anchor_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id uuid NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
  recipient_email_hash text NOT NULL,
  recipient_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anchor_recipients_unique UNIQUE (anchor_id, recipient_email_hash)
);

-- Index for fast lookups by recipient user
CREATE INDEX idx_anchor_recipients_user_id ON anchor_recipients(recipient_user_id) WHERE recipient_user_id IS NOT NULL;
-- Index for fast lookups by email hash (for claim flow)
CREATE INDEX idx_anchor_recipients_email_hash ON anchor_recipients(recipient_email_hash);

ALTER TABLE anchor_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE anchor_recipients FORCE ROW LEVEL SECURITY;

-- RLS: Recipients can see only their own rows
CREATE POLICY "Recipients can view own credentials"
  ON anchor_recipients
  FOR SELECT
  TO authenticated
  USING (recipient_user_id = auth.uid());

-- RLS: Org admins can insert recipients for their org's anchors
CREATE POLICY "Org admins can insert recipients"
  ON anchor_recipients
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM anchors a
      JOIN profiles p ON p.id = auth.uid()
      WHERE a.id = anchor_id
        AND a.org_id = p.org_id
        AND p.role = 'ORG_ADMIN'
    )
  );

-- RLS: Individual users can insert recipients for their own anchors
CREATE POLICY "Individuals can insert recipients for own anchors"
  ON anchor_recipients
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM anchors a
      WHERE a.id = anchor_id
        AND a.user_id = auth.uid()
    )
  );

-- Service role can do everything (for worker auto-linking)
CREATE POLICY "Service role full access"
  ON anchor_recipients
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- RPC: get_my_credentials — fetch credentials issued TO the current user
-- =============================================================================

CREATE OR REPLACE FUNCTION get_my_credentials()
RETURNS TABLE (
  recipient_id uuid,
  anchor_id uuid,
  claimed_at timestamptz,
  recipient_created_at timestamptz,
  public_id text,
  filename text,
  fingerprint text,
  status text,
  credential_type text,
  metadata jsonb,
  issued_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz,
  org_name text,
  org_id uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    ar.id AS recipient_id,
    ar.anchor_id,
    ar.claimed_at,
    ar.created_at AS recipient_created_at,
    a.public_id,
    a.filename,
    a.fingerprint,
    a.status::text,
    a.credential_type::text,
    a.metadata,
    a.issued_at,
    a.expires_at,
    a.created_at,
    o.display_name AS org_name,
    a.org_id
  FROM anchor_recipients ar
  JOIN anchors a ON a.id = ar.anchor_id
  LEFT JOIN organizations o ON o.id = a.org_id
  WHERE ar.recipient_user_id = auth.uid()
    AND a.deleted_at IS NULL
  ORDER BY a.created_at DESC;
$$;

-- =============================================================================
-- RPC: link_recipient_on_signup — auto-link unclaimed credentials on signup
-- Called by the worker/trigger after a new user is created.
-- Matches email hash against unclaimed recipients.
-- =============================================================================

CREATE OR REPLACE FUNCTION link_recipient_on_signup(p_user_id uuid, p_email_hash text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  linked_count integer;
BEGIN
  UPDATE anchor_recipients
  SET recipient_user_id = p_user_id,
      claimed_at = now()
  WHERE recipient_email_hash = p_email_hash
    AND recipient_user_id IS NULL;

  GET DIAGNOSTICS linked_count = ROW_COUNT;
  RETURN linked_count;
END;
$$;

COMMENT ON TABLE anchor_recipients IS 'Tracks which credentials have been issued to which recipients. Email stored as HMAC hash for privacy. UF-03.';
COMMENT ON FUNCTION get_my_credentials IS 'Returns all credentials issued to the current authenticated user. UF-03.';
COMMENT ON FUNCTION link_recipient_on_signup IS 'Auto-links unclaimed credentials to a newly signed-up user by email hash. UF-03.';
