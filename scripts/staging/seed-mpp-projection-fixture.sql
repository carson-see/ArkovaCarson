-- seed-mpp-projection-fixture.sql — soak fixtures for the mig-public-projection
-- batch (PR #2314 / 0415 FERPA §99.37, PR #2440 / 0421 sub_type projection).
--
-- TWO orgs on purpose: the FERPA negative case has to be proven CROSS-ORG, and
-- the per-org isolation check needs a second tenant whose published records must
-- never carry the first tenant's issuer identity.
--
-- Data-only (§1.11A): writes NOTHING to supabase_migrations.schema_migrations.
-- Idempotent on stable synthetic UUIDs. Every string is obviously a fixture.
BEGIN;

-- Transaction-local service_role claim so protect_anchor_status_transition()
-- takes its fast-path and permits a direct SECURED insert (same mechanism as
-- scripts/staging/seed-baseline-fixture.sql).
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ── auth users (root of the FK chain) ──────────────────────────────────────
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, reauthentication_token, phone_change, phone_change_token
)
SELECT '00000000-0000-0000-0000-000000000000', v.id, 'authenticated', 'authenticated',
       v.email, extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')),
       NOW(), NOW(), NOW(),
       '{"provider": "email", "providers": ["email"]}', '{"full_name": "TSOAK MPP"}',
       false, '', '', '', '', '', '', '', ''
FROM (VALUES
  ('99ff0000-0000-4000-8000-0000000000a2'::uuid, 'tsoak-mpp-a@seed-fixture.invalid'),
  ('99ff0000-0000-4000-8000-0000000000b2'::uuid, 'tsoak-mpp-b@seed-fixture.invalid')
) AS v(id, email)
ON CONFLICT (id) DO NOTHING;

-- ── organizations (two tenants) ────────────────────────────────────────────
INSERT INTO public.organizations (id, legal_name, display_name, domain, verification_status)
VALUES
  ('99ff0000-0000-4000-8000-0000000000a1', 'TSOAK-MPP Alpha University LLC',
   'TSOAK-MPP Alpha University', 'tsoak-mpp-alpha.invalid', 'UNVERIFIED'),
  ('99ff0000-0000-4000-8000-0000000000b1', 'TSOAK-MPP Bravo College LLC',
   'TSOAK-MPP Bravo College', 'tsoak-mpp-bravo.invalid', 'UNVERIFIED')
ON CONFLICT (id) DO NOTHING;

-- ── profiles ───────────────────────────────────────────────────────────────
INSERT INTO public.profiles (id, email, full_name, role, org_id, is_public_profile, is_platform_admin)
VALUES
  ('99ff0000-0000-4000-8000-0000000000a2', 'tsoak-mpp-a@seed-fixture.invalid',
   'TSOAK MPP Alpha Admin', 'ORG_ADMIN', '99ff0000-0000-4000-8000-0000000000a1', false, false),
  ('99ff0000-0000-4000-8000-0000000000b2', 'tsoak-mpp-b@seed-fixture.invalid',
   'TSOAK MPP Bravo Admin', 'ORG_ADMIN', '99ff0000-0000-4000-8000-0000000000b1', false, false)
ON CONFLICT (id) DO NOTHING;

-- ── anchors ────────────────────────────────────────────────────────────────
-- `filename` deliberately carries a learner name: that string IS directory
-- information under 34 CFR 99.3, and watching whether it reaches an anonymous
-- caller is the whole point of the FERPA half of this soak.
INSERT INTO public.anchors (
  id, public_id, user_id, org_id, status, credential_type, sub_type,
  directory_info_opt_out, filename, fingerprint, file_size,
  issued_at, expires_at, chain_timestamp, chain_block_height, chain_tx_id,
  metadata, created_at
)
SELECT
  v.id, v.public_id, v.user_id, v.org_id, 'SECURED', v.credential_type::credential_type,
  v.sub_type, v.opt_out,
  'Jordan Rivera ' || v.public_id || '.pdf',
  md5('mpp-hi-' || v.public_id) || md5('mpp-lo-' || v.public_id),
  12345,
  NOW() - INTERVAL '30 days', NOW() + INTERVAL '365 days',
  NOW() - INTERVAL '29 days', 900000,
  md5('mpp-tx-hi-' || v.public_id) || md5('mpp-tx-lo-' || v.public_id),
  jsonb_build_object(
    'issuer', v.issuer,
    'title', 'Bachelor of Science',
    'sub_type', v.sub_type,
    '_fixture', true, '_synthetic', true,
    '_purpose', 'mig-public-projection soak (PR #2314 / #2440)'
  ),
  NOW() - INTERVAL '30 days'
