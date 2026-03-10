-- =============================================================================
-- Migration 0042: verification_events analytics table
-- Story: P6-TS-06
-- Date: 2026-03-10
--
-- PURPOSE
-- -------
-- Tracks public verification lookups for analytics and security auditing.
-- Each time a public verification query is made (via RPC or API), an event
-- is recorded with the method, result, and (optionally) requester info.
--
-- No PII is stored — only the public_id and request metadata.
--
-- CHANGES
-- -------
-- 1. Create verification_events table
-- 2. Add indexes for analytics queries
-- 3. Add RLS policies (service-role insert, org admins read own org's events)
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Create verification_events table
-- ---------------------------------------------------------------------------
CREATE TABLE verification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which anchor was verified
  anchor_id uuid REFERENCES anchors(id) ON DELETE SET NULL,
  public_id text NOT NULL,

  -- Verification method and result
  method text NOT NULL DEFAULT 'web',
    -- web | api | embed | qr
  result text NOT NULL,
    -- verified | revoked | not_found | error
  fingerprint_provided boolean NOT NULL DEFAULT false,

  -- Request metadata (no PII)
  ip_hash text,           -- SHA-256 of IP, never raw IP
  user_agent text,
  referrer text,
  country_code char(2),

  -- Optional link to the org that owns the anchor
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Constraints
  CONSTRAINT verification_events_method_check
    CHECK (method IN ('web', 'api', 'embed', 'qr')),
  CONSTRAINT verification_events_result_check
    CHECK (result IN ('verified', 'revoked', 'not_found', 'error')),
  CONSTRAINT verification_events_public_id_length
    CHECK (char_length(public_id) >= 1 AND char_length(public_id) <= 50)
);

-- Force RLS
ALTER TABLE verification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_events FORCE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX idx_verification_events_public_id
  ON verification_events(public_id);

CREATE INDEX idx_verification_events_org_id
  ON verification_events(org_id)
  WHERE org_id IS NOT NULL;

CREATE INDEX idx_verification_events_created_at
  ON verification_events(created_at);

CREATE INDEX idx_verification_events_method
  ON verification_events(method);


-- ---------------------------------------------------------------------------
-- 3. RLS Policies
-- ---------------------------------------------------------------------------

-- ORG_ADMIN can read verification events for their org's anchors
CREATE POLICY verification_events_org_admin_select
  ON verification_events
  FOR SELECT
  TO authenticated
  USING (
    org_id IS NOT NULL
    AND org_id = (SELECT p.org_id FROM profiles p WHERE p.id = auth.uid())
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
      AND p.role = 'ORG_ADMIN'
    )
  );

-- Insert via service_role only (worker/API inserts events)
-- No INSERT policy for authenticated — the worker uses service_role


-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE verification_events IS 'Analytics: tracks public verification lookups (no PII)';
COMMENT ON COLUMN verification_events.method IS 'How the verification was initiated: web, api, embed, qr';
COMMENT ON COLUMN verification_events.result IS 'Outcome: verified, revoked, not_found, error';
COMMENT ON COLUMN verification_events.ip_hash IS 'SHA-256 hash of requester IP (never raw IP)';


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP TABLE IF EXISTS verification_events;
