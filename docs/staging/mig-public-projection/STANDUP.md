# Soak stand-up — `mig-public-projection` (PR #2314 + PR #2440)

**Status: SOAKING, and the batch carries a BLOCKING finding.** The rig is real, the
window is running, and PR #2440's changed behavior is proven. PR #2314's changed
behavior is proven *in isolation* and proven **absent from the composed head** — the
two migrations clobber each other. Details in "The finding" below.

## Rig

| Field | Value |
|---|---|
| Supabase project | `arkova-soak-mig-public-projection` |
| Project ref | `uayovlvdhmuovuyfxrog` |
| Region / PG | `us-east-2` / 17.6.1.166 |
| Cloud Run service | `arkova-worker-mig-public-projection-staging` |
| Service URL | https://arkova-worker-mig-public-projection-staging-270018525501.us-central1.run.app |
| Serving revision | `arkova-worker-mig-public-projection-staging-00002-vxw` |
| Image | `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:2cb1dbc6e226d0886977e0abdbcdb2a42f13734ec74cf63cf95b1daabdcba44f` |
| Cloud Build id | `e58a75c0-1514-44b6-8c28-75243619ddc7` |
| Profile | `mock` (`USE_MOCKS=true`, `ENABLE_PROD_NETWORK_ANCHORING=false`) |
| Soak head | `8daeeb018c7408b86c97042fbb20d64759ba82f2` |
| `/health` `git_sha` | `8daeeb018c7408b86c97042fbb20d64759ba82f2` (matches soak head) |

Soak head is the integration merge of PR #2314 head `f51e6904491dec2eea7301220bb3b2e3eee159f7`
then PR #2440 head `876236e979d1b43dad87c46a6483f2528f0da8b4`, in PR-number order.
Both merged cleanly; no conflict resolution was required.

## Clock (FD-CLOCK-1)

Taken from the **serving revision's** `metadata.creationTimestamp`, not a probe loop.

* Soak start: **2026-08-30T22:18:50Z** (`…-00002-vxw`)
* Soak end:   **2026-09-01T22:18:50Z** (48 h)

Revision `…-00001-h9f` (22:06:27Z) was superseded before the window opened: the fresh
rig had no `ENABLE_BATCH_ANCHORING` switchboard row, the flag registry caches at boot,
and the batch trigger therefore returned a **hollow 200** (`{"processed":0}`) with the
work never attempted. The flag was seeded, the worker restarted to reload the registry,
and the clock was taken from the revision that actually serves the window. That hollow
200 is the same shape as the `if (error || empty)` swallow recorded in memory — worth
noting that the trigger's HTTP response is identical whether it drained a cohort or was
gated off.

## Preflight — clean_mirror BEFORE any batch migration

`scripts/ci/staging-honesty-preflight.ts --project-ref uayovlvdhmuovuyfxrog`
→ `environment_type=clean_mirror`, **exit 0**, at `2026-08-30T22:08:33.589Z`,
all 7 checks PASS. Artifact: `clean-mirror-preflight-pre-migration.json`
(sha256 `baacd6795fcb8af1599adcc2423c0893a25cbe3b8a4e2b50b6992e6e3babf7ce`).

0415 and 0421 were deliberately held out of the schema replay so the clean-mirror
reading is genuinely *pre*-migration, then applied in numeric order afterwards via
`npx supabase db push --linked`. Ledger head after: `0421`. No `migration repair`,
no ledger hand-edits (§1.11A); `db push` writes the numeric version itself, so the
§0-rule-10 MCP reconciliation does not apply here.

## The finding — 0415 and 0421 clobber each other (BLOCKING)

Both migrations `CREATE OR REPLACE FUNCTION public.get_public_anchor(text)`, and
**neither body contains the other's change**. 0421's body was derived from 0385
(`main` head); 0415's was derived from 0385 too. Whichever is applied last wins
outright. 0421's own header says this in its "MERGE-ORDER DEPENDENCY" section — this
soak measured it rather than trusting it.

Measured on the rig, same nine anchors, same anonymous caller, minutes apart
(`phase1-0415-rpc-capture.json` vs `phase2-0421-rpc-capture.json`):

| Anchor | Key | After 0415 | After 0421 |
|---|---|---|---|
| `ARK-MPP-A-OPTDEG` | `issuer_name` | `"Unknown Issuer"` | `"TSOAK-MPP Alpha University"` |
| `ARK-MPP-A-OPTDEG` | `issued_date` | `null` | `2026-07-31T22:10:28Z` |
| `ARK-MPP-A-OPTDEG` | `directory_info_suppressed` | `true` | **absent** |
| `ARK-MPP-A-OPTNULL` | `directory_info_suppressed` | `true` | **absent** |
| `ARK-MPP-B-OPTDEG` | `directory_info_suppressed` | `true` | **absent** |
| all nine | `sub_type` | **absent** | correct value / explicit `null` |

Reapplying 0415 last reverses it exactly: FERPA suppression returns, `sub_type`
disappears. The clobber is **bidirectional**, so no application order produces a
head carrying both changes.

**Which surfaces survive.** The revert is not total, which makes it more dangerous,
not less — it leaves a control that is live on two surfaces out of three:

