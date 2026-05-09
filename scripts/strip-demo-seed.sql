-- =============================================================================
-- SEC-01: Strip Demo Seed Data for Production
-- Date: 2026-03-16
--
-- RUN THIS ONCE before production launch to remove all demo users, orgs,
-- anchors, and test data from the production Supabase instance.
--
-- USAGE:
--   psql $DATABASE_URL -f scripts/strip-demo-seed.sql
--   -- OR via Supabase dashboard SQL editor
--
-- WHAT IT DOES:
--   1. Deletes demo auth.users (the 4 seed accounts)
--   2. Cascades to profiles, memberships, anchors, audit_events, etc.
--   3. Cleans up orphaned records
--   4. Keeps: switchboard_flags, plans, credential_templates (if org-owned, also deleted)
--
-- WHAT IT KEEPS:
--   - switchboard_flags (feature flags — schema-required defaults)
--   - plans table (Stripe price IDs — required for billing)
--   - Any real user accounts created after launch
--
-- SAFETY: This script is idempotent. Running it twice has no additional effect.
-- =============================================================================

BEGIN;

-- ─── 1. Identify demo user IDs ─────────────────────────────────────────
-- These are the seed.sql demo accounts with known UUIDs
DO $$
DECLARE
  demo_user_ids uuid[] := ARRAY[
    '11111111-0000-0000-0000-000000000001'::uuid, -- admin@umich-demo.arkova.io
    '11111111-0000-0000-0000-000000000002'::uuid, -- registrar@umich-demo.arkova.io
    '22222222-0000-0000-0000-000000000001'::uuid, -- admin@midwest-medical.arkova.io
    '33333333-0000-0000-0000-000000000001'::uuid  -- individual@demo.arkova.io
  ];
  demo_org_ids uuid[];
BEGIN
  -- Get org IDs associated with demo users
  SELECT ARRAY_AGG(DISTINCT org_id)
  INTO demo_org_ids
  FROM profiles
  WHERE id = ANY(demo_user_ids)
    AND org_id IS NOT NULL;

  -- ─── 2. Delete in dependency order (deepest references first) ─────────

  -- Webhook delivery logs (references webhook_endpoints)
  DELETE FROM webhook_delivery_logs
  WHERE endpoint_id IN (
    SELECT id FROM webhook_endpoints WHERE org_id = ANY(demo_org_ids)
  );

  -- Webhook dead letter queue
  DELETE FROM webhook_dead_letter_queue
  WHERE org_id = ANY(demo_org_ids);

  -- Webhook endpoints
  DELETE FROM webhook_endpoints
  WHERE org_id = ANY(demo_org_ids);

  -- AI usage events
  DELETE FROM ai_usage_events
  WHERE org_id = ANY(demo_org_ids);

  -- AI credits
  DELETE FROM ai_credits
  WHERE org_id = ANY(demo_org_ids);

  -- Credential embeddings
  DELETE FROM credential_embeddings
  WHERE org_id = ANY(demo_org_ids);

  -- Credit transactions
  DELETE FROM credit_transactions
  WHERE org_id = ANY(demo_org_ids);

  -- Credits
  DELETE FROM credits
  WHERE org_id = ANY(demo_org_ids);

  -- Batch verification jobs (references api_keys — must delete before api_keys)
  DELETE FROM batch_verification_jobs
  WHERE api_key_id IN (
    SELECT id FROM api_keys WHERE org_id = ANY(demo_org_ids)
  );

  -- API key usage
  DELETE FROM api_key_usage
  WHERE api_key_id IN (
    SELECT id FROM api_keys WHERE org_id = ANY(demo_org_ids)
  );

  -- API keys
  DELETE FROM api_keys
  WHERE org_id = ANY(demo_org_ids);

  -- Anchor proofs (references anchors)
  DELETE FROM anchor_proofs
  WHERE anchor_id IN (
    SELECT id FROM anchors WHERE org_id = ANY(demo_org_ids) OR user_id = ANY(demo_user_ids)
  );

  -- Anchor chain index
  DELETE FROM anchor_chain_index
  WHERE anchor_id IN (
    SELECT id FROM anchors WHERE org_id = ANY(demo_org_ids) OR user_id = ANY(demo_user_ids)
  );

  -- Anchor recipients
  DELETE FROM anchor_recipients
  WHERE anchor_id IN (
    SELECT id FROM anchors WHERE org_id = ANY(demo_org_ids) OR user_id = ANY(demo_user_ids)
  );

  -- Anchoring jobs (references anchors)
  DELETE FROM anchoring_jobs
  WHERE anchor_id IN (
    SELECT id FROM anchors WHERE org_id = ANY(demo_org_ids) OR user_id = ANY(demo_user_ids)
  );

  -- Verification events
  DELETE FROM verification_events
  WHERE anchor_id IN (
    SELECT id FROM anchors WHERE org_id = ANY(demo_org_ids) OR user_id = ANY(demo_user_ids)
  );

  -- Anchors
  DELETE FROM anchors
  WHERE org_id = ANY(demo_org_ids) OR user_id = ANY(demo_user_ids);

  -- Audit events for demo users
  DELETE FROM audit_events
  WHERE actor_id = ANY(demo_user_ids);

  -- Credential templates
  DELETE FROM credential_templates
  WHERE org_id = ANY(demo_org_ids);

  -- Invitations
  DELETE FROM invitations
  WHERE org_id = ANY(demo_org_ids);

  -- Memberships
  DELETE FROM memberships
  WHERE user_id = ANY(demo_user_ids);

  -- Subscriptions
  DELETE FROM subscriptions
  WHERE user_id = ANY(demo_user_ids);

  -- Profiles
  DELETE FROM profiles
  WHERE id = ANY(demo_user_ids);

  -- Organizations (after all references cleared)
  IF demo_org_ids IS NOT NULL THEN
    DELETE FROM organizations
    WHERE id = ANY(demo_org_ids);
  END IF;

  -- ─── 3. Delete demo auth users ───────────────────────────────────────
  DELETE FROM auth.identities WHERE user_id = ANY(demo_user_ids);
  DELETE FROM auth.sessions WHERE user_id = ANY(demo_user_ids);
  DELETE FROM auth.refresh_tokens WHERE user_id = ANY(demo_user_ids);
  DELETE FROM auth.mfa_factors WHERE user_id = ANY(demo_user_ids);
  DELETE FROM auth.users WHERE id = ANY(demo_user_ids);

  -- ─── 4. Verify ───────────────────────────────────────────────────────
  RAISE NOTICE 'Demo data stripped. Remaining auth.users: %',
    (SELECT count(*) FROM auth.users);
  RAISE NOTICE 'Remaining organizations: %',
    (SELECT count(*) FROM organizations);
  RAISE NOTICE 'Remaining anchors: %',
    (SELECT count(*) FROM anchors);

END $$;

COMMIT;
