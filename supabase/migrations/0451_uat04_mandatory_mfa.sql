-- UAT-04: email verification, then MFA, before any human product authority.
-- Hosted rollout must also enable the custom access-token hook in Auth config.
-- Existing AAL1 JWTs are denied immediately by the PostgREST pre-request hook
-- and restrictive RLS policies; no token refresh is required for containment.
-- ROLLBACK: run the complete block at the bottom. It restores the email-only
-- token hook from 0436; disabling that hook would let existing unconfirmed
-- OAuth accounts refresh into authenticated. Keep worker/edge AAL2 checks
-- until legacy AAL1 JWTs expire.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arkova_mfa_pending') THEN
    CREATE ROLE arkova_mfa_pending NOLOGIN NOINHERIT;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'arkova_mfa_pending'
      AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolinherit OR rolcreaterole
        OR rolcreatedb OR rolreplication)
  ) THEN
    RAISE EXCEPTION 'MFA-pending role has elevated attributes';
  END IF;
END
$$;

-- Deliberately do not grant this role to authenticator. A refreshed AAL1 JWT
-- fails before PostgREST can assume a database role, while GoTrue's MFA
-- enroll/challenge/verify endpoints remain available to complete the gate.
REVOKE arkova_mfa_pending FROM authenticator;

CREATE OR REPLACE FUNCTION private.is_human_mfa_verified()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal' = 'aal2',
    false
  )
$$;
REVOKE ALL ON FUNCTION private.is_human_mfa_verified() FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_human_mfa_verified() TO authenticated;

-- Preserve any already-configured PostgREST pre-request function. Its resolved
-- fully-qualified call is stored in a read-only private table and invoked after
-- the MFA check so an old AAL1 token cannot reach a legacy hook with side effects.
CREATE TABLE private.mfa_pre_request_chain (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  previous_call text
);
INSERT INTO private.mfa_pre_request_chain(singleton, previous_call)
VALUES (true, NULL);
REVOKE ALL ON private.mfa_pre_request_chain FROM PUBLIC, anon, authenticated;
GRANT SELECT ON private.mfa_pre_request_chain TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.enforce_human_mfa_pre_request()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_previous text;
  v_claims jsonb := COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
BEGIN
  SELECT previous_call INTO v_previous
  FROM private.mfa_pre_request_chain
  WHERE singleton;

  IF v_claims ->> 'role' IN ('authenticated', 'arkova_mfa_pending')
     AND v_claims ->> 'aal' IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MFA verification required';
  END IF;

  IF v_previous IS NOT NULL AND v_previous <> '' THEN
    EXECUTE format('SELECT %s', v_previous);
  END IF;
END
$$;
REVOKE ALL ON FUNCTION private.enforce_human_mfa_pre_request() FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.enforce_human_mfa_pre_request() TO anon, authenticated, service_role;

DO $$
DECLARE
  v_setting text;
  v_previous text;
  v_previous_proc regprocedure;
  v_previous_call text;
BEGIN
  SELECT config INTO v_setting
  FROM unnest(COALESCE(
    (SELECT rolconfig FROM pg_roles WHERE rolname = 'authenticator'),
    ARRAY[]::text[]
  )) AS config
  WHERE config LIKE 'pgrst.db_pre_request=%'
  LIMIT 1;

  v_previous := NULLIF(split_part(COALESCE(v_setting, ''), '=', 2), '');
  IF v_previous IS NOT NULL
     AND v_previous <> 'private.enforce_human_mfa_pre_request' THEN
    v_previous_proc := to_regprocedure(v_previous || '()');
    IF v_previous_proc IS NULL THEN
      RAISE EXCEPTION 'Configured pgrst.db_pre_request function % does not resolve', v_previous;
    END IF;
    SELECT format('%I.%I()', n.nspname, p.proname)
    INTO v_previous_call
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.oid = v_previous_proc::oid;
    UPDATE private.mfa_pre_request_chain
    SET previous_call = v_previous_call
    WHERE singleton;
  ELSE
    UPDATE private.mfa_pre_request_chain
    SET previous_call = NULL
    WHERE singleton;
  END IF;

  ALTER ROLE authenticator
    SET pgrst.db_pre_request = 'private.enforce_human_mfa_pre_request';
END
$$;

