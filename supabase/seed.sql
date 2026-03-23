-- =============================================================================
-- ARKOVA SEED DATA — Production-matching
-- File: supabase/seed.sql
-- Updated: March 2026 (Session 7 — stripped all demo accounts)
--
-- This file seeds ONLY what production has:
--   - Platform admin accounts (carson@arkova.ai, sarah@arkova.ai)
--   - Arkova organization
--   - Switchboard flags
--   - Billing plans
--
-- No demo data. No fictional users. Local should match prod for UAT accuracy.
--
-- USAGE
--   npx supabase db reset          -- applies migrations + this seed
--   npm run dev                    -- login with carson@arkova.ai / Arkova2026!
--
-- ACCOUNTS (for local dev login)
--   carson@arkova.ai    password: Arkova2026!
--   sarah@arkova.ai     password: Arkova2026!
-- =============================================================================


-- =============================================================================
-- 0. CONSTANTS
-- =============================================================================

-- Organization
-- ORG_ARKOVA: Arkova (platform org)

-- Users
-- USER_CARSON:  44444444-0000-0000-0000-000000000001  carson@arkova.ai  ORG_ADMIN (platform admin)
-- USER_SARAH:   44444444-0000-0000-0000-000000000002  sarah@arkova.ai   ORG_ADMIN (platform admin)


-- =============================================================================
-- 1. TRUNCATE (safe reset — seed is idempotent on db reset)
-- =============================================================================

TRUNCATE TABLE audit_events    RESTART IDENTITY CASCADE;
TRUNCATE TABLE anchoring_jobs  RESTART IDENTITY CASCADE;
TRUNCATE TABLE anchor_proofs   RESTART IDENTITY CASCADE;
TRUNCATE TABLE anchors         RESTART IDENTITY CASCADE;
TRUNCATE TABLE memberships     RESTART IDENTITY CASCADE;
TRUNCATE TABLE profiles        RESTART IDENTITY CASCADE;
TRUNCATE TABLE organizations   RESTART IDENTITY CASCADE;

-- Delete seeded auth users so re-inserts work cleanly
DELETE FROM auth.identities WHERE user_id IN (
  '44444444-0000-0000-0000-000000000001',
  '44444444-0000-0000-0000-000000000002'
);
DELETE FROM auth.users WHERE id IN (
  '44444444-0000-0000-0000-000000000001',
  '44444444-0000-0000-0000-000000000002'
);


-- =============================================================================
-- 2. AUTH USERS
-- Supabase local dev: insert directly into auth.users.
-- Passwords are bcrypt of "Arkova2026!"
-- =============================================================================

INSERT INTO auth.users (
  instance_id, id, aud, role, email,
  encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, confirmation_token
) VALUES
  (
    '00000000-0000-0000-0000-000000000000',
    '44444444-0000-0000-0000-000000000001',
    'authenticated', 'authenticated',
    'carson@arkova.ai',
    '$2a$10$PznXcJEPjFjAM8Aq.KHO0epDNy0hVN5k5Y3lFD1R0P.2oJqB8vXi',
    NOW(), NOW(), NOW(),
    '{"provider": "email", "providers": ["email"]}',
    '{"full_name": "Carson Seeger"}',
    false, ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '44444444-0000-0000-0000-000000000002',
    'authenticated', 'authenticated',
    'sarah@arkova.ai',
    '$2a$10$PznXcJEPjFjAM8Aq.KHO0epDNy0hVN5k5Y3lFD1R0P.2oJqB8vXi',
    NOW(), NOW(), NOW(),
    '{"provider": "email", "providers": ["email"]}',
    '{"full_name": "Sarah Rushton"}',
    false, ''
  );


-- =============================================================================
-- 3. AUTH IDENTITIES (required by Supabase auth)
-- =============================================================================

INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at) VALUES
  (
    gen_random_uuid(),
    '44444444-0000-0000-0000-000000000001',
    '{"sub": "44444444-0000-0000-0000-000000000001", "email": "carson@arkova.ai"}',
    'email',
    '44444444-0000-0000-0000-000000000001',
    NOW(), NOW(), NOW()
  ),
  (
    gen_random_uuid(),
    '44444444-0000-0000-0000-000000000002',
    '{"sub": "44444444-0000-0000-0000-000000000002", "email": "sarah@arkova.ai"}',
    'email',
    '44444444-0000-0000-0000-000000000002',
    NOW(), NOW(), NOW()
  );


