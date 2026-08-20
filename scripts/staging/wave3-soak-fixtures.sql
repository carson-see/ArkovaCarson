-- scripts/staging/wave3-soak-fixtures.sql
--
-- WAVE 3 soak-driver fixtures — additive to scripts/staging/seed-baseline-fixture.sql.
-- Not part of the standard rig-provisioning baseline; specific to exercising
-- #2272 (queue-digest default-on/opt-out) and #2276 (platform-health-digest)
-- role-resolved-recipient behavior, and #2230/#2236 (Drive connect deny-reason
-- not_admin) on the arkova-wave3-2026-08 rig (jiotjhqmedkajdsojsbn).
--
-- Idempotent: ON CONFLICT DO NOTHING on stable 5eed0003-... fixture UUIDs.
-- Clearly synthetic: *-fixture.invalid emails, "Seed Fixture" org names.
-- Data-only: no writes to supabase_migrations.schema_migrations.

BEGIN;

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Org C — VERIFIED, default-enrolled (no opt-out), one PENDING_RESOLUTION
-- anchor so #2272's per-org digest has a real, non-empty queue to report on.
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, legal_name, display_name, domain, verification_status)
VALUES ('5eed0003-0000-0000-0000-0000000000c1', 'Seed Fixture Org C LLC', 'Seed Fixture Org C', 'seed-fixture-c.invalid', 'VERIFIED')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token,
  recovery_token, email_change, email_change_token_new, email_change_token_current,
  reauthentication_token, phone_change, phone_change_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '5eed0003-0000-0000-0000-0000000000a1',
  'authenticated', 'authenticated',
  'orgc-admin-fixture@seed-fixture.invalid',
  extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
  NOW(), NOW(), NOW(),
  '{"provider": "email", "providers": ["email"]}',
  '{"full_name": "Org C Admin Fixture"}',
  false, '', '', '', '', '', '', '', ''
) ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
SELECT '5eed0003-0000-0000-0000-0000000000d1', '5eed0003-0000-0000-0000-0000000000a1',
  '{"sub": "5eed0003-0000-0000-0000-0000000000a1", "email": "orgc-admin-fixture@seed-fixture.invalid"}'::jsonb,
  'email', '5eed0003-0000-0000-0000-0000000000a1', NOW(), NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM auth.identities WHERE provider = 'email' AND provider_id = '5eed0003-0000-0000-0000-0000000000a1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email, full_name, role, org_id, is_public_profile, is_platform_admin)
VALUES ('5eed0003-0000-0000-0000-0000000000a1', 'orgc-admin-fixture@seed-fixture.invalid', 'Org C Admin Fixture', 'ORG_ADMIN', '5eed0003-0000-0000-0000-0000000000c1', false, false)
ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role;

INSERT INTO public.anchors (id, user_id, org_id, filename, fingerprint, status, file_size, file_mime, description, metadata, legal_hold, created_at)
VALUES (
  '5eed0003-0000-0000-0000-0000000000e1',
  '5eed0003-0000-0000-0000-0000000000a1',
  '5eed0003-0000-0000-0000-0000000000c1',
  'wave3-fixture-queue-item.pdf',
  'face5eed0003face5eed0003face5eed0003face5eed0003face5eed0003face',
  'PENDING_RESOLUTION',
  4096, 'application/pdf',
  'Wave 3 soak-driver fixture — queue item for #2272 default-enrolled org digest.',
  '{"_fixture": true, "_purpose": "wave3-soak-driver-queue-digest-enrolled"}'::jsonb,
  true, NOW()
) ON CONFLICT (id) DO UPDATE SET status = 'PENDING_RESOLUTION';

-- ---------------------------------------------------------------------------
-- Org D — VERIFIED, EXPLICIT QUEUE_DIGEST opt-out row, ALSO one
-- PENDING_RESOLUTION anchor (so if the opt-out were NOT honored, the digest
-- would have something to say — the proof is that Org D never appears in
-- send attempts despite carrying the same non-empty queue as Org C).
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (id, legal_name, display_name, domain, verification_status)
VALUES ('5eed0003-0000-0000-0000-0000000000c2', 'Seed Fixture Org D LLC', 'Seed Fixture Org D', 'seed-fixture-d.invalid', 'VERIFIED')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token,
  recovery_token, email_change, email_change_token_new, email_change_token_current,
  reauthentication_token, phone_change, phone_change_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '5eed0003-0000-0000-0000-0000000000a2',
  'authenticated', 'authenticated',
  'orgd-admin-fixture@seed-fixture.invalid',
  extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
  NOW(), NOW(), NOW(),
  '{"provider": "email", "providers": ["email"]}',
  '{"full_name": "Org D Admin Fixture"}',
  false, '', '', '', '', '', '', '', ''
) ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
SELECT '5eed0003-0000-0000-0000-0000000000d2', '5eed0003-0000-0000-0000-0000000000a2',
  '{"sub": "5eed0003-0000-0000-0000-0000000000a2", "email": "orgd-admin-fixture@seed-fixture.invalid"}'::jsonb,
  'email', '5eed0003-0000-0000-0000-0000000000a2', NOW(), NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM auth.identities WHERE provider = 'email' AND provider_id = '5eed0003-0000-0000-0000-0000000000a2')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email, full_name, role, org_id, is_public_profile, is_platform_admin)
VALUES ('5eed0003-0000-0000-0000-0000000000a2', 'orgd-admin-fixture@seed-fixture.invalid', 'Org D Admin Fixture', 'ORG_ADMIN', '5eed0003-0000-0000-0000-0000000000c2', false, false)
ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role;

