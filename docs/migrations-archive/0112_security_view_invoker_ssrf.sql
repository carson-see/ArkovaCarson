-- SEC-009: Ensure all views accessing RLS-protected tables use SECURITY INVOKER
-- SEC-010: Revoke HTTP extension functions from anon/authenticated to prevent SSRF
--
-- ROLLBACK:
--   -- SEC-010: Re-grant HTTP functions if needed
--   GRANT EXECUTE ON FUNCTION http_get(text) TO authenticated;
--   GRANT EXECUTE ON FUNCTION http_post(text, text) TO authenticated;
--   -- SEC-009: Views would need to be recreated without security_invoker

-- ============================================================================
-- SEC-009: View SECURITY INVOKER audit
-- ============================================================================
-- Postgres 15+ supports security_invoker on views. Views without it that access
-- RLS-protected tables bypass RLS because they run as the view owner (typically superuser).
--
-- We recreate any public views with security_invoker = true.

DO $$
DECLARE
  v_name text;
  v_def text;
BEGIN
  FOR v_name, v_def IN
    SELECT viewname, definition
    FROM pg_views
    WHERE schemaname = 'public'
  LOOP
    -- Recreate view with security_invoker
    EXECUTE format(
      'CREATE OR REPLACE VIEW public.%I WITH (security_invoker = true) AS %s',
      v_name, v_def
    );
    RAISE NOTICE 'SEC-009: Set security_invoker on view: %', v_name;
  END LOOP;
END $$;

-- ============================================================================
-- SEC-010: SSRF prevention — revoke HTTP extension functions
-- ============================================================================
-- The http extension (http_get, http_post, etc.) allows database-level HTTP requests.
-- If accessible to anon or authenticated roles, attackers could use the database
-- as an SSRF proxy to hit internal services.

-- Revoke from anon and authenticated (ignore errors if functions don't exist)
DO $$
BEGIN
  -- http_get variants
  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION http_get(text) FROM anon, authenticated';
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION http_get(text, jsonb) FROM anon, authenticated';
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  -- http_post variants
  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION http_post(text, text) FROM anon, authenticated';
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION http_post(text, text, text) FROM anon, authenticated';
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  -- http_put
  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION http_put(text, text, text) FROM anon, authenticated';
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  -- http_delete
  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION http_delete(text) FROM anon, authenticated';
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  -- http_head
  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION http_head(text) FROM anon, authenticated';
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  -- Generic http() function
  BEGIN
    EXECUTE 'REVOKE ALL ON FUNCTION http(http_request) FROM anon, authenticated';
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  RAISE NOTICE 'SEC-010: HTTP extension functions revoked from anon/authenticated';
END $$;