| Surface | FERPA §99.37 enforced on the composed head? |
|---|---|
| `public.get_public_anchor` (SQL, behind the public verify page) | **NO** — 0415's layer replaced |
| `public.search_public_credentials` (SQL) | YES — 0421 does not touch it |
| `GET /api/v1/verify/:publicId` (worker, TS predicate) | YES — `suppressesDirectoryInfo()` is unaffected by SQL |

`private.is_directory_info_suppressed` remains installed but is orphaned from
`get_public_anchor`. That is precisely the failure mode 0415 was written to fix
("a control believed to be global, live on one surface out of several"),
reintroduced by merge order.

**This does not block either PR on its own.** Whichever lands first is correct and
complete. The requirement is on the second lander: it must be rebuilt on the first's
body before it merges. Do not fix the resulting CI failure by pinning a filename or
renumbering — 0421's header is explicit about that too.

## What the load actually drives

`scripts/staging/targeted/public-projection-driver.ts` against the rig, 30 s passes,
55-minute segments, detached supervisor, restarted automatically for the full window.
Fixtures: `scripts/staging/seed-mpp-projection-fixture.sql` — 9 projection anchors
across **two** orgs plus 24 PENDING trigger anchors.

Per pass, per anchor, against the **anonymous** surfaces:

* `rpc/get_public_anchor` via PostgREST with the rig's anon key — FERPA suppression
  (opted-out DEGREE, opted-out **null-type**, non-opted-out control, opted-out
  non-education boundary), `sub_type` projection for every seeded value including the
  explicit-`null` case, and cross-org issuer identity.
* `GET /api/v1/verify/:publicId` on the worker (IAM to Cloud Run, anonymous to the app).
* A not-found control, so the projection is shown not to 500 on an unknown id.

The null-`credential_type` case is the one that matters: every production record
carrying `directory_info_opt_out` has a null type, and the pre-0415 predicate was
falsy for exactly those rows.

First cycle (phase 1, 0415 live): 200 requests, `sql:ferpa_suppressed` 24/24,
`sql:ferpa_published` 48/48, `sql:org_isolation` 48/48, `sql:not_found_control` 8/8.
The worker REST calls hit the documented 100 req/min anon rate limit at the initial
5 s probe cadence — every 200 passed its assertion, and the steady-state cadence was
lowered to 30 s so 429s do not mask coverage.

## T3 triggers (real work, non-zero)

| Requirement | Call | Result |
|---|---|---|
| Trigger A | `POST /jobs/batch-anchors?force=true&org_id=<orgA>` | `processed: 12`, `batch_1788128469130_12`, root `3828c432…` — org A PENDING→SUBMITTED |
| Per-org isolation | observed during Trigger A | org B held at `PENDING=12`, untouched |
| Trigger B | `POST /jobs/check-confirmations` | `checked: 12, confirmed: 12` — org A SUBMITTED→SECURED |
| Daily flush | `POST /jobs/batch-anchors?force=true` (unscoped 3am sweep) | `processed: 12`, `batch_1788128495579_12` — org B PENDING→SUBMITTED |

`/jobs/process-anchors` is a deliberate no-op on this head (`batch-anchor` owns
ordinary PENDING anchors), so it is not a usable Trigger A.

## Rollback rehearsal (both migrations)

* **0421** — restored 0385's `get_public_anchor` body verbatim per its ROLLBACK block:
  `sub_type` disappeared. Reapplied: `sub_type` returned. rc=0 both ways.
* **0415** — restored 0387's `search_public_credentials` body and dropped
  `private.is_directory_info_suppressed` per its ROLLBACK block: the FERPA filter left
  `search_public_credentials` and the predicate count went to 0. Reapplied: both
  returned. rc=0 both ways.

After the rehearsal the rig was restored to numeric order (0421 last), confirmed by
probe and by ledger head.

## Provisioner defects encountered

Worked around, not fixed here:

1. **COMING_UP / IPv6 link race** — hit on a prior rig as
   `LegacyDbConfigIpv6Error`. Avoided by polling the project to `ACTIVE_HEALTHY`
   *before* `supabase link`. The provisioner does not wait.
2. **`IP_HASH_PEPPER` missing from every overlay** — confirmed by grep; the script's
   `--set-secrets` list omits it while `config.ts`'s production `superRefine` requires
   it. Wired explicitly at deploy; without it the service crash-loops on boot.
3. Multi-`CREATE INDEX CONCURRENTLY` files (9 of them at this head) cannot go through
   `db push`'s pipeline. Set aside, applied via the session pooler, ledger rows
   inserted, files restored — note that `db push` then refuses to run at all while a
   remote ledger row has no local file, so the files must be moved **back** before
   resuming rather than left aside.
4. The leap-day hold schedule and chain-profile secrets were not reached: this rig runs
   the `mock` profile, which creates no Cloud Scheduler jobs. Triggers were driven by
   authenticated `POST /jobs/*` instead.

## Teardown

Owed when the window closes and both PRs are dispositioned:
`scripts/staging/teardown-isolated-rig.sh`. Do not tear down while either PR is open —
the rig ref is named in both evidence blocks. Secrets created:
`supabase-url-mig-public-projection-staging`,
`supabase-service-role-key-mig-public-projection-staging`,
`supabase-db-password-uayovlvdhmuovuyfxrog`.
