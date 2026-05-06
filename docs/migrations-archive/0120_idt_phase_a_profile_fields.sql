-- IDT Phase A: Disclaimer acceptance + bio + social links (IDT-01, IDT-02)
-- Adds identity trust layer fields to profiles table.

-- Disclaimer acceptance timestamp (IDT-01)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS disclaimer_accepted_at timestamptz DEFAULT NULL;

-- Profile bio (IDT-02)
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS bio text DEFAULT NULL;

-- Social links as JSONB (IDT-02)
-- Expected shape: { "linkedin": "url", "twitter": "handle", "github": "handle", "website": "url" }
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS social_links jsonb DEFAULT NULL;

-- Constraint: bio max 500 chars
ALTER TABLE profiles
  ADD CONSTRAINT profiles_bio_length CHECK (bio IS NULL OR length(bio) <= 500);

-- Index for profiles that have accepted the disclaimer (for compliance queries)
CREATE INDEX IF NOT EXISTS idx_profiles_disclaimer_accepted
  ON profiles (disclaimer_accepted_at)
  WHERE disclaimer_accepted_at IS NOT NULL;

-- RLS: profiles table already has RLS. The new columns inherit existing policies.
-- Users can read their own profile and update their own profile.
-- No additional RLS needed since policies are row-level, not column-level.

COMMENT ON COLUMN profiles.disclaimer_accepted_at IS 'Timestamp when user accepted the platform disclaimer (IDT-01)';
COMMENT ON COLUMN profiles.bio IS 'User biography, max 500 characters (IDT-02)';
COMMENT ON COLUMN profiles.social_links IS 'Social profile links as JSON: { linkedin, twitter, github, website } (IDT-02)';

-- ROLLBACK:
-- ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_bio_length;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS disclaimer_accepted_at;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS bio;
-- ALTER TABLE profiles DROP COLUMN IF EXISTS social_links;
-- DROP INDEX IF EXISTS idx_profiles_disclaimer_accepted;
