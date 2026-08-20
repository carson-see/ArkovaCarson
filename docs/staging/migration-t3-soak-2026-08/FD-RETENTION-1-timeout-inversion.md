# FD-RETENTION-1 — 0411 lock_timeout/statement_timeout race inversion

**Date:** 2026-08-20
**Finding source:** migration-T3 soak on `fizyjojbebyalirtjjht` (`arkova-staging-2026-08`), documented in `docs/staging/migration-t3-soak-2026-08/soak-start-2026-08-20.md`, "Real finding: BUG-019's lock-contention fix does not achieve graceful degradation under this rig's role config."
**Migration under investigation:** `supabase/migrations/0411_bug019_cleanup_expired_data_lock_timeout.sql` (PR #2235, branch `fix/data-integrity-soak-cluster`, merged into `rc/migration-t3-wave-2026-08` at `5ff29d186` — read-only, not modified by this diagnosis)
**Investigator:** Claude Opus 5, diagnosis-only session (isolated worktree)

## Verdict

**Not prod-affecting under production's current ambient configuration.** This is a real code defect, but the specific failure the soak observed — HTTP 500 at ~8.2s with SQLSTATE `57014` instead of the designed HTTP 200 skip at ~5s — cannot currently occur in production, because production's `authenticator` role carries a `statement_timeout` of 60s (30s `lock_timeout`), a 55-second margin over the function's own 5s `lock_timeout`. The rig's `authenticator` role carries `statement_timeout=8s` / `lock_timeout=8s` — a near-zero margin over the function's 5s `lock_timeout` — which is what inverts the race there.

Evidence (read-only `pg_roles` query, both projects, 2026-08-20):

| Role | Rig `fizyjojbebyalirtjjht` (`arkova-staging-2026-08`) | Prod `vzwyaatejekddvltxyye` |
|---|---|---|
| `authenticator` | `statement_timeout=8s`, `lock_timeout=8s` | `statement_timeout=60s`, `lock_timeout=30s` |
| `authenticated` | `statement_timeout=8s` | `statement_timeout=30s` |
| `anon` | `statement_timeout=3s` | `statement_timeout=3s` |
| `service_role` | `rolconfig` is `NULL` (no override) | `rolconfig` is `NULL` (no override) |
| `postgres` (MCP session role) | `statement_timeout=0` | `statement_timeout=0` |

No database-level (`pg_db_role_setting`, role-independent) override of either timeout exists on either project — only `app.settings.jwt_exp` / `search_path`. Confirmed both ways: `pg_roles.rolconfig` and `pg_db_role_setting` agree.

`service_role`'s `rolconfig` is `NULL` on both projects, which matters here: PostgREST/Supabase's connection architecture logs in as `authenticator` and does `SET LOCAL ROLE service_role` per request for RLS/privilege purposes — it does **not** re-establish a new session as `service_role`. Per-role `ALTER ROLE ... SET` settings apply at session start for the actual login role, not on `SET ROLE`. So the GUCs that govern this call are `authenticator`'s, not `service_role`'s, on both rig and prod — confirmed by the table above, not assumed.

The call path is `services/worker/src/routes/cron.ts` `POST /cleanup-retention` (also invoked in-process by `scheduleInProcess('cleanup-expired-data', '0 2 * * *', ...)` in `services/worker/src/routes/scheduled.ts:232`, and by an external Cloud Scheduler job `cleanup-retention` at `30 5 * * *` UTC with retry policy `30s,120s,2` per `scripts/gcp-setup/cloud-scheduler.test.ts:225`) — all go through `callRpc(db, 'cleanup_expired_data')`, i.e. `SupabaseClient.rpc()`, i.e. PostgREST, i.e. the `authenticator` connection above. There is no alternate direct-`pg`-connection path for this call.

## 1. What `0411`'s `SET LOCAL lock_timeout` actually covers

Read `origin/rc/migration-t3-wave-2026-08:supabase/migrations/0411_bug019_cleanup_expired_data_lock_timeout.sql` directly (branch not modified). The function body:

```sql
CREATE OR REPLACE FUNCTION "public"."cleanup_expired_data"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "lock_timeout" TO '5s'          -- routine-level, applies function-wide
    AS $$
DECLARE
  ...
BEGIN
  ...
  DELETE FROM webhook_delivery_logs ...;   -- RowExclusiveLock, no contention risk
  DELETE FROM verification_events ...;     -- same
  DELETE FROM ai_usage_events ...;         -- same

  BEGIN                                     -- implicit subtransaction (SAVEPOINT)
    SET LOCAL lock_timeout = '5s';           -- re-asserted, same subtransaction
    DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events;   -- AccessExclusiveLock wait
    DELETE FROM audit_events WHERE ...;
    CREATE TRIGGER reject_audit_delete ...;   -- ShareRowExclusiveLock wait
    v_audit_purge_skipped := false;
  EXCEPTION
    WHEN lock_not_available THEN              -- SQLSTATE 55P03
      v_audit_count := -1;
      v_audit_purge_skipped := true;
      RAISE WARNING ...;
  END;
  ...
END;
$$;
```

**Scope check: correct.** `SET LOCAL lock_timeout = '5s'` is the first statement inside the `BEGIN...EXCEPTION` block, ahead of `DROP TRIGGER`, the guarded `DELETE`, and `CREATE TRIGGER` — all three DDL/DML statements that can block on `audit_events`'s locks are inside that scope. `lock_timeout` genuinely bounds all three lock acquisitions to 5s each.

**Exception-class check: correct in isolation.** `EXCEPTION WHEN lock_not_available` targets SQLSTATE `55P03`, which is precisely the code Postgres raises when a statement's wait for a lock exceeds `lock_timeout`. That is the right condition name for what `lock_timeout` produces — the handler is not miswired.

**The actual bug: the function never touches `statement_timeout`.** `statement_timeout` bounds the entire top-level statement — the whole `SELECT cleanup_expired_data()` RPC call, from the moment PostgREST's query arrives, including every nested statement the PL/pgSQL body executes — not just this function's post-entry work. `0411` sets `lock_timeout` twice (routine-level and via `SET LOCAL`) but sets `statement_timeout` nowhere. So the ambient `statement_timeout` inherited from whatever role logged in (`authenticator`, per above) keeps ticking, uncoordinated with the function's own `lock_timeout`. Two independent alarms are racing:

- `lock_timeout=5s`, armed from the moment the `DROP TRIGGER` wait begins.
- ambient `statement_timeout`, armed from the moment the top-level RPC call began (function entry, effectively t≈0, since `cleanup_expired_data()` has essentially no work before it reaches the audit block).

Whichever deadline is reached first wins and determines the SQLSTATE the caller sees. On the rig, ambient `statement_timeout=8s` is barely 3 seconds later than the 5s `lock_timeout` deadline — leaving no real margin once any prior processing time is counted, and the soak's own reproduction (`57014` at `8.26s`, twice) shows `statement_timeout` won. On prod, ambient `statement_timeout=60s` gives `lock_timeout=5s` a 55-second head start; `lock_timeout` will reach its own deadline and abort the wait (`55P03`, caught) long before `statement_timeout`'s 60s budget could possibly be exhausted by a bounded 5-second-max lock wait.

This is why the migration's design is only *accidentally* correct in prod today — it depends on prod's ambient `statement_timeout` staying comfortably above the function's `lock_timeout`, a relationship the function does nothing to enforce or even assert.

## 2. Why the rig's ambient config differs — provisioning gap, not a deliberate stress test

`arkova-staging-2026-08` (`fizyjojbebyalirtjjht`) was created 2026-08-19, one day before this soak. Its `authenticator` carries `statement_timeout=8s` / `lock_timeout=8s`; prod's `authenticator` carries `statement_timeout=60s` / `lock_timeout=30s`, and `authenticated`'s `statement_timeout` differs the same way (8s rig vs 30s prod). No script in this repo (`scripts/ops/`, `scripts/gcp-setup/`, `docs/reference/STAGING_RIG.md`) sets these values — they were never found tuned anywhere in-tree. The most plausible read is that `8s`/`8s` is Supabase's platform default for a freshly provisioned project's API roles, and this rig's ambient GUCs were never widened to mirror prod's hand-tuned values the way the rest of the rig's config was brought into line (per `docs/staging/agents.md`'s standing note that isolated rigs are a known source of config drift from prod — e.g. `project_isolated_rig_deploy_env`, `project_staging_worker_secret_drift`). Nothing in the migration-T3 premortem documents an intentional decision to tighten the rig's ambient timeouts for stress-testing; it reads as an unaddressed provisioning gap, not a deliberate adversarial setting.

