# Migration-T3 wave — CTO pre-mortem proposal (2026-08-19)

**STATUS: PROPOSAL FOR FOUNDER REVIEW. Nothing in this document has been executed.**
No PR has been readied, no migration has been applied anywhere, no rig has been touched. This
is a plan, written read-only against the current state of three draft PRs and the newly
rebuilt staging rig, for Carson to approve, amend, or reject before any of it runs.

**Scope: three migration-carrying draft PRs**, all currently `DRAFT`, `OPEN`, CI green on
their current heads (verified via `gh pr checks` at write time), base `main`
(`b6cfad73c73fbaf45bea08e3b155d61501a49daa`):

| PR | Head SHA | Migration(s) | What it does |
|---|---|---|---|
| [#2219](https://github.com/carson-see/ArkovaCarson/pull/2219) | `235ed69d574f9ba57c621397c7b3bd488d0279ed` | `0410_partner_accounts.sql` | HTTP router for the SCRUM-2990 partner-provisioning state machine (HakiChain onboarding path); the backing table for a previously table-less pure state machine (PR #1606) |
| [#2235](https://github.com/carson-see/ArkovaCarson/pull/2235) | `4ce5753c42f0353afd86e51615598c29a4242795` | `0411`, `0412`, `0413` | Data-integrity cluster: BUG-019 (`cleanup_expired_data` unbounded lock), BUG-009 (stale `pg_class.reltuples` estimate laundered into a fake `0`), BUG-011 (missing `calibration_features` view) + `cron.ts` schema-column fix + `copy.ts` |
| [#2248](https://github.com/carson-see/ArkovaCarson/pull/2248) | `c993e81cd241cafd13328108b9fa45bf6e314e11` | `0414` | FD-17 / BUG-2026-08-12-005: replays `anon`/`authenticated` EXECUTE revokes that exist only in `docs/migrations-archive/` and never reach a freshly built environment; rewritten this cycle to be a **prod no-op on both axes** after the first cut over-revoked `authenticated` on two live UI paths |

**Target rig — the new standing rig, not the frozen fullsoak-2026-08 rig:**

| Field | Value |
|---|---|
| Supabase project ref | `fizyjojbebyalirtjjht` (`arkova-staging-2026-08`, `us-east-2`) |
| Cloud Run service | `arkova-worker-staging`, serving revision `arkova-worker-staging-00252-696`, 100% traffic |
| Ledger head | `0409` — **exactly** the head this wave's migrations chain from (`0410` → `0411`–`0413` → `0414`), no gap |
| Preflight | `environment_type=clean_mirror`, 6/6 checks pass, captured 2026-08-19T19:52:36Z |
| Image | `git_sha b6cfad73c73fbaf45bea08e3b155d61501a49daa` — current `origin/main` tip |

This rig was rebuilt earlier today (session record:
`docs/staging/staging-rig-rebuild-2026-08-19.md` on worktree branch
`docs/staging-rig-rebuild`, **not yet on `main`** — a T0 doc-only PR that should land
independently of this wave, per the CLAUDE.md §0.10 direct-to-main carve-out). Its evidence
(preflight JSON, ledger diff against prod, Cloud Run health read) is cited above from that
record, not re-verified in this session — this proposal is read-only. **Getting that doc onto
`main` is a light prerequisite for this wave**, not because the rig depends on it (the rig is
real infrastructure, independent of the doc), but because the next session that needs to find
this rig should not have to be told about it in chat.

**Explicitly NOT this wave:** the chain-pair + rate-limit T3 soak currently running on the
*other* rig (`arkova-worker-fullsoak-2026-08-staging` / Supabase `gnkuaywlpmsaezwvlvhk`,
started 2026-08-19T16:51:23Z, closes ~2026-08-21T16:51:23Z, PRs #2216/#2250/#2269) is a
different soak on a different rig with different PRs. This proposal never touches it. The two
soaks can run concurrently without interaction — different Supabase projects, different Cloud
Run services.

---

## 1. Landing order + rationale

**`0410` → `0411`–`0413` → `0414`, strictly serial, apply-then-merge-then-next — never
batched.**

This is not just "lowest number first." Two independent reasons make it the *only* correct
order:

**a) It is the only order the files themselves support.** Ledger head is `0409`; `0410` is
the first free numeric prefix and `0414` the last claimed one (confirmed in each PR's own
`supabase/migrations/agents.md` addition — #2219 derives `0410` from a scan showing `0400`–
`0409` claimed and nothing at `0410`+; #2235 derives `0411`–`0413` from the same scan noting
`0410` claimed on another ref; #2248 derives `0414` from a scan showing `0410`–`0413` claimed
by #2219/#2235 and both `origin/main` head and the **prod** numeric ledger head still at
`0409`). Applying out of numeric order would desync file-order from apply-order for no reason.

**b) `0414` has a real, load-bearing dependency on `0411` — this is not cosmetic.**
`0411_bug019_cleanup_expired_data_lock_timeout.sql` does `CREATE OR REPLACE FUNCTION
cleanup_expired_data()`. On Postgres/Supabase, `CREATE OR REPLACE` re-triggers `ALTER DEFAULT
PRIVILEGES`, which re-grants `anon` and `authenticated` EXECUTE on the function **even though
the function already existed** (this is the exact mechanism `docs/migrations-archive/0062` and
now `0414` fight against — session-memory note `project_supabase_revoke_from_public_is_not_enough`
records five prior occurrences of this exact class before this one: 0364/0377/0378/0388/0406).
`0414` closes that same function's `anon`/`authenticated` grant.
**If `0414` applied before `0411`, `0411`'s later apply would silently re-open the hole `0414`
had just closed** — a regression introduced by correctly-ordered-looking migrations applied in
the wrong sequence. `0414`'s own file header
states this generally ("sorts after every migration that (re)defines any of these functions —
notably 0392... Because `CREATE OR REPLACE` re-grants, the revoke must come last"); this wave
is the first place that general rule has a concrete instance (`cleanup_expired_data`), and it
is a hard ordering constraint, not a style preference. **Control:** verify
`has_function_privilege('anon', 'cleanup_expired_data()'::regprocedure, 'EXECUTE')` returns
`false` after `0414` applies, not just at the end of the wave — see §2's per-migration
verification below.

No other cross-migration dependency exists in this wave: `0410` (new table,
`partner_accounts`) and `0412`/`0413` (dashboard cache estimate + a recreated view) touch
disjoint objects from everything else and from each other. `0414`'s sixteen-function list does
not include `refresh_cache_anchor_status_counts` (that function gets its own inline
`anon`/`authenticated` revoke inside `0412` itself — verified by reading both files; no
collision, no ordering need between `0412` and `0414`).

**Apply → reconcile → merge, one PR at a time — not "apply all four migrations, then merge
all three PRs."** Reason: the migration-drift gate's `ledger-orphan-prod-row` check (SCRUM-2500,
`scripts/ci/check-ledger-numeric-integrity.ts`) reddens **every other open PR on the repo**
whenever a numbered migration exists in prod's ledger without its `.sql` file on `main` (see
§3, mechanism recorded in session-memory note `project_orphan_ledger_audit_vs_prod_apply`).
Applying all five
migrations to prod up front (before any of the three PRs merges) would put four separate
orphan prefixes (`0410`, `0411`, `0412`, `0413` — or all five once `0414` joins) into
`ledger-numeric-exemptions.json` simultaneously, widening the blast radius and the duration
every unrelated open PR spends red. Landing one PR at a time keeps the exemption list to the
minimum necessary window: `0410` exempted only until #2219 merges and drops it; then
`0411`–`0413` exempted only until #2235 merges; then `0414` exempted only until #2248 merges.

---

## 2. Soak design (§1.12 T3: 48h, targeted per changed behavior)

**Window:** 48 hours minimum, starting when the union of all three branches is deployed to
`fizyjojbebyalirtjjht`'s `arkova-worker-staging` at the exact combined head (see merge-order
note below — the three PRs are file-disjoint, so a union branch should merge cleanly, but that
has to be *verified*, not assumed, before the clock starts). Generic synthetic load
(`scripts/staging/load-harness.ts`-class traffic) is supporting worker-health evidence only
per §1.12 — it does not touch `partner_accounts`, the retention cron, the dashboard cache
estimate, the calibration view, or any of the sixteen revoked functions on its own. Each PR
needs its own targeted driver plus the volume/concurrency backdrop
(session-memory notes `feedback_soak_evidence_standard` and `feedback_soak_merge_grade_procedure`
item 12: **5k–10k req/hour sustained, not a single seeded probe**).