FROM (VALUES
  -- org A
  ('99ff0001-0000-4000-8000-000000000001'::uuid, 'ARK-MPP-A-OPTDEG',  '99ff0000-0000-4000-8000-0000000000a2'::uuid, '99ff0000-0000-4000-8000-0000000000a1'::uuid, 'DEGREE',  'official_undergraduate',     true,  'TSOAK-MPP Alpha University'),
  ('99ff0001-0000-4000-8000-000000000002'::uuid, 'ARK-MPP-A-OPTNULL', '99ff0000-0000-4000-8000-0000000000a2'::uuid, '99ff0000-0000-4000-8000-0000000000a1'::uuid, NULL,      NULL,                        true,  'TSOAK-MPP Alpha University'),
  ('99ff0001-0000-4000-8000-000000000003'::uuid, 'ARK-MPP-A-NOOPTDEG','99ff0000-0000-4000-8000-0000000000a2'::uuid, '99ff0000-0000-4000-8000-0000000000a1'::uuid, 'DEGREE',  'official_graduate',         false, 'TSOAK-MPP Alpha University'),
  ('99ff0001-0000-4000-8000-000000000004'::uuid, 'ARK-MPP-A-OPTLIC',  '99ff0000-0000-4000-8000-0000000000a2'::uuid, '99ff0000-0000-4000-8000-0000000000a1'::uuid, 'LICENSE', 'state_license',             true,  'TSOAK-MPP Alpha University'),
  ('99ff0001-0000-4000-8000-000000000005'::uuid, 'ARK-MPP-A-OTHPRO',  '99ff0000-0000-4000-8000-0000000000a2'::uuid, '99ff0000-0000-4000-8000-0000000000a1'::uuid, 'OTHER',   'Professional Certification', false, 'TSOAK-MPP Alpha University'),
  ('99ff0001-0000-4000-8000-000000000006'::uuid, 'ARK-MPP-A-OTHRN',   '99ff0000-0000-4000-8000-0000000000a2'::uuid, '99ff0000-0000-4000-8000-0000000000a1'::uuid, 'OTHER',   'nursing_rn',                false, 'TSOAK-MPP Alpha University'),
  ('99ff0001-0000-4000-8000-000000000007'::uuid, 'ARK-MPP-A-OTHNULL', '99ff0000-0000-4000-8000-0000000000a2'::uuid, '99ff0000-0000-4000-8000-0000000000a1'::uuid, 'OTHER',   NULL,                        false, 'TSOAK-MPP Alpha University'),
  -- org B (cross-org)
  ('99ff0002-0000-4000-8000-000000000001'::uuid, 'ARK-MPP-B-OPTDEG',  '99ff0000-0000-4000-8000-0000000000b2'::uuid, '99ff0000-0000-4000-8000-0000000000b1'::uuid, 'DEGREE',  'official_undergraduate',     true,  'TSOAK-MPP Bravo College'),
  ('99ff0002-0000-4000-8000-000000000002'::uuid, 'ARK-MPP-B-OTHCLE',  '99ff0000-0000-4000-8000-0000000000b2'::uuid, '99ff0000-0000-4000-8000-0000000000b1'::uuid, 'OTHER',   'cle_ethics',                false, 'TSOAK-MPP Bravo College')
) AS v(id, public_id, user_id, org_id, credential_type, sub_type, opt_out, issuer)
ON CONFLICT (id) DO UPDATE SET
  credential_type        = EXCLUDED.credential_type,
  sub_type               = EXCLUDED.sub_type,
  directory_info_opt_out = EXCLUDED.directory_info_opt_out,
  status                 = EXCLUDED.status;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.anchors WHERE public_id LIKE 'ARK-MPP-%';
  RAISE NOTICE 'seed-mpp: % projection fixture anchors across 2 orgs', n;
END $$;

COMMIT;
