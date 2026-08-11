-- 0409 — `public.get_lock_waits()`: read-only lock-wait observability for the worker.
--
-- WHY THIS EXISTS (2026-08-11 P0, HANDOFF.md):
--   Two long census SELECTs held AccessShareLock on public.organizations for
--   ~50 minutes. An unguarded `ALTER TABLE public.organizations` requested
--   AccessExclusiveLock and queued behind them. Postgres lock queues are FIFO,
--   so every later lock request queued behind that ALTER -- including
--   PostgREST's schema-cache introspection, whose AccessShareLock was
--   perfectly compatible with the running reads. Introspection hit its ~10s
--   lock_timeout, PostgREST entered a PGRST002 loop, and /api/v1/verify served
--   service_unavailable for 11m39s.
--
--   The barrier formed at ~16:35Z; user impact began at 16:40:11Z. Nothing in
--   this system could see the gap, because pg_locks / pg_stat_activity are not
--   reachable through PostgREST. This function makes that 5-minute window
--   observable to the worker, which logs it for the Cloud Monitoring alarm
--   `PAGE - Postgres lock wait > 60s on a public relation`.
--
-- WHY SECURITY DEFINER: pg_stat_activity redacts other sessions' rows for
--   non-privileged roles, so `service_role` alone cannot see how long another
--   backend has been waiting. Running as owner lifts that. `SET search_path =
--   public` per CLAUDE.md §1.4.
--
-- WHY NO QUERY TEXT IS RETURNED: the blocked/blocking statements can contain
--   user data. This function deliberately exposes NO `pg_stat_activity.query`
--   -- only pids, relation, lock mode and durations. An operator who needs the
--   statement text queries Postgres directly with their own credentials; the
--   worker (which ships its output to Cloud Logging and Sentry) never sees it.
--   This keeps the alarm path clear of CLAUDE.md §1.4 / §1.6 exposure.
--
-- READ-ONLY. Takes no lock beyond the catalog reads pg_locks already implies,
-- so it cannot itself contribute to the barrier it detects.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.get_lock_waits(integer);

CREATE OR REPLACE FUNCTION public.get_lock_waits(p_min_wait_seconds integer DEFAULT 60)
RETURNS TABLE (
  relation text,
  lock_mode text,
  wait_seconds bigint,
  blocked_pid integer,
  blocking_pids integer[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.relname::text                                              AS relation,
    l.mode::text                                                 AS lock_mode,
    EXTRACT(epoch FROM (now() - a.query_start))::bigint          AS wait_seconds,
    a.pid                                                        AS blocked_pid,
    pg_blocking_pids(a.pid)                                      AS blocking_pids
  FROM pg_locks l
  JOIN pg_class c      ON c.oid = l.relation
  JOIN pg_namespace n  ON n.oid = c.relnamespace
  JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.granted IS FALSE
    AND l.locktype = 'relation'
    AND n.nspname = 'public'
    AND a.pid <> pg_backend_pid()
    AND a.query_start IS NOT NULL
    -- `now() - query_start` is the age of the blocked STATEMENT, which is an
    -- upper bound on how long it has been waiting for this particular lock.
    -- For a statement that blocks immediately -- which is what a queued DDL
    -- request does -- the two are the same to within milliseconds.
    AND now() - a.query_start > make_interval(secs => GREATEST(p_min_wait_seconds, 0))
  ORDER BY wait_seconds DESC
  LIMIT 50;
$$;

COMMENT ON FUNCTION public.get_lock_waits(integer) IS
  'Read-only lock-wait observability for the worker lock-wait monitor. Returns ungranted relation locks on public tables older than p_min_wait_seconds. Returns no query text by design. Added after the 2026-08-11 FIFO lock-barrier P0.';

-- Least privilege: the worker's service_role only. This exposes backend pids
-- and lock state, which is operational metadata, not tenant data -- but there
-- is no caller-facing use for it, so nobody else gets EXECUTE.
REVOKE ALL ON FUNCTION public.get_lock_waits(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_lock_waits(integer) TO service_role;
