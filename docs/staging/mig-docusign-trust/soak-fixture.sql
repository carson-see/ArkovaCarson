-- mig-docusign-trust soak fixture (DATA-ONLY, CLAUDE.md §1.11A — no ledger writes)
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Two orgs, each with its own DocuSign connected account (per-org isolation test)
INSERT INTO public.organizations (id, legal_name, display_name, domain, verification_status) VALUES
  ('50a70000-0000-4000-8000-00000000a001','Soak Org A LLC','Soak Org A','soak-org-a.invalid','UNVERIFIED'),
  ('50a70000-0000-4000-8000-00000000b001','Soak Org B LLC','Soak Org B','soak-org-b.invalid','UNVERIFIED')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, reauthentication_token, phone_change, phone_change_token
) VALUES
  ('00000000-0000-0000-0000-000000000000','50a70000-0000-4000-8000-00000000a0a1','authenticated','authenticated',
   'soak-a@soak-fixture.invalid', extensions.crypt('<REDACTED-SOAK-USER-PASSWORD>', extensions.gen_salt('bf')),
   NOW(), NOW(), NOW(), '{"provider": "email", "providers": ["email"]}', '{"full_name": "Soak User A"}',
   false,'','','','','','','',''),
  ('00000000-0000-0000-0000-000000000000','50a70000-0000-4000-8000-00000000b0b1','authenticated','authenticated',
   'soak-b@soak-fixture.invalid', extensions.crypt('<REDACTED-SOAK-USER-PASSWORD>', extensions.gen_salt('bf')),
   NOW(), NOW(), NOW(), '{"provider": "email", "providers": ["email"]}', '{"full_name": "Soak User B"}',
   false,'','','','','','','','')
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
SELECT '50a70000-0000-4000-8000-00000000a0d1','50a70000-0000-4000-8000-00000000a0a1',
  '{"sub": "50a70000-0000-4000-8000-00000000a0a1", "email": "soak-a@soak-fixture.invalid"}'::jsonb,
  'email','50a70000-0000-4000-8000-00000000a0a1',NOW(),NOW(),NOW()
WHERE NOT EXISTS (SELECT 1 FROM auth.identities WHERE provider='email' AND provider_id='50a70000-0000-4000-8000-00000000a0a1')
ON CONFLICT (id) DO NOTHING;
INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
SELECT '50a70000-0000-4000-8000-00000000b0d1','50a70000-0000-4000-8000-00000000b0b1',
  '{"sub": "50a70000-0000-4000-8000-00000000b0b1", "email": "soak-b@soak-fixture.invalid"}'::jsonb,
  'email','50a70000-0000-4000-8000-00000000b0b1',NOW(),NOW(),NOW()
WHERE NOT EXISTS (SELECT 1 FROM auth.identities WHERE provider='email' AND provider_id='50a70000-0000-4000-8000-00000000b0b1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email, full_name, role, org_id, is_public_profile, is_platform_admin) VALUES
  ('50a70000-0000-4000-8000-00000000a0a1','soak-a@soak-fixture.invalid','Soak User A','ORG_ADMIN','50a70000-0000-4000-8000-00000000a001',false,false),
  ('50a70000-0000-4000-8000-00000000b0b1','soak-b@soak-fixture.invalid','Soak User B','ORG_ADMIN','50a70000-0000-4000-8000-00000000b001',false,false)
ON CONFLICT (id) DO NOTHING;

-- DocuSign connected accounts, one per org. hmac_keys left NULL so the worker
-- falls back to DOCUSIGN_CONNECT_HMAC_SECRET (resolveHmacKeys) for both orgs.
INSERT INTO public.org_integrations (id, org_id, provider, account_id, account_label, connected_at) VALUES
  ('50a70000-0000-4000-8000-0000000a1a01','50a70000-0000-4000-8000-00000000a001','docusign','aa000000-1111-4111-8111-00000000000a','Soak DS Account A',NOW()),
  ('50a70000-0000-4000-8000-0000000b1b01','50a70000-0000-4000-8000-00000000b001','docusign','bb000000-2222-4222-8222-00000000000b','Soak DS Account B',NOW())
ON CONFLICT (id) DO NOTHING;

-- Flags the soak needs on (§1.9 / switchboard)
INSERT INTO public.switchboard_flags (flag_key, enabled, description) VALUES
  ('ENABLE_VERIFICATION_API', true, 'soak mig-docusign-trust'),
  ('ENABLE_DOCUSIGN_WEBHOOK', true, 'soak mig-docusign-trust'),
  ('ENABLE_CONNECTOR_ARTIFACT_ENQUEUE', true, 'soak mig-docusign-trust'),
  ('ENABLE_CONNECTOR_ARTIFACT_DRAIN', true, 'soak mig-docusign-trust')
ON CONFLICT (flag_key) DO UPDATE SET enabled = EXCLUDED.enabled;

COMMIT;
