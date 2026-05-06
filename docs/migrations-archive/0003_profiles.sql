-- Migration: 0003_profiles.sql
-- Description: Create profiles table linked to auth.users
-- Rollback: DROP TABLE IF EXISTS profiles; DROP FUNCTION IF EXISTS enforce_lowercase_email();

-- Function to enforce lowercase email
CREATE OR REPLACE FUNCTION enforce_lowercase_email()
RETURNS TRIGGER AS $$
BEGIN
  NEW.email = lower(NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Profiles table
CREATE TABLE profiles (
  -- Primary key references auth.users for tight coupling
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- User information
  email text NOT NULL,
  full_name text NULL,
  avatar_url text NULL,

  -- Role and organization
  role user_role NULL, -- NULL until assigned
  role_set_at timestamptz NULL, -- Timestamp when role was first set
  org_id uuid NULL REFERENCES organizations(id) ON DELETE SET NULL,

  -- Manual review flags (admin-controlled)
  requires_manual_review boolean NOT NULL DEFAULT false,
  manual_review_reason text NULL,
  manual_review_completed_at timestamptz NULL,
  manual_review_completed_by uuid NULL,

  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Constraints
  CONSTRAINT profiles_email_format CHECK (email ~ '^[^@]+@[^@]+\.[^@]+$'),
  CONSTRAINT profiles_email_length CHECK (char_length(email) <= 255),
  CONSTRAINT profiles_full_name_length CHECK (full_name IS NULL OR char_length(full_name) <= 255),
  CONSTRAINT profiles_manual_review_reason CHECK (
    (requires_manual_review = false AND manual_review_reason IS NULL) OR
    (requires_manual_review = true)
  ),
  CONSTRAINT profiles_org_required_for_org_admin CHECK (
    role IS NULL OR role != 'ORG_ADMIN' OR org_id IS NOT NULL
  )
);

-- Indexes
CREATE UNIQUE INDEX idx_profiles_email ON profiles(email);
CREATE INDEX idx_profiles_org_id ON profiles(org_id) WHERE org_id IS NOT NULL;
CREATE INDEX idx_profiles_role ON profiles(role) WHERE role IS NOT NULL;
CREATE INDEX idx_profiles_requires_review ON profiles(requires_manual_review) WHERE requires_manual_review = true;

-- Trigger for lowercase email
CREATE TRIGGER enforce_profiles_lowercase_email
  BEFORE INSERT OR UPDATE OF email ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION enforce_lowercase_email();

-- Trigger for updated_at
CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- Comments
COMMENT ON TABLE profiles IS 'User profiles linked to Supabase Auth users';
COMMENT ON COLUMN profiles.id IS 'References auth.users(id), cascade on delete';
COMMENT ON COLUMN profiles.email IS 'User email, stored lowercase';
COMMENT ON COLUMN profiles.role IS 'User role (INDIVIDUAL or ORG_ADMIN), immutable once set';
COMMENT ON COLUMN profiles.role_set_at IS 'Timestamp when role was first assigned';
COMMENT ON COLUMN profiles.org_id IS 'Organization membership (required for ORG_ADMIN)';
COMMENT ON COLUMN profiles.requires_manual_review IS 'Flag for admin manual review requirement';
