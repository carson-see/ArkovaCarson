-- BUG-019 (P1, 2026-08 soak) — `cleanup_expired_data()` builds an unbounded
-- lock barrier on `audit_events` on every retention run.
--
-- The baseline body (00000000000000_baseline_at_main_HEAD.sql:1608) does, with
-- no bounded `lock_timeout` anywhere:
--
--     DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events;   -- AccessExclusiveLock
--     DELETE FROM audit_events WHERE created_at < now() - INTERVAL '2 years' ...;
--     CREATE TRIGGER reject_audit_delete BEFORE DELETE ON audit_events ...;  -- ShareRowExclusiveLock
--
-- That is the exact CLAUDE.md §1.2 shape that caused the 2026-08-11 production
-- P0. Postgres lock queues are FIFO: an unbounded request that blocks on a long
-- reader becomes a barrier in front of EVERY later lock request — including
-- PostgREST's schema-cache introspection, whose lock mode was compatible with
-- what was actually running. On 2026-08-11 one `ALTER TABLE` did that and
-- `/api/v1/verify` served `service_unavailable` for 11m39s.
--
-- `audit_events` is a worse place for it than most. Every write path in the
-- system appends an audit row, so an `AccessExclusiveLock` request on it queues
-- in front of ordinary application traffic, not just DDL. And this is not a
-- one-shot migration statement under operator supervision — it is a
-- SECURITY DEFINER function invoked from `POST /cron/cleanup-retention` on a
-- daily clock, so the barrier is re-armed every single day, unwatched.
--
-- It survived the `scripts/ci/check-hot-table-ddl-lock-timeout.ts` ratchet added
-- after the P0 because that linter read a migration as a flat statement list and
-- never looked inside a stored routine body. That gap is closed in the same PR
-- (`RUNTIME_DDL_TABLES` + the `function-body` context), so this class cannot
-- return silently.
--
-- WHAT CHANGES
--
--   1. `SET lock_timeout TO '5s'` on the routine itself. Defense in depth: a
--      future editor who removes the in-body `SET LOCAL` still cannot ship an
--      unbounded barrier. It also bounds the three retention DELETEs. Those take
--      only `RowExclusiveLock` and cannot form the PostgREST barrier, so this is
--      not the fix — but a purge of rows older than 90 days / 1 year has no
--      legitimate reason to wait more than 5s on anything, and the cron retries
--      tomorrow. Behaviour change is limited to "abort and retry" replacing
--      "wait indefinitely".
--
--   2. `SET LOCAL lock_timeout = '5s'` immediately before the DDL pair, which is
--      the literal form §1.2 names, inside the same subtransaction as the DDL.
--
--   3. The audit purge moves into its own `BEGIN ... EXCEPTION` block catching
--      `lock_not_available` (SQLSTATE 55P03). This matters for correctness, not
--      just tidiness: without it a timeout on `DROP TRIGGER` aborts the whole
--      function and throws away the three retention DELETEs that already
--      succeeded, and the cron 500s. With it, the subtransaction rolls back —
--      which also restores `reject_audit_delete`, so the append-only guard on
--      `audit_events` is never left dropped — the other three tables keep their
--      cleanup, and the run reports the skip instead of failing.
--
--      PL/pgSQL variable assignments are NOT rolled back with the
--      subtransaction, so `v_audit_count` / `v_audit_purge_skipped` are reset
--      explicitly in the handler: a `ROW_COUNT` captured before a failing
--      `CREATE TRIGGER` describes a DELETE that no longer happened.
--
--   4. Two additive keys in the returned jsonb, `audit_events_purge_skipped` and
--      the `-1` sentinel convention on `audit_events_deleted`, so a skipped
--      purge is distinguishable from "there was nothing to purge". The route
--      (`POST /cron/cleanup-retention`) echoes the RPC result verbatim, so no
--      caller change is required and no existing key changes meaning.
--
-- Grants are re-asserted rather than assumed. `CREATE OR REPLACE` preserves the
-- existing ACL, so this is a no-op on a correct database — but it is cheap, and
-- `PUBLIC` is named explicitly per the 0364 no-op-revoke catch.
--
-- Applied NOWHERE by this PR: the 2026-08 full soak freeze is in effect until
-- 2026-08-19T15:51:30Z. This file ships for post-window application by the RTE.
--
-- ROLLBACK:
--   Restore the baseline definition verbatim from
--   00000000000000_baseline_at_main_HEAD.sql:1608-1660 — i.e. the same body with
--   NO `SET lock_timeout` clause on the routine, NO `SET LOCAL lock_timeout`
--   before the DDL, the audit purge inline rather than in a subtransaction, and
--   the returned jsonb carrying only:
--     success, webhook_delivery_logs_deleted, verification_events_deleted,
--     ai_usage_events_deleted, audit_events_deleted
--   then:
--     NOTIFY pgrst, 'reload schema';
--   Note what rolling back restores: an unbounded `AccessExclusiveLock` request
--   on `audit_events`, once per day, forever.

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
BEGIN
  IF auth.role() != 'service_role' THEN
    RAISE EXCEPTION 'Only service_role can run data cleanup' USING ERRCODE = 'insufficient_privilege';
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
  'BUG-019: GDPR retention purge. Every table-level lock it takes is bounded by lock_timeout (5s on the routine plus an explicit SET LOCAL before the audit_events DDL pair) so it can never become a FIFO barrier in front of PostgREST schema-cache introspection — the 2026-08-11 P0 mechanism, CLAUDE.md §1.2. The audit purge runs in its own subtransaction catching lock_not_available (55P03): on a timeout the rollback restores reject_audit_delete, the other retention DELETEs are kept, and the result reports audit_events_purge_skipped=true with audit_events_deleted=-1 (sentinel, not a count).';

-- Grant hygiene: no-op on a correct database (CREATE OR REPLACE preserves the
-- ACL), asserted anyway. PUBLIC is named explicitly — a revoke naming only
-- anon/authenticated is silently a no-op against a PUBLIC grant (0364).
REVOKE ALL ON FUNCTION public.cleanup_expired_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_data() TO service_role;

NOTIFY pgrst, 'reload schema';
