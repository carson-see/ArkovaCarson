# PR #2314 FD-FERPA-1 — T3 soak maturity record, clock closed <<FILL: confirm 2026-08-23T19:24:30Z or actual capture time>>

> TEMPLATE (pre-staged 2026-08-23 while the window was running). Every `<<FILL>>`
> marker is a close-time number that `close-capture.sh` prints into its
> `summary.md` (or that `rollback-rehearsal.sh` prints into its record);
> everything else was already true at pre-stage time and was verified against
> the rig / gcloud / the PR — not copied from the stand-up doc. When filled,
> rename to `maturity-<closeUTC>.md` and drop this note.

**Rig:** `arkova-worker-ferpa2314-staging`, revision `arkova-worker-ferpa2314-staging-00001-cit`, tag `pr-2314`
**Image digest:** `sha256:be79097dc3fcf9b755d45ad301cd55abb28f33a8726226386fdcb8986e5ef518` (linux/amd64)
**Worker `git_sha` (from `/health`):** `93747a6aa451991476ab0b00d58c3fb0754f2e2d` — the frozen **soaked** head (see §Exact-head deviation: the live PR head has moved)
**Supabase:** `wjuelohtpklodpjklvqy` (`arkova-ferpa-2314-2026-08`, us-east-2, PG 17.6.1.155) — isolated, provisioned 2026-08-21 for this window
**Declared tier:** T3 — `supabase/migrations/` (0415) + anon-reachable `SECURITY DEFINER` projections over the verification surface
**Revision clock start (FD-CLOCK-1):** 2026-08-21T19:24:30.248332Z — re-verified from `gcloud run revisions describe` on 2026-08-23 during close-out prep, **not** read from the stand-up doc
**Clock close:** 2026-08-23T19:24:30Z — **48.00 h, the full T3 minimum**
**Network label:** `/health` reports `network: mainnet`, but the rig carries no `BITCOIN_TREASURY_WIF` and `ENABLE_PROD_NETWORK_ANCHORING=false` (`kms: warning` is expected) — zero chain exposure by design; #2314 changes SQL projections and a REST projection, not the signer.

## Verdict

<<FILL: one paragraph. Write it FROM the numbers below after they are in — clock
integrity result, loaded-coverage % (expected ≈92.6% because of the disclosed
3h34m gap), 5xx count and attribution, driver fail count, T3 trigger status.
Do not write it first.>>

## Clock integrity — <<FILL: PASSES / FAILS>> (FD-CLOCK-1)

| Condition | Observed |
|---|---|
| Serving revision | `arkova-worker-ferpa2314-staging-00001-cit` |
| Revision created | 2026-08-21T19:24:30.248332Z |
| Revision at close | <<FILL: unchanged / CHANGED — from close-capture §2>> |
| Revisions that served requests in-window | <<FILL: from close-capture §3 distinct list + total sampled>> |
| Traffic | <<FILL: expect 100 %, tag `pr-2314`, single revision — close-capture §2>> |
| Container terminations / OOM | <<FILL: close-capture §4>> |
| 5xx across the 48 h window | <<FILL: close-capture §5 total>> |
| Health at close | <<FILL: 5× HTTP + timings from close-capture §1>> |

The clock is the serving revision's `creationTimestamp`, not instance uptime — reading
`/health` `uptime` as the clock understates the window because Cloud Run recycles
instances mid-window.

**The load gap does not break the clock.** The clock is rig revision uptime; the
2026-08-22 gap below is a **driver-side** hole in offered load, disclosed as such. The
revision served throughout (close-capture §3's 09:24→13:24Z chunks show ambient traffic
only during the gap).

## Load coverage — with one disclosed 3h34m gap

**The gap, in full (known at pre-stage time; the close capture must re-confirm it is
the ONLY one):** at 2026-08-22T11:30:06Z the driver's `health` probe got a **503 on a
cold start** and the cycle failed (`deviations='health=503(want 200)'`). The supervisor
did exactly what it is designed to do — **fail loud and stop** (`driver FAILED —
stopping so the gap is visible`), leaving a visible hole rather than silently retrying.
The driver was restarted at **2026-08-22T15:04:01Z** with a **bounded cold-start
retry** added to the load loop (a probe that hits a cold-start 503 retries once and
counts the event in a dedicated `coldStartRetries` counter — bounded and counted, never
a silent retry loop; every post-restart cycle reports `coldstart_retries=` in the
supervisor log). Offered load was down **3 h 33 m 55 s**. By evidence-file
`finished_at` the gap reads ~11:30Z → ~15:29Z because the restarted cycle finishes
25 min after the restart. Loaded coverage of the 48 h clock is therefore expected at
**≈ 92.6 %**, and the fail-loud stop is evidence the supervision model works, not a
defect being talked around.