-- =============================================================================
-- 4. ORGANIZATION — Arkova
-- =============================================================================

INSERT INTO organizations (id, legal_name, display_name, domain, verification_status)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'Arkova Inc.',
  'Arkova',
  'arkova.ai',
  'VERIFIED'
);


-- =============================================================================
-- 5. PROFILES
-- =============================================================================

INSERT INTO profiles (id, email, full_name, role, org_id, avatar_url, is_public_profile)
VALUES
  (
    '44444444-0000-0000-0000-000000000001',
    'carson@arkova.ai',
    'Carson Seeger',
    'ORG_ADMIN',
    'aaaaaaaa-0000-0000-0000-000000000001',
    NULL,
    true
  ),
  (
    '44444444-0000-0000-0000-000000000002',
    'sarah@arkova.ai',
    'Sarah Rushton',
    'ORG_ADMIN',
    'aaaaaaaa-0000-0000-0000-000000000001',
    NULL,
    true
  );


-- =============================================================================
-- 6. ORG_MEMBERS (migration 0087 junction table)
-- =============================================================================

INSERT INTO org_members (user_id, org_id, role)
VALUES
  ('44444444-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner'),
  ('44444444-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'admin')
ON CONFLICT (user_id, org_id) DO NOTHING;


-- =============================================================================
-- 7. SWITCHBOARD FLAGS
-- The TRUNCATE profiles CASCADE above may cascade to switchboard_flags
-- (via updated_by FK). Re-insert to ensure flags exist.
-- =============================================================================

INSERT INTO switchboard_flags (id, value, default_value, description, is_dangerous) VALUES
  ('ENABLE_PROD_NETWORK_ANCHORING', true, false, 'Enable production network anchoring (real network fees)', true),
  ('ENABLE_OUTBOUND_WEBHOOKS', false, false, 'Enable outbound webhook delivery', false),
  ('ENABLE_NEW_CHECKOUTS', true, true, 'Allow new checkout sessions', false),
  ('ENABLE_REPORTS', true, true, 'Enable report generation', false),
  ('MAINTENANCE_MODE', false, false, 'Put the app in maintenance mode', true),
  ('ENABLE_AI_EXTRACTION', true, false, 'Enable AI-powered credential metadata extraction (P8)', false),
  ('ENABLE_SEMANTIC_SEARCH', true, false, 'Enable semantic search with vector embeddings (P8)', false),
  ('ENABLE_AI_FRAUD', true, false, 'Enable AI-powered fraud detection (P8)', false),
  ('ENABLE_VERIFICATION_API', true, false, 'Enable Verification API v1 endpoints (P4.5)', false),
  ('ENABLE_AI_REPORTS', true, false, 'Enable AI-powered report generation (P8)', false)
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- 8. PLANS
-- Plans created by migration 0016 but may be truncated by CASCADE.
-- =============================================================================

INSERT INTO plans (id, name, description, price_cents, billing_period, records_per_month, features)
VALUES
  ('free', 'Free', 'Get started with Arkova', 0, 'month', 3, '["3 records per month", "Basic verification", "7-day proof access"]'),
  ('individual', 'Individual', 'For personal document security', 1000, 'month', 10, '["10 records per month", "Document verification", "Basic support", "Proof downloads"]'),
  ('professional', 'Professional', 'For growing businesses', 10000, 'month', 100, '["100 records per month", "Priority support", "Bulk CSV upload", "API access"]'),
  ('organization', 'Organization', 'For enterprise teams', 0, 'custom', 999999, '["Unlimited records", "Dedicated support", "Custom integrations", "SLA guarantee"]')
ON CONFLICT (id) DO NOTHING;

-- Active subscription for Carson (platform admin)
INSERT INTO subscriptions (id, user_id, org_id, plan_id, status, current_period_start, current_period_end)
VALUES
  (
    'dddddddd-0000-0000-0000-000000000001',
    '44444444-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000001',
    'professional',
    'active',
    NOW() - INTERVAL '15 days',
    NOW() + INTERVAL '15 days'
  )
ON CONFLICT (id) DO NOTHING;