### #2219 — partner-provisioning router (`0410`)

- **Full CAS lifecycle, both success and rejection paths**, driven through the real HTTP
  surface (`POST /api/partner-provisioning` → `approve` → `provision`, and separately →
  `reject`), not just direct RPC calls to `partner-provisioning.ts` (which already has 22 unit
  tests and is out of scope for the soak — the soak's job is the *router's* auth/persistence
  layer, not the machine's pure logic).
- **Authorization boundary, actively probed, not just read from the code**: sponsor-org
  `owner`/`org_admin` must get 403 on approve/reject/cancel/provision (the router is stricter
  than the machine, which admits them — confirmed by reading `partner-provisioning-router.ts`'s
  own doc comment); only platform admins succeed. Self-provision by the requester must be
  blocked (the router's own stated fix for a gap in the machine).
- **The open-request uniqueness constraint under concurrency**: fire two concurrent `POST
  /api/partner-provisioning` requests for the same `(sponsor_org_id, lower(partner_name))`
  while one is `requested`/`approved` — exactly one must succeed, the other must surface the
  `23505` from `partner_accounts_open_request_uniq` as a clean 4xx, not a 500.
- **`FORCE ROW LEVEL SECURITY` verified live, not just in the migration file**: an
  `authenticated` JWT against the rig's PostgREST must get zero rows / permission-denied on
  direct table access, confirming the "no policy for authenticated" design holds outside the
  file's own header commentary.
- **`ENABLE_PARTNER_PROVISIONING` flag-off behavior**: with the switchboard flag dark, every
  route under the prefix must 404 (not 401) — the router's stated design goal ("an
  unauthenticated caller sees the same 404 as a dark surface, and never a 401 that would
  confirm it exists"). Toggle the flag on the rig mid-soak and re-verify both states.

### #2235 — data-integrity cluster (`0411`–`0413`)

- **`0411` / BUG-019, forced-timeout branch**: this is the fix's whole point and the hardest
  behavior to exercise passively. Hold a competing lock on `audit_events` (a manual `LOCK TABLE
  audit_events IN ACCESS EXCLUSIVE MODE` in a separate session, held >5s) while the daily
  `POST /cron/cleanup-retention` fires, and confirm: (a) the call returns 200 with
  `audit_events_purge_skipped: true` and `audit_events_deleted: -1`, not a 500; (b)
  `reject_audit_delete` is still attached to `audit_events` afterward (the subtransaction
  rollback restored it); (c) the other three retention deletes (webhook logs, verification
  events, AI usage events) still ran. Then let a normal (uncontended) run happen and confirm
  the audit purge completes and reports a real count. Both branches, not just the happy path —
  the happy path was never broken.
- **`0412` / BUG-009, the actual soak-design point of interest**: `pg_class.reltuples` only
  becomes untrustworthy (`-1`/`0`/stale) on a table that hasn't been analyzed recently or was
  just bulk-loaded — which the anchors table on a fresh rig genuinely is. **Force at least two
  `ANALYZE anchors` cycles during the window** (once early, once after seeding enough rows to
  materially change the row count) and capture `refresh_cache_anchor_status_counts()`'s output
  and `total_source` around each: pre-analyze it should read `exact` or `unavailable`,
  post-analyze `estimate`, and `total`/`SECURED` must never render `0` when the table is
  non-empty (the exact bug BUG-009 fixed) and must never render as a *count* when
  `total_source != 'estimate'|'exact'` (i.e. `-1` must survive to the API response, not get
  coerced to `0` somewhere downstream — check both `/jobs/smoke-test`'s `anchor-count` check,
  which #2235 also touches, and the admin dashboard reader).
- **`0412`'s own new anon/authenticated revoke** (`refresh_cache_anchor_status_counts`,
  discovered by the CI ratchet mid-authorship of this migration): verify
  `has_function_privilege('anon', ..., 'EXECUTE') = false` on the rig, same as the `0414`
  functions below — this one ships inside `0412`, not `0414`, so it needs its own check or it
  will be silently skipped by a soak plan that only remembers to check `0414`'s sixteen.
- **`0413` / BUG-011**: fire `POST /jobs/calibration-refit` (registered cron `0 3 * * 1`) and
  confirm 200 instead of the prod `PGRST205`; confirm the view's RLS-invoker semantics by
  querying it as a non-service_role role and confirming zero rows / denied, matching the
  `security_invoker = true` + explicit revoke in the file. This job is read-only/advisory
  (proposes calibration knots, applies nothing), so a full month-long refit cycle is not
  required — one manual trigger plus the scheduled Monday 3am firing inside the 48h window is
  sufficient evidence the route itself works end to end.
- **`cron.ts` BUG-002 fix** (schema-column correction for `check-credential-expiry`,
  landing in the same PR): fire `POST /cron/check-credential-expiry` against seeded anchors
  with `expires_at` inside the 7/30/90-day windows and confirm the webhook payload matches
  `ComplianceDocumentExpiringPayloadSchema` (strict) — `public_id`, not the internal
  `anchors.id`, ships (§6 "Exposing `user_id`/`org_id`/`anchors.id` publicly" — the pre-fix
  code shipped the UUID and only survived because the event type was unregistered/unvalidated).

### #2248 — anon/authenticated revoke replay (`0414`)

- **Every one of the sixteen functions, both axes, probed live against the rig's PostgREST**
  — not re-derived from the file, actually called. `anon` (unauthenticated) request: all
  sixteen must 401/403/permission-denied. `authenticated` (any signed-in, non-privileged) JWT:
  fourteen must be denied, and the two exceptions — `get_user_monthly_anchor_count` and
  `get_pipeline_stats` — must **succeed**, matching prod's deliberate ACL. This is the direct
  regression test for the exact defect the first cut of this migration shipped (over-revoking
  `authenticated` on those two, caught by review before merge, per the campaign doc's defect
  #2) — the soak is the second, independent confirmation of the same fix on live infrastructure,
  not a repeat of the code-review finding.
- **The two live UI paths, exercised through the frontend, not just the RPC**: log in against
  the rig as a normal user and load whatever surface calls `useEntitlements.ts`'s monthly-count
  hook; separately hit `PipelineAdminPage.tsx`'s client-RPC fallback (may require simulating the
  worker route failing, since that's a *fallback* path — otherwise this leg is only proven at
  the RPC layer, which is necessary but not sufficient given the hook's silent-degrade-to-0
  failure mode this migration exists to protect).
- **Prod-no-op assertion, on the rig standing in for prod**: since the file claims to be a
  no-op against prod's actual ACL, the rig — being freshly built at `clean_mirror` from the
  same repo, i.e. in the *pre-0414* state the file is designed to fix — is exactly the
  environment where re-running `0414` a second time (idempotency check) and diffing the ACL
  before/after is meaningful evidence, distinct from "trust the file comment that it's a no-op
  on prod" (which cannot be verified on a rig at all, only on prod itself — out of scope here).
- **`http*` exclusion, negative-control**: confirm `extensions.http`/`http_get`/etc. remain
  anon-executable on the rig post-apply (the file explicitly does NOT touch them) — proves the
  migration didn't over-reach past its stated sixteen-function scope.

### Cross-cutting: per-org isolation check

Seed at least two organizations on the rig (one already exists from the baseline fixture,
per the rebuild doc — seed a second). Run the partner-provisioning CAS flow, the
credential-expiry cron, and the dashboard-cache refresh against **both orgs concurrently**
and confirm: `partner_accounts` rows for org A are invisible to a service-role query scoped to
org B's context where the router enforces `sponsor_org_id`; the expiry cron's `groupByOrg`
dispatches org-scoped webhooks only (no cross-org leakage in `dispatchWebhookEvent` payloads);
`0412`'s cache refresh is a global singleton (`pipeline_dashboard_cache`, one row,
`cache_key='anchor_status_counts'`) by design — confirm that's the *intended* shape (it is:
this is a platform-wide admin metric, not per-org) rather than mistaking the absence of
per-org partitioning for a bug.