| | |
|---|---|
| Requests in window (log-side) | <<FILL: close-capture §3 total>> |
| Per-2h-slice counts | <<FILL: paste the 24 slice lines>> |
| Gaps > 30 min (driver-side, from file deltas) | <<FILL: expect exactly ONE — the disclosed 11:30→15:29 file-gap. Any other gap is undocumented: investigate>> |
| Loaded coverage of the 48 h clock | <<FILL: expected ≈92.6 %>> |
| Driver sustained cycles in-window | <<FILL: driver-rollup `sustained_in_window.cycles`; 82 rc=0 as of 09:53Z on 08-23>> |
| Driver totals ok/fail | <<FILL: `sustained_in_window.ok` / `.fail`>> |
| status_200 / 404 / 429 / other | <<FILL: from driver-rollup (404s are the two DECLARED 404 probes)>> |
| coldStartRetries (bounded, counted) | <<FILL: from driver-rollup — 1 as of 10:18Z on 08-23: the 2026-08-22T23:01:19Z cycle absorbed exactly one cold-start 503 via the bounded retry (deviations empty — the retry answered 200). That is the driver fix PROVEN working in-window on the same failure class that stopped the 11:30Z cycle>> |
| Deviations (sustained, in-window) | <<FILL: expect exactly the one health=503 cycle at 11:30:06Z>> |
| Supervisor rc history | <<FILL: expect exactly ONE rc=1 (11:30:06Z) + the rest rc=0. NOTE: the supervisor does NOT stop itself at 19:24:30Z — its end-epoch parse lacks `-u` and reads the close as local EDT (~23:24Z); post-close cycles are excluded from the roll-up and the supervisor is stopped manually per the teardown checklist>> |
| Post-close overrun cycles (excluded) | <<FILL: driver-rollup `post_close_overrun_cycles`>> |

**Offered-load design (fixed at stand-up, not a close-time number):** core pass
(`health` + `2314-suppressed-still-verifies` + `2314-control-unaffected`) every 10 s,
member + anon blocks every 5 min — **~18/min offered against the code-enforced
60 req/min/IP `apiIpShadowGuard` ceiling** (§1.10's 100/min figure is not what the code
enforces). Every probe declares an expected status AND a `jq` predicate over the body;
401/403/429 are FAIL unless declared; `429` has its own counter so limiter pressure
cannot hide in `status_other`.

**Driver verification runs (pre-supervisor, disclosed and deliberately kept):**

- **Run 1, 110 s, finished 2026-08-21T19:30:56Z — the run that DISCOVERED the real
  ceiling.** Offered at 3 req/5 s (36/min) plus the member block, it drew **ten 429s**
  (`fail: 10`, all `(want 200|404)=429` deviations, `status_other: 10` — this run
  predates the dedicated 429 counter). It is kept in evidence deliberately: it is the
  measured basis for the 18/min sustained budget and for FD-LOAD-1's 60/min correction.
  It is **excluded from sustained totals** (roll-up separates it), not deleted.
- **Run 2, 200 s, finished 2026-08-21T19:36:11Z:** 72 ok / 0 fail (66×200 + 6×declared
  404) at the corrected budget. Sustained supervision started immediately after.

## What the probes actually assert (the changed path, not just liveness)

The defect path and the survival invariant are asserted in one probe:
`2314-suppressed-still-verifies` requires `verified==true ∧ status=="ACTIVE" ∧
network_receipt_id!=null ∧ bitcoin_block!=null ∧ directory_info_suppressed==true ∧
issuer_name==null ∧ issued_date==null ∧ expiry_date==null` on every hit for 48 h. The
member block walks the full fixture matrix: control (not suppressed), NULL-type
fail-closed branch, CPE boundary (NOT suppressed — the fix is scoped), declared-404s,
provenance on a suppressed record, anon PostgREST fingerprint projection, and the
search match-set assertion (the opted-out CLE stays out, its identically-named twin
stays in). Generic-load caveat (§1.12) does not bite: every probe traverses 0415's
changed functions or the REST twin fixed in the same PR.

## 5xx

<<FILL: from close-capture §5. At least ONE is expected — the 2026-08-22T11:30:06Z
cold-start 503 on /api/health that stopped the driver. If the total is exactly that
one: state it, attribute it, done. If more: per-status/per-path table + timestamps +
cause + confinement, in the style of the chain-pair record — assert confinement, not
harmlessness.>>

## Environment basis — `clean_mirror`, isolated project, preflight at the PR head

