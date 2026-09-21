-- SCRUM-5142 owned synthetic fixtures for the reserved UAT-17 rig.
-- Data only: never touches the migration ledger or flags.
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

INSERT INTO auth.users (
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,
  raw_app_meta_data,raw_user_meta_data,is_super_admin,confirmation_token,recovery_token,
  email_change,email_change_token_new,email_change_token_current,reauthentication_token,
  phone_change,phone_change_token
) VALUES (
  '00000000-0000-0000-0000-000000000000','51420000-0000-4000-8000-00000000a001',
  'authenticated','authenticated','uat24-folder-admin@seed-fixture.invalid',
  extensions.crypt(gen_random_uuid()::text,extensions.gen_salt('bf')),now(),now(),now(),
  '{"provider":"email","providers":["email"]}','{"full_name":"UAT24 Folder Admin"}',
  false,'','','','','','','',''
) ON CONFLICT (id) DO NOTHING;

INSERT INTO auth.identities(id,user_id,identity_data,provider,provider_id,last_sign_in_at,created_at,updated_at)
SELECT '51420000-0000-4000-8000-00000000e001','51420000-0000-4000-8000-00000000a001',
  '{"sub":"51420000-0000-4000-8000-00000000a001","email":"uat24-folder-admin@seed-fixture.invalid"}',
  'email','51420000-0000-4000-8000-00000000a001',now(),now(),now()
WHERE NOT EXISTS (SELECT 1 FROM auth.identities
  WHERE provider='email' AND provider_id='51420000-0000-4000-8000-00000000a001');

INSERT INTO public.organizations(
  id,legal_name,display_name,domain,verification_status,hipaa_mfa_required
) VALUES (
  '51420000-0000-4000-8000-00000000b001','UAT24 Folder Fixture LLC',
  'UAT24 Folder Fixture','uat24-folder-fixture.invalid','UNVERIFIED',false
) ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles(id,email,full_name,role,org_id,is_public_profile,is_platform_admin)
VALUES ('51420000-0000-4000-8000-00000000a001','uat24-folder-admin@seed-fixture.invalid',
  'UAT24 Folder Admin','ORG_ADMIN','51420000-0000-4000-8000-00000000b001',false,false)
-- The rig's canonical auth trigger may already have created this profile with
-- immutable role ORG_MEMBER. Preserve that coarse profile role; exact folder
-- administration is established by the canonical org_members.owner row below.
ON CONFLICT (id) DO UPDATE SET org_id=excluded.org_id,deleted_at=NULL;

INSERT INTO public.org_members(user_id,org_id,role)
VALUES ('51420000-0000-4000-8000-00000000a001','51420000-0000-4000-8000-00000000b001','owner')
ON CONFLICT (user_id,org_id) DO UPDATE SET role=excluded.role;

INSERT INTO public.org_integrations(id,org_id,provider,account_id,account_label,connected_at,revoked_at)
VALUES ('51420000-0000-4000-8000-00000000d001','51420000-0000-4000-8000-00000000b001',
  'google_drive','uat24-folder-fixture-account','UAT24 Folder Fixture',now(),NULL)
ON CONFLICT (id) DO UPDATE SET revoked_at=NULL;

INSERT INTO public.anchors(
  id,user_id,org_id,fingerprint,filename,status,credential_type,metadata
) VALUES (
  '51420000-0000-4000-8000-00000000c001','51420000-0000-4000-8000-00000000a001',
  '51420000-0000-4000-8000-00000000b001',
  md5('uat24-folder-fixture-a') || md5('uat24-folder-fixture-b'),
  'uat24-folder-fixture.pdf','PENDING','OTHER',
  '{"_fixture":true,"_synthetic":true,"_purpose":"SCRUM-5142 hosted folder driver"}'
) ON CONFLICT (id) DO NOTHING;

COMMIT;
