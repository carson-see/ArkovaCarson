-- =============================================================================
-- Migration: 0023_is_public_profile
-- Story: P3-TS-02
-- Purpose: Add is_public_profile boolean to profiles table.
--          Controls whether the user's verification records are publicly
--          discoverable. Default false (private).
-- =============================================================================

ALTER TABLE profiles
  ADD COLUMN is_public_profile boolean NOT NULL DEFAULT false;

-- No new RLS policy needed:
--   profiles_update_own already allows: auth.uid() = id
--   protect_privileged_profile_fields() trigger does NOT block is_public_profile
--   so users can toggle this column directly via the client.

-- ROLLBACK:
-- ALTER TABLE profiles DROP COLUMN is_public_profile;
