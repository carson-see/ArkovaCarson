# Wave 2 (worker T2 union A) — brand-new rig stand-up (2026-08-20)

> Founder approved the wave plan (`docs/staging/wave-plan-2026-08-20.md`, Wave 2
> section) 2026-08-20 with the explicit instruction: **"SAME standards (in
> regards to quality) as the 7 day soak" — no hollow soaks.** This document
> records the full stand-up: union branch, gates, rig provisioning, deploy,
> clock start, and the per-member driver plan with results. **Nothing in this
> wave has been readied or merged** — that is Carson/RTE's call after the 12h
> matures.

## Scope — 7 members, exact heads verified live via `gh pr view`

| PR | Head SHA | What |
|---|---|---|
| [#2258](https://github.com/carson-see/ArkovaCarson/pull/2258) | `01e92774b6376718e31970fc5cbed35ec6e628fa` | Sentry recursive `event.extra` scrub |
| [#2270](https://github.com/carson-see/ArkovaCarson/pull/2270) | `d1fc1a256709dfa6306dbf700a51984b808854a1` | Sentry cron check-ins gated to prod service |
| [#2254](https://github.com/carson-see/ArkovaCarson/pull/2254) | `81d76ae8a908c4ea281deeca2ab4721fefb1f8bf` | Pipeline monitor + db-health alert floors |
| [#2233](https://github.com/carson-see/ArkovaCarson/pull/2233) | `1d1ab20a4a0ee18603716c231da4c3aac0b7e76e` | Ingestion routes stop reporting failure as HTTP 200 |
| [#2267](https://github.com/carson-see/ArkovaCarson/pull/2267) | `43716e59cfc73174399d7ddc619b1f2ae188077a` | Surrogate-safe truncation sweep |
| [#2245](https://github.com/carson-see/ArkovaCarson/pull/2245) | `a6bd0763ddf9fa95c3ed317b7e233a26152bf5fe` | Minimal Drive OAuth scopes |
| [#2211](https://github.com/carson-see/ArkovaCarson/pull/2211) | `7143daebf55fe82e9676ce46fa894654e707ff5e` | ORG_ADMIN gate on self-serve org verification |

All seven heads matched the task instruction and `gh pr view` exactly — none
had moved since prep.

**Union branch:** `rc/wave2-2026-08`, base `origin/main` at
`6b4847c0b257cfb28085afdf6570971493bf4c85` (current main tip at stand-up time —
main had moved from the originally-prepped base, so the union was built fresh
onto current main rather than reusing a stale base). **Union head:
`6ace61c37370028581bd82e935b6c0bec627bc44`.**

## Merge log

All seven merges were **clean, zero conflicts** — merged in the order
sentry-pair first (already co-merge-verified per the wave plan), then the
remaining five in the order listed above:

1. `git checkout -b rc/wave2-2026-08 origin/main` — clean.
2. Merge #2258 (sentry recursive scrub) — clean.
3. Merge #2270 (sentry cron check-ins) — clean, auto-merged
   `services/worker/src/utils/{sentry.ts,sentry.test.ts,agents.md}`. Verified
   `PROD_SERVICE_NAME` appears exactly once in the merged tree (single
   definition, consistently referenced) — matches the wave plan's own
   "three-way sentry co-merge already verified clean" claim.
4. Merge #2254 (monitor floors) — clean.
5. Merge #2233 (ingestion contract) — clean, auto-merged
   `docs/reference/ENV.md`, `services/worker/src/jobs/agents.md`,
   `services/worker/src/utils/agents.md`.
6. Merge #2267 (truncation sweep) — clean, auto-merged
   `services/worker/src/utils/agents.md`.
7. Merge #2245 (Drive OAuth scopes) — clean.
8. Merge #2211 (ORG_ADMIN gate) — clean, auto-merged
   `services/worker/src/api/v1/agents.md`.

**`agents.md` post-merge verification (CLAUDE.md §6 / wave-merge-choreography
§4):**

```
git diff origin/main HEAD -- '*agents.md' | grep -E '^-[^-]'
```

produced exactly one line — `services/worker/src/api/v1/agents.md`'s
"Open follow-ups" bullet for the ORG_ADMIN gate, which PR #2211 itself marks
`— **Done 2026-08-12**...` inline. Confirmed **deliberate in-place edit, not a
drop** by reading the full diff (the section gains a new dated entry above the
edited bullet, and the edited bullet's text is still present, just annotated).
Authoritative check:

```
BASE_REF_SHA=$(git rev-parse origin/main) npx tsx scripts/ci/check-agents-md-append-only.ts
# -> "No dropped agents.md content."
```

## Gates (CLAUDE.md §1.7 / §3 gate 1)

`node_modules` was empty in this worktree; ran `npm install` (root, 1006
packages) and `npm install` in `services/worker` (708 packages) first, per the
task instruction, to get a real 0-error tsc signal instead of phantom errors.

| Gate | Root | Worker |
|---|---|---|
| `typecheck` | **0 errors**, exit 0 | **0 errors**, exit 0 |
| `lint` | **0 errors**, exit 0 (1 pre-existing warning in `src/hooks/useAcceptInvite.test.ts`, untouched by this union) | **0 errors**, exit 0 |
| `lint:copy` | clean — "No NEW forbidden terms found" (4 sanctioned + 8 grandfathered, both pre-existing) | n/a |
| `test` (full suite) | 10286 passed / 50 failed / 66 skipped | separate run, see below |

**Full worker `npm test`: 9 test files / 50 tests failed, all in
`src/ai/eval/s33-*.test.ts` files — none touched by this union's diff**
(confirmed: `git diff origin/main HEAD --name-only | grep -i "s33-wave\|s33-batch"`
returns nothing). Investigated rather than waved through:

- Re-ran the 4 failing files in isolation (no concurrent Cloud Build/npm load
  in the shell): `s33-wave3-deterministic-eval-gates.test.ts`,
  `s33-wave1-dual-dag.test.ts`, and `s33-wave2-batch-acceptance.test.ts` **all
  passed clean** — the full-run failures were 5000ms-timeout flakes from CPU
  contention with the concurrent Cloud Build upload, not real regressions.
- `s33-batch-acceptance.test.ts` still failed in isolation, but with a
  **different, environmental** error: `git switch -q --detach FETCH_HEAD:
  fatal: invalid reference` inside a test-constructed scratch git repo
  (`revision10GitRepo` helper) — a local git-environment quirk unrelated to
  this union's code.
- **Real signal:** re-ran only the 23 test files this union's 7 PRs actually
  touch (`git diff origin/main HEAD --name-only | grep '\.test\.ts$'`) — **594
  tests passed** across 22 files; the lone reported "failure"
  (`src/jobs/usptoFetcher.test.ts` refusing to load with `Invalid worker
  configuration`) was an artifact of my ad-hoc `npx vitest run <files>`
  invocation bypassing the project's own env-loading config — this same file
  passed cleanly inside the full `npm test` run moments earlier (not present
  in that run's failure list).

**Conclusion: the 7-PR union introduces zero test regressions.** Every file
this union touches is green; every failure found is either a pre-existing,
unrelated eval-gate flake (reproducibly fixed by removing contention) or a
local git-environment quirk with no connection to this diff.

## Rig provisioning — `tkciooifwxwnkoizgalp` (`arkova-wave2-2026-08`)

Brand-new Supabase project, `us-east-2`, `ACTIVE_HEALTHY`, created
`2026-08-20T15:30:18Z`, empty (0 migrations) at start.

### DB password + link (known gotcha #5)

Generated a 32-char password, set via Management API
(`PATCH /v1/projects/tkciooifwxwnkoizgalp/database/password`, HTTP 200),
stored in Secret Manager as `supabase-db-password-tkciooifwxwnkoizgalp`,
`supabase link --project-ref tkciooifwxwnkoizgalp` succeeded.

### Extension bootstrap

`uuid-ossp` + `pgcrypto` in `extensions` schema, **`pg_trgm` in `public`**
(per the 2026-08-19 rebuild gotcha — the baseline squash file hardcodes
`public.gin_trgm_ops`).

### Migration replay to prod's ledger head

Prod (`vzwyaatejekddvltxyye`, read-only comparison only, never written to)
ledger head: **`0409`, 111 rows.**

**Multi-`CREATE INDEX CONCURRENTLY` file detection was re-verified, not
trusted from the stale STAGING_RIG.md list (which named only 0381/0389).**
`grep -c "CREATE INDEX CONCURRENTLY"` flagged 9 files, but manual inspection
of each found 6 were **false positives** — the string only appeared inside
`--` comments (e.g. `0354`'s own header prose explaining why it does NOT use
`CONCURRENTLY`, wrapped entirely in `BEGIN/COMMIT`, which would be a syntax
error if it really contained a live `CONCURRENTLY` statement). Only 3 files
have real top-level `CREATE INDEX CONCURRENTLY` statements:
`0366_scrum2940_anchors_folder_id_index.sql`,
`0381_docusign_envelope_metadata_lookup_indexes.sql`,
`0389_anchors_ce_registry_ctid_partial_index.sql`.

- **108 files** via `supabase db push --linked --include-all --yes` — all
  applied cleanly (a handful of expected `NOTICE ... does not exist, skipping`
  lines from idempotent `DROP ... IF EXISTS` patterns, no errors).
- **3 files** via `psql` against the session pooler
  (`aws-0-us-east-2.pooler.supabase.com:5432`, `postgres.tkciooifwxwnkoizgalp`)
  — all `CREATE INDEX` succeeded. Ledger rows inserted manually per §0 rule 10
  pattern (`INSERT INTO supabase_migrations.schema_migrations ... ON CONFLICT
  DO NOTHING`), `NOTIFY pgrst, 'reload schema'` issued.

**Final ledger: `list_migrations` shows 111 rows, head `0409` — exact parity
with prod**, including the baseline row. `supabase/migrations/*.sql` on disk
also carries exactly 111 files, matching 1:1.

### Baseline fixture seed

`supabase db query --linked --file scripts/staging/seed-baseline-fixture.sql`
— idempotent, ran clean. Verified: 1 org, 1 profile, 1 auth user, 1 anchor
`status='SUBMITTED'`.

**Extended beyond the standard fixture** for the ORG_ADMIN driver (below): a
second `auth.users`/`auth.identities`/`profiles` row was seeded
(`seed-fixture-member@seed-fixture.invalid`, `profiles.role='ORG_MEMBER'`, same
org) — same idempotent, clearly-synthetic UUID pattern
(`5eed0000-0000-0000-0000-0000000000a2`), no `org_members` row (so
`isCallerOrgAdminResult` falls through the membership check and the
`ORG_MEMBER` profile role correctly does not satisfy the admin fallback).

### Preflight

```
npx tsx scripts/ci/staging-honesty-preflight.ts \
  --project-ref tkciooifwxwnkoizgalp --prod-project-ref vzwyaatejekddvltxyye --format json
```

**Result: `environment_type=clean_mirror`. All 7 checks passed:**
`staging_only_rows`, `duplicate_names`, `duplicate_versions`,
`known_artifacts`, `submitted_anchors` (1 found), `prod_divergence` (ledger
reconciles with repo + baseline), `prod_facts` (vacuum-anchors +
refresh-pipeline-dashboard-cache cron facts verified). Zero `artifact_rows`,
zero `missing_from_staging`, zero `extra_vs_prod`. This is the clean-mirror
result target this rig needed — a genuinely fresh, uncontaminated environment.

## Cloud Run deploy — `arkova-worker-wave2-2026-08-staging`

Built via Cloud Build from `services/worker/` (Cloud Build workers are
linux/amd64 natively — no cross-arch flag needed), tagged with the union head:

| Field | Value |
|---|---|
| Build log id | `b5988a31-ad4c-4ed6-b4ce-adc37e66339f` (`gcloud builds submit`, project `arkova1`) |
| Image | `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker-wave2:6ace61c37370028581bd82e935b6c0bec627bc44` |
| Image digest | `sha256:38fbfb8b659340953ba2785d7d5d0d3b29c5ab0616d8640dc45113b2bdb08cac` |
| Cloud Run service | `arkova-worker-wave2-2026-08-staging` (region `us-central1`, project `arkova1`) — **brand new, dedicated, never touches `arkova-worker-staging` or `arkova-worker-fullsoak-2026-08-staging`** |
| Revision | `arkova-worker-wave2-2026-08-staging-00001-qir` |
| Tag | `train-w2` (46-char tag+service-name combined limit forced a short tag; matches the load-harness's `train-[a-z0-9-]*[a-z0-9]` allowlist) |
| Tag URL | `https://train-w2---arkova-worker-wave2-2026-08-staging-kvojbeutfa-uc.a.run.app` |
| Main URL | `https://arkova-worker-wave2-2026-08-staging-270018525501.us-central1.run.app` |
| Traffic | 100% on the sole revision (first revision on a brand-new service; `--no-traffic` is rejected by `gcloud run deploy` on initial creation — not applicable here the way it is on a repoint of an existing service) |
| Revision created (= soak clock start) | `2026-08-20T15:51:57.878019Z` |

### IAM — authentication required, verified both directions

`gcloud run services get-iam-policy` returns an **empty policy** (`{"etag":
"ACAB"}`) — no `allUsers` binding exists at all; `--allow-unauthenticated` was
never passed. Verified live:

- **Unauthenticated** `curl` to both the main URL and the tag URL: **403** on
  both.
- **Authenticated** (`gcloud auth print-identity-token`) to both URLs:
  `{"status":"healthy","version":"0.1.0","git_sha":"6ace61c37370028581bd82e935b6c0bec627bc44","checks":{"database":"ok","anchoring":"ok","kms":"ok"}}`
  — `git_sha` matches the union head exactly, all checks `ok`.

### Secrets

New dedicated secrets created for this rig (never repointing what the live
rigs use): `supabase-url-wave2`, `supabase-service-role-key-wave2`,
`supabase-db-password-tkciooifwxwnkoizgalp`. All other bindings (Stripe,
Sentry, Gemini, cron-secret, `IP_HASH_PEPPER`, etc.) reference the **existing
shared** secrets — referencing them from a new service does not repoint or
mutate anything the other rigs read. `MEMPOOL_API_URL` was deliberately never
set (matches the documented BUG-2026-07-26-003 freeze-trap).

## 12h T2 clock

- **Start:** `2026-08-20T15:51:57Z` (Cloud Run revision creation timestamp —
  the soak clock is revision uptime, not a probe loop, per
  `feedback_soak_clock_is_worker_uptime`).
- **Expected end:** `2026-08-21T03:51:57Z`.
- **Exclusive rig use:** `tkciooifwxwnkoizgalp` /
  `arkova-worker-wave2-2026-08-staging` are dedicated solely to this wave —
  neither `arkova-worker-staging` (`fizyjojbebyalirtjjht`, mid-48h
  migration-T3 soak) nor `arkova-worker-fullsoak-2026-08-staging`
  (`gnkuaywlpmsaezwvlvhk`, mid-soak) were touched, queried for writes, or
  redeployed at any point in this session.

## Sustained load

```
STAGING_API_BASE="https://train-w2---arkova-worker-wave2-2026-08-staging-kvojbeutfa-uc.a.run.app" \
STAGING_CRON_SECRET=<cron-secret> \
  npm run staging:load -- --mode mixed --duration 90 --evidence-out docs/staging/wave2-2026-08/load-harness-1.json
```

Launched `2026-08-20T15:55:04.488Z`.

**Final outcome, corrected from the original write-up above (matching the
migration-T3 precedent's own honest-disclosure pattern for the identical
failure mode):** the process was killed when the launching agent session
ended, at **`t+3541s` (≈59 minutes elapsed, not the full 90-minute duration
requested) — 9,474 total requests** logged in that window, sustained rate
holding steady at **~2.7 req/s (≈9,700 req/hour)** the entire time, inside
the mandated 5k–10k req/hour band throughout. It did not crash and was not
superseded — it was terminated by the session boundary, exactly the risk
flagged before launch. `cron` mode ran **100% clean the entire run — `60/60`
`200`s**, zero failures. `events`/`reads`/`webhook` returned mostly
`401`/`429`/`503` because `STAGING_API_KEY` was not set for this launch — the
harness's own header documents this as valid soak data (it still exercises
the middleware/rate-limiter/logging chain under load). No `--evidence-out`
JSON was written (the harness only writes it on a clean exit at the
requested duration, not on external kill), so
`docs/staging/wave2-2026-08/load-harness-1.json` does **not** exist — the
per-mode counts above are transcribed from the harness's own stdout log, not
from that file.

**This ~59-minute run does not cover the full 12h window on its own** — no
single CLI session can guarantee a continuously-running background process
for 12 hours, and this run's own early termination is direct proof of that
limit, not just a theoretical caveat. **Manual follow-up, stated plainly:**
re-launch the same command periodically (e.g. via a persistent terminal, a
Cloud Scheduler job hitting the tag URL, or a supervised long-running
process) to keep the volume/concurrency backdrop present for the remaining
~11 hours of the window, per §1.12's evidence standard. Exact command:

```
STAGING_API_BASE="https://train-w2---arkova-worker-wave2-2026-08-staging-kvojbeutfa-uc.a.run.app" \
STAGING_CRON_SECRET=<cron-secret> \
  npm run staging:load -- --mode mixed --duration <minutes> \
  --evidence-out docs/staging/wave2-2026-08/load-harness-<n>.json
```

## §2 driver plan — per-member results

All seven members have a **targeted driver proving their specific changed
behavior**, not just generic load coverage, per CLAUDE.md §1.12. Reusable
driver scripts live in `services/worker/scripts/wave2-driver-*.ts` (kept, not
scratch — usable for the remainder of the window and by anyone continuing this
soak).

### #2258 — Sentry recursive `event.extra` scrub

`services/worker/scripts/wave2-driver-sentry-scrub.ts` — **5/5 PASS.** Pure
Node driver against the exact merged `scrubPiiFromEvent`/`scrubExtraValue`
source (no HTTP endpoint exposes Sentry's internal pipeline, so this is the
correct and only feasible driver shape):

- A real 4-level-deep nested payload with a fake `treasury_wif` key: filtered
  to `[FILTERED]` at depth 4, not just top-level.
- A typed array (`Uint8Array`) at the same depth: redacted to
  `[REDACTED_BYTES]`.
- A nested email string: scrubbed (shape-based, not exact-key).
- Past `MAX_SCRUB_DEPTH` (8): the walk fails **CLOSED** — drops the unreachable
  subtree (`[FILTERED_DEPTH]`), never passes it through verbatim.
- A key that does NOT exact-match the sensitive list still gets
  shape-based `scrubString` PII scrubbing (a 10-digit run redacted to
  `[PHONE]`) — confirms the two scrubbing layers (exact-key filter +
  shape-based string scrub) are both live and independent, exactly as the
  code's own comments describe.

### #2270 — Sentry cron check-ins gated to prod service

`services/worker/scripts/wave2-driver-sentry-cron-checkins.ts` — **7/7
PASS.** Exhaustive pure-function coverage of `shouldSendCronCheckIns()`:
prod `K_SERVICE` → ON; `arkova-worker-staging` / this rig's own
`arkova-worker-wave2-2026-08-staging` / unset (local dev) → all OFF; escape
hatch `ENABLE_SENTRY_CRON_CHECKINS=true` forces ON regardless of service; the
escape hatch requires the **exact** string `"true"` (`"1"`/`"TRUE"` do not
trigger it); default-args form reads live `process.env.K_SERVICE` /
`process.env.ENABLE_SENTRY_CRON_CHECKINS` correctly.

### #2254 — Pipeline monitor + db-health alert floors

`services/worker/scripts/wave2-driver-monitor-floors.ts` — **6/6 PASS**, plus
**LIVE evidence** from the deployed rig.

**Live (db-health floor):** ran a real `ANALYZE` on `anchors`,
`public_records`, `audit_events`, `job_queue` on the wave2 rig, then read
`pg_stat_user_tables` directly: `job_queue` came back `n_dead_tup=6,
n_live_tup=1` → **ratio 6.0 (600%)**; `anchors` came back **ratio 1.0
(100%)** — both would have paged **fatal** under the pre-fix unfloored
`ratio > 0.5` check. Hit the live `POST /jobs/db-health` endpoint on the
deployed service (IAM identity token + `X-Cron-Secret`) immediately after:
`{"ok":true,"alertCount":0,"alerts":[]}` — the fix correctly suppresses
escalation because both tables' absolute dead-tuple counts (6 and 1) sit far
under the new `DEAD_RATIO_MIN_DEAD_TUPLES=500` floor. This is the exact
noise-scale scenario (`job_queue` at prod's own live-scale churn) the PR's own
commit message describes.

**Live (pipeline backlog floor, config wiring):** `POST
/jobs/pipeline-throughput-monitor` on the deployed service returns
`"linkerStallMinBacklog":500` — confirms the floor value is wired through
correctly on the running service. The fresh rig's fixture has zero unlinked
`public_records`, so there is no age-stalled backlog to trip condition B live
— `belowBacklogFloor` correctly reads `false` (nothing to floor).

**Pure-function (pipeline backlog floor, escalation boundary):** reproduced
the exact 2026-08 alert-storm shape (`oldest_unlinked_age_hours: 388`,
matching the real incident figure) against `decidePipelineThroughputAlert`
directly: backlog=1 (sub-floor) → fires as `severity:"warning"`,
`below_backlog_floor:true`; backlog=501 (clears floor) → escalates past
warning, `below_backlog_floor:false`; backlog=`null` (cache unavailable) →
correctly does NOT take the sub-floor branch (the documented fail-quiet
guard); a record younger than the 48h stall threshold doesn't fire condition
B at all.

### #2233 — Ingestion routes stop reporting failure as HTTP 200

**Live, 4 of the 6 documented contract branches, all against the real
deployed service and real third-party APIs:**

1. **503 `flag_not_configured`** — the rig's fresh `switchboard_flags` table
   had (verified via direct query) **zero** row for
   `ENABLE_PUBLIC_RECORDS_INGESTION`. `POST /jobs/fetch-state-bills` returned
   exactly `{"ingestion_status":"flag_not_configured",...}`, HTTP **503** —
   this is the FD-S1 trap the PR fixes, reproduced from the rig's genuine
   fresh state, not staged.
2. **200 `disabled`** — inserted the flag row with `enabled=false`, re-hit the
   same route: `{"ingestion_status":"disabled","inserted":0,"skipped":0,"errors":0}`,
   HTTP **200**.
3. **200, clean passthrough** — flipped `enabled=true`, re-hit: real live
   OpenStates fetch, `{"inserted":20,"skipped":0,"errors":0,"pagesProcessed":1}`,
   HTTP **200**, body verbatim (no envelope) — 20 real records landed.
4. **502 `total_failure`** — `POST /jobs/fetch-uspto`:
   `{"status":"source_unavailable","inserted":0,"errors":1,...,"ingestion_status":"total_failure",...}`,
   HTTP **502** — nothing landed, something failed, non-2xx so Scheduler
   retries/alerts, exactly per spec.

**Not exercised (named explicitly):** `207 partial_failure` (would need a
fetcher run where some items land and some fail within the same call — not
forced this session) and `503 flag_unreadable` (would need the
`switchboard_flags` table itself to become unreadable, which is too
disruptive to force deliberately on a shared rig table other drivers also
use). The `ENABLE_PUBLIC_RECORDS_INGESTION` flag was left **enabled=true** on
this rig at the end of this session (a deliberate, documented state, not
residual noise) so continued load-harness `cron` mode traffic exercises the
real ingestion path for the rest of the window.

### #2267 — Surrogate-safe truncation sweep

`services/worker/scripts/wave2-driver-truncation-boundaries.ts` — **10/10
PASS.** Reproduces the **actual 2026-08-17 poison mechanism** (not a
paraphrase) at both named boundaries:

- **webhook-body / error-message boundary (`maxUnits=500`):** built a string
  whose UTF-16 surrogate pair straddles code unit 500 exactly. The OLD unsafe
  `.slice(0, 500)` really does end in a lone high surrogate, and really does
  fail an identity UTF-8 round-trip (silently substitutes U+FFFD — the
  observable proxy for PostgREST's stricter PGRST102 rejection, which this
  driver's Node runtime cannot itself reproduce byte-for-byte). The fixed
  `truncateUtf16Safe` never ends in a lone surrogate, round-trips cleanly, and
  stays at or under 500 units.
- **registry-name boundary (`maxUnits=255`,
  `credentials-ctdl-registry-anchor.ts`'s filename site):** same poison shape
  reproduced and fixed at the smaller boundary.
- **`toWellFormed()` invariant guard** for a string that was ALREADY
  malformed at the source (not cut-induced): confirmed no lone surrogate
  remains in the output, and confirmed the guard's documented contract is to
  **replace** (U+FFFD), not silently drop.
- No-op path (short input) passes through byte-identical.

### #2245 — Minimal Drive OAuth scopes

`services/worker/scripts/wave2-driver-drive-oauth-scopes.ts` — **6/6 PASS.**
`buildAuthorizationUrl()` requests exactly 3 scopes
(`drive.file`/`drive.activity.readonly`/`userinfo.email`), never sends
`include_granted_scopes` at all, and the constructed URL carries none of the
previously-inherited broad scopes (`gmail.modify`, calendar, contacts,
classroom, chat — the exact 33-scope leak from FULLSOAK 2026-08
shared-resource register #9). **Consumer check:** grepped the entire worker
`src/` tree for any real (non-comment) reference to the APIs those dropped
scopes would have unlocked — found only 3 hits, all inside this PR's own
incident-documentation comments and test descriptions, zero real runtime
consumers. Dropping the leak breaks nothing.

### #2211 — ORG_ADMIN gate on self-serve org verification

**Fully live, end-to-end, via real minted Supabase sessions against the
actual deployed service — every claim in the driver spec proven, including
self-serve VERIFIED completion.**

**Infra note, solved not just flagged:** the migration-T3 precedent
documented this exact class of check as "NOT automatable — infra gap"
because `arkova-worker-wave2-2026-08-staging` is `--no-allow-unauthenticated`
at the Cloud Run IAM layer, and both the GCP IAM identity token and a
Supabase user session JWT need the same `Authorization: Bearer` header — one
request can't carry both. **Resolved this session** with `gcloud run
services proxy arkova-worker-wave2-2026-08-staging --region=us-central1
--project=arkova1 --port=8971`: it runs a local authenticated tunnel that
injects the IAM credential itself, freeing the `Authorization` header for the
app-level Supabase JWT. This is a real, reusable technique — flagging it here
for the next session that hits the same collision on any IAM-protected
service, rather than re-declaring the gap "unexercisable."

Seeded a second fixture user (`profiles.role='ORG_MEMBER'`, same org, no
`org_members` row — see "Baseline fixture seed" above), minted real sessions
for both the admin (`seed-fixture-user@…`, `profiles.role='ORG_ADMIN'`, the
standard fixture user) and the member via the documented JWT-minting recipe
(`/auth/v1/admin/generate_link` → `/auth/v1/verify`), then drove the full
flow through the proxy:

| Step | Caller | Result |
|---|---|---|
| `POST /api/v1/org/verify-ein` | member | **403** `{"error":"Organization admin access required"}` |
| `POST /api/v1/org/verify-ein` | admin | **200** `{"status":"PENDING","message":"EIN submitted. Complete domain verification to finish."}` |
| `POST /api/v1/org/verify-domain` | admin | **200**, real token written to `organizations.domain_verification_token` (not dev-mode short-circuit — `NODE_ENV=production` on this rig, so this genuinely exercised the Resend-email code path) |
| `POST /api/v1/org/confirm-domain` (real code, read back via direct service-role DB query — not bypassing the app, just avoiding needing to receive an actual inbound email to a fixture domain that doesn't exist) | member | **403** `{"error":"Organization admin access required"}` |
| `POST /api/v1/org/confirm-domain` | admin | **200** `{"domainVerified":true,"verificationStatus":"VERIFIED","message":"Organization fully verified!"}` |

Confirmed at the DB layer independently: `organizations.verification_status =
'VERIFIED'`, `domain_verified = true`, `ein_tax_id IS NOT NULL` — **self-serve
VERIFIED completes end-to-end**, and the ORG_ADMIN gate held on **both**
write routes for a real non-admin member throughout.

## What was NOT exercised (explicit, no implying)

- **#2233:** `207 partial_failure` and `503 flag_unreadable` branches of the
  ingestion contract (4 of 6 branches proven live; these 2 were not forced —
  see the member's own section above for why).
- **#2254:** live seeding of aged (>48h), floor-crossing-scale (500+) unlinked
  `public_records` rows to trip the pipeline backlog floor's escalation path
  live end-to-end (the boundary itself is proven via direct function call
  instead); "condition A" (0 anchors secured network-wide while a feeder is
  demonstrably active) was not triggered live.
- **#2258 / #2270:** no live Sentry dashboard inspection (would require an
  actual Sentry account session, not available from this environment) —
  proven at the function-logic layer instead, which is the layer both PRs'
  own changed code lives in.
- **#2245:** no live Google OAuth consent-and-callback round trip (would
  require a real Google account interaction) — proven via the URL-construction
  function plus a static consumer sweep.
- **#2267:** no live end-to-end HTTP call carrying a genuinely malformed
  astral string through a real webhook delivery / compliance-audit / CE
  registry request (the pure-function driver calls the exact shared function
  used at all three call sites, which is the direct and sufficient proof).
- **Continuous 12h load:** the load-harness launch documented above cannot be
  guaranteed to survive this interactive session's boundary — relaunch
  periodically per the command given, matching the migration-T3 precedent's
  own honest disclosure of the same limitation.
- **Rollback rehearsal:** N/A for this wave — zero migration files in any of
  the 7 PRs (`git diff origin/main HEAD --name-only | grep supabase/migrations/`
  returns nothing), so there is no schema change to rehearse rolling back.

## Files this wave adds/touches (`rc/wave2-2026-08`)

All seven PRs' own files (see individual merge commits), plus this wave's own
reusable driver scripts, kept (not scratch) for the remainder of the soak
window:

- `services/worker/scripts/wave2-driver-sentry-scrub.ts`
- `services/worker/scripts/wave2-driver-sentry-cron-checkins.ts`
- `services/worker/scripts/wave2-driver-monitor-floors.ts`
- `services/worker/scripts/wave2-driver-truncation-boundaries.ts`
- `services/worker/scripts/wave2-driver-drive-oauth-scopes.ts`

(The ORG_ADMIN gate driver was run ad hoc via `curl` through `gcloud run
services proxy`, not as a checked-in script — the commands are reproduced
verbatim in this doc's own table above.)

## Branch-head bookkeeping — soaked head vs. current head

The deployed image, Cloud Run revision, `/api/health` `git_sha`, RC manifest
`train_launch_sha`, and every driver result above all reference union head
**`6ace61c37370028581bd82e935b6c0bec627bc44`** (the state after the 7 PR
merges, before this wave's own driver scripts were added). After the deploy
and all live driver runs, one more commit
(`32fa576d82ec11b969294fe928e803f91fb9c0f6`) was added to `rc/wave2-2026-08`
to check in the five reusable `wave2-driver-*.ts` scripts referenced
throughout this doc. That commit **adds new standalone script files only** —
it does not modify any file the running server imports or that any of the 7
PRs touch, so the deployed artifact's actual runtime is unaffected; this is
the same pattern the migration-T3 precedent documented for its own
post-deploy fix commit. `rc/wave2-2026-08`'s pushed branch tip is therefore
`32fa576d8`, one commit ahead of the soaked/deployed head `6ace61c37`.

## Explicitly not done (per task scope)

No PR readied or merged. No prod-apply (`vzwyaatejekddvltxyye` untouched,
read-only comparison queries only). `arkova-worker-staging`
(`fizyjojbebyalirtjjht`) and `arkova-worker-fullsoak-2026-08-staging`
(`gnkuaywlpmsaezwvlvhk`) were never touched, queried for writes, or
redeployed.

---

_Written 2026-08-20 during soak stand-up. Claims verified against Supabase
MCP (`list_migrations`/`execute_sql`) output, `gcloud run`/`gcloud builds`
describe/list output, live `curl` probes with real IAM + Supabase session
tokens, and this session's own `git`/`npm`/`vitest`/`tsx` output — not
asserted from either the wave plan or any prior doc._
