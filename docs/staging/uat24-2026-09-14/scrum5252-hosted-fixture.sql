-- SCRUM-5252 deterministic synthetic fixture for authorized retired B4.
-- Data only: no migration-ledger or feature-flag writes. Apply once before the
-- diagnostic phase; qualifying cycles retain this base fixture.
BEGIN;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

INSERT INTO public.organizations(id,legal_name,display_name,domain,verification_status,hipaa_mfa_required)
VALUES
 ('52520000-0000-4000-8000-00000000b001','SCRUM-5252 Org A LLC','SCRUM-5252 Org A','scrum5252-a.invalid','UNVERIFIED',false),
 ('52520000-0000-4000-8000-00000000b002','SCRUM-5252 Org B LLC','SCRUM-5252 Org B','scrum5252-b.invalid','UNVERIFIED',false)
ON CONFLICT (id) DO NOTHING;

DO $owned_orgs$ BEGIN
 IF (SELECT count(*) FROM public.organizations WHERE
       (id='52520000-0000-4000-8000-00000000b001' AND domain='scrum5252-a.invalid') OR
       (id='52520000-0000-4000-8000-00000000b002' AND domain='scrum5252-b.invalid')) <> 2 THEN
   RAISE EXCEPTION 'SCRUM-5252 fixture org ownership mismatch';
 END IF;
END $owned_orgs$;

INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,
 raw_app_meta_data,raw_user_meta_data,is_super_admin,confirmation_token,recovery_token,email_change,
 email_change_token_new,email_change_token_current,reauthentication_token,phone_change,phone_change_token)
SELECT '00000000-0000-0000-0000-000000000000',v.id,'authenticated','authenticated',v.email,
 extensions.crypt(gen_random_uuid()::text,extensions.gen_salt('bf')),now(),now(),now(),
 '{"provider":"email","providers":["email"]}'::jsonb,jsonb_build_object('full_name',v.full_name),
 false,'','','','','','','',''
FROM (VALUES
 ('52520000-0000-4000-8000-00000000a001'::uuid,'scrum5252-platform@seed-fixture.invalid','SCRUM-5252 Platform Admin'),
 ('52520000-0000-4000-8000-00000000a002'::uuid,'scrum5252-target@seed-fixture.invalid','SCRUM-5252 Target Member'),
 ('52520000-0000-4000-8000-00000000a003'::uuid,'scrum5252-peer@seed-fixture.invalid','SCRUM-5252 Peer Member')
) v(id,email,full_name)
ON CONFLICT (id) DO NOTHING;

-- Fail before touching identities/profiles if this deterministic namespace was
-- ever occupied by anything except the exact owned synthetic accounts.
DO $owned_users$ BEGIN
 IF (SELECT count(*) FROM auth.users
     WHERE (id,email) IN (
       ('52520000-0000-4000-8000-00000000a001','scrum5252-platform@seed-fixture.invalid'),
       ('52520000-0000-4000-8000-00000000a002','scrum5252-target@seed-fixture.invalid'),
       ('52520000-0000-4000-8000-00000000a003','scrum5252-peer@seed-fixture.invalid')
     )) <> 3 THEN
   RAISE EXCEPTION 'SCRUM-5252 fixture id ownership mismatch';
 END IF;
END $owned_users$;

INSERT INTO auth.identities(id,user_id,identity_data,provider,provider_id,last_sign_in_at,created_at,updated_at)
SELECT v.identity_id,v.user_id,jsonb_build_object('sub',v.user_id::text,'email',v.email),
 'email',v.user_id::text,now(),now(),now()
FROM (VALUES
 ('52520000-0000-4000-8000-00000000e001'::uuid,'52520000-0000-4000-8000-00000000a001'::uuid,'scrum5252-platform@seed-fixture.invalid'),
 ('52520000-0000-4000-8000-00000000e002'::uuid,'52520000-0000-4000-8000-00000000a002'::uuid,'scrum5252-target@seed-fixture.invalid'),
 ('52520000-0000-4000-8000-00000000e003'::uuid,'52520000-0000-4000-8000-00000000a003'::uuid,'scrum5252-peer@seed-fixture.invalid')
) v(identity_id,user_id,email)
WHERE NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.provider='email' AND i.provider_id=v.user_id::text)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles(id,email,full_name,is_public_profile)
VALUES
 ('52520000-0000-4000-8000-00000000a001','scrum5252-platform@seed-fixture.invalid','SCRUM-5252 Platform Admin',false),
 ('52520000-0000-4000-8000-00000000a002','scrum5252-target@seed-fixture.invalid','SCRUM-5252 Target Member',false),
 ('52520000-0000-4000-8000-00000000a003','scrum5252-peer@seed-fixture.invalid','SCRUM-5252 Peer Member',false)
