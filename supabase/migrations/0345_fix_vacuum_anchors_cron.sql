-- 0345_fix_vacuum_anchors_cron.sql
-- BUG-2026-06-24-001 (PROD silent failure): pg_cron job jobid=2 `vacuum-anchors`
-- (schedule `3 * * * *`) has failed EVERY hour for 24h+ with
--   ERROR: VACUUM cannot run inside a transaction block
-- because its command was MULTI-statement:
--   SET statement_timeout = 0; SET maintenance_work_mem = '1GB'; VACUUM (ANALYZE) public.anchors;
-- pg_cron wraps a multi-statement command body in a transaction, and VACUUM
-- cannot run inside a transaction → the job never ran. `public.anchors` (the
-- largest table, ~3M SECURED rows) has therefore had NO scheduled VACUUM/ANALYZE
-- since the job was created — only autovacuum has been keeping it alive.
--
-- FIX: pg_cron runs a SINGLE top-level VACUUM statement OUTSIDE a transaction.
-- It is the `SET …; SET …;` prefixes that force the implicit transaction, so we:
--   1. Reduce the job command to the single statement `VACUUM (ANALYZE) public.anchors`
--      (single top-level VACUUM → pg_cron runs it non-transactionally → succeeds).
--   2. Preserve the two GUCs WITHOUT inlining them into the command, by setting
--      them on the role that runs the job (jobid=2 username = `postgres`, verified
--      on prod 2026-06-24 via `SELECT username FROM cron.job WHERE jobid=2`). A
--      role-level GUC applies to every session that role opens — including the
--      pg_cron background-worker session — so the VACUUM still runs to completion
--      with `statement_timeout = 0` and `maintenance_work_mem = '1GB'`, while the
--      command body stays a single statement and runs non-transactionally.
--
-- `postgres` is the dedicated maintenance/superuser role pg_cron already uses for
-- this job; scoping these maintenance GUCs to it (not to the app roles
-- authenticated/anon/service_role) is the narrow, correct placement —
-- `statement_timeout = 0` here only ever lifts the timeout for postgres-role
-- maintenance sessions, never for application query paths.
--
-- This migration is itself transaction-safe: ALTER ROLE and cron.alter_job are
-- both valid inside a transaction (only VACUUM is not — which is exactly the bug
-- we are removing from the job command). Hence BEGIN/COMMIT below is fine.
--
-- ROLLBACK:
--   ALTER ROLE postgres RESET statement_timeout;
--   ALTER ROLE postgres RESET maintenance_work_mem;
--   SELECT cron.alter_job(
--     job_id  => 2,
--     command => $rollback$SET statement_timeout = 0; SET maintenance_work_mem = '1GB'; VACUUM (ANALYZE) public.anchors;$rollback$
--   );
--   -- (restores the prior multi-statement command — note this reinstates the
--   --  failing state; rollback is provided for completeness, not because the
--   --  prior state is desirable.)

BEGIN;

-- 1. Preserve the maintenance GUCs at the role level so the cron session inherits
--    them. ALTER ROLE … SET is idempotent (re-running just re-sets the same value).
ALTER ROLE postgres SET statement_timeout = '0';
ALTER ROLE postgres SET maintenance_work_mem = '1GB';

-- 2. Reduce the job command to a single top-level VACUUM so pg_cron runs it
--    OUTSIDE a transaction. Guarded: only touch jobid=2 when it is the known
--    `vacuum-anchors` job, so a re-run (or a prod whose job was already fixed) is
--    a safe no-op and we never repoint some other job that happens to be id 2.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobid = 2 AND jobname = 'vacuum-anchors'
  ) THEN
    PERFORM cron.alter_job(
      job_id  => 2,
      command => 'VACUUM (ANALYZE) public.anchors'
    );
  END IF;
END
$$;

COMMIT;
