-- =============================================================================
-- Migration 0022: Seed Schema Alignment
-- Story: Demo Quality / 07_seed_clickthrough.md
-- Date: 2026-03-07
--
-- PURPOSE
-- -------
-- Adds missing columns, enum values, and tables required by the demo seed data.
-- These changes are purely additive — no existing columns or types are renamed.
--
-- CHANGES
-- -------
-- 1. anchor_status enum: add EXPIRED value
-- 2. user_role enum: add ORG_MEMBER value
-- 3. anchors table: add label, issued_at, expires_at, revoked_at, revocation_reason
-- 4. memberships table: new table for org membership tracking
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Add EXPIRED to anchor_status enum
-- ---------------------------------------------------------------------------
ALTER TYPE anchor_status ADD VALUE IF NOT EXISTS 'EXPIRED';


-- ---------------------------------------------------------------------------
-- 2. Add ORG_MEMBER to user_role enum
-- ---------------------------------------------------------------------------
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'ORG_MEMBER';


-- ---------------------------------------------------------------------------
-- 3. Add new columns to anchors
-- ---------------------------------------------------------------------------

-- Human-readable credential label (e.g. "Bachelor of Science — Maya Chen")
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS label text;

-- Date the credential was issued (e.g. commencement date)
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS issued_at timestamptz;

-- Expiration date for time-limited credentials (NULL = no expiry)
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- When the credential was revoked (NULL if not revoked)
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- Reason for revocation (required when revoked_at is set)
ALTER TABLE anchors ADD COLUMN IF NOT EXISTS revocation_reason text;

-- Constraint: revocation_reason requires revoked_at
ALTER TABLE anchors ADD CONSTRAINT anchors_revocation_consistency
  CHECK (revocation_reason IS NULL OR revoked_at IS NOT NULL);

-- Constraint: label length
ALTER TABLE anchors ADD CONSTRAINT anchors_label_length
  CHECK (label IS NULL OR (char_length(label) >= 1 AND char_length(label) <= 500));

-- Constraint: revocation_reason length
ALTER TABLE anchors ADD CONSTRAINT anchors_revocation_reason_length
  CHECK (revocation_reason IS NULL OR char_length(revocation_reason) <= 2000);


-- ---------------------------------------------------------------------------
-- 4. Create memberships table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memberships (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  org_id     uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role       user_role   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- One membership per user per org
  CONSTRAINT memberships_user_org_unique UNIQUE (user_id, org_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_memberships_user_id ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_org_id ON memberships(org_id);

-- Force RLS
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

-- RLS Policies: users can see their own memberships + org admins can see org memberships
CREATE POLICY memberships_select_own ON memberships
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY memberships_select_org ON memberships
  FOR SELECT TO authenticated
  USING (org_id = get_user_org_id() AND is_org_admin());

-- Only service role can insert/update/delete memberships
-- (managed by backend, not client-side)


-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- NOTE: Enum values cannot be removed in Postgres without recreation.
-- For a full rollback, drop the table and columns:
--
-- DROP TABLE IF EXISTS memberships;
-- ALTER TABLE anchors DROP CONSTRAINT IF EXISTS anchors_revocation_consistency;
-- ALTER TABLE anchors DROP CONSTRAINT IF EXISTS anchors_label_length;
-- ALTER TABLE anchors DROP CONSTRAINT IF EXISTS anchors_revocation_reason_length;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS label;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS issued_at;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS expires_at;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS revoked_at;
-- ALTER TABLE anchors DROP COLUMN IF EXISTS revocation_reason;