Two preflight runs bracket the clock start, both against `wjuelohtpklodpjklvqy` from
the **PR-head checkout** (the only correct place for a PR that adds a migration —
`loadRepoMigrationVersions()` reads the local tree):

- 2026-08-21T19:25:53Z — `environment_type = clean_mirror`, exit 0, 6/6 checks.
- 2026-08-21T19:26:09Z — with the FD-PREFLIGHT-1 fix applied (Check 7 `org_topology`
  restored): `clean_mirror`, exit 0, **7/7 checks**, `org_topology: 1 org, prod-like`.

Verbatim JSON for both is in `soak-start-2026-08-21T1924Z.md`. A third run from a
`main` checkout correctly reported `soak_artifact` / `Unexplained extras: [0415]` —
recorded there as the wrong-tree signature, not contamination.

Disclosed provisioning deviations (stand-up doc §"DISCLOSED DEVIATION", summarized):
schema replayed file-by-file via the Management API (operator constraint: no
`db push --linked`); `0381` had ` CONCURRENTLY` stripped (transaction wrapper;
identical resulting index on a greenfield rig); ledger rows inserted by the replay —
provisioning a new isolated project, not laundering a shared rig. `0415` applied
**byte-exact** (file md5 = payload md5 = `192e5797b9fc052ae0e8dbbeb3d4bd9a`) with all
three function bodies md5-verified out of `pg_proc.prosrc` after apply, and the ledger
confirmed at numeric head `0415` via `list_migrations` (§0 rule 10 run as verification:
0 rows rewritten).

## Exact-head deviation — the PR branch moved past the soaked head (§1.11A)

**Discovered 2026-08-23 during close-out prep, from `gh pr view`, not from any doc.**
The stand-up froze the head at `93747a6aa…` and the rig soaked that head for the full
window (BUILD_SHA + `/health` `git_sha` + image digest all pin it). But the live PR
branch now stands at <<FILL-AT-READY: live head — `99ea75fbfda0d0fa800b3e7871fb1becf4327ecd`
at pre-stage time>>, four commits past the soaked head:

