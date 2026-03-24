-- Migration: 0104_advisory_lock_rpc.sql
-- Description: Create wrapper RPCs for pg_try_advisory_lock/pg_advisory_unlock.
-- Built-in PG functions don't expose named parameters through PostgREST,
-- causing db.rpc('pg_try_advisory_lock', {key: N}) to fail silently.
-- These wrappers have explicit named params that PostgREST can route.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS try_advisory_lock(bigint);
--           DROP FUNCTION IF EXISTS release_advisory_lock(bigint);

CREATE OR REPLACE FUNCTION try_advisory_lock(lock_id bigint)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_try_advisory_lock(lock_id);
$$;

CREATE OR REPLACE FUNCTION release_advisory_lock(lock_id bigint)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_advisory_unlock(lock_id);
$$;

-- Grant execute to authenticated and service_role (worker uses service_role)
GRANT EXECUTE ON FUNCTION try_advisory_lock(bigint) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION release_advisory_lock(bigint) TO authenticated, service_role;
