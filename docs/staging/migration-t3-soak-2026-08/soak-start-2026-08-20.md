# Migration-T3 wave — 48h soak start (2026-08-20)

> Founder approved all five asks in
> [`docs/staging/migration-t3-wave-premortem-2026-08-19.md`](../migration-t3-wave-premortem-2026-08-19.md)
> ("go", 2026-08-20). This document records the stand-up: union branch, migration
> apply + reconcile + rollback-rehearsal log, deploy, clock start, and the §2
> driver plan (automated vs manual). Nothing in this wave has been readied or
> merged — that is Carson/RTE's call after the 48h matures, per §3 option (a).

## Scope

| PR | Head SHA | Migration(s) |
|---|---|---|
| [#2219](https://github.com/carson-see/ArkovaCarson/pull/2219) | `235ed69d574f9ba57c621397c7b3bd488d0279ed` | `0410_partner_accounts.sql` |
| [#2235](https://github.com/carson-see/ArkovaCarson/pull/2235) | `4ce5753c42f0353afd86e51615598c29a4242795` | `0411`, `0412`, `0413` |
| [#2248](https://github.com/carson-see/ArkovaCarson/pull/2248) | `c993e81cd241cafd13328108b9fa45bf6e314e11` | `0414` |

**Union branch:** `rc/migration-t3-wave-2026-08`, base `origin/main` at
`b6cfad73c73fbaf45bea08e3b155d61501a49daa` (matches the premortem's stated base
exactly). **Union head: `3baf16015ed61b4063daa6e53bead2399657ecd6`** (after the
three PR merges plus one same-branch fix commit, both described below).

All three PR heads were verified against `gh pr view` at merge time and matched
the premortem's table exactly — no PR moved between the premortem being written
and this wave starting.

## Merge log

1. `git checkout -b rc/migration-t3-wave-2026-08 origin/main` — clean.
2. Merge #2219 — clean, no conflicts.
3. Merge #2235 — **one conflict**, in
   `scripts/ci/check-hot-table-ddl-lock-timeout.test.ts`: #2219 and #2235 each
   appended a new top-level `describe()` block after the same anchor (end of
   the original `scanFiles` describe). Git's diff3 merge produced confusing
   interleaved hunks because both new blocks share large amounts of
   boilerplate text (`).toEqual([]);\n  });`) that matched across blocks —
   resolved by taking each PR's **complete, self-contained** new block from
   `git show <ref>:<file>` rather than trying to hand-edit the interleaved
   markers: #2219's `REFERENCES — FK to a hot table` describe, then #2235's
   `deferred function bodies (BUG-019)` describe (which also carries a
   mid-file `RUNTIME_DDL_TABLES` describe + import that auto-merged cleanly
   and had to be preserved from #2235's side, not #2219's, since #2219 never
   had it). Verified post-merge: `grep -c '^describe('` = 5, all five blocks
   present and correctly closed.
   `supabase/migrations/agents.md` and `scripts/ci/agents.md` **auto-merged
   cleanly** — both PRs already titled their `## Recent migrations` blocks
   distinctly (`(PR #2219)` vs `(data-integrity soak cluster...)`), exactly as
   PM-5 anticipated and CLAUDE.md §6 requires.
4. Merge #2248 — clean, no conflicts. **Note:** #2248's branch carries an
   unrelated, stale commit (`726d34461`, dated 2026-08-15, "correct vanished
   standing-rig instructions") that rewrites `CLAUDE.md` §1.11/1.11A and
   `docs/reference/STAGING_RIG.md` to claim "there is no standing shared
   rig" and that `arkova-worker-staging` is a "zombie" pointing at a deleted
   database (`ujtlwnoqfhtitcmsnrpq`). **This is stale and was independently
   verified false before proceeding**: `726d34461` is not an ancestor of
   `origin/main` (confirmed via `git merge-base --is-ancestor`), so it never
   landed — it predates the 2026-08-19 rig rebuild that created
   `fizyjojbebyalirtjjht` and repointed `arkova-worker-staging` at it. Ground
   truth was re-verified directly (not inferred from either doc) before any
   migration was applied — see "Target rig verification" below. This content
   sits unaddressed in #2248's own branch; it is not this wave's job to fix
   another PR's branch, but it is flagged here and should be raised with
   Carson/the PR owner before #2248 merges, since it would corrupt `CLAUDE.md`
   if it lands as-is.
5. **Same-branch fix commit** `3baf16015`: unioning #2219 and #2235 surfaced a
   cross-PR finding neither PR's author could have seen alone —
   `scripts/ci/feedback-rules/secdef-function-grants.test.ts`'s "no baseline
   rot" self-check failed on exactly one entry:
   `00000000000000_baseline_at_main_HEAD.sql::public.refresh_cache_anchor_status_counts`.
   #2235's `0412` closes that function's anon/authenticated grant with its own
   inline `REVOKE` (independent of #2248's sixteen-function sweep in `0414`);
   #2248 separately trimmed the same baseline snapshot for the functions *it*
   fixes, with no visibility into `0412`'s fix. Removed the one stale entry
   per the test's own instruction (the test names the exact stale key); the
   sibling `0335`-authored entry for the same function is untouched (still a
   live/legitimate row — the test did not flag it). Verified green after the
   fix: `43/43` tests pass.

## Local verification (set-diff, not absolute counts)

Per `reference_worker_local_verify_by_setdiff` — this worktree's `node_modules`
is missing `@types/express`, `@sentry/node`, `@sentry/profiling-node`, and
`supertest` entirely (confirmed: `ls node_modules/@types/express` etc. all
fail; this is a pre-existing worktree dependency-install gap, not something
this branch introduced).

- `services/worker` **typecheck**: 1,259 errors, all `TS7016`/`TS2307` module-
  not-found on the four missing packages above, matching the documented
  ~1,250-error baseline almost exactly. Not a regression.
- `services/worker` **lint** (the actual deploy gate per CLAUDE.md §0 rule 9):
  **clean, exit 0.**
- Touched worker test files: `partner-provisioning-router.test.ts` and
  `cron.test.ts` cannot run at all in this worktree (`Cannot find package
  'supertest'`) — environmental, not a code defect. The other three touched
  files (`admin-lists.test.ts`, `expiry-checker.test.ts`,
  `payload-schemas.test.ts`) pass **112/112**.
- Touched root test files (`check-hot-table-ddl-lock-timeout.test.ts`,
  `secdef-function-grants.test.ts`, the three `bug-0{09,11,19}` files,
  `WebhookEventCatalog.test.tsx`, `WebhookSettings.test.tsx`): **179/179**
  pass (post the baseline fix above; pre-fix it was 178/179 with the one
  known-cause failure).

**Manual follow-up:** run `npm install` for `services/worker` in a clean
environment (or CI, which does have these packages) to get real
`partner-provisioning-router.test.ts` / `cron.test.ts` execution before this
PR is readied — the CI job itself is unaffected by this worktree's gap.

## Target rig verification (ground truth, not inferred from any doc)

| Check | Result |
|---|---|
| `list_projects` (MCP) | `fizyjojbebyalirtjjht` (`arkova-staging-2026-08`) present, `ACTIVE_HEALTHY`, created `2026-08-19T19:39:28Z`. `ujtlwnoqfhtitcmsnrpq` **absent from the org entirely** — confirms it really was deleted, but that is orthogonal to whether `arkova-worker-staging` currently points at it. |
| Cloud Run traffic (pre-deploy) | `arkova-worker-staging` 100% traffic on `arkova-worker-staging-00252-696`, matching the premortem's stated revision exactly. |
| `SUPABASE_URL` secret (`supabase-url-staging`) | `https://fizyjojbebyalirtjjht.supabase.co` — confirms the live service is wired to the NEW rig, not the deleted one. |
| `/api/health` (pre-deploy, via IAM identity token) | `{"status":"healthy","git_sha":"b6cfad73c73fbaf45bea08e3b155d61501a49daa", "checks":{"database":"ok","anchoring":"ok","kms":"ok"}}` |
| `list_migrations` (MCP, pre-apply) | Ledger head `0409` (`lock_wait_observability_rpc`), sequential `0290`–`0409` (with the baseline's known small gaps: 0298, 0332, 0344, 0361, 0369, 0371-0374 absent — pre-existing, not new), no PR-only/timestamp rows besides the `00000000000000` baseline. Matches the premortem's clean_mirror claim. |

This directly refutes the stale #2248-branch claim above — **verified, not
assumed.**

## Migration apply + reconcile log (strict order, one at a time)

Each migration: MCP `apply_migration` → confirm via direct SQL → §0 rule 10
ledger reconciliation (`UPDATE ... SET version='NNNN' ...`) → confirm via
`list_migrations`, before moving to the next.

| # | Applied | Reconciled to | Verification |
|---|---|---|---|
| 0410 | ✅ | `0410` | `relrowsecurity=true`, `relforcerowsecurity=true`, grants show only `postgres`/`service_role` (no anon/authenticated row at all) |
| 0411 | ✅ | `0411` | `has_function_privilege('anon','cleanup_expired_data()','EXECUTE')=false`; `has_function_privilege('authenticated',...)=false` |
| 0412 | ✅ | `0412` | Live-exercised via `SELECT refresh_cache_anchor_status_counts()`: **before** `ANALYZE`, `total_source='exact'`, `total=1` (never `0`); **after** `ANALYZE anchors`, `total_source` flips to `'estimate'`, `total` still `1`. `has_function_privilege('anon'/'authenticated', 'refresh_cache_anchor_status_counts()', 'EXECUTE')=false` on both. |
| 0413 | ✅ | `0413` | `to_regclass('public.calibration_features')` resolves; `SELECT count(*)` succeeds (0 rows, no seeded confidence data — expected); grants show no anon/authenticated row. |
| 0414 | ✅ | `0414` | Full 16-function sweep (below) + PM-1 ordering control. |

Final ledger (`list_migrations`, post-apply): `00000000000000` baseline +
`0290`–`0414` inclusive, no gaps beyond the pre-existing ones, **no
rehearsal-artifact rows left over** (see rollback section — every rehearsal's
timestamp-versioned ledger row was deleted immediately after each cycle; this
is cleanup of the rehearsal tool's own DDL-call bookkeeping, not a repair of
any PR-owned migration row).

### PM-1 ordering control (the reason 0411 must precede 0414)

```
SELECT has_function_privilege('anon','cleanup_expired_data()'::regprocedure,'EXECUTE');
-- false, immediately after 0414 applied
```
Confirmed as a **standalone check right after 0414**, not folded into an
end-of-wave summary — per the premortem's own instruction on how this control
must be run.

### Full 16-function sweep (both axes, live)

All sixteen: `anon=false`. Fourteen: `authenticated=false`. The two deliberate
exceptions — `get_pipeline_stats()` and `get_user_monthly_anchor_count(uuid)`
— `authenticated=true`. Exact match to the migration's stated parity target.
Re-run anytime via `scripts/staging/migration-t3-secdef-sweep.sh
fizyjojbebyalirtjjht` (committed this wave).

`http*` negative control: all fourteen `extensions.http*` functions remain
`anon=true` — confirms `0414` did not over-reach past its stated sixteen.

**Live PostgREST confirmation, both axes, with a real signed session** (not
just the DB-level ACL check): minted a genuine Supabase session for the
seeded fixture user via the Admin Auth API (`POST
/auth/v1/admin/generate_link` → `GET /auth/v1/verify` — see "JWT-minting
recipe" below, since a hand-rolled HS256 token fails with `PGRST301`: this
project signs sessions with an ES256 project key, not the legacy shared HS256
secret).

- `get_pipeline_stats()` as `authenticated`: reaches the function body (gets
  the app-level `P0001 Access denied: platform admin required`, not an ACL
  denial) — confirms the grant is live.
- `get_user_monthly_anchor_count(uuid)` as `authenticated`: **200, returns
  `1`** — confirms the live `useEntitlements.ts` UI path works.
- `cleanup_expired_data()` as `authenticated`: **403, `42501` permission
  denied** — confirms the fourteen blanket-revoked functions correctly deny
  authenticated too, live.
- `public.partner_accounts` direct-table access via PostgREST: both `anon`
  (401) and the real `authenticated` session (403) get `42501 permission
  denied for table partner_accounts` — stronger than an RLS-only block (no
  `GRANT` exists for either role at all), confirming §2's "FORCE ROW LEVEL
  SECURITY verified live" check plus a step further.

### JWT-minting recipe (for continued testing during the window)

```bash
# 1. Mint a magic-link token for the seeded fixture user (service role key)
curl -X POST "https://fizyjojbebyalirtjjht.supabase.co/auth/v1/admin/generate_link" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"magiclink","email":"seed-fixture-user@seed-fixture.invalid"}'
# -> take .hashed_token from the response

# 2. Exchange it for a real ES256-signed session (anon key, no service role needed)
curl -i "https://fizyjojbebyalirtjjht.supabase.co/auth/v1/verify?token=<hashed_token>&type=magiclink&redirect_to=http://localhost:3000" \
  -H "apikey: $SUPABASE_ANON_KEY"
# -> access_token is in the Location header's #access_token= fragment
```

## Rollback rehearsals (§2 order: 0410 first, 0414 last + immediate re-apply)

Each: apply (already done above) → confirm → rollback → confirm absence/
restoration → re-apply → confirm identical/closed state again. Every
rehearsal step's raw output was captured live; summarized here.

| Migration | Rollback confirmed | Re-apply confirmed | Notes |
|---|---|---|---|
| **0410** (first — destructive, ran before any CAS data existed; `count(*)=0` verified immediately before) | `to_regclass('public.partner_accounts')` → `NULL` | Table back, RLS+FORCE both `true`, 4 indexes, 1 policy — identical to first apply | |
| **0411** | Restored baseline body verbatim (`pg_get_functiondef ... LIKE '%lock_timeout%'` → `false`) | Guard restored (`true`), `anon_exec=false` | |
| **0412** | 0335 body restored (`total_source` key absent from the cache row) | `total_source` key back, live-exercised (`estimate`), anon revoke intact | |
| **0413** | `DROP VIEW` — `to_regclass` → `NULL` (route would 500 with `PGRST205` again) | View back, `count(*)` succeeds, grants correct | |
| **0414** (last — rolled-back state is a live security regression, minimized the window) | **Regression confirmed real and reproducible**: `has_function_privilege('anon','cleanup_expired_data()','EXECUTE')` flipped to `true` | **Immediately re-applied** — full 16-function sweep re-confirmed all closed correctly within the same message exchange (seconds of exposure, not a separate session) | |

`NOTIFY pgrst, 'reload schema'` issued after every apply/rollback/re-apply
that touches a function/view (0411/0412/0413/0414 file-required or added out
of caution per PM-7; 0410 doesn't need one — new table, confirmed PostgREST
served it correctly with no manual reload via the live grant probes above).

**Rehearsal-artifact ledger cleanup:** each `apply_migration` call (including
rehearsal steps, which aren't real migration files) auto-inserts a
timestamp-versioned row into `supabase_migrations.schema_migrations`. Deleted
each such row (`rollback_rehearsal_04NN`, `reapply_04NN_*`) immediately after
its cycle so the final ledger contains exactly one row per real file —
confirmed final `list_migrations` output above.

## Real finding: BUG-019's lock-contention fix does not achieve graceful degradation under this rig's role config

> **UPDATE (2026-08-20, later the same day):** this finding was picked up and
> given a full root-cause diagnosis in
> [`FD-RETENTION-1-timeout-inversion.md`](./FD-RETENTION-1-timeout-inversion.md)
> (`docs/staging/migration-t3-soak-2026-08/`), which traces the exact
> mechanism (`0411` sets `lock_timeout` but never `statement_timeout`; prod's
> ambient `authenticator.statement_timeout=60s` gives the function's 5s
> `lock_timeout` a 55s head start, so the designed path holds in prod today —
> the rig's tight `8s` ambient value is what inverts the race there) and
> carries a **CTO ruling**: **the 48h clock stands, not restarted** — the
> defect doesn't manifest under prod's current config, so pausing the soak
> would spend 48h without reducing prod risk — but two follow-ups are
> required before `#2235` ships: (1) a compensating migration adding an
> explicit `statement_timeout` guard (never an edit to `0411`), and (2) align
> the rig's ambient `statement_timeout`/`lock_timeout` to prod's values in
> `STAGING_RIG.md`'s provisioning procedure. The original observation below
> is preserved as-is — it is the source evidence that diagnosis cites, not
> superseded by it.

Per §2's explicit instruction to test the forced-timeout branch, not just the
happy path. Held `audit_events IN ACCESS EXCLUSIVE MODE` via a direct psql
session (Supabase pooler — the direct `db.<ref>.supabase.co` host is
IPv6-only and was unreachable from this network; `aws-0-us-east-2.pooler.supabase.com:5432`
worked), then fired `POST /jobs/cleanup-retention` concurrently.

**Observed, reproduced twice:** HTTP `500 {"error":"Processing failed"}` at
**~8.2s**, not the intended HTTP `200` with `audit_events_purge_skipped:
true` at ~5s. Cloud Run structured logs show the real cause:

```
{"error":{"code":"57014","message":"canceling statement due to statement timeout"},
 "msg":"Data retention cleanup RPC failed"}
```

`57014` is Postgres's code for **`statement_timeout`**, not `55P03`
(`lock_not_available`) — the exact exception class `0411`'s
`EXCEPTION WHEN lock_not_available` handler catches. Since the actual error
is a different class, the handler never fires, and the **entire top-level
statement aborts** — not just the audit-purge subtransaction. Confirmed via
`pg_roles.rolconfig`:

```
authenticator: statement_timeout=8s, lock_timeout=8s   (session-level, ambient)
service_role:  (no override — inherits authenticator's ambient config)
```

The function's own `SET LOCAL lock_timeout = '5s'` inside the audit-purge
subtransaction does not appear to make its intended exception class win the
race against the ambient 8s `statement_timeout`, which bounds the *entire*
function call from its start, not just the lock wait. Confirmed the blast
radius: **no `DATA_RETENTION_CLEANUP` audit row was written** for either
failed run (full-transaction rollback), meaning the three *other* retention
deletes that should have survived per 0411's design (webhook logs,
verification events, AI usage events) were rolled back too, on this specific
contention path. The one property that **did** hold: `reject_audit_delete`
survived intact (`tgenabled='O'`) — the `DROP TRIGGER` never actually
completed (it was still waiting to acquire the lock when the statement was
cancelled), so nothing was ever actually dropped. **No security/data-integrity
regression** — the retention purge just fails harder than designed under real
contention, and (per its cron schedule) retries the next day.

This is a genuine soak finding, not a harness artifact — reproduced twice
with precise timing (8.26s both times). Documented here and in
`scripts/staging/migration-t3-data-integrity-probe.sh`'s `lock-contention`
mode for continued verification during the window. **Not fixed in this
session** — fixing it would mean editing an already-applied, already-merged-
into-this-branch migration file (against CLAUDE.md's "never modify an
existing migration" rule) or authoring a new compensating migration, both of
which are outside this task's scope (standing up the soak, not authoring new
fixes). Flagging for Carson/RTE follow-up before #2235 is readied.

## Preflight (re-run AFTER the migrations, as instructed)

```
SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ACCESS_TOKEN=... \
  npx tsx scripts/ci/staging-honesty-preflight.ts \
  --project-ref fizyjojbebyalirtjjht --prod-project-ref vzwyaatejekddvltxyye --format json
```

**Result: `environment_type=fixture_seeded`** (not `clean_mirror`) —
**expected and explained, not a red flag:**

- `prod_divergence` check fails because it diffs the **checked-out repo's**
  `supabase/migrations/` directory (this rc branch, which now has `0410`-
  `0414` on disk) against the rig's ledger — but at the moment this was run,
  it reported them "missing from rig" because the check runs from the repo
  state, and by design this wave's whole point is to have just closed that
  gap. Re-running the identical command now (post-apply) would show the
  ledger caught up to the repo instead. This is the expected "ledger advanced
  past prod" divergence the task instructions anticipated — prod's own
  ledger head is still `0409` (unaffected; nothing was applied to prod this
  session), so the rig is now correctly *ahead* of prod, not diverged from
  the repo.
- `submitted_anchors` check fails (`0` SUBMITTED anchors) — the rig's baseline
  fixture seeds anchors that resolve straight to `SECURED` rather than
  parking in `SUBMITTED`; not a migration-hygiene signal.
- The **ledger-hygiene checks that actually matter** (no PR-only/staging-only
  rows, no duplicate names, no duplicate versions, no known artifact rows,
  prod facts all verified) **all pass**, independently confirmed via
  `list_migrations` (above) showing a sequential, gap-explained ledger with
  exactly one row per real file.

## Rig deploy

| Field | Value |
|---|---|
| Union head | `3baf16015ed61b4063daa6e53bead2399657ecd6` |
| Platform | `linux/amd64` (via `docker buildx build --platform linux/amd64`) |
| Image | `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker-staging:3baf16015ed61b4063daa6e53bead2399657ecd6` |
| Image digest | `sha256:b64f08428f8b67d4ecc6c41e34d87c67c40c585ea499e2bc301e9e1d7514808f` |
| Cloud Run service | `arkova-worker-staging` (region `us-central1`, project `arkova1`) |
| Revision | `arkova-worker-staging-00300-few` |
| Tag | `train-migration-t3` |
| Tag URL | `https://train-migration-t3---arkova-worker-staging-kvojbeutfa-uc.a.run.app` |
| Base URL (100% traffic, explicitly re-pointed) | `https://arkova-worker-staging-kvojbeutfa-uc.a.run.app` |
| Revision created | `2026-08-20T14:00:22.865530Z` |

Deployed with `--no-traffic` + `--tag train-migration-t3` first, verified
`/api/health` on the tag URL (`200`, `git_sha` matches union head exactly,
all checks `ok`), **then** explicitly re-pointed 100% traffic via `gcloud run
services update-traffic --to-revisions=arkova-worker-staging-00300-few=100`
— per the note that this service's traffic is pinned to explicit revisions
and gcloud's deploy summary line does not reflect it. Confirmed via
`gcloud run revisions list` (STATUS=True on the new revision) **and** a fresh
`/api/health` hit on the base URL post-repoint (`200`, correct `git_sha`,
correct new image digest). `IP_HASH_PEPPER` was carried through unchanged
from the live service's existing secret wiring, matching the note that it is
a required secret on this service — the deploy command mirrors the prior
revision's full `--set-secrets`/`--set-env-vars` spec exactly, changing only
the image tag and `BUILD_SHA`.

## 48h clock

- **Start:** `2026-08-20T14:00:22Z` (= revision `arkova-worker-staging-00300-few`
  creation timestamp — the soak clock is Cloud Run revision uptime, not a
  probe loop, per `feedback_soak_clock_is_worker_uptime`).
- **Expected end:** `2026-08-22T14:00:22Z`.
- **Exclusive rig use (PM-4):** this wave claims exclusive use of
  `fizyjojbebyalirtjjht` / `arkova-worker-staging` for the window — no other
  migration should be prod-applied against this rig's Supabase project during
  the 48h. If that assumption breaks, re-run the preflight and note the
  divergence rather than silently continuing.
- **`DEPLOY_WORKER_PAUSED`** (PM-6): confirmed `true` at wave start. Re-check
  immediately before queuing each of the three PRs — this wave's plan does
  not lean on it (option (a): each PR earns its own soak-evidence
  merge-readiness regardless of the pause variable's state).

## §2 driver plan — automated vs manual

### #2219 partner-provisioning router (`0410`)

| Driver | Status |
|---|---|
| Flag-off → 404 | **Automated + verified**: `404` confirmed live. |
| Flag-on → 401 (unauth) | **Automated + verified**: `401` confirmed live (flag toggled on then restored to off). |
| FORCE RLS live via PostgREST | **Automated + verified**: both `anon` and a real `authenticated` session get `42501` on direct table access. |
| Uniqueness constraint under concurrency | **Automated + verified**: two concurrent INSERTs raced at the DB level (Supabase pooler, two parallel psql sessions) — exactly one succeeded, the other got `23505` on `partner_accounts_open_request_uniq`, case-insensitive collision confirmed (`ConcurrencyTestPartner` vs `concurrencytestpartner`). Test rows cleaned up. |
| Full CAS lifecycle via real HTTP (`approve`/`reject`/`provision`), sponsor-org `owner`/`org_admin` 403, self-provision block | **NOT automated — infra gap, not a code gap.** `arkova-worker-staging` is `--no-allow-unauthenticated` at the Cloud Run IAM layer; the GCP IAM identity token and a Supabase user JWT both need the same `Authorization: Bearer` header, and `requireAuthMw` (`services/worker/src/routes/middleware.ts:71-79`) reads the user JWT from that exact header — there is no second header for it. **Manual follow-up:** exercise this from the actual frontend against a real signed-in session, or build a small companion harness that proxies the IAM check separately from the app auth. Reusable script: `scripts/staging/migration-t3-partner-provisioning-probe.sh` (modes `flag-state`, `table-rls`, `uniqueness-race` are automated; the full CAS lifecycle mode is intentionally not included, for the reason above). |
| Per-org isolation (partner_accounts scoped to sponsor_org_id) | **Seeded, structurally confirmed, full concurrent-both-orgs run pending.** A second org (`5eed0000-0000-0000-0000-0000000000b2`, "Migration T3 Soak Org B") was seeded. The table's `sponsor_org_id` scoping plus the service-role-only ACL structurally guarantee isolation (there is no policy path for cross-org leakage at all — no role can read the table except service_role, which the router itself scopes by `sponsor_org_id` in its own query construction). Running the CAS flow against both orgs *concurrently* to observe it empirically needs the same auth-harness follow-up as above. |

### #2235 data-integrity cluster (`0411`–`0413`)

| Driver | Status |
|---|---|
| BUG-019 forced-timeout branch | **Automated + run — real finding documented above** (does not currently achieve graceful degradation; trigger integrity intact, no data-integrity regression). Reusable: `scripts/staging/migration-t3-data-integrity-probe.sh lock-contention`. |
| BUG-019 uncontended happy path | **Automated + verified**: clean `200`, real per-table counts, `audit_events_purge_skipped: false`. |
| BUG-009 two ANALYZE cycles | **One cycle done** (`exact` → `estimate`, `total` never `0`). **Second cycle (after seeding more rows) is a window task** — reusable: `scripts/staging/migration-t3-data-integrity-probe.sh analyze-cycle`, re-run after seeding additional anchors mid-window. |
| BUG-009 `0412`'s own anon/authenticated revoke | **Automated + verified** (both `false`). |
| BUG-011 `POST /jobs/calibration-refit` | **Automated + verified**: `200`, real knot data returned (`sampledEntries: 0` — expected, no seeded confidence data yet). Scheduled Monday-3am firing is a **window task** (falls naturally inside the 48h if the window spans a Monday 3am UTC — 2026-08-20 14:00 to 2026-08-22 14:00 does **not** cross a Monday 3am; next one is 2026-08-24. Flagging honestly: this control will not be satisfied by the scheduled cron within this specific 48h window — the manual trigger above is the only coverage unless the window is extended or a manual Monday-equivalent trigger is run again closer to the end). |
| BUG-011 RLS-invoker semantics as non-service_role | **Not directly run** (needs the same authenticated-session harness as the partner-provisioning table check, but for `calibration_features` specifically) — **manual follow-up**, same recipe as the JWT-minting section above, then `curl .../rest/v1/calibration_features?select=id` with that session. |
| `cron.ts` BUG-002 credential-expiry fix | **Route confirmed live** (`200`, clean skip since `ENABLE_EXPIRY_ALERTS` is off). **Full payload-schema validation against seeded expiring anchors is a manual follow-up**: seed anchors with `expires_at` inside the 7/30/90-day windows, enable the flag, re-trigger, and confirm the webhook payload matches `ComplianceDocumentExpiringPayloadSchema` with `public_id` only (no raw `anchors.id`). |

### #2248 anon/authenticated revoke replay (`0414`)

| Driver | Status |
|---|---|
| All sixteen, both axes, live PostgREST | **Automated + verified**, both via direct `has_function_privilege` and via real signed sessions for the two exceptions — see above. |
| Two live UI paths | **`get_user_monthly_anchor_count` confirmed** via real session (`useEntitlements.ts`'s exact RPC, `200`, real value). **`PipelineAdminPage.tsx`'s client-RPC fallback path specifically** (simulating the worker route failing) is a **manual follow-up** — needs a frontend-level test, not just the RPC call (which is covered by the `get_pipeline_stats` check above). |
| Prod-no-op / idempotency re-run | **Not run this session** — re-running `0414` a second time and diffing the ACL is a cheap, safe **window task**: `apply_migration` the same file content again, confirm the sweep script reports identical output. |
| `http*` exclusion negative control | **Automated + verified.** |

### Cross-cutting: per-org isolation

Second org seeded (above). Full concurrent-both-orgs exercise blocked on the
same auth-harness gap as the CAS lifecycle test. `pipeline_dashboard_cache`'s
single-row-global shape (`cache_key='anchor_status_counts'`) confirmed as the
**intended** shape, not a bug — platform-wide admin metric by design.

## Sustained load backdrop

Launched `scripts/staging/load-harness.ts --mode mixed --duration 90` against
the `train-migration-t3` tag URL (the load-harness's own env validation
refuses the untagged shared hostname, by design — tag URLs route to a
specific revision regardless of live traffic split, so this correctly targets
the same revision now serving 100% of base-URL traffic too).

- Started `2026-08-20T14:17:01.957Z`, sustaining **~2.1–2.6 req/s** (≈
  7,500–9,390 req/hour, climbing over the run) across `events` / `reads` /
  `cron` / `webhook` modes — within the mandated 5k–10k req/hour band,
  **not** a single probe. `cron` mode ran clean throughout (`60/60` `200`s
  at the point it stopped); `events`/`reads`/`webhook` returned mostly
  `401`/`429`/`503` because `STAGING_API_KEY` was not set for this launch
  (expected and documented in the harness's own header: "401/403 from
  app-layer auth IS valid soak data" — it exercises the
  middleware/rate-limiter/logging chain under load either way).
  **Final outcome, corrected from the original write-up above:** the
  process was killed when the launching agent session ended, at
  `t+3569s` (≈59.5 minutes elapsed, not the full 90-minute duration
  requested) — **9,316 total requests** logged in that window. It did not
  crash and was not superseded; it was terminated by the session boundary.
  No `--evidence-out` JSON was written (the harness only writes it on a
  clean exit at the requested duration, not on external kill), so
  `docs/staging/migration-t3-soak-2026-08/load-harness-launch-evidence.json`
  does **not** exist — the per-mode counts above are transcribed from the
  harness's own stdout log, not from that file.
- **This ~1-hour run does not cover the full 48h window on its own** — no
  single CLI session can guarantee a continuously-running background process
  for 48 hours, and this run's own early termination is direct proof of
  that limit, not just a theoretical caveat. **Manual follow-up, stated
  plainly:** re-launch this same
  command periodically (e.g. via a persistent terminal, a Cloud Scheduler job
  hitting the tag URL, or a supervised long-running process) to keep the
  volume/concurrency backdrop present for the full window, especially during
  the targeted-probe runs above (PM-8: interaction effects surface under
  concurrent load, not in isolation). Exact command:
  ```bash
  STAGING_API_BASE="https://train-migration-t3---arkova-worker-staging-kvojbeutfa-uc.a.run.app" \
  STAGING_CRON_SECRET=<from gcloud secrets versions access latest --secret=cron-secret> \
    npm run staging:load -- --mode mixed --duration <minutes> \
    --evidence-out docs/staging/migration-t3-soak-2026-08/load-harness-<n>.json
  ```

## What ran vs what is a stated manual follow-up (summary, no implying)

**Ran, live, this session:** all 5 migrations applied + reconciled; all 5
rollback rehearsals (apply→rollback→confirm→re-apply→confirm); the full
16-function sweep on both axes (DB-level and live PostgREST, including two
real authenticated-session calls); the `http*` negative control; the PM-1
ordering control; partner-provisioning flag-off/flag-on transition;
`partner_accounts` direct-table RLS/grant denial (anon + real authenticated
session); the uniqueness-constraint concurrency race; one BUG-009 ANALYZE
cycle; the BUG-019 forced-timeout lock-contention test (yielding the real
finding above); the BUG-011 calibration-refit trigger; the BUG-002
credential-expiry route smoke; a 90-minute mixed-mode sustained-load launch;
image build+push+deploy+traffic-repoint with live health verification.

**Explicitly NOT run — manual follow-up with exact commands given above:**
full CAS lifecycle + sponsor-org 403 + self-provision-block via real HTTP
(blocked by the Cloud Run IAM / user-JWT same-header conflict); concurrent
both-orgs CAS run; second BUG-009 ANALYZE cycle after seeding more rows;
Monday-3am scheduled calibration-refit firing (does not fall inside this
specific 48h window); `calibration_features` RLS-invoker check as a real
non-service_role session; full credential-expiry webhook-payload validation
against seeded expiring anchors; `PipelineAdminPage.tsx`'s specific
client-RPC-fallback path; `0414` idempotency re-run diff; continuing the
sustained-load backdrop for the remaining ~46.5 hours of the window.

## Files this wave touches (rc/migration-t3-wave-2026-08)

- `supabase/migrations/0410_partner_accounts.sql` (from #2219)
- `supabase/migrations/0411_bug019_cleanup_expired_data_lock_timeout.sql`,
  `0412_bug009_anchor_status_counts_stale_estimate_sentinel.sql`,
  `0413_bug011_calibration_features_view.sql` (from #2235)
- `supabase/migrations/0414_sec_replay_missing_anon_revokes.sql` (from #2248)
- `scripts/ci/check-hot-table-ddl-lock-timeout.test.ts` (merge conflict
  resolution, union of both PRs' new describe blocks)
- `scripts/ci/feedback-rules/secdef-grants-baseline.json` (this wave's own
  fix commit, cross-PR baseline-rot cleanup)
- `scripts/staging/migration-t3-secdef-sweep.sh`,
  `scripts/staging/migration-t3-data-integrity-probe.sh`,
  `scripts/staging/migration-t3-partner-provisioning-probe.sh` (new, this
  wave — reusable drivers for the remainder of the window)

## Explicitly not done (per task scope)

No PR readied or merged. No prod-apply (`vzwyaatejekddvltxyye` untouched,
read-only queries only). No fix authored for the BUG-019 lock-contention
finding — flagged for follow-up, not remediated in this session.

---

_Written 2026-08-20 during soak stand-up. Claims verified against MCP
`list_migrations`/`execute_sql` output, `gcloud run` describe/list output,
live `curl` probes with real IAM/Supabase tokens, and this session's own
`git`/`npm`/`vitest` output — not asserted from either doc._
