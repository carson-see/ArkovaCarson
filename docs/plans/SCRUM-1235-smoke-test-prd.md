# SCRUM-1235 — Production Smoke Test Timeout Fix — PRD

> **Source of truth:** [SCRUM-1235](https://arkova.atlassian.net/browse/SCRUM-1235). Confluence audit page mirrors this PRD.
>
> **Status:** Engineering scoping doc. Not the canonical user-facing doc — that lives in Confluence.

---

## 1. Problem

The Production Smoke Test Suite that fronts the System Health admin page (built under SCRUM-43 / P7-TS-06) is broken on prod. Three of five checks fail every run:

* `anchor-count` — 60 112 ms / 60 098 ms (PostgREST 60 s timeout)
* `recent-secured` — 60 141 ms on 4/24, 3 298 ms on 4/22 (intermittent)
* `rls-active` — 60 359 ms / 60 096 ms (PostgREST 60 s timeout) AND semantically broken (runs via service_role which bypasses RLS)

Two of three are deterministic; the third is a planner-stats drift symptom. The checks were green on 4/14 and 4/16 with sub-15 s runtimes — they degraded as the `anchors` table crossed ~1 M rows and now sits at 1.41 M+.

The "Degraded Performance" banner is correct. We do not currently have a working production observability surface for "is the anchoring pipeline still alive."

## 2. Goals

1. All five smoke checks pass on prod with p95 latency < 1 s.
2. `rls-active` actually verifies RLS is enforced on `anchors` (test what it claims to test).
3. No new third-party dependencies, no Vercel cost increase, no Cloud Run config change (see `feedback_worker_hands_off`).
4. Stable for at least the next 10× growth in the `anchors` table (the trick — `pg_class.reltuples` — does not scale with row count).

## 3. Non-goals

* Reworking the smoke test history storage (`audit_events` row per run) — fine as-is.
* Reworking the System Health UI — fine as-is.
* Cloud Scheduler binding for periodic smoke runs — separate ops task.
* Migrating `recent-secured` to a SECURITY DEFINER RPC unless `is + order` doesn't fix the planner.

## 4. Constraints (from CLAUDE.md)

* TDD red→green→refactor.
* Migration must include a `-- ROLLBACK:` comment.
* SECURITY DEFINER functions must `SET search_path = public`.
* No PII or treasury keys in any new code path.
* Coverage thresholds maintained.
* Confluence page mandatory; ticket-level not just epic-level.
* Never merge to main.

## 5. Solution

### 5.1 `anchor-count`

Replace `db.from('anchors').select('*', { count: 'exact', head: true })` with the existing fast RPC:

```ts
const { data, error } = await db.rpc('get_anchor_status_counts_fast');
const total = Number(data?.total ?? 0);
```

`get_anchor_status_counts_fast()` (migration 0182) returns total via `pg_class.reltuples` (instant) and exact counts only for the small statuses. No new migration needed for this one.

### 5.2 `rls-active`

Replace the broken count query with a new RPC that **actually** verifies RLS on `anchors`:

```sql
CREATE OR REPLACE FUNCTION verify_anchors_rls_enabled()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT relrowsecurity AND relforcerowsecurity
  FROM pg_class
  WHERE relname = 'anchors'
    AND relnamespace = 'public'::regnamespace;
$$;
```

Both `relrowsecurity` and `relforcerowsecurity` must be true (CLAUDE.md §1.4 requires `FORCE ROW LEVEL SECURITY`). Returns boolean — pass = true, fail = false.

The check fails closed: if the RPC errors or returns false, the smoke test reports `fail`.

Goes in migration `0262_verify_anchors_rls_enabled.sql`.

### 5.3 `recent-secured`

Two small query changes to make the planner pick the existing `idx_anchors_status_created` partial index (created in migration 0174):

* Add `.is('deleted_at', null)` — matches the index's `WHERE deleted_at IS NULL` clause.
* Add `.order('created_at', { ascending: false })` — matches the index's `created_at DESC` ordering and lets `LIMIT 1` short-circuit.

If this still drifts, follow-up: SECURITY DEFINER RPC `get_recent_secured_anchor()` with `SET statement_timeout = '5s'` and explicit index hint. Tracked as a stretch task on the ticket.

## 6. Files touched

| File | Change |
|---|---|
| `services/worker/src/routes/cron.ts` | Rewrite `runSmokeTestSuite()` checks 2, 3, 5 |
| `services/worker/src/routes/cron.test.ts` | New tests covering RPC paths + error cases |
| `supabase/migrations/0262_verify_anchors_rls_enabled.sql` | New SECURITY DEFINER function |
| `services/worker/src/types/database.types.ts` | Regenerated after prod migration applies (deferred — `feedback_worker_hands_off`) |
| `services/worker/agents.md` | Note the new RPC in the worker's available helpers list |
| `HANDOFF.md` | Append "Now" entry for 2026-04-25 |

## 7. Test plan

* **Unit (vitest):** mock `db.rpc('get_anchor_status_counts_fast')` and `db.rpc('verify_anchors_rls_enabled')`. Assert pass/fail/error paths for all 5 checks.
* **Integration:** none new — existing `cron.test.ts` covers the route mount.
* **Manual (post-merge, post-prod-migration):** click Run Now on `/system-health`, expect 5/5 pass with all latencies < 1 s.
* **Regression:** confirm `anchor-count` returns the same total seen on the Admin Overview page.

## 8. Rollout

1. Merge PR (human-gated).
2. Apply migration 0262 to prod via Supabase MCP.
3. Regenerate `database.types.ts`.
4. Click Run Now in System Health, confirm 5/5 green.
5. Update Confluence audit page with prod-confirmed timings.

## 9. Risks

* `pg_class.reltuples` is an estimate — can be stale if `ANALYZE` hasn't run recently. Acceptable: smoke test only checks `total > 0`, not exactness.
* If RLS is genuinely disabled on `anchors`, `rls-active` will start failing for real. That's the correct behavior (we want to know).
* Recent-secured's planner-stats fix is best-effort. If it still flakes, follow-up RPC.

## 10. Definition of Done

Six gates per CLAUDE.md §3:

* [ ] Tests written first, seen failing, made passing. CI green.
* [ ] Jira: status transitioned, AC ticked, Confluence URL pasted.
* [ ] Confluence: per-story page current.
* [ ] Bug log: this regression logged in the master tracker.
* [ ] `agents.md` updated for `services/worker/`.
* [ ] HANDOFF.md updated.
