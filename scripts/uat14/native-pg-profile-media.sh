#!/usr/bin/env bash
set -euo pipefail
PG_BIN="${UAT14_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PSQL="$PG_BIN/psql"; CREATEDB="$PG_BIN/createdb"; DROPDB="$PG_BIN/dropdb"
export PGHOST="${PGHOST:-127.0.0.1}"
case "$PGHOST" in 127.0.0.1|localhost|::1|/tmp|/var/run/postgresql) ;; *) echo 'local PostgreSQL required' >&2; exit 2 ;; esac
DB="arkova_uat14_media_${$}_${RANDOM}"
$CREATEDB "$DB"
trap '$DROPDB --if-exists "$DB" >/dev/null 2>&1 || true' EXIT

$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<'SQL' >/dev/null
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION private.is_human_mfa_verified() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.aal',true)='aal2' $$;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, public_id text UNIQUE, is_public_profile boolean NOT NULL DEFAULT false, deleted_at timestamptz, status text DEFAULT 'ACTIVE', avatar_url text, full_name text, bio text, social_links jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE public.organizations(id uuid PRIMARY KEY, public_id text UNIQUE, suspended boolean NOT NULL DEFAULT false);
CREATE TABLE public.org_members(user_id uuid, org_id uuid REFERENCES organizations, role text);
CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage, public, auth TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated;
GRANT SELECT ON public.org_members, public.organizations, public.profiles TO anon, authenticated;
CREATE FUNCTION public.get_public_member_profile(p_public_id text) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('public_id', p.public_id, 'display_name', coalesce(p.full_name,'Public member'), 'avatar_url',p.avatar_url,'bio',p.bio,'social_links',p.social_links,'created_at',p.created_at,'organizations','[]'::jsonb) FROM profiles p WHERE p.public_id=p_public_id AND p.is_public_profile $$;
CREATE FUNCTION public.get_public_org_profile(p_org_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('org_id',o.id,'display_name','Org') FROM organizations o WHERE o.id=p_org_id $$;
SQL

$PSQL -v ON_ERROR_STOP=1 -d "$DB" -f supabase/migrations/0481_uat14_profile_brand_media.sql >/dev/null

U=11111111-1111-4111-8111-111111111111
OTHER=22222222-2222-4222-8222-222222222222
O=33333333-3333-4333-8333-333333333333
A="users/person-public/avatar/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png"
B="users/person-public/banner/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png"
L="organizations/org-public/logo/cccccccc-cccc-4ccc-8ccc-cccccccccccc.png"
$PSQL -v ON_ERROR_STOP=1 -d "$DB" <<SQL >/dev/null
INSERT INTO profiles(id,public_id,is_public_profile,avatar_storage_path,banner_storage_path) VALUES ('$U','person-public',true,'$A','$B');
INSERT INTO profiles(id,public_id,is_public_profile) VALUES ('$OTHER','other-public',false);
INSERT INTO organizations(id,public_id,logo_storage_path) VALUES ('$O','org-public','$L');
INSERT INTO org_members VALUES ('$U','$O','admin'),('$OTHER','$O','member');
SET ROLE authenticated; SET request.jwt.claim.sub='$U'; SET request.jwt.claim.aal='aal2';
INSERT INTO storage.objects(bucket_id,name) VALUES ('profile-media','$A'),('profile-media','$B'),('profile-media','$L');
INSERT INTO storage.objects(bucket_id,name) VALUES ('profile-media','organizations/org-public/banner/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png');
DELETE FROM storage.objects WHERE name='organizations/org-public/banner/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png';
RESET ROLE;
SQL

if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "SET ROLE authenticated; SET request.jwt.claim.sub='$OTHER'; SET request.jwt.claim.aal='aal2'; INSERT INTO storage.objects(bucket_id,name) VALUES ('profile-media','users/person-public/avatar/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png');" >/dev/null 2>&1; then exit 1; fi
if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "SET ROLE authenticated; SET request.jwt.claim.sub='$U'; SET request.jwt.claim.aal='aal1'; INSERT INTO storage.objects(bucket_id,name) VALUES ('profile-media','users/person-public/avatar/dddddddd-dddd-4ddd-8ddd-dddddddddddd.png');" >/dev/null 2>&1; then exit 1; fi
[[ "$($PSQL -At -d "$DB" -c "SET ROLE anon; SELECT count(*) FROM storage.objects WHERE name='$A';")" == *$'1' ]]
[[ "$($PSQL -At -d "$DB" -c "SET ROLE anon; SELECT get_public_member_profile_v2('person-public')->>'avatar_storage_path';")" == *"$A" ]]
[[ "$($PSQL -At -d "$DB" -c "SET ROLE anon; SELECT get_public_org_profile_v2('$O'::uuid)->>'logo_storage_path';")" == *"$L" ]]
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE profiles SET is_public_profile=false WHERE id='$U';" >/dev/null
[[ "$($PSQL -At -d "$DB" -c "SET ROLE anon; SELECT get_public_member_profile_v2('person-public')->>'error';")" == *'Profile not found' ]]
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE profiles SET is_public_profile=true WHERE id='$U';" >/dev/null
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE profiles SET status='INACTIVE' WHERE id='$U';" >/dev/null
[[ "$($PSQL -At -d "$DB" -c "SET ROLE anon; SELECT get_public_member_profile_v2('person-public')->>'error';")" == *'Profile not found' ]]
[[ "$($PSQL -At -d "$DB" -c "SET ROLE anon; SELECT count(*) FROM storage.objects WHERE name='$A';")" == *$'0' ]]
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE profiles SET status='ACTIVE', deleted_at=now() WHERE id='$U';" >/dev/null
[[ "$($PSQL -At -d "$DB" -c "SET ROLE anon; SELECT get_public_member_profile_v2('person-public')->>'error';")" == *'Profile not found' ]]
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE profiles SET deleted_at=NULL WHERE id='$U';" >/dev/null
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE profiles SET is_public_profile=false WHERE id='$U';" >/dev/null
[[ "$($PSQL -At -d "$DB" -c "SET ROLE anon; SELECT get_public_member_profile_v2('person-public')->>'error';")" == *'Profile not found' ]]
[[ "$($PSQL -At -d "$DB" -c "SET ROLE anon; SELECT count(*) FROM storage.objects WHERE name='$A';")" == *$'0' ]]
[[ "$($PSQL -At -d "$DB" -c "SET ROLE authenticated; SET request.jwt.claim.sub='$U'; SET request.jwt.claim.aal='aal1'; SELECT count(*) FROM storage.objects WHERE name='$A';")" == *$'0' ]]
[[ "$($PSQL -At -d "$DB" -c "SET ROLE authenticated; SET request.jwt.claim.sub='$U'; SET request.jwt.claim.aal='aal2'; SELECT count(*) FROM storage.objects WHERE name='$A';")" == *$'1' ]]
$PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE organizations SET suspended=true WHERE id='$O';" >/dev/null
[[ "$($PSQL -At -d "$DB" -c "SET ROLE anon; SELECT count(*) FROM storage.objects WHERE name='$L';")" == *$'0' ]]
[[ "$($PSQL -At -d "$DB" -c "SET ROLE anon; SELECT get_public_org_profile_v2('$O'::uuid)->>'error';")" == *'Organization not found' ]]
if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE profiles SET avatar_storage_path='users/other-public/avatar/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png' WHERE id='$U';" >/dev/null 2>&1; then exit 1; fi
if $PSQL -v ON_ERROR_STOP=1 -d "$DB" -c "UPDATE profiles SET public_id=NULL, avatar_storage_path='users/none/avatar/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.png' WHERE id='$OTHER';" >/dev/null 2>&1; then exit 1; fi
[[ "$($PSQL -At -d "$DB" -c "SELECT string_agg(table_name||'.'||column_name||':'||data_type,',' ORDER BY table_name,column_name) FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('avatar_storage_path','banner_storage_path','logo_storage_path');")" == 'organizations.banner_storage_path:text,organizations.logo_storage_path:text,profiles.avatar_storage_path:text,profiles.banner_storage_path:text' ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT string_agg(proname||'('||pg_get_function_identity_arguments(oid)||'):'||pg_get_function_result(oid),',' ORDER BY proname) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('get_public_member_profile_v2','get_public_org_profile_v2');")" == 'get_public_member_profile_v2(p_public_id text):jsonb,get_public_org_profile_v2(p_org_id uuid):jsonb' ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT array_to_string(allowed_mime_types,',') FROM storage.buckets WHERE id='profile-media';")" == 'image/png' ]]
ACL_MATRIX="$($PSQL -At -d "$DB" -c "SELECT string_agg(p.proname||':'||has_function_privilege('anon',p.oid,'EXECUTE')||':'||has_function_privilege('authenticated',p.oid,'EXECUTE')||':'||has_function_privilege('service_role',p.oid,'EXECUTE'),',' ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('can_read_profile_media','can_write_profile_media','get_public_member_profile_v2','get_public_org_profile_v2');")"
[[ "$ACL_MATRIX" == 'can_read_profile_media:true:true:true,can_write_profile_media:false:true:true,get_public_member_profile_v2:true:true:true,get_public_org_profile_v2:true:true:true' ]]
[[ "$($PSQL -At -d "$DB" -c "SELECT count(*) FROM pg_proc p, LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('can_read_profile_media','can_write_profile_media','get_public_member_profile_v2','get_public_org_profile_v2') AND a.grantee=0 AND a.privilege_type='EXECUTE';")" == 0 ]]
echo 'UAT-14 native profile media PASS owner-write cross-owner-deny aal1-deny public-toggle owner-read pending-org-cleanup org-suspension path-check opaque-DTO exact-ACL anon-v2'