| Commit | What it is |
|---|---|
| `c47c471ad` | Merge of `origin/main` (branch was 286 behind; clears GitHub DIRTY + FD-GATE-2 tier inflation) |
| `37414cd3f` | `test(ferpa)` — RLS suite owns its fixture instead of borrowing `c001` (**test-only**) |
| `fed9ff08b` | `test(ferpa)` — fixture profile must be `is_public_profile=true` or search asserts pass vacuously (**test-only**) |
| `99ea75fbf` | Merge of `origin/main` (inherits the #2348 secdef ratchet timeout fix) |

`git rev-list <soaked>..<live> --not origin/main` = the two test-only commits + the two
merge commits. **Zero runtime, migration, or worker-code changes are introduced by the
branch itself beyond the soaked head** — the non-merge delta touches
`tests/rls/ferpa-directory-info-opt-out.test.ts` and RLS-suite fixture wiring only.
§1.11A says a post-soak commit "invalidates exact-head evidence and requires a new soak
or an explicit residual-risk note." This section is that note's factual basis:

- **Deviation class:** test-only own-commits + merges of already-merged `main` (the
  same class the RC-manifest restamps accepted repeatedly on 2026-08-23, each with a
  per-file audit).
- **Impact on the soak's meaning:** none claimed for runtime behavior — the tested
  worker/SQL surface at the live head is byte-identical to (soaked head + main), and
  main's own commits carry their own merged evidence. <<FILL-AT-READY: re-verify with
  `git diff <soaked-head> <live-head> -- services/worker/ supabase/migrations/ src/`
  excluding files main already carries — paste the per-file audit or "byte-identical
  vs main" line into the PR body.>>
- **Ruling owed:** <<FILL: CTO/Carson acceptance line naming the live head, or a
  re-soak decision. The evidence block must not be pasted as merge-grade without it.>>

## T3 trigger coverage — each item evidenced or stated NOT done

The stand-up listed these as OWED. State each honestly at close; a `NOT RUN` row here
must survive into the PR body and the ready decision as an explicit residual, not be
rounded up.

| T3 item | Status at close | Evidence |
|---|---|---|
| **Trigger A** (size, 10,000 pending) | <<FILL: FIRED / NOT RUN — ambient load cannot reach it (FD-TRIGGER-1); a volume run via `scripts/staging/fullsoak-trigger-b-volume.sh` was required and <<FILL: was/was not>> executed>> | <<FILL: artifact path or "none">> |
| **Trigger B** (age, 3,000 + 3 h) | <<FILL: FIRED / NOT RUN — same mechanism>> | <<FILL>> |
| **Daily flush observation** | <<FILL: close-capture §6 captured the 03:00Z windows on both nights (2026-08-22, 2026-08-23). State what fired over the rig's ~1–2 row PENDING population — an observation of the trigger firing, NOT volume proof — or state NOT OBSERVED>> | `dailyflush-2026-08-22.txt`, `dailyflush-2026-08-23.txt` in the close dir |
| **Per-org isolation check** | <<FILL: this rig has ONE org (`org_topology: 1 org`). Either a second org with its own opted-out record was added and the check run (state what was measured), or state NOT DONE — single-org rig, isolation not claimable from this window>> | <<FILL>> |
| **Multiple trigger cycles** | <<FILL: follows from A/B rows above>> | — |
| **Rollback rehearsal** | <<FILL: run `rollback-rehearsal.sh` AFTER close-capture AND after stopping the supervisor. Paste the PASS/FAIL lines: prod-md5 gate, rig rollback md5s + match-set 1→2, re-apply md5s + match-set 2→1, digest-executed deploy rollback, traffic restore>> | <<FILL: rehearsal record path>> |

## §1.12 T3 requirements — met / unmet

| Requirement | Status |
|---|---|
| 48 h soak | <<FILL: met/broken — clock table above; note the disclosed 3h34m load gap does not stop the revision clock>> |
| Soak at the exact frozen head | **Deviation, disclosed** — soaked head ≠ live PR head; see §Exact-head deviation. Ruling owed. |
| Merge-grade staging evidence w/ exact head + base SHA | <<FILL-AT-READY: live head + merge-base in the PR body>> |
| Clean preflight | Met — `clean_mirror` 7/7 at 19:26:09Z, verbatim in the stand-up doc |
| Evidence exercises the PR's changed path | Met — probe matrix above traverses 0415's three functions and the REST twin continuously |
| Multiple trigger cycles / Trigger A / Trigger B / daily flush / per-org isolation | <<FILL: from the T3 table above — expect a mix of met and honestly-NOT-done rows>> |
| E2E result | <<FILL-AT-READY: CI E2E run URL at the live head>> |
| Rollback rehearsal | <<FILL: from rollback-rehearsal.sh record>> |
| Migration applied | Met on the rig — 0415 byte-exact, ledger numeric head 0415. **NOT applied to prod** — prod apply is the RTE's post-merge action (prod still serves the pre-0415 bodies; that is also what makes the rollback-source-from-prod rehearsal design valid) |
| Staging deploy log id | **N/A, disclosed:** `public.staging_deploy_log` does not exist in this rig's replayed chain and the deploy was the manual isolated-rig pattern (digest-pinned `gcloud run deploy`), not `scripts/staging/deploy.sh`. Deploy artifacts: revision `00001-cit` createTime + image digest above |

## What this window covers for #2314 — and what it does NOT

**Covers:** 0415's suppression layer and its REST twin under ~18/min authenticated +
anon probing for 48 h (minus the disclosed gap) at the frozen soaked head, on an
isolated `clean_mirror` rig at ledger head `0415`, with per-probe body predicates,
declared-status 404s, a fixture matrix that exercises the main path, the fail-closed
NULL-type branch, the CPE boundary, and the search match-set — plus the survival
invariant (suppressed records still verify) on every single hit.

**Does NOT cover — do not cite this window for any of these:**

- **Prod-shaped load.** ~18 req/min, single IP, serial probes. No concurrency bursts,
  no multi-instance fan-out, no limiter saturation (the one 429 burst was the
  deliberately-kept discovery run).
- **Multi-org behavior / per-org isolation** — single-org rig, unless the T3 table
  above says otherwise at close.
- **Batch triggers at volume** — unless the T3 table above says otherwise at close.
- **Anchoring / chain / treasury.** No WIF, `ENABLE_PROD_NETWORK_ANCHORING=false`.
- **Prod's three real opted-out records.** This window proves fixture behavior; the
  prod-apply of 0415 and the post-apply read of `ARK-DOC-6Y9RK6` /
  `ARK-DOC-JTYBP3` / `ARK-DOC-QAUVZY` is the RTE's separate, post-merge action.
- **The counsel/CTO items** the PR body carries (disclosure obligations for the three
  live records; the `credential_type` residual) — legal/CTO calls, not soak outputs.

## Teardown

See `teardown-checklist.md` in this directory. Order matters: evidence block into
#2314 and gate-verified FIRST, teardown LAST — a torn-down rig cannot re-answer
questions. Step 0 (stop the overrunning supervisor) happens right after close-capture,
before the rollback rehearsal.
