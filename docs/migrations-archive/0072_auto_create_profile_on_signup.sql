-- Migration: 0072_auto_create_profile_on_signup
-- Description: Auto-create a profiles row when a new user signs up via auth.users.
-- Without this trigger, new signups have no profile row and the onboarding
-- RPC (update_profile_onboarding) silently fails — blocking all new users.
--
-- ROLLBACK:
-- DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
-- DROP FUNCTION IF EXISTS create_profile_for_new_user();

-- Create a function that inserts a profile row for new auth users
CREATE OR REPLACE FUNCTION create_profile_for_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, created_at, updated_at)
  VALUES (
    NEW.id,
    LOWER(COALESCE(NEW.email, '')),
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''),
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Fire after a new user is inserted into auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION create_profile_for_new_user();

-- Backfill: create profile rows for any auth.users that don't have one
INSERT INTO profiles (id, email, full_name, created_at, updated_at)
SELECT
  u.id,
  LOWER(COALESCE(u.email, '')),
  COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', ''),
  COALESCE(u.created_at, NOW()),
  NOW()
FROM auth.users u
LEFT JOIN profiles p ON p.id = u.id
WHERE p.id IS NULL
ON CONFLICT (id) DO NOTHING;
