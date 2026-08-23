# TRAIN-6 / PR #2249 — T3 soak maturity record (window 2), clock closed <<FILL: confirm 2026-08-23T20:33:58Z or actual capture time>>

> TEMPLATE (pre-staged 2026-08-23 while the window was running). Every `<<FILL>>`
> marker is a close-time number that `close-capture.sh` prints into its
> `summary.md` (or `rollback-rehearsal.sh` into its record); everything else was
> already true at pre-stage time and was verified against the rig / gcloud / the
> evidence files — not copied from the stand-up doc. When filled, rename to
> `maturity-<closeUTC>.md` and drop this note.

**Rig:** `arkova-worker-wave2-2026-08-staging`, revision `arkova-worker-wave2-2026-08-staging-00006-gik`, tag `train-6`
**Image digest:** `sha256:76f1d043280c24ea593932ebe4e32158afbe56a647c4be709ca93f121d8508b4` (the revision-pinned digest; the push-time `d0aaa51b…` value is recorded in the stand-up, not quietly swapped)
**Worker `git_sha` (from `/health`):** `f0e4cfe2e375b838a6f164f7c15e23d6b981c34b` — the union head (= #2249 head `df0e6fa93…` on base `224cef8a9…`; ancestry re-verified at stand-up)
**Supabase:** `tkciooifwxwnkoizgalp` (isolated)
**Declared tier:** T3 — `services/worker/src/jobs/anchorExpirySweep.ts` matches the anchor-lifecycle path rule; every other touched file alone would be T2
**Revision clock start (FD-CLOCK-1):** 2026-08-21T20:33:58.053472Z — re-verified from `gcloud run revisions describe` on 2026-08-23 during close-out prep
**Clock close:** 2026-08-23T20:33:58Z — **48.00 h, the full T3 minimum**
**Chain exposure:** none — `USE_MOCKS=true`, no WIF; #2249 changes DB-row validation in job code, not the signer.

## Window 1 is VOID — and that is part of this record, not a footnote

The first TRAIN-6 window (clock 2026-08-21T18:54:36Z, revision `00005-nax`) was
**abandoned at ~1.65 h**: its preflight failed `submitted_anchors` ("Zero SUBMITTED
anchors") because `scripts/staging/seed-baseline-fixture.sql`'s single SUBMITTED anchor
had **self-reverted ~7 minutes after seeding**. The reclaimer is
`public.recover_stuck_broadcasts()` (migration `0379`, `*/2` in-process cron) acting on
`chain_tx_id IS NULL` — NOT the soak's own sweep probe, which window 1's stand-up
initially blamed (that attribution is corrected in the window-2 stand-up; the proposed
"re-point the probe" fix would have changed nothing). Filed as **FD-SEED-1** (systemic:
every rig seeded with that file) and cross-corrected into **FD-TRAIN6-1** (SCRUM-3189),
whose general rule — *check whether the driver's own actions can violate the
preconditions its window is judged against* — stands, while its named mechanism was
wrong. §1.11A forbids claiming a soak on a failed preflight, so window 1 produced **no
citable evidence**; `soak-start-2026-08-21T1854Z.md` carries a supersession header and
must not be cited. Window 1's 4 driver cycles sit in the same evidence directory —
**every aggregate in this record filters on
`.servingRevision == "arkova-worker-wave2-2026-08-staging-00006-gik"`.**

## The restart was built to survive its own rig — the durable fixture

Window 2 reseeded with a fixture designed against every live mutator on the rig
(full mutator-by-mutator exclusion table in the stand-up doc):

- **Set A — 5 durable SUBMITTED anchors** (`5eed0002-…`): synthetic 64-hex
  `chain_tx_id` (NOT NULL — outside 0379's predicate) + `legal_hold=true` (outside the
  mock auto-confirmer's predicate). Two independent exclusions because two different
  jobs mutate SUBMITTED rows. `chain_tx_id NOT NULL` is also the state-machine-correct
  shape (INV-1b: SUBMITTED with null txid is unreachable through modeled write paths —
  the old seed manufactured an impossible state and 0379 is the net that cleans it up).
- **Positive control** (`5eed0009-…`): identical but `chain_tx_id IS NULL`, planted at
  20:25:51Z, **reclaimed by the cron at 20:32:10Z** (~6.3 min), self-stamped
  `_recovery_reason: stuck_submitted_null_txid`. The control died, Set A did not —
  Set A's survival is the exclusion working, not a dormant cron. Left in place as a
  disclosed PENDING row.
- **Set B — 100 SECURED anchors** (`5eed0003-…`): staggered `expires_at` (4 past-due at
  seed + one falling due every 30 min for 48 h) so `anchorExpirySweep` has real work on
  every pass instead of window 1's `checked: 0` green-but-hollow probes.

**Set B is the poison-row defect path, seeded on purpose.** Every fixture id and the
fixture org id are non-RFC-9562 UUIDs (zero version/variant nibbles) — the exact shape
Zod 4's strict `z.string().uuid()` rejects and Postgres stores happily, i.e. the exact
value class that DoS'd whole job passes before #2249 (BUG-2026-08-12-003 / FD-15).
Measured at stand-up with the tree's own Zod: strict uuid() = false, `dbUuid` shape =
true, for all three id families. So **every `SECURED → EXPIRED` transition drives both
changed sites in `anchorExpirySweep.ts`** (`AnchorIdSchema = dbUuid(…)` in
`casUpdateToExpired`; `target_id`/`org_id: dbUuid(…)` in `AuditEventRowSchema`), and
**every org-queue claim drives `ClaimedOrgSchema`'s `dbUuid('org_id')`** with the value
the base code threw on. Window 2's first member pass claimed the fixture org
successfully at 20:34:51Z (`last_run_status: succeeded`); the org fell due again at
+24 h — <<FILL: close-capture §6 shows the second claim (~2026-08-22T20:34Z) and the
end-state `organization_queue_run_state` row>>.

## Verdict

<<FILL: one paragraph, written FROM the numbers below — clock integrity, cycle count
and fail rate (interim at 28.4 h: 67 cycles, 12,107 ok / 1 fail = 0.008 %), 429=0,
fixture invariants held (submitted floor 5, secured+expired=100 conserved), lifecycle
transitions observed (~55 at 28.4 h, expect ~95+ by close), T3 trigger status.
Do not write it first.>>

## Clock integrity — <<FILL: PASSES / FAILS>> (FD-CLOCK-1)

| Condition | Observed |
|---|---|
| Serving revision | `arkova-worker-wave2-2026-08-staging-00006-gik` |
| Revision created | 2026-08-21T20:33:58.053472Z |
| Revision at close | <<FILL: unchanged / CHANGED — close-capture §2. The no-traffic tag `pr-2290` on `00003-qiz` is expected>> |
| Revisions that served requests in-window | <<FILL: close-capture §3 distinct list + total sampled>> |
| Traffic | <<FILL: expect 100 % on 00006-gik, tag `train-6`>> |
| Container terminations / OOM | <<FILL: close-capture §4>> |
| Non-declared 5xx across 48 h | <<FILL: close-capture §5 — see the 5xx section for the declared stream>> |
| Health at close | <<FILL: 5× HTTP + timings from close-capture §1>> |

## Load coverage — continuous, with the fixture invariant audited every cycle

| | |
|---|---|
| Requests in window (log-side) | <<FILL: close-capture §3 total>> |
| Per-2h-slice counts | <<FILL: paste the 24 slice lines>> |
| Driver cycles (window-2, in-window) | <<FILL: driver-rollup `in_window.cycles`; 89 rc=0 as of 09:50Z on 08-23, 67 at the 00:40Z interim>> |
| Driver totals ok/fail | <<FILL: interim at 28.4 h: 12,107 / 1>> |
| status_200 / 429 / other | <<FILL: `s429` MUST be 0 — the FD-LOAD-1 positive control (8 rpm offered vs the real 60 rpm ceiling, vs the migration-T3 window that measured its own limiter with 144,763 × 429)>> |
| `fixture.submitted` min across all cycles | <<FILL: MUST be 5 — the continuously-audited invariant. Window 1's failure was invisible for 8 minutes precisely because nothing watched this; window 2 re-measures it on every member pass and records a deviation on breach>> |
| `secured + expired` conservation | <<FILL: driver-rollup `conservation_violations` — MUST be []. Interim: conserved at 100 on every sample, secured 95→40 / expired 5→60 by 00:37Z — one cohort aging through the lifecycle, not churn>> |
| Lifecycle transitions observed | <<FILL: fixture_first vs fixture_last — expect expired ≈100 by close>> |
| Deviations | <<FILL: expect EXACTLY ONE — see next section>> |
| Gaps > 30 min | <<FILL: expect NONE — this window had no supervisor stop>> |
| Supervisor rc history | <<FILL: expect all rc=0, no "done" line yet — the supervisor's end-epoch parse lacks `-u` and reads the close as ~00:33Z local-parsed; it is stopped manually per the post-seal plan and post-close cycles are excluded (`post_close_overrun_cycles` in the roll-up)>> |

**Offered-load design (fixed at stand-up):** core pass every 10 s + 7-probe member
block every 5 min ≈ **8 req/min**, computed and enforced at driver startup against the
real 60 req/min/IP `apiIpShadowGuard` ceiling (refuses to start above 45). Every probe
declares an expected status and a required JSON field; 401/403 FAIL unless declared;
429 has a dedicated counter and is a hard FAIL tagged `RATELIMIT:`.

## The single deviation, in full

Cycle `load-20260822T011106Z.json` (capturedAt 2026-08-22T01:11:06Z): one `health`
probe answered **503** where 200 was declared — `fail: 1` in `requests`, deviation
recorded, **non-recurring** across every following cycle. 1 failed request in
<<FILL: final ok+fail total>>. Same cold-start-503 class as the ferpa2314 window's
stop, at 1/48h frequency. Recorded, not explained — a single transient 503 with no
recurrence has no diagnosable signal, and inventing one would be worse than naming it.

**Driver caveat, stated rather than discovered later:** unlike the ferpa2314 driver,
`train6-load-loop.sh` does **not** end with a fail-on-FAIL assertion, so this fail=1
cycle exited rc=0 and the supervisor kept running. The supervisor's fail-loud design
holds for driver-level (script) failures only, not probe failures. For this window
that is the better outcome — a 48 h T3 window should not be ended by one transient
cold-start 503 (the ferpa2314 window WAS, and carries a 3h34m gap for it) — but it is
a design divergence between the two drivers and is recorded as such.

## Environment basis — `clean_mirror`, exit 0, bracketing the clock start

Preflight run **from the PR-head checkout** against `tkciooifwxwnkoizgalp`:
`environment_type = clean_mirror`, exit 0, all six checks pass,
`submitted_anchors: 5 SUBMITTED anchor(s) found` — at 2026-08-21T20:36:36Z, with an
independent agreeing run at 20:26:30Z; the two runs bracket the 20:33:58Z clock start.
Verbatim JSON in the stand-up doc. **Check 7 `org_topology` is absent and that is
expected, not a pass** — the script at this head still carries FD-PREFLIGHT-1 (the
check errors on a nonexistent column and silently skips); the rig's real topology is
1 org, no seed-prefixed names. The fixture seeding is a deliberate, disclosed,
data-only rig write (no ledger writes, no repair, no push, no reset).

## T3 trigger coverage — each item evidenced or stated NOT done

| T3 item | Status at close | Evidence |
|---|---|---|
| **Poison-row defect path** (the PR's actual changed behavior) | **SEEDED AND DRIVEN** — non-RFC uuids on every fixture id drive both changed `anchorExpirySweep` sites on every expiry transition (~<<FILL: final expired count>> transitions across 48 h) and the org-queue claim path at start and +24 h | Stand-up §"Set B is also the poison row", close-capture §6 DB reads + `/jobs/*` counts, driver-rollup fixture progression |
| **Trigger A** (size, 10,000 pending) | <<FILL: FIRED / NOT RUN — ambient load cannot reach it (FD-TRIGGER-1); a volume run via `scripts/staging/fullsoak-trigger-b-volume.sh` was required and <<FILL: was/was not>> executed. NOTE the rig runs USE_MOCKS=true — a volume run here exercises batch claim/drain, not real broadcast>> | <<FILL>> |
| **Trigger B** (age, 3,000 + 3 h) | <<FILL: same shape>> | <<FILL>> |
| **Daily flush observation** | <<FILL: close-capture §7 captured 03:00Z both nights. 2 disclosed PENDING rows are three orders of magnitude below MIN_BATCH_THRESHOLD (3,000) — state what fired as an observation, or state NOT OBSERVED>> | `dailyflush-*.txt` in the close dir |
| **Per-org isolation check** | <<FILL: single-org rig (1 fixture org). Either a second-org check was actually run (state what was measured — e.g. one org's quarantined claim not blocking another's, per the PR body's proposed check), or state NOT DONE — single-org rig, isolation not claimable from this window>> | <<FILL>> |
| **Rollback rehearsal** | <<FILL: run `rollback-rehearsal.sh` AFTER close-capture AND after stopping the supervisor. Paste: digest-executed rollback image, 3x200 health at git_sha=main-head, traffic restored to 00006-gik + union-head health. #2249 is worker-code only — a deploy rollback IS the whole rollback>> | <<FILL: rehearsal record path>> |

## §1.12 T3 requirements — met / unmet

| Requirement | Status |
|---|---|
| 48 h soak at the exact frozen head | <<FILL: expect MET — clock table above; head `df0e6fa93…` unchanged on the PR through the window (verify `gh pr view 2249 --json headRefOid` BEFORE the post-seal merge of main)>> |
| Clean preflight | Met — `clean_mirror` exit 0, two bracketing runs, verbatim above |
| Evidence exercises the PR's changed path | Met — the poison-row row of the T3 table; this is the deepest changed-path coverage of the 2026-08 windows because the defect shape itself is the fixture |
| Trigger A / Trigger B / daily flush / per-org isolation | <<FILL: from the T3 table — expect a mix of met and honestly-NOT-done rows; NOT-done rows ride into the deferred manifest entry as named residuals>> |
| E2E result | <<FILL-AT-READY: CI E2E run URL at the post-merge head>> |
| Rollback rehearsal | <<FILL: from rollback-rehearsal.sh record>> |
| Migration applied | N/A — #2249 touches no `supabase/migrations/` file (worker job code + tests only) |
| Staging deploy log id | **N/A, disclosed:** manual isolated-rig deploy pattern (digest-pinned `gcloud run deploy`), not `scripts/staging/deploy.sh`. Deploy artifacts: revision `00006-gik` createTime + digest above |

## What this window covers for #2249 — and what it does NOT

**Covers:** 48 h of the hardened `db-row-validation` path under continuous load with
the real defect shape live in every fixture row — `anchorExpirySweep` with real work
falling due every 30 min, the org-queue scheduler claiming a non-RFC-uuid org twice,
five further job routes through the hardened path (happy-path regression), fixture
durability continuously audited, rate budget as the FD-LOAD-1 positive control.

**Does NOT cover — do not cite this window for any of these:**

- **Signing / treasury / broadcast.** `USE_MOCKS=true`, no WIF. Any #2249 behavior
  touching those paths is out of scope.
- **`parseDbRows` quarantine counter with `quarantined > 0`.** NOT REACHABLE on a real
  rig — `claim_due_org_queue_runs` returns a Postgres `uuid` column, which cannot fail
  the shape check. `quarantined: 0` is by construction, not coverage; the unit suite is
  the only place that path executes. (Stated at stand-up; still true.)
- **`api/partner-provisioning.ts`, DocuSign/Drive connector files** — NOT PROBED.
- **`connector-artifact-drain` body** — 200 but `skipped: true` (flag off): shallow.
- **`professional-education`** — declared fail-closed 503, by design (flag unset).
- **Prod-shaped concurrency / multi-org fan-out** — 8 rpm serial probes, single org.
- **The base code's behavior** — this window proves the FIX serves; the regression
  proof that the base code fails on these rows is the PR's mutation-tested unit suite,
  not the soak.

## Post-seal path to merge

This PR exits through the **deferred consolidated soak manifest**
(`docs/staging/rc-manifests/rc-deferred-2026-08-22.json`), NOT the per-PR evidence
path: its branch is DIRTY vs main (expected — frozen mid-soak while main took the
2026-08-22/23 merge wave) and it is **not currently in `included_prs`** (verified
2026-08-23 during close-out prep). The full sequence — merge main in, restamp/roster
move in the manifest, THEN cycle+ready — is `2249-post-seal-plan.md` in this
directory. The rig is **shared history; teardown is deferred** (same file).