### Rollback rehearsal, per migration, per the Doc Update Matrix procedure

Each of the four files carries a `-- ROLLBACK:` block. §4's Doc Update Matrix procedure
(`supabase db push` → regenerate types → seed update → `supabase db reset` → apply →
rollback → confirm → re-apply → confirm) gets run **individually per migration on the rig**,
in landing order, mirroring the precedent already set on this exact rig class (the 72h launch
RC manifest rehearsed 5/7 of its migrations this same way —
`docs/staging/launch-72h-2026-08/rollback-rehearsal-0370-0377.json`):

1. `0410`: apply → confirm table/RLS/policy state → rollback (drops the table — the file's own
   comment warns this is destructive if any request has reached `approved`/`provisioned`, so
   rehearse this **before** seeding CAS-flow data that would be lost) → confirm absence →
   re-apply → confirm identical state (idempotent `CREATE TABLE IF NOT EXISTS` + `DROP POLICY
   IF EXISTS`/`DROP TRIGGER IF EXISTS` guards).
2. `0411`: apply → confirm `cleanup_expired_data`'s new body + grants → rollback (restores the
   pre-fix unbounded-lock body verbatim, per the file's own explicit warning about what that
   restores) → confirm restoration → re-apply → confirm.
3. `0412`: apply → confirm `refresh_cache_anchor_status_counts`'s new body + `0412`'s own
   anon/authenticated revoke → rollback (restores the 0335 body, including the un-analyzed-table
   bug) → confirm → re-apply → confirm.