-- Apply an additional restrictive AAL2 predicate to every RLS-protected public
-- table and storage.objects. Existing ownership/tenant policies remain in
-- force; this policy grants no new access.
DO $$
DECLARE
  v_table record;
BEGIN
  FOR v_table IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND c.relrowsecurity
      AND (n.nspname = 'public' OR (n.nspname = 'storage' AND c.relname = 'objects'))
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      'mfa_verified_authenticated', v_table.schema_name, v_table.table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated USING (private.is_human_mfa_verified()) WITH CHECK (private.is_human_mfa_verified())',
      'mfa_verified_authenticated', v_table.schema_name, v_table.table_name
    );
  END LOOP;
END
$$;

-- Compose the existing mailbox-confirmation hook. Email proof has precedence;
-- once it clears, AAL1 receives a role with no product grants and AAL2
-- explicitly regains authenticated so the pending role cannot become sticky.
CREATE OR REPLACE FUNCTION private.oauth_email_confirmation_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claims jsonb := event -> 'claims';
  v_role text := event -> 'claims' ->> 'role';
BEGIN
  IF private.requires_oauth_email_confirmation((event ->> 'user_id')::uuid) THEN
    v_claims := jsonb_set(v_claims, '{role}', '"arkova_email_pending"'::jsonb);
  ELSIF v_role IN ('authenticated', 'arkova_email_pending', 'arkova_mfa_pending') THEN
    IF v_claims ->> 'aal' = 'aal2' THEN
      v_claims := jsonb_set(v_claims, '{role}', '"authenticated"'::jsonb);
    ELSE
      v_claims := jsonb_set(v_claims, '{role}', '"arkova_mfa_pending"'::jsonb);
    END IF;
  END IF;
  RETURN jsonb_build_object('claims', v_claims);
END
$$;
REVOKE ALL ON FUNCTION private.oauth_email_confirmation_token_hook(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION private.oauth_email_confirmation_token_hook(jsonb)
  TO supabase_auth_admin;

NOTIFY pgrst, 'reload config';
NOTIFY pgrst, 'reload schema';
COMMIT;

-- ROLLBACK (execute separately, do not include with the forward migration):
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
-- UPDATE private.oauth_email_confirmation_policy
-- SET enabled_at = NULL WHERE singleton; -- stop only NEW OAuth enrollment
-- CREATE OR REPLACE FUNCTION private.oauth_email_confirmation_token_hook(event jsonb)
-- RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $rollback$
-- BEGIN
--   IF private.requires_oauth_email_confirmation((event->>'user_id')::uuid) THEN
--     RETURN jsonb_build_object('claims',jsonb_set(event->'claims','{role}','"arkova_email_pending"'::jsonb));
--   END IF;
--   RETURN event;
-- END $rollback$;
-- DO $rollback$
-- DECLARE v_previous_call text;
-- BEGIN
--   SELECT previous_call INTO v_previous_call FROM private.mfa_pre_request_chain WHERE singleton;
--   IF v_previous_call IS NULL THEN
--     ALTER ROLE authenticator RESET pgrst.db_pre_request;
--   ELSE
--     EXECUTE format('ALTER ROLE authenticator SET pgrst.db_pre_request = %L',
--       regexp_replace(v_previous_call, '\(\)$', ''));
--   END IF;
-- END $rollback$;
-- DO $rollback$
-- DECLARE v_table record;
-- BEGIN
--   FOR v_table IN SELECT n.nspname, c.relname FROM pg_class c
--     JOIN pg_namespace n ON n.oid=c.relnamespace
--     WHERE c.relkind IN ('r','p')
--       AND (n.nspname='public' OR (n.nspname='storage' AND c.relname='objects'))
--   LOOP
--     EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
--       'mfa_verified_authenticated',v_table.nspname,v_table.relname);
--   END LOOP;
-- END $rollback$;
-- DROP FUNCTION private.enforce_human_mfa_pre_request();
-- DROP FUNCTION private.is_human_mfa_verified();
-- DROP TABLE private.mfa_pre_request_chain;
-- NOTIFY pgrst, 'reload config';
-- NOTIFY pgrst, 'reload schema';
-- COMMIT;
-- Keep arkova_mfa_pending until every JWT carrying it has expired.