## 3. The exact fix

Add an explicit `statement_timeout` override with real margin above the 5s `lock_timeout`, at both the routine level and immediately before the guarded DDL (mirroring the existing `lock_timeout` pattern exactly, for the same "defense in depth" reason `0411`'s own comment gives for setting `lock_timeout` twice):

```sql
CREATE OR REPLACE FUNCTION "public"."cleanup_expired_data"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    SET "lock_timeout" TO '5s'
    SET "statement_timeout" TO '15s'        -- NEW: floor, always >> lock_timeout
    AS $$
...
  BEGIN
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '15s';    -- NEW: re-asserted before the DDL pair
    DROP TRIGGER IF EXISTS reject_audit_delete ON audit_events;
    ...
```

`SET`/`SET LOCAL statement_timeout` inside a function is the same mechanism `0411` already trusts for `lock_timeout` (Postgres re-arms the timeout alarm from the GUC's assign hook the moment the value changes, exactly like the existing `SET LOCAL lock_timeout` pattern this file already relies on) — so this guarantees `lock_timeout=5s` always wins the race regardless of the calling role's ambient `statement_timeout`, in any environment, present or future. 15s is a generous but arbitrary choice (3x the lock_timeout); any value with real margin above 5s (e.g. 10s+) works. This must ship as a **new compensating migration**, not an edit to `0411` — CLAUDE.md §4/"Common Mistakes" forbids modifying an existing migration file, and `0411` is already merged into `rc/migration-t3-wave-2026-08`.

I did not apply this anywhere and did not touch `0411`, `rc/migration-t3-wave-2026-08`, or PR #2235's branch. Whether to ship this fix before readying #2235, ship #2235 as-is with a documented residual-risk note, or land the fix as a follow-up migration is the CTO's call.

## 4. Blast radius if shipped unfixed

**In an environment with a tight ambient `statement_timeout` (like the current rig):** under real lock contention on `audit_events`, the RPC call throws an uncaught `57014` instead of the caught `55P03`. Because all four retention `DELETE`s (webhook logs, verification events, AI usage events, audit events) execute inside one top-level statement, an uncaught exception anywhere in it — even one thrown deep inside the audit-purge subtransaction — aborts the **entire transaction**, not just the audit purge. Confirmed by the soak: **no `DATA_RETENTION_CLEANUP` audit row was written** for either failed run, meaning the three otherwise-successful deletes were rolled back too, on top of the audit purge that was already designed to skip. `POST /cleanup-retention` (`services/worker/src/routes/cron.ts:1921`) returns a bare `500 {"error":"Processing failed"}` with no `withCronMonitoring`/Sentry wrapper on this route (unlike most other cron routes in the same file) — so nothing pages on this failure today, independent of `0411`. The in-process `scheduleInProcess` cron (2:00 AM UTC) just logs and exits; the external Cloud Scheduler job (5:30 AM UTC) retries twice (`30s,120s,2` backoff) — if the competing lock is still held at all three attempts, the whole day's retention run is skipped and retried the next day. **No security or data-integrity regression in any case**: the soak confirmed `reject_audit_delete` survives intact — the `DROP TRIGGER` never actually completes when the wait is cancelled, so the append-only guard is never actually left off, in either the designed-skip path or the hard-fail path.

**In production, under its current ambient config:** the function should behave as designed — `lock_timeout` wins the race, the handler catches `55P03`, the subtransaction rolls back cleanly, the other three deletes commit, and the RPC returns `200` with `audit_events_purge_skipped: true`. The core P0-prevention goal of `0411` (bounding the `audit_events` lock wait so it can never re-form the 2026-08-11 FIFO-barrier mechanism) holds in **both** outcomes, rig and prod — in neither case does the wait become unbounded; the only thing that changes is whether the *other* three tables' cleanup survives the failure. The residual risk in prod is latent, not active: it would only become live if prod's `authenticator.statement_timeout` were ever tightened toward the low double digits (a plausible future hardening change, given the trend of Arkova narrowing timeouts elsewhere), or if a future change added meaningful processing time before the audit-purge block that eats into the current 55s margin.

## Recommendation

**Do not restart the 48h clock.** The observed failure is real and reproducible, but it is a rig-provisioning-config artifact given production's actual current ambient timeouts, not a defect that manifests in prod today. It does not touch the migration's core safety property (bounded lock wait, no barrier re-formation), and no data-integrity or security regression exists in either environment. Recommend: (1) flag the fix above to Carson/CTO for a follow-up compensating migration before or shortly after `#2235` lands — it is cheap, mechanically consistent with `0411`'s own existing pattern, and removes a real (if currently dormant) reliance on ambient config outside this function's control; (2) separately flag that `arkova-staging-2026-08`'s `authenticator`/`authenticated` ambient timeouts should be widened to mirror prod (`60s`/`30s` and `30s`) so this class of rig-vs-prod divergence doesn't reproduce for the next soak on this rig.