4. `0413`: apply → confirm view + its security-invoker/grant state → rollback (`DROP VIEW`) →
   confirm `calibration-refit` route 500s again as it does on unfixed prod → re-apply → confirm.
5. `0414`: apply → confirm the sixteen-function ACL state (both axes) → rollback (the file's own
   rollback block, explicitly labeled in its header as restoring "the INSECURE" pre-fix state,
   present only to satisfy the rehearsal gate) → confirm the anon-executable regression is
   real and reproducible → re-apply → confirm closed again. **Do this rollback rehearsal step
   LAST in the sequence and re-apply immediately** — of the five, this is the one where the
   rolled-back state is an active security regression on whatever rig it's rehearsed against,
   not merely a functional regression; minimize the window it's live.

After each individual apply (not just each rollback/reapply cycle), run
`NOTIFY pgrst, 'reload schema'` where the file requires it (`0410`? no — new table, PostgREST
picks it up on next schema-cache refresh cycle either way, but issuing it costs nothing and
removes a variable; `0411`/`0412` explicitly `NOTIFY` in-file already; `0413` explicitly
`NOTIFY`s already; `0414` explicitly documents it does **not** need one, being grant-only with
no signature change — confirm PostgREST actually still serves the sixteen functions correctly
post-`0414` without a manual reload, as a live check of that claim).

