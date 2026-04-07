-- =============================================================================
-- ARKOVA SEED DATA — Production-matching
-- File: supabase/seed.sql
-- Updated: March 2026 (Session 7 — stripped all demo accounts)
--
-- This file seeds:
--   - Platform admin accounts (carson@arkova.ai, sarah@arkova.ai)
--   - Arkova organization
--   - Switchboard flags
--   - Billing plans
--   - Demo accounts with rich dummy data for UAT
--
-- USAGE
--   npx supabase db reset          -- applies migrations + this seed
--   npm run dev                    -- login with any account below
--
-- ACCOUNTS (for local dev login — all use password: Arkova2026!)
--   carson@arkova.ai           Platform admin (Arkova org)
--   sarah@arkova.ai            Platform admin (Arkova org)
--   demo-admin@arkova.local    Org admin (Acme Corp) — org logo, members, org records
--   demo-user@arkova.local     Individual user — 7 personal records, version lineage
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
  is_super_admin, confirmation_token,
  recovery_token, email_change, email_change_token_new,
  email_change_token_current, reauthentication_token, phone_change, phone_change_token
) VALUES
  (
    '00000000-0000-0000-0000-000000000000',
    '44444444-0000-0000-0000-000000000001',
    'authenticated', 'authenticated',
    'carson@arkova.ai',
    '$2a$10$bliuc8RqEzfNHpNdY0HIaeMjGaU1hGtiSYaKErxCOSSbsBe2o4K3q',
    NOW(), NOW(), NOW(),
    '{"provider": "email", "providers": ["email"]}',
    '{"full_name": "Carson Seeger"}',
    false, '',
    '', '', '', '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '44444444-0000-0000-0000-000000000002',
    'authenticated', 'authenticated',
    'sarah@arkova.ai',
    '$2a$10$bliuc8RqEzfNHpNdY0HIaeMjGaU1hGtiSYaKErxCOSSbsBe2o4K3q',
    NOW(), NOW(), NOW(),
    '{"provider": "email", "providers": ["email"]}',
    '{"full_name": "Sarah Rushton"}',
    false, '',
    '', '', '', '', '', '', ''
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

-- Delete auto-created profiles (from trigger 0072) so we can insert with full seed data.
-- The trigger creates minimal profiles; we need full data with org_id, role, etc.
DELETE FROM profiles WHERE id IN (
  '44444444-0000-0000-0000-000000000001',
  '44444444-0000-0000-0000-000000000002'
);

INSERT INTO profiles (id, email, full_name, role, org_id, avatar_url, is_public_profile, is_platform_admin)
VALUES
  (
    '44444444-0000-0000-0000-000000000001',
    'carson@arkova.ai',
    'Carson Seeger',
    'ORG_ADMIN',
    'aaaaaaaa-0000-0000-0000-000000000001',
    NULL,
    true,
    true
  ),
  (
    '44444444-0000-0000-0000-000000000002',
    'sarah@arkova.ai',
    'Sarah Rushton',
    'ORG_ADMIN',
    'aaaaaaaa-0000-0000-0000-000000000001',
    NULL,
    true,
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

-- Memberships (legacy junction table, used by RLS policies)
INSERT INTO memberships (user_id, org_id, role)
VALUES
  ('44444444-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'ORG_ADMIN'),
  ('44444444-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'ORG_ADMIN')
ON CONFLICT (user_id, org_id) DO NOTHING;


-- =============================================================================
-- 7. SWITCHBOARD FLAGS
-- The TRUNCATE profiles CASCADE above may cascade to switchboard_flags
-- (via updated_by FK). Re-insert to ensure flags exist.
-- =============================================================================

INSERT INTO switchboard_flags (id, value, default_value, description, is_dangerous) VALUES
  ('ENABLE_PROD_NETWORK_ANCHORING', false, false, 'Enable production network anchoring (real network fees)', true),
  ('ENABLE_OUTBOUND_WEBHOOKS', false, false, 'Enable outbound webhook delivery', false),
  ('ENABLE_NEW_CHECKOUTS', true, true, 'Allow new checkout sessions', false),
  ('ENABLE_REPORTS', true, true, 'Enable report generation', false),
  ('MAINTENANCE_MODE', false, false, 'Put the app in maintenance mode', true),
  ('ENABLE_AI_EXTRACTION', true, false, 'Enable AI-powered credential metadata extraction (P8)', false),
  ('ENABLE_SEMANTIC_SEARCH', true, false, 'Enable semantic search with vector embeddings (P8)', false),
  ('ENABLE_AI_FRAUD', true, false, 'Enable AI-powered fraud detection (P8)', false),
  ('ENABLE_VERIFICATION_API', true, false, 'Enable Verification API v1 endpoints (P4.5)', false),
  ('ENABLE_AI_REPORTS', true, false, 'Enable AI-powered report generation (P8)', false),
  ('ENABLE_X402_PAYMENTS', false, false, 'Enable x402 USDC pay-per-request on Base L2', false),
  ('ENABLE_GRC_INTEGRATIONS', false, false, 'Enable GRC platform integrations (Vanta, Drata, Anecdotes) — CML-05', false)
ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description;


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


-- =============================================================================
-- 8b. ARKOVA ORG ANCHORS — for RLS org-level tests
-- =============================================================================

INSERT INTO anchors (id, user_id, org_id, filename, fingerprint, status, file_size, file_mime, credential_type, public_id, description, metadata, chain_tx_id, chain_block_height, chain_timestamp, legal_hold, created_at)
VALUES (
  'aaaaaaaa-0000-0000-0000-000000000010',
  '44444444-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'Arkova_Incorporation.pdf',
  'a9b9c9d9e9f9a9b9c9d9e9f9a9b9c9d9e9f9a9b9c9d9e9f9a9b9c9d9e9f9a9b9',
  'SECURED',
  1200000,
  'application/pdf',
  'LEGAL',
  'ARK-ORG-001',
  'Arkova articles of incorporation',
  '{"entity_name": "Arkova Inc.", "form_type": "Articles of Incorporation", "_confidence": 0.95, "_prompt_version": "v3"}',
  'arkova_org_tx_001',
  200100,
  NOW() - INTERVAL '90 days',
  true,
  NOW() - INTERVAL '90 days'
);


-- =============================================================================
-- 9. DEMO USERS — For local development and UAT testing
--    demo-admin@arkova.local   password: Arkova2026!  (ORG_ADMIN at Acme Corp)
--    demo-user@arkova.local    password: Arkova2026!  (INDIVIDUAL)
-- =============================================================================

-- Demo org: Acme Corporation
INSERT INTO organizations (id, legal_name, display_name, domain, verification_status, description, website_url, org_type, location, linkedin_url)
VALUES (
  'bbbbbbbb-0000-0000-0000-000000000001',
  'Acme Corporation',
  'Acme Corp',
  'acme.example.com',
  'VERIFIED',
  'Leading provider of innovative solutions',
  'https://acme.example.com',
  'corporation',
  'San Francisco, CA',
  'https://linkedin.com/company/acme-example'
)
ON CONFLICT (id) DO NOTHING;

-- Demo auth users
DELETE FROM auth.identities WHERE user_id IN (
  '55555555-0000-0000-0000-000000000001',
  '55555555-0000-0000-0000-000000000002'
);
DELETE FROM auth.users WHERE id IN (
  '55555555-0000-0000-0000-000000000001',
  '55555555-0000-0000-0000-000000000002'
);

INSERT INTO auth.users (
  instance_id, id, aud, role, email,
  encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, confirmation_token,
  recovery_token, email_change, email_change_token_new,
  email_change_token_current, reauthentication_token, phone_change, phone_change_token
) VALUES
  (
    '00000000-0000-0000-0000-000000000000',
    '55555555-0000-0000-0000-000000000001',
    'authenticated', 'authenticated',
    'demo-admin@arkova.local',
    '$2a$10$bliuc8RqEzfNHpNdY0HIaeMjGaU1hGtiSYaKErxCOSSbsBe2o4K3q',
    NOW(), NOW(), NOW(),
    '{"provider": "email", "providers": ["email"]}',
    '{"full_name": "Alex Demo-Admin"}',
    false, '',
    '', '', '', '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '55555555-0000-0000-0000-000000000002',
    'authenticated', 'authenticated',
    'demo-user@arkova.local',
    '$2a$10$bliuc8RqEzfNHpNdY0HIaeMjGaU1hGtiSYaKErxCOSSbsBe2o4K3q',
    NOW(), NOW(), NOW(),
    '{"provider": "email", "providers": ["email"]}',
    '{"full_name": "Jamie Demo-User"}',
    false, '',
    '', '', '', '', '', '', ''
  );

INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at) VALUES
  (
    gen_random_uuid(),
    '55555555-0000-0000-0000-000000000001',
    '{"sub": "55555555-0000-0000-0000-000000000001", "email": "demo-admin@arkova.local"}',
    'email',
    '55555555-0000-0000-0000-000000000001',
    NOW(), NOW(), NOW()
  ),
  (
    gen_random_uuid(),
    '55555555-0000-0000-0000-000000000002',
    '{"sub": "55555555-0000-0000-0000-000000000002", "email": "demo-user@arkova.local"}',
    'email',
    '55555555-0000-0000-0000-000000000002',
    NOW(), NOW(), NOW()
  );

-- Demo profiles
DELETE FROM profiles WHERE id IN (
  '55555555-0000-0000-0000-000000000001',
  '55555555-0000-0000-0000-000000000002'
);

INSERT INTO profiles (id, email, full_name, role, org_id, is_public_profile, is_platform_admin)
VALUES
  (
    '55555555-0000-0000-0000-000000000001',
    'demo-admin@arkova.local',
    'Alex Demo-Admin',
    'ORG_ADMIN',
    'bbbbbbbb-0000-0000-0000-000000000001',
    true,
    false
  ),
  (
    '55555555-0000-0000-0000-000000000002',
    'demo-user@arkova.local',
    'Jamie Demo-User',
    'INDIVIDUAL',
    NULL,
    true,
    false
  );

-- Demo org membership
INSERT INTO org_members (user_id, org_id, role)
VALUES
  ('55555555-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'owner')
ON CONFLICT (user_id, org_id) DO NOTHING;

INSERT INTO memberships (user_id, org_id, role)
VALUES
  ('55555555-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'ORG_ADMIN')
ON CONFLICT (user_id, org_id) DO NOTHING;

-- Demo subscription (individual plan for demo-user)
INSERT INTO subscriptions (id, user_id, plan_id, status, current_period_start, current_period_end)
VALUES
  (
    'dddddddd-0000-0000-0000-000000000002',
    '55555555-0000-0000-0000-000000000002',
    'individual',
    'active',
    NOW() - INTERVAL '10 days',
    NOW() + INTERVAL '20 days'
  )
ON CONFLICT (id) DO NOTHING;


-- =============================================================================
-- 9b. CREDENTIAL TEMPLATES — for RLS org-level tests
-- Must come after both orgs (Arkova + Acme) and profiles are created.
-- =============================================================================

DELETE FROM credential_templates WHERE org_id IN (
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001'
);

INSERT INTO credential_templates (org_id, name, credential_type, default_metadata, is_active, created_by)
VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Arkova Standard Certificate', 'CERTIFICATE', '{"fields": ["issuer", "date"]}', true, '44444444-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Acme Compliance Report', 'CERTIFICATE', '{"fields": ["auditor", "period"]}', true, '55555555-0000-0000-0000-000000000001');


-- =============================================================================
-- 10. DEMO ANCHORS — Rich records with metadata for testing card rendering
-- =============================================================================

-- ── INDIVIDUAL USER (demo-user) — personal records with AI-extracted metadata ──

-- Record 1: SECURED with rich metadata (contract)
INSERT INTO anchors (id, user_id, filename, fingerprint, status, file_size, file_mime, credential_type, public_id, description, metadata, chain_tx_id, chain_block_height, chain_timestamp, created_at)
VALUES (
  'cccccccc-0000-0000-0000-000000000001',
  '55555555-0000-0000-0000-000000000002',
  'Employment_Agreement_2026.pdf',
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  'SECURED',
  2458000,
  'application/pdf',
  'LEGAL',
  'ARK-DEMO-001',
  'Employment agreement between Jamie Demo-User and TechCo Inc.',
  '{"entity_name": "TechCo Inc.", "form_type": "Employment Agreement", "date": "2026-01-15", "parties": "Jamie Demo-User, TechCo Inc.", "effective_date": "2026-02-01", "term": "2 years", "governing_law": "California", "_confidence": 0.92, "_prompt_version": "v3"}',
  'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
  210435,
  NOW() - INTERVAL '14 days',
  NOW() - INTERVAL '14 days'
);

-- Record 2: SECURED with certificate metadata
INSERT INTO anchors (id, user_id, filename, fingerprint, status, file_size, file_mime, credential_type, public_id, description, metadata, chain_tx_id, chain_block_height, chain_timestamp, created_at)
VALUES (
  'cccccccc-0000-0000-0000-000000000002',
  '55555555-0000-0000-0000-000000000002',
  'AWS_Solutions_Architect_Cert.pdf',
  'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
  'SECURED',
  1240000,
  'application/pdf',
  'CERTIFICATE',
  'ARK-DEMO-002',
  'AWS Solutions Architect Professional certification',
  '{"entity_name": "Amazon Web Services", "credential_type": "Professional Certification", "recipient_name": "Jamie Demo-User", "issued_date": "2025-11-20", "expiry_date": "2028-11-20", "certification_id": "AWS-SAP-2025-78291", "_confidence": 0.95, "_prompt_version": "v3"}',
  'def456abc123def456abc123def456abc123def456abc123def456abc123def4',
  210102,
  NOW() - INTERVAL '30 days',
  NOW() - INTERVAL '30 days'
);

-- Record 3: PENDING (just uploaded, no chain data yet)
INSERT INTO anchors (id, user_id, filename, fingerprint, status, file_size, file_mime, credential_type, description, metadata, created_at)
VALUES (
  'cccccccc-0000-0000-0000-000000000003',
  '55555555-0000-0000-0000-000000000002',
  'Q1_2026_Tax_Return.pdf',
  'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  'PENDING',
  3890000,
  'application/pdf',
  'FINANCIAL',
  'Q1 2026 tax return filing',
  '{"entity_name": "Jamie Demo-User", "form_type": "1040", "date": "2026-03-20", "tax_year": "2025", "filing_status": "Single", "_confidence": 0.88, "_prompt_version": "v3"}',
  NOW() - INTERVAL '2 hours'
);

-- Record 4: SECURED — NDA with metadata
INSERT INTO anchors (id, user_id, filename, fingerprint, status, file_size, file_mime, credential_type, public_id, metadata, chain_tx_id, chain_block_height, chain_timestamp, created_at)
VALUES (
  'cccccccc-0000-0000-0000-000000000004',
  '55555555-0000-0000-0000-000000000002',
  'Mutual_NDA_Acme_TechCo.pdf',
  'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
  'SECURED',
  890000,
  'application/pdf',
  'LEGAL',
  'ARK-DEMO-004',
  '{"entity_name": "Acme Corp & TechCo Inc.", "form_type": "Mutual NDA", "date": "2026-02-10", "parties": "Acme Corporation, TechCo Inc.", "effective_date": "2026-02-10", "duration": "3 years", "_confidence": 0.91, "_prompt_version": "v3"}',
  'ghi789abc123ghi789abc123ghi789abc123ghi789abc123ghi789abc123gh78',
  210300,
  NOW() - INTERVAL '20 days',
  NOW() - INTERVAL '20 days'
);

-- Record 5: SECURED — License
INSERT INTO anchors (id, user_id, filename, fingerprint, status, file_size, file_mime, credential_type, public_id, metadata, chain_tx_id, chain_block_height, chain_timestamp, created_at, issued_at, expires_at)
VALUES (
  'cccccccc-0000-0000-0000-000000000005',
  '55555555-0000-0000-0000-000000000002',
  'CA_Bar_License_2026.pdf',
  'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
  'SECURED',
  560000,
  'application/pdf',
  'LICENSE',
  'ARK-DEMO-005',
  '{"entity_name": "State Bar of California", "recipient_name": "Jamie Demo-User", "credential_type": "Attorney License", "license_number": "SBN-320145", "issued_date": "2026-01-01", "expiry_date": "2027-01-01", "jurisdiction": "California", "_confidence": 0.96, "_prompt_version": "v3"}',
  'jkl012abc123jkl012abc123jkl012abc123jkl012abc123jkl012abc1230a',
  210050,
  NOW() - INTERVAL '45 days',
  NOW() - INTERVAL '45 days',
  '2026-01-01T00:00:00Z',
  '2027-01-01T00:00:00Z'
);

-- Record 6: PENDING (recently uploaded, awaiting anchoring)
-- NOTE: SUBMITTED status can't be used in seed because ALTER TYPE ADD VALUE
-- doesn't work inside the transaction that `supabase db reset` uses.
-- After db reset, run the post-reset SUBMITTED fix from CLAUDE.md, then:
--   UPDATE anchors SET status = 'SUBMITTED' WHERE id = 'cccccccc-0000-0000-0000-000000000006';
INSERT INTO anchors (id, user_id, filename, fingerprint, status, file_size, file_mime, credential_type, metadata, chain_tx_id, created_at)
VALUES (
  'cccccccc-0000-0000-0000-000000000006',
  '55555555-0000-0000-0000-000000000002',
  'Patent_Application_AI_Method.pdf',
  'f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1',
  'PENDING',
  5200000,
  'application/pdf',
  'PATENT',
  '{"entity_name": "Jamie Demo-User", "form_type": "Patent Application", "date": "2026-03-22", "patent_title": "AI-Powered Document Verification Method", "application_number": "US2026/0012345", "_confidence": 0.87, "_prompt_version": "v3"}',
  'mno345abc123mno345abc123mno345abc123mno345abc123mno345abc1230a',
  NOW() - INTERVAL '30 minutes'
);

-- ── VERSION LINEAGE — Record 7 is v2 of Record 5 (license renewal) ──

INSERT INTO anchors (id, user_id, filename, fingerprint, status, file_size, file_mime, credential_type, public_id, parent_anchor_id, metadata, chain_tx_id, chain_block_height, chain_timestamp, created_at, issued_at, expires_at)
VALUES (
  'cccccccc-0000-0000-0000-000000000007',
  '55555555-0000-0000-0000-000000000002',
  'CA_Bar_License_2027_Renewal.pdf',
  'a7b7c7d7e7f7a7b7c7d7e7f7a7b7c7d7e7f7a7b7c7d7e7f7a7b7c7d7e7f7a7b7',
  'SECURED',
  580000,
  'application/pdf',
  'LICENSE',
  'ARK-DEMO-007',
  'cccccccc-0000-0000-0000-000000000005',
  '{"entity_name": "State Bar of California", "recipient_name": "Jamie Demo-User", "credential_type": "Attorney License (Renewed)", "license_number": "SBN-320145", "issued_date": "2027-01-01", "expiry_date": "2028-01-01", "jurisdiction": "California", "_confidence": 0.97, "_prompt_version": "v3"}',
  'pqr678abc123pqr678abc123pqr678abc123pqr678abc123pqr678abc1230a',
  211200,
  NOW() - INTERVAL '2 days',
  NOW() - INTERVAL '2 days',
  '2027-01-01T00:00:00Z',
  '2028-01-01T00:00:00Z'
);


-- ── ORG ADMIN (demo-admin) — org-level credentials ──

INSERT INTO anchors (id, user_id, org_id, filename, fingerprint, status, file_size, file_mime, credential_type, public_id, description, metadata, chain_tx_id, chain_block_height, chain_timestamp, created_at)
VALUES (
  'cccccccc-0000-0000-0000-000000000010',
  '55555555-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001',
  'Acme_SOC2_Type2_Report.pdf',
  'a10b10c10d10e10f10a10b10c10d10e10f10a10b10c10d10e10f10a10b10cd10',
  'SECURED',
  8500000,
  'application/pdf',
  'CERTIFICATE',
  'ARK-DEMO-010',
  'SOC 2 Type II audit report for Acme Corporation',
  '{"entity_name": "Acme Corporation", "form_type": "SOC 2 Type II Report", "date": "2026-02-28", "auditor": "Deloitte LLP", "period_start": "2025-03-01", "period_end": "2026-02-28", "opinion": "Unqualified", "_confidence": 0.94, "_prompt_version": "v3"}',
  'stu901abc123stu901abc123stu901abc123stu901abc123stu901abc12301',
  210800,
  NOW() - INTERVAL '10 days',
  NOW() - INTERVAL '10 days'
),
(
  'cccccccc-0000-0000-0000-000000000011',
  '55555555-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001',
  'Acme_Articles_of_Incorporation.pdf',
  'b11c11d11e11f11a11b11c11d11e11f11a11b11c11d11e11f11a11b11c11dab0',
  'SECURED',
  1200000,
  'application/pdf',
  'LEGAL',
  'ARK-DEMO-011',
  'Original articles of incorporation for Acme Corporation',
  '{"entity_name": "Acme Corporation", "form_type": "Articles of Incorporation", "date": "2020-06-15", "state": "Delaware", "registered_agent": "CT Corporation System", "authorized_shares": "10,000,000", "_confidence": 0.93, "_prompt_version": "v3"}',
  'vwx234abc123vwx234abc123vwx234abc123vwx234abc123vwx234abc12301',
  200150,
  NOW() - INTERVAL '60 days',
  NOW() - INTERVAL '60 days'
),
(
  'cccccccc-0000-0000-0000-000000000012',
  '55555555-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000001',
  'Employee_Handbook_v4.pdf',
  'c12d12e12f12a12b12c12d12e12f12a12b12c12d12e12f12a12b12c12d12eab0',
  'PENDING',
  4300000,
  'application/pdf',
  'OTHER',
  NULL,
  'Acme employee handbook version 4',
  '{"entity_name": "Acme Corporation", "form_type": "Employee Handbook", "date": "2026-03-20", "version": "4.0", "department": "Human Resources", "_confidence": 0.85, "_prompt_version": "v3"}',
  NULL,
  NULL,
  NULL,
  NOW() - INTERVAL '1 hour'
);
