-- =====================================================================
-- STAGING RIG ONLY — DO NOT APPLY TO PROD.
--
-- Apply path: Supabase MCP `apply_migration` against project_ref
--   ujtlwnoqfhtitcmsnrpq (the arkova-staging rig). NEVER against
--   vzwyaatejekddvltxyye (prod). NEVER via `supabase db push --linked`
--   from the repo (which would propagate to prod the next time prod
--   runs db push).
--
-- This file is the canonical record of the helper RPCs the synthetic
-- seed (`scripts/staging/seed.ts`) depends on. It lives in `docs/staging/`
-- (not `supabase/migrations/`) explicitly to keep it out of the prod
-- migration ledger.
--
-- Migration name (for `apply_migration`): staging_only_seed_helpers
--
-- If the rig is rebuilt from scratch:
--   1. Set up the rig per docs/reference/STAGING_RIG.md.
--   2. Replay the prod schema via `supabase db push --linked`.
--   3. Apply this file via Supabase MCP `apply_migration` to the new
--      project_ref. (You can paste it into the MCP query field, or use
--      `supabase db remote query --file docs/staging/staging-only-rpcs.sql`
--      against the linked staging project — NEVER against prod.)
-- =====================================================================

-- staging_seed_auth_users — bulk-insert auth.users rows so the synthetic
-- seed can satisfy the public.profiles.id -> auth.users.id FK.
--
-- Inserts with email_confirmed_at = NULL so the second auth trigger
-- (zz_auth_user_auto_associate_org) becomes a no-op; we then UPDATE
-- profiles to set org_id explicitly via staging_seed_assign_profile_orgs.
CREATE OR REPLACE FUNCTION public.staging_seed_auth_users(p_users jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO auth.users (
    id, email, raw_app_meta_data, raw_user_meta_data,
    aud, role, created_at, updated_at, email_confirmed_at,
    instance_id, is_sso_user, is_anonymous
  )
  SELECT
    (u->>'id')::uuid,
    LOWER(u->>'email'),
    '{"provider":"staging-synthetic"}'::jsonb,
    '{}'::jsonb,
    'authenticated',
    'authenticated',
    now(),
    now(),
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    false,
    false
  FROM jsonb_array_elements(p_users) AS u
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.staging_seed_auth_users(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staging_seed_auth_users(jsonb) TO service_role;

-- staging_seed_assign_profile_orgs — bulk-update profiles.org_id from
-- (id, org_id) pairs. Bypasses the protect_privileged_fields trigger by
-- being a direct UPDATE under service_role + SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.staging_seed_assign_profile_orgs(p_pairs jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  UPDATE profiles p
  SET org_id = (pair->>'org_id')::uuid
  FROM jsonb_array_elements(p_pairs) AS pair
  WHERE p.id = (pair->>'id')::uuid;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.staging_seed_assign_profile_orgs(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staging_seed_assign_profile_orgs(jsonb) TO service_role;

-- staging_purge_synthetic_data — one-shot purge for re-runs. Cascades
-- through synthetic orgs (org_prefix LIKE 'STG%'), purges synthetic
-- public records by source allowlist + nonces, deletes the auth.users
-- rows we created (provider tag 'staging-synthetic').
CREATE OR REPLACE FUNCTION public.staging_purge_synthetic_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_orgs integer;
  v_users integer;
  v_records integer;
BEGIN
  -- Public records aren't FK'd off organizations. Wipe synthetic ones
  -- by their source signature.
  DELETE FROM public_record_embeddings
   WHERE public_record_id IN (
     SELECT id FROM public_records
     WHERE source IN ('sec_iapd','openstates','sam_gov','fbi_npsbn','state_bar','court_records')
   );
  DELETE FROM public_records
   WHERE source IN ('sec_iapd','openstates','sam_gov','fbi_npsbn','state_bar','court_records');
  GET DIAGNOSTICS v_records = ROW_COUNT;

  -- Webhook-nonce tables don't FK off organizations.
  DELETE FROM docusign_webhook_nonces WHERE envelope_id LIKE 'stg-env-%';
  DELETE FROM checkr_webhook_nonces  WHERE report_id LIKE 'stg-rpt-%';

  -- Synthetic orgs cascade-delete almost everything (memberships,
  -- api_keys, integrations, rules, executions, anchors, etc.).
  DELETE FROM organizations
   WHERE org_prefix LIKE 'STG%';
  GET DIAGNOSTICS v_orgs = ROW_COUNT;

  -- auth.users rows we created (the on-delete-cascade from profiles
  -- handles profile cleanup).
  DELETE FROM auth.users
   WHERE raw_app_meta_data->>'provider' = 'staging-synthetic';
  GET DIAGNOSTICS v_users = ROW_COUNT;

  RETURN jsonb_build_object(
    'organizations_deleted', v_orgs,
    'auth_users_deleted', v_users,
    'public_records_deleted', v_records
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.staging_purge_synthetic_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staging_purge_synthetic_data() TO service_role;