---

## 3. THE MERGE-PATH DECISION

Two options exist. **Recommendation: (a).** The reasoning below is not a coin flip — tracing
the actual CI mechanics shows (b) does not achieve what it might appear to promise for this
specific wave.

### Option (a) — prod-apply-before-merge, per §0 rule 10 / migration-drift gate mechanics

Apply each migration to prod via the Supabase MCP `apply_migration` tool, then reconcile the
ledger row to its numeric prefix per CLAUDE.md §0 rule 10 (`UPDATE
supabase_migrations.schema_migrations SET version='NNNN' WHERE name='<file>' AND version !~
'^[0-9]{4}$'`), confirmed via `list_migrations` showing the numeric head — **before** that
migration's owning PR merges. This satisfies `migration-drift.yml`'s "PR numeric ledger drift"
check, which has no "authored but not yet applied" passing state (session-memory note
`project_migration_drift_gate_mechanics`). Do this once per migration, in the
landing order from §1, immediately followed by that PR's merge, before moving to the next.

### Option (b) — deferred/RC-manifest path (`deferred_consolidated_soak`, SCRUM-2980)

Bind all three PRs' exact head SHAs into one RC manifest under `docs/staging/rc-manifests/`,
set `soak_mode: "deferred_consolidated_soak"`, and let the manifest satisfy the **Staging Soak
Evidence Gate** for all three without each PR carrying its own duplicated `## Staging Soak
Evidence` block — valid only while `DEPLOY_WORKER_PAUSED=true` is positively confirmed live
(currently `true`, per `gh variable get DEPLOY_WORKER_PAUSED` at write time — but see the
pre-mortem's PM-6 below on how long that can be trusted to hold).

### Why (b) does not actually change the migration-apply requirement — the finding that
decides this

`deferred_consolidated_soak` waives `scripts/ci/check-staging-evidence.ts`'s evidence
requirement. It has **no effect whatsoever** on `migration-drift.yml`'s "PR numeric ledger
drift" check — that is a structurally separate gate, reads nothing from
`DEPLOY_WORKER_PAUSED`, and its only bypass (`exempt_regex`) is a hardcoded legacy `0022`–
`0310` carve-out that cannot cover `0410`–`0414`. **Confirmed against real precedent, not
inferred**: the one existing manifest that used `deferred_consolidated_soak` with real
migrations attached —
[`rc-manifests/rc-2026-08-launch-72h.json`](rc-manifests/rc-2026-08-launch-72h.json)
(Wave G, five T3 migration PRs including `0375`/`0376`) — still applied every migration to
prod and reconciled the ledger **before** its owning PR merged, using the exact same
apply-then-exempt-then-merge mechanism as option (a); its `prod_cutover.residual_note` records
this explicitly ("Migrations at prod: ledger head 0378 + 0375 applied and numerically
reconciled (`0375` exempted in `ledger-numeric-exemptions.json` until #1739 lands)"). What
`deferred_consolidated_soak` actually deferred there was the **staging soak evidence** for the
worker-code surfaces, not the migration-apply step — the manifest's own `migration_plan` block
tracked `rollback_proof`/`reapply_proof` as real, already-completed rehearsals, not deferred
ones.

So the real content of "choosing (b)" for this wave is narrower than it sounds: it would let
the three PRs merge **before** the 48h soak in §2 fully matures, on the strength of the
manifest alone, with real evidence backfilled into the manifest before the eventual prod
*deploy* (not merge) — while still requiring the exact same prod-apply-before-merge dance for
every migration regardless. Given that this wave's whole point is to *validate* the highest-
blast-radius change class in the repo (hot-table FKs, a new provisioning surface with CAS
transitions, and a widened security-revoke replay) before it reaches `main`, letting the PRs
merge ahead of the soak completing gains speed at the cost of exactly the assurance the soak
exists to provide — and gains it only for the code-surface evidence, not the migration-apply
sequencing, which is identical either way.

**Recommendation: (a).** Run the real 48h soak from §2 to completion, on the rig, before any
of these three PRs merges. Use the RC-manifest mechanism *only* in its general §1.12
sense — one shared document centralizing the real, matured evidence for all three PRs
(so each PR body can cite `RC manifest path: docs/staging/migration-t3-wave-rc-<date>.json`
instead of triplicating a near-identical soak narrative) — **without** setting `soak_mode:
"deferred_consolidated_soak"**. That gets the documentation efficiency of (b) without its
actual effect (unsoaked-at-merge-time code on `main`), and it costs nothing given (b)'s
apparent time savings don't materialize for the migration-apply gate anyway.

### The orphan-audit interaction (accepted friction, not a blocker)

Every prod-apply under option (a) — for `0410`, then `0411`–`0413`, then `0414` — will trip
`ledger-orphan-prod-row` (SCRUM-2500, mechanism recorded in session-memory note
`project_orphan_ledger_audit_vs_prod_apply`) against **every other open PR**
whose checked-out tree lacks that prefix, for as long as the owning PR stays unmerged. This is
known, accepted friction with a documented reconcile, not a design flaw: add the just-applied
prefix(es) to `scripts/ci/snapshots/ledger-numeric-exemptions.json` with a dated reason
immediately after each apply, and **remove it the moment the owning PR merges and lands its
`.sql` file on `main`** (a stale exemption masks a future real drift on that prefix — the
audit's own `auditStaleExemptions()` warns on this, per the current `HANDOFF.md` §Now entry on
the ledger). Landing one PR at a time (§1) keeps this to one or a small batch of prefixes
exempted at a time rather than all five simultaneously.

---

## 4. Pre-mortem — it is 2026-08-27 and this wave caused an incident. Why?

**PM-1 — `0414` applied before `0411`, silently re-opening `cleanup_expired_data`'s
anon/authenticated grant.**
Covered in depth in §1(b). If the landing-order discipline slips — e.g. an RTE applies `0414`
out of turn because it's the smallest/simplest-looking file, or because #2248 happens to get
picked up first in some batch tooling — `0411`'s later `CREATE OR REPLACE` re-triggers `ALTER
DEFAULT PRIVILEGES` and reopens exactly the hole `0414` just closed, and nothing in either
file's own CI check catches a wrong-order *prod apply* (the gates check ledger presence and
grant statements inside a file, not the temporal sequence two separately-applied files were
executed in). *Control:* apply strictly in the §1 order; after `0414` applies, immediately
re-verify `has_function_privilege('anon', 'cleanup_expired_data()'::regprocedure, 'EXECUTE') =
false` as a standalone check, not folded into a end-of-wave summary check that would only catch
this after the fact.

**PM-2 — the two hot-table FKs in `0410` queue behind a long reader despite the `lock_timeout`
guard, because the guard bounds the *wait*, not the *retry storm*.**
The guard (`SET LOCAL lock_timeout = '5s'`) means a single apply attempt fails fast rather than
camping the FIFO queue — this closes the 2026-08-11 P0 mechanism for a *single* apply. It does
not by itself prevent an apply script that retries in a tight loop from re-queuing repeatedly
against the same long reader, which has a similar (if bounded-per-attempt) effect. *Control:*
apply `0410` during a low-write window on the rig (not mid-load-test), with a single manual
apply attempt and a real wait-and-retry-later posture on failure — not an automated retry loop.
Also worth having ready: `SELECT * FROM public.get_lock_waits(30)` (migration `0409`,
already on this rig's ledger head) to see any queued lock **before** committing to the apply
window, since that function exists specifically to make this visible ahead of time now.

**PM-3 — `0414` revokes something prod actually needs that this cycle's sweep still missed.**
The first cut of `0414` already over-revoked `authenticated` on two functions and was caught
by code review before merge (campaign doc defect #2) — proof the sweep process finds real
misses, not proof it has now found all of them. The current file's authority for "prod grants
authenticated on exactly these two" is a live `has_function_privilege` sweep against
`vzwyaatejekddvltxyye` dated 2026-08-18; if a function acquired a new browser caller between
that sweep and this wave's actual prod-apply, the file would be stale in a way neither CI check
nor this document can catch by inspection. *Control:* the per-function soak-time probe in §2
(all sixteen, both axes, driven live) is the control — re-run the exact live `pg_get_function_
identity_arguments` + `has_function_privilege` sweep against prod (not the rig) immediately
before the prod-apply step for `0414`, not just trust the file's 2026-08-18 snapshot. The CI
ratchet (`secdef-function-grants.ts`'s `DELIBERATELY_AUTHENTICATED` set) is a second, independent
control that would catch a *future* PR trying to revoke either of the two kept grants — it does
not validate that the two-function list is complete today.

**PM-4 — rig-vs-prod divergence during the 48h window: prod's migration ledger or grant state
moves while this wave is soaking.**
The rig was built `clean_mirror` at prod ledger head `0409` today. If a *different* PR's
migration gets prod-applied during this wave's 48h window (entirely plausible — multiple
migration-carrying PRs are open across the repo right now), the rig silently stops being
representative of prod, and this wave's soak evidence would be graded against a state prod no
longer matches. *Control:* either (i) treat this rig as reserved/exclusive for this wave for
the 48h window — no other PR's migration gets prod-applied against `fizyjojbebyalirtjjht`
during that time (a §1.11A "clean, exclusive use" declaration, not a technical lock) — or (ii)
if another migration does land on prod mid-window, re-run `staging-honesty-preflight.ts` and
diff `list_migrations` against prod again before trusting the remaining soak hours, and note
the divergence explicitly in the evidence rather than silently continuing.

**PM-5 — `supabase/migrations/agents.md` collides between #2219 and #2235 (documented failure
class, CLAUDE.md §6).**
Both PRs append a new `## Recent migrations (...)` section at the **identical** anchor point —
the same trailing paragraph about `0408`'s `credential_type` drift (verified by diffing both
PRs against `origin/main`: both hunks are `@@ -559,3 +...`). This is precisely the pattern
CLAUDE.md §6 names ("two PRs collide → loser dequeued from Mergify"). Both PRs already follow
the recommended mitigation shape — each titles its own block distinctly (`## Recent migrations
(PR #2219)` vs `## Recent migrations (data-integrity soak cluster — BUG-019 / BUG-009 /
BUG-011)`) rather than using an identical unnamed heading, which is what makes a union-resolve
possible — but a collision at merge time (whichever of #2219/#2235 merges second inherits a
conflicting base) is still likely enough to plan for. *Control:* per §1's order, #2219 merges
first; before queuing #2235, rebase its branch onto post-#2219 `main` locally and resolve
`agents.md` as a **union of both sections** (doc-only file, explicitly no-re-soak per CLAUDE.md
§6's own guidance) rather than letting Mergify discover the conflict and dequeue #2235
mid-queue. #2248's single-line mid-table insertion (a different anchor point entirely,
verified by diff) does not collide with either.

**PM-6 — `DEPLOY_WORKER_PAUSED` flips to `false` mid-wave, independent of this wave's own
timeline.**
The variable is currently `true`, but *because of* the unrelated chain-pair + rate-limit T3
soak on the other rig, which closes ~2026-08-21T16:51:23Z — close in time to when this wave's
own 48h clock (if started today) would also close. If that other soak's exit un-pauses
deploys before this wave's three PRs have all merged, a merge of any of them (all touch
`services/worker/`) would deploy to prod immediately on merge, collapsing the "soak first,
merge after" sequencing this whole document is built around into "soak, but the last PR to
merge ships live the moment CI goes green." *Control:* this is exactly why option (a) does not
lean on `DEPLOY_WORKER_PAUSED` at all — under (a), each PR's merge-readiness is gated by its
own real, matured soak evidence and the migration-drift ledger reconcile, not by the pause
variable's state. Whether prod deploy resumes mid-wave is a separate, acceptable risk *iff*
each PR has already independently earned Ready status on its own soak evidence by the time it
merges — which is the plan in §1/§2 regardless of what the pause variable does. Check
`gh variable get DEPLOY_WORKER_PAUSED` again immediately before queuing each of the three PRs,
not just once at the start of the wave.

**PM-7 — PostgREST schema-cache staleness after an apply that "doesn't need" a reload.**
`0410` (new table) and `0414` (grant-only, no signature change) both reason, correctly, that
they don't strictly require `NOTIFY pgrst, 'reload schema'`. That reasoning is about PostgREST
picking up the *new* state eventually via its own cache-refresh cycle, not about the *interval*
during which the router (#2219) or a soak probe (`0414`'s live per-function checks) might
observe stale schema/grant state and produce a false pass or false fail. *Control:* issue
`NOTIFY pgrst, 'reload schema'` after every apply in this wave regardless of whether the file
strictly requires it — §2 already plans this for `0410`; extend the same discipline to `0414`,
and confirm via a fresh unauthenticated probe immediately after each `NOTIFY` that the change
is actually visible over PostgREST, not just in `pg_proc`/`information_schema` directly.

**PM-8 — the CAS uniqueness index (`0410`) or the retention-cron subtransaction (`0411`) pass
in isolation but fail under the wave's own concurrent-load backdrop.**
§2's cross-cutting per-org isolation check and the mandated 5k–10k req/hour volume backdrop
(`feedback_soak_merge_grade_procedure` item 12) exist precisely because a targeted single-probe
soak has repeatedly proven insufficient on this codebase — a duplicate-request race in
`partner_accounts_open_request_uniq`, or a real lock contention event triggering `0411`'s
`lock_not_available` branch, are both far more likely to surface under sustained concurrent
load than under one or two manual probes. *Control:* run the targeted probes from §2 **during**
the sustained-load window, not before/after it as a separate cleaner phase — the whole point is
to catch interaction effects the isolated probes would miss.

---

## 5. Explicit asks for Carson

This wave does not proceed past this document without explicit sign-off. Specifically:

1. **Approve (or reject/amend) the landing order** in §1 — `0410` → `0411`–`0413` → `0414`,
   applied to prod and reconciled one migration-owning PR at a time, never batched.
2. **Approve (or reject/amend) the merge-path recommendation** in §3 — option (a),
   prod-apply-before-merge for every migration, with the RC-manifest used only to centralize
   real soak evidence (not `deferred_consolidated_soak`). If you'd rather trade the
   assurance-before-merge property for speed via the deferred mode, say so explicitly — it is
   available, understood, and not what this document defaults to.
3. **Approve running the 48h T3 soak** described in §2 against `fizyjojbebyalirtjjht` /
   `arkova-worker-staging`, including the rollback rehearsal sequence for all four migration
   files (destructive for `0410` specifically if run after CAS data exists — §2 sequences it
   first for that reason).
4. **Confirm exclusive use of the rig for the 48h window** (PM-4) — or explicitly accept the
   alternative of re-preflighting mid-window if another migration lands on prod concurrently.
5. **Confirm the `docs/staging/staging-rig-rebuild-2026-08-19.md` doc-only PR can land on
   `main` independently** (T0, no code, per the §0.10 carve-out) — a light, separate ask,
   not gated on anything above.

**Nothing is readied. No PR moves to `gh pr ready`, no migration is applied, and no soak
starts until this document is explicitly approved.**
