-- Strip Demo Seed Accounts from Production (SEC-01)
--
-- This script removes all demo/test accounts and their associated data
-- from the production database. Run ONCE before public launch.
--
-- Usage:
--   psql $DATABASE_URL -f scripts/strip-demo-seeds.sql
--   OR via Supabase SQL Editor (Dashboard → SQL → paste + run)
--
-- ROLLBACK: Not possible — demo data is permanently deleted.
-- Ensure you have a database backup before running.
--
-- Safe guards:
--   1. Only deletes accounts with known demo email patterns
--   2. Uses transactions for atomicity
--   3. Cascading deletes respect FK constraints
--   4. Preserves real user data
-- ============================================================================

BEGIN;

-- 1. Identify demo user IDs by email pattern
-- These are the seed accounts from supabase/seed.sql and CLAUDE.md Section 11
CREATE TEMP TABLE demo_users AS
SELECT id, email FROM auth.users
WHERE email IN (
  -- Original seed accounts
  'admin_demo@arkova.local',
  'user_demo@arkova.local',
  'beta_admin@betacorp.local',
  -- Demo environment accounts
  'admin@umich-demo.arkova.io',
  'registrar@umich-demo.arkova.io',
  'admin@midwest-medical.arkova.io',
  'individual@demo.arkova.io'
)
OR email LIKE '%@arkova.local'
OR email LIKE '%demo.arkova.io';

-- 2. Report what will be deleted (for audit log before deletion)
DO $$
DECLARE
  user_count INT;
BEGIN
  SELECT COUNT(*) INTO user_count FROM demo_users;
  RAISE NOTICE 'Found % demo user(s) to delete', user_count;
  IF user_count = 0 THEN
    RAISE NOTICE 'No demo users found — nothing to do.';
  END IF;
END $$;

-- 3. Delete associated data in dependency order (child → parent)

-- 3a. Delete anchor recipients for demo users' anchors
DELETE FROM public.anchor_recipients
WHERE anchor_id IN (
  SELECT id FROM public.anchors WHERE user_id IN (SELECT id FROM demo_users)
);

-- 3b. Delete anchor chain index entries
DELETE FROM public.anchor_chain_index
WHERE anchor_id IN (
  SELECT id FROM public.anchors WHERE user_id IN (SELECT id FROM demo_users)
);

-- 3c. Delete credential embeddings
DELETE FROM public.credential_embeddings
WHERE anchor_id IN (
  SELECT id FROM public.anchors WHERE user_id IN (SELECT id FROM demo_users)
);

-- 3d. Delete verification events for demo anchors
DELETE FROM public.verification_events
WHERE anchor_id IN (
  SELECT id FROM public.anchors WHERE user_id IN (SELECT id FROM demo_users)
);

-- 3e. Delete webhook delivery logs for demo anchors
DELETE FROM public.webhook_delivery_logs
WHERE anchor_id IN (
  SELECT id FROM public.anchors WHERE user_id IN (SELECT id FROM demo_users)
);

-- 3f. Delete AI usage events for demo users
DELETE FROM public.ai_usage_events
WHERE user_id IN (SELECT id FROM demo_users);

-- 3g. Delete AI credits for demo users
DELETE FROM public.ai_credits
WHERE user_id IN (SELECT id FROM demo_users);

-- 3h. Delete API key usage for demo orgs
DELETE FROM public.api_key_usage
WHERE api_key_id IN (
  SELECT id FROM public.api_keys
  WHERE org_id IN (
    SELECT org_id FROM public.profiles WHERE id IN (SELECT id FROM demo_users) AND org_id IS NOT NULL
  )
);

-- 3i. Delete API keys for demo orgs
DELETE FROM public.api_keys
WHERE org_id IN (
  SELECT org_id FROM public.profiles WHERE id IN (SELECT id FROM demo_users) AND org_id IS NOT NULL
);

-- 3j. Delete webhook endpoints for demo orgs
DELETE FROM public.webhook_endpoints
WHERE org_id IN (
  SELECT org_id FROM public.profiles WHERE id IN (SELECT id FROM demo_users) AND org_id IS NOT NULL
);

-- 3k. Delete credential templates for demo orgs
DELETE FROM public.credential_templates
WHERE org_id IN (
  SELECT org_id FROM public.profiles WHERE id IN (SELECT id FROM demo_users) AND org_id IS NOT NULL
);

-- 3l. Delete audit events for demo users
-- audit_events has a reject_modification trigger. If it blocks DELETE,
-- gracefully skip and let PII-03 retention policy clean up after 2 years.
DO $$
BEGIN
  DELETE FROM public.audit_events
  WHERE actor_id IN (SELECT id FROM demo_users);
  RAISE NOTICE 'Demo audit events deleted.';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Could not delete audit events (trigger blocked DELETE). PII-03 retention will clean up.';
END $$;

-- 3m. Delete credits for demo users
DELETE FROM public.credits
WHERE user_id IN (SELECT id FROM demo_users);

-- 3n. Delete subscriptions for demo users
DELETE FROM public.subscriptions
WHERE user_id IN (SELECT id FROM demo_users);

-- 3o. Delete anchors for demo users
DELETE FROM public.anchors
WHERE user_id IN (SELECT id FROM demo_users);

-- 3p. Delete batch verification jobs for demo orgs
DELETE FROM public.batch_verification_jobs
WHERE org_id IN (
  SELECT org_id FROM public.profiles WHERE id IN (SELECT id FROM demo_users) AND org_id IS NOT NULL
);

-- 4. Delete profiles (must happen before org deletion due to FK)
DELETE FROM public.profiles
WHERE id IN (SELECT id FROM demo_users);

-- 5. Delete demo organizations (only if no real users remain)
DELETE FROM public.organizations
WHERE id IN (
  SELECT DISTINCT org_id FROM demo_users d
  JOIN public.profiles p ON p.id = d.id
  WHERE p.org_id IS NOT NULL
)
AND id NOT IN (
  -- Preserve orgs that have non-demo members
  SELECT org_id FROM public.profiles
  WHERE org_id IS NOT NULL
  AND id NOT IN (SELECT id FROM demo_users)
);

-- 6. Delete auth users (must be last — FK from profiles)
DELETE FROM auth.users
WHERE id IN (SELECT id FROM demo_users);

-- 7. Clean up temp table
DROP TABLE demo_users;

-- 8. Report completion
DO $$
BEGIN
  RAISE NOTICE 'Demo seed accounts stripped successfully.';
  RAISE NOTICE 'Run SELECT COUNT(*) FROM auth.users to verify remaining users.';
END $$;

COMMIT;