ON CONFLICT (id) DO UPDATE SET email=excluded.email,full_name=excluded.full_name,deleted_at=NULL,status='ACTIVE';

SELECT public.admin_change_user_role('52520000-0000-4000-8000-00000000a001','ORG_ADMIN');
SELECT public.admin_set_user_org('52520000-0000-4000-8000-00000000a001','52520000-0000-4000-8000-00000000b002','owner');
SELECT public.admin_set_platform_admin('52520000-0000-4000-8000-00000000a001',true);
SELECT public.admin_change_user_role('52520000-0000-4000-8000-00000000a002','ORG_MEMBER');
SELECT public.admin_set_user_org('52520000-0000-4000-8000-00000000a002','52520000-0000-4000-8000-00000000b001','member');
SELECT public.admin_set_platform_admin('52520000-0000-4000-8000-00000000a002',false);
SELECT public.admin_change_user_role('52520000-0000-4000-8000-00000000a003','ORG_MEMBER');
SELECT public.admin_set_user_org('52520000-0000-4000-8000-00000000a003','52520000-0000-4000-8000-00000000b001','member');
SELECT public.admin_set_platform_admin('52520000-0000-4000-8000-00000000a003',false);

INSERT INTO public.folders(id,owner_scope,user_id,org_id,context_org_id,name,created_by)
VALUES
 ('52520000-0000-4000-8000-00000000f001','USER','52520000-0000-4000-8000-00000000a002',NULL,'52520000-0000-4000-8000-00000000b001','SCRUM-5252 contextual','52520000-0000-4000-8000-00000000a002'),
 ('52520000-0000-4000-8000-00000000f002','USER','52520000-0000-4000-8000-00000000a002',NULL,NULL,'SCRUM-5252 global personal','52520000-0000-4000-8000-00000000a002'),
 ('52520000-0000-4000-8000-00000000f003','ORG',NULL,'52520000-0000-4000-8000-00000000b001',NULL,'SCRUM-5252 Org A','52520000-0000-4000-8000-00000000a002'),
 ('52520000-0000-4000-8000-00000000f004','ORG',NULL,'52520000-0000-4000-8000-00000000b002',NULL,'SCRUM-5252 Org B','52520000-0000-4000-8000-00000000a001')
ON CONFLICT (id) DO NOTHING;

DO $fixture$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id='52520000-0000-4000-8000-00000000a001' AND role='ORG_ADMIN' AND org_id='52520000-0000-4000-8000-00000000b002' AND is_platform_admin IS TRUE AND deleted_at IS NULL)
 OR (SELECT count(*) FROM public.profiles WHERE id IN ('52520000-0000-4000-8000-00000000a002','52520000-0000-4000-8000-00000000a003') AND role='ORG_MEMBER' AND org_id='52520000-0000-4000-8000-00000000b001' AND is_platform_admin IS FALSE AND deleted_at IS NULL) <> 2
 OR (SELECT count(*) FROM public.folders WHERE
       (id='52520000-0000-4000-8000-00000000f001' AND owner_scope='USER' AND user_id='52520000-0000-4000-8000-00000000a002' AND org_id IS NULL AND context_org_id='52520000-0000-4000-8000-00000000b001' AND name='SCRUM-5252 contextual') OR
       (id='52520000-0000-4000-8000-00000000f002' AND owner_scope='USER' AND user_id='52520000-0000-4000-8000-00000000a002' AND org_id IS NULL AND context_org_id IS NULL AND name='SCRUM-5252 global personal') OR
       (id='52520000-0000-4000-8000-00000000f003' AND owner_scope='ORG' AND user_id IS NULL AND org_id='52520000-0000-4000-8000-00000000b001' AND context_org_id IS NULL AND name='SCRUM-5252 Org A') OR
       (id='52520000-0000-4000-8000-00000000f004' AND owner_scope='ORG' AND user_id IS NULL AND org_id='52520000-0000-4000-8000-00000000b002' AND context_org_id IS NULL AND name='SCRUM-5252 Org B')) <> 4
 THEN RAISE EXCEPTION 'SCRUM-5252 base fixture invariant failed'; END IF;
END $fixture$;
COMMIT;
