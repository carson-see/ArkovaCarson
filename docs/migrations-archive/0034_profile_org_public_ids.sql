-- Migration: 0032_profile_org_public_ids.sql
-- Description: Add public_id to profiles and organizations for anonymous searchable identity
-- Story: User-requested — public User IDs and Org IDs for anonymous lookup
--
-- ROLLBACK:
-- DROP TRIGGER IF EXISTS generate_profile_public_id_on_insert ON profiles;
-- DROP TRIGGER IF EXISTS generate_org_public_id_on_insert ON organizations;
-- DROP FUNCTION IF EXISTS auto_generate_profile_public_id();
-- DROP FUNCTION IF EXISTS auto_generate_org_public_id();
-- DROP INDEX IF EXISTS idx_profiles_public_id;
-- DROP INDEX IF EXISTS idx_organizations_public_id;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS public_id;
-- ALTER TABLE organizations DROP COLUMN IF EXISTS public_id;

-- =============================================================================
-- ADD PUBLIC_ID TO PROFILES
-- =============================================================================
-- Searchable, non-guessable identifier so users can be found without exposing
-- their real name when is_public_profile = false.
-- Reuses the same generate_public_id() function from 0020_public_verification.sql.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS public_id text UNIQUE;

CREATE INDEX IF NOT EXISTS idx_profiles_public_id
  ON profiles(public_id) WHERE public_id IS NOT NULL;

-- Auto-generate public_id on profile creation
CREATE OR REPLACE FUNCTION auto_generate_profile_public_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.public_id IS NULL THEN
    NEW.public_id := generate_public_id();

    -- Retry on collision
    WHILE EXISTS (SELECT 1 FROM profiles WHERE public_id = NEW.public_id AND id != NEW.id) LOOP
      NEW.public_id := generate_public_id();
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER generate_profile_public_id_on_insert
  BEFORE INSERT ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_profile_public_id();

-- Backfill existing profiles that have no public_id
DO $$
DECLARE
  r RECORD;
  new_pid text;
BEGIN
  FOR r IN SELECT id FROM profiles WHERE public_id IS NULL LOOP
    new_pid := generate_public_id();
    WHILE EXISTS (SELECT 1 FROM profiles WHERE public_id = new_pid) LOOP
      new_pid := generate_public_id();
    END LOOP;
    UPDATE profiles SET public_id = new_pid WHERE id = r.id;
  END LOOP;
END;
$$;

-- =============================================================================
-- ADD PUBLIC_ID TO ORGANIZATIONS
-- =============================================================================

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS public_id text UNIQUE;

CREATE INDEX IF NOT EXISTS idx_organizations_public_id
  ON organizations(public_id) WHERE public_id IS NOT NULL;

-- Auto-generate public_id on org creation
CREATE OR REPLACE FUNCTION auto_generate_org_public_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.public_id IS NULL THEN
    NEW.public_id := generate_public_id();

    -- Retry on collision
    WHILE EXISTS (SELECT 1 FROM organizations WHERE public_id = NEW.public_id AND id != NEW.id) LOOP
      NEW.public_id := generate_public_id();
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER generate_org_public_id_on_insert
  BEFORE INSERT ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_org_public_id();

-- Backfill existing organizations that have no public_id
DO $$
DECLARE
  r RECORD;
  new_pid text;
BEGIN
  FOR r IN SELECT id FROM organizations WHERE public_id IS NULL LOOP
    new_pid := generate_public_id();
    WHILE EXISTS (SELECT 1 FROM organizations WHERE public_id = new_pid) LOOP
      new_pid := generate_public_id();
    END LOOP;
    UPDATE organizations SET public_id = new_pid WHERE id = r.id;
  END LOOP;
END;
$$;
