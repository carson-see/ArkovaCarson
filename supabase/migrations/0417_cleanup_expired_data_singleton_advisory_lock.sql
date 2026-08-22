-- BUG-2026-08-22-001 (P1) — `cleanup_expired_data()` deadlocks in PRODUCTION
-- every night, because N Cloud Run instances each run the in-process cron.
--
-- MEASURED, not theorised. `arkova-worker` runs `autoscaling.knative.dev/
-- minScale = 2` (`gcloud run services describe arkova-worker`, 2026-08-22), so
-- two instances are always warm, and `routes/scheduled.ts` registers
-- `cleanup-expired-data` on `0 2 * * *` in every one of them. Cloud Logging for
-- `arkova-worker`, six consecutive nights (2026-08-17 .. 2026-08-22), shows the
-- job starting on TWO distinct `labels.instanceId` values within milliseconds:
--
--     02:00:00.001Z  instance A  "Running GDPR data retention cleanup"
--     02:00:00.020Z  instance B  "Running GDPR data retention cleanup"
--     02:00:02.454Z  instance A  "Data retention cleanup complete"
--     02:00:02.680Z  instance B  "Data retention cleanup RPC failed"
--                                 {"code":"40P01","message":"deadlock detected"}
--
-- On four of those six nights one of the two runs died with SQLSTATE 40P01:
--
--     Process 4149725 waits for AccessExclusiveLock on object 7387929
--       of class 2620 of database 5; blocked by process 4149717.
--     Process 4149717 waits for AccessExclusiveLock on relation 25434
--       of database 5; blocked by process 4149725.
--
-- relation 25434 is `audit_events`; class 2620 is `pg_trigger`. Two callers
-- entering the `DROP TRIGGER` / `DELETE` / `CREATE TRIGGER` section together
-- acquire the table lock and the catalog-object lock in opposite orders. That
-- is a lock-ORDER cycle, and no timeout prevents it — Postgres's deadlock
-- detector breaks the cycle by killing one side.
--
-- WHY `0411` DOES NOT ALREADY FIX THIS
--
-- `0411_bug019_cleanup_expired_data_lock_timeout.sql` (PR #2235) bounds every
-- table-level lock this function takes and wraps the audit purge in a
-- subtransaction — the correct fix for the FIFO *barrier* (BUG-019, the §1.2
-- 2026-08-11 P0 shape). It does not address concurrency, and it cannot:
--
--   * its handler catches `lock_not_available` (55P03). A deadlock raises
--     `deadlock_detected` (40P01), which that handler does not match, so the
--     subtransaction abort propagates and the whole function still dies —
--     discarding the three retention DELETEs that had already succeeded.
--   * `lock_timeout` bounds how long a lock is WAITED for. A deadlock is
--     detected and broken before any timeout is reached, so the bound is never
--     the operative limit.
--
-- Verified on real Postgres 15.18 (throwaway container, isolated port, not the
-- shared local dev stack) with `0411` APPLIED: six synchronized concurrent
-- callers, four rounds — 17 of 24 calls raised 40P01, with the identical
-- `relation` <-> `class 2620` cycle seen in prod. `0411` is necessary and is not
-- sufficient. This migration composes on top of it; it does not replace it.
--
-- WHAT CHANGES
--
--   A transaction-scoped advisory lock at the top of the body. The first caller
--   takes it and does the work; every concurrent caller returns a `skipped`
--   result immediately, having touched nothing. One run per tick, whatever N is.
--
--   `pg_try_advisory_xact_lock(8675309, 2)` — the two-int form, in the Arkova
--   namespace `8675309` already established by
--   `refresh_pipeline_dashboard_cache()` (`scripts/ops/ensure-pipeline-dashboard-cache-cron.ts:593`,
--   which holds `(8675309, 1)`). `2` is claimed here for `cleanup_expired_data`.
--
--   TRANSACTION-scoped (`_xact_`) is load-bearing, and is the reason this is an
--   advisory lock at all rather than the `withRunLease` TTL primitive that
--   `services/worker/src/jobs/run-lease.ts` uses for the anchor jobs. That file
--   REJECTED advisory locks for its path, correctly, and for a reason that does
--   not apply here: it needed the SESSION-scoped `try_advisory_lock` RPC, whose
--   release can land on a different PostgREST pool backend than the acquire and
--   silently no-op, wedging the lock until that connection recycles. A
--   transaction-scoped lock has no release call to misroute — Postgres drops it
--   at COMMIT or ROLLBACK, on whichever backend held it. It cannot stick.
--
--   Placing the guard INSIDE the function rather than in the worker also covers
--   every caller at once: the in-process `node-cron` on N instances, the
--   Cloud Scheduler -> `POST /cron/cleanup-retention` path, and any operator
--   smoke call. A guard in `routes/scheduled.ts` would cover only the first.
--
--   The skip path deliberately does NOT write a `DATA_RETENTION_CLEANUP` audit
--   row. Duplicate rows are the other half of this defect: on the two nights
--   both prod runs succeeded, prod recorded two rows for one purge, and on
--   staging 2026-08-22T02:00Z four revisions recorded four. An audit trail that
--   over-reports how many times retention ran is worse than no row.
--
--   The skip result keeps every key the success result carries, so the route
--   (`POST /cron/cleanup-retention`, which echoes the RPC result verbatim) and
--   any dashboard reading those keys cannot break. Counts are `-1`, the
--   "not measured" sentinel `0411` introduced — not `0`, which would falsely
--   assert an empty purge. `success` stays `true`: a skip is the guard working,
--   not a failure.
--
-- BODY PROVENANCE. Everything below the advisory-lock block is `0411`'s body
-- verbatim. This file therefore yields the correct end state whether it is
-- applied after `0411` (the intended order) or, if #2235 were ever abandoned,
-- on its own. It must NOT be applied BEFORE `0411`, which would be a silent
-- fast-forward of another PR's unlanded work.
--
-- ROLLBACK:
--   Re-apply `0411_bug019_cleanup_expired_data_lock_timeout.sql` verbatim — it
--   is this body with the `pg_try_advisory_xact_lock` block and the two
--   `skipped_concurrent_run` keys removed. Then:
--     NOTIFY pgrst, 'reload schema';
--   Note what rolling back restores: a nightly 40P01 deadlock in production for
--   as long as `arkova-worker` runs more than one instance.

CREATE OR REPLACE FUNCTION "public"."cleanup_expired_data"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "lock_timeout" TO '5s'
    AS $$
DECLARE
  v_webhook_count integer := 0;
  v_verification_count integer := 0;
  v_ai_usage_count integer := 0;
  -- -1 is the "not measured" sentinel, matching the convention the dashboard
  -- cache refreshers already use. It is NOT a count.
  v_audit_count integer := -1;
  v_audit_purge_skipped boolean := true;
  v_got_lock boolean;
BEGIN
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Only service_role can run data cleanup' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Singleton guard. Transaction-scoped: released by Postgres at COMMIT or
  -- ROLLBACK, so it cannot wedge the way a session lock released through a
  -- pooled PostgREST backend can (run-lease.ts's rejection rationale).
  SELECT pg_try_advisory_xact_lock(8675309, 2) INTO v_got_lock;
  IF NOT v_got_lock THEN
    RAISE NOTICE 'cleanup_expired_data: another run holds the singleton lock; skipping. This is the guard working, not an error.';
    RETURN jsonb_build_object(
      'success', true,
      'skipped_concurrent_run', true,
      'webhook_delivery_logs_deleted', -1,
      'verification_events_deleted', -1,
      'ai_usage_events_deleted', -1,
      'audit_events_deleted', -1,
      'audit_events_purge_skipped', true
    );
  END IF;

  DELETE FROM webhook_delivery_logs WHERE created_at < now() - INTERVAL '90 days';
  GET DIAGNOSTICS v_webhook_count = ROW_COUNT;

  DELETE FROM verification_events WHERE created_at < now() - INTERVAL '1 year';
  GET DIAGNOSTICS v_verification_count = ROW_COUNT;

  DELETE FROM ai_usage_events WHERE created_at < now() - INTERVAL '1 year';
  GET DIAGNOSTICS v_ai_usage_count = ROW_COUNT;

  -- The append-only guard on audit_events has to come off to purge, and go back
  -- on before this transaction commits. Both statements take table-level locks,
  -- so both get a bounded wait: fail fast and retry tomorrow, never camp the
  -- queue. On a timeout the subtransaction rolls back, which restores
  -- reject_audit_delete along with the DELETE — the guard is never left off.
  BEGIN
    SET LOCAL lock_timeout = '5s';

    DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events;

    DELETE FROM audit_events
    WHERE created_at < now() - INTERVAL '2 years'
      AND NOT EXISTS (
        SELECT 1 FROM anchors WHERE anchors.id::text = audit_events.target_id AND anchors.legal_hold = true
      );
    GET DIAGNOSTICS v_audit_count = ROW_COUNT;

    CREATE TRIGGER reject_audit_delete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_modification();

    v_audit_purge_skipped := false;
  EXCEPTION
    WHEN lock_not_available THEN
      -- Assignments made before the error survive the rollback; the DELETE they
      -- described does not. Reset both so the result cannot overstate the run.
      v_audit_count := -1;
      v_audit_purge_skipped := true;
      RAISE WARNING 'cleanup_expired_data: audit_events purge skipped, could not take the table lock within 5s (SQLSTATE 55P03). reject_audit_delete is intact; retention on the other tables completed; the purge retries on the next run.';
  END;

  INSERT INTO audit_events (event_type, event_category, actor_id, details)
  VALUES ('DATA_RETENTION_CLEANUP', 'SYSTEM', NULL,
    jsonb_build_object(
      'webhook_delivery_logs_deleted', v_webhook_count,
      'verification_events_deleted', v_verification_count,
      'ai_usage_events_deleted', v_ai_usage_count,
      'audit_events_deleted', v_audit_count,
      'audit_events_purge_skipped', v_audit_purge_skipped,
      'retention_policy', jsonb_build_object('webhook_delivery_logs', '90 days', 'verification_events', '1 year', 'ai_usage_events', '1 year', 'audit_events', '2 years')
    )::text);

  RETURN jsonb_build_object(
    'success', true,
    'skipped_concurrent_run', false,
    'webhook_delivery_logs_deleted', v_webhook_count,
    'verification_events_deleted', v_verification_count,
    'ai_usage_events_deleted', v_ai_usage_count,
    'audit_events_deleted', v_audit_count,
    'audit_events_purge_skipped', v_audit_purge_skipped
  );
END;
$$;

ALTER FUNCTION "public"."cleanup_expired_data"() OWNER TO "postgres";

COMMENT ON FUNCTION "public"."cleanup_expired_data"() IS
  'BUG-2026-08-22-001 + BUG-019: GDPR retention purge, singleton and lock-bounded. pg_try_advisory_xact_lock(8675309, 2) makes concurrent callers a no-op skip instead of a 40P01 deadlock — arkova-worker runs minScale=2 and registers this job in-process on every instance, so two callers hit it every night. Transaction-scoped so it cannot wedge on a pooled PostgREST backend (see services/worker/src/jobs/run-lease.ts for why the session-scoped RPC was rejected). Every table-level lock is additionally bounded by lock_timeout per CLAUDE.md §1.2, and the audit purge runs in its own subtransaction catching lock_not_available (55P03). A skipped run writes NO audit row and reports skipped_concurrent_run=true with -1 sentinels.';

-- Grant hygiene: no-op on a correct database (CREATE OR REPLACE preserves the
-- ACL), asserted anyway. PUBLIC is named explicitly — a revoke naming only
-- anon/authenticated is silently a no-op against a PUBLIC grant (0364).
REVOKE ALL ON FUNCTION public.cleanup_expired_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_data() TO service_role;

NOTIFY pgrst, 'reload schema';