INSERT INTO public.anchors (id, user_id, org_id, filename, fingerprint, status, file_size, file_mime, description, metadata, legal_hold, created_at)
VALUES (
  '5eed0003-0000-0000-0000-0000000000e2',
  '5eed0003-0000-0000-0000-0000000000a2',
  '5eed0003-0000-0000-0000-0000000000c2',
  'wave3-fixture-optout-queue-item.pdf',
  'face5eed0004face5eed0004face5eed0004face5eed0004face5eed0004face',
  'PENDING_RESOLUTION',
  4096, 'application/pdf',
  'Wave 3 soak-driver fixture — queue item for #2272 opt-out org (must NOT be digested).',
  '{"_fixture": true, "_purpose": "wave3-soak-driver-queue-digest-optout"}'::jsonb,
  true, NOW()
) ON CONFLICT (id) DO UPDATE SET status = 'PENDING_RESOLUTION';

INSERT INTO public.organization_rules (id, org_id, name, description, trigger_type, trigger_config, action_type, action_config, enabled, created_by_user_id)
VALUES (
  '5eed0003-0000-0000-0000-0000000000f1',
  '5eed0003-0000-0000-0000-0000000000c2',
  'Wave 3 fixture — QUEUE_DIGEST opt-out',
  'Soak-driver fixture proving #2272 honors an explicit opt-out.',
  'QUEUE_DIGEST',
  '{}'::jsonb,
  'NOTIFY',
  '{}'::jsonb,
  false,
  '5eed0003-0000-0000-0000-0000000000a2'
) ON CONFLICT (id) DO UPDATE SET enabled = false;

-- ---------------------------------------------------------------------------
-- Platform-admin fixture profile — #2276's ONLY recipient source
-- (profiles.is_platform_admin = true). No org required.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token,
  recovery_token, email_change, email_change_token_new, email_change_token_current,
  reauthentication_token, phone_change, phone_change_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '5eed0003-0000-0000-0000-0000000000a3',
  'authenticated', 'authenticated',
  'platform-admin-fixture@seed-fixture.invalid',
  extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
  NOW(), NOW(), NOW(),
  '{"provider": "email", "providers": ["email"]}',
  '{"full_name": "Platform Admin Fixture"}',
  false, '', '', '', '', '', '', '', ''
) ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
SELECT '5eed0003-0000-0000-0000-0000000000d3', '5eed0003-0000-0000-0000-0000000000a3',
  '{"sub": "5eed0003-0000-0000-0000-0000000000a3", "email": "platform-admin-fixture@seed-fixture.invalid"}'::jsonb,
  'email', '5eed0003-0000-0000-0000-0000000000a3', NOW(), NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM auth.identities WHERE provider = 'email' AND provider_id = '5eed0003-0000-0000-0000-0000000000a3')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email, full_name, role, org_id, is_public_profile, is_platform_admin)
VALUES ('5eed0003-0000-0000-0000-0000000000a3', 'platform-admin-fixture@seed-fixture.invalid', 'Platform Admin Fixture', 'INDIVIDUAL', NULL, false, true)
ON CONFLICT (id) DO UPDATE SET is_platform_admin = true;

-- ---------------------------------------------------------------------------
-- Non-admin MEMBER of the baseline Seed Fixture Org (5eed0000-...-b1) — for
-- #2230/#2236's Drive connect `not_admin` deny-reason case. No org_members
-- admin row, profiles.role = MEMBER, org_id set to the baseline org.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token,
  recovery_token, email_change, email_change_token_new, email_change_token_current,
  reauthentication_token, phone_change, phone_change_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '5eed0003-0000-0000-0000-0000000000a4',
  'authenticated', 'authenticated',
  'member-fixture@seed-fixture.invalid',
  extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
  NOW(), NOW(), NOW(),
  '{"provider": "email", "providers": ["email"]}',
  '{"full_name": "Member Fixture"}',
  false, '', '', '', '', '', '', '', ''
) ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
SELECT '5eed0003-0000-0000-0000-0000000000d4', '5eed0003-0000-0000-0000-0000000000a4',
  '{"sub": "5eed0003-0000-0000-0000-0000000000a4", "email": "member-fixture@seed-fixture.invalid"}'::jsonb,
  'email', '5eed0003-0000-0000-0000-0000000000a4', NOW(), NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM auth.identities WHERE provider = 'email' AND provider_id = '5eed0003-0000-0000-0000-0000000000a4')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email, full_name, role, org_id, is_public_profile, is_platform_admin)
VALUES ('5eed0003-0000-0000-0000-0000000000a4', 'member-fixture@seed-fixture.invalid', 'Member Fixture', 'ORG_MEMBER', '5eed0000-0000-0000-0000-0000000000b1', false, false)
ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role;

COMMIT;

-- Post-conditions (informational):
--   Org C: VERIFIED, 1 PENDING_RESOLUTION anchor, no opt-out -> #2272 should
--     attempt a queue_reminder send to orgc-admin-fixture@seed-fixture.invalid.
--   Org D: VERIFIED, 1 PENDING_RESOLUTION anchor, QUEUE_DIGEST opt-out
--     enabled=false -> #2272 must NOT attempt a send for Org D.
--   platform-admin-fixture: is_platform_admin=true -> #2276 should attempt a
--     notification send to platform-admin-fixture@seed-fixture.invalid (and
--     to the baseline seed-fixture-user IF it is ever flipped is_platform_admin,
--     which it is not, by design, so it must NOT receive this digest).
--   member-fixture: MEMBER of the baseline org, no org_members admin row ->
--     Drive connect with org_id=5eed0000-0000-0000-0000-0000000000b1 must
--     deny with reason=not_admin.
