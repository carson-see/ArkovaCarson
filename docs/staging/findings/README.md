# Soak findings — index

Findings from soak windows, newest first. These exist because each one cost real
soak time, and none of them was obvious from inside the window that produced it.

**The pattern connecting most of them:** soak health was judged by *"did the clock run and
is `/health` green"*, never by *"did the soak exercise anything."* Under those criteria a
soak measuring nothing is indistinguishable from a healthy soak.

## Evidence integrity — read these before trusting any soak

| Finding | One-line lesson |
|---|---|
| [FD-WAVE3-1](FD-WAVE3-1-load-driver-sent-empty-bearer-for-5h.md) | A driver can run for hours sending an **empty bearer token** and report success. Check that requests actually authenticated. |
| [FD-TRIGGER-1](FD-TRIGGER-1-ambient-load-cannot-reach-triggers-a-b.md) | Ambient anchor traffic (~36/day) can **never** reach Trigger A (10,000) or B (3,000+3h), both required T3 evidence. Use `scripts/staging/fullsoak-trigger-b-volume.sh`. |
| [FD-CLOCK-1](FD-CLOCK-1-instance-uptime-is-the-wrong-soak-clock.md) | The clock is the serving **revision's** `creationTimestamp` plus integrity conditions — **not** instance uptime. Cloud Run recycles instances. |
| [FD-RC-1](FD-RC-1-manifests-cannot-be-retrofitted.md) | An RC manifest asserting soak coverage **cannot be retrofitted**. It is a train-launch artifact: manifest first, restack once, freeze, then soak. |
| [FD-LOAD-1](FD-LOAD-1-mixed-mode-exceeds-anonymous-rate-limit.md) | `--mode mixed` offers **160 req/min** into the anonymous limiter, so events/webhook/reads report `ok=0` every cycle. The soak measures its own rate limiter. **The real ceiling is 60/min, not §1.10's 100** — `apiIpShadowGuard` (`index.ts:413`) caps all of `/api` at 60 and skips only keyed `/api/v1`. Budget soak drivers under 60. |
| [FD-PROBE-1](FD-PROBE-1-anonymous-401-cannot-prove-a-route-exists.md) | An anonymous `401` under a prefix-gated router is returned **unconditionally** — it cannot tell "mounted and gated" from "route does not exist". One probe was green all window against a `404`. |
| [FD-SEED-1](FD-SEED-1-baseline-fixture-self-reverts-in-7-minutes.md) | **OPEN, systemic.** `seed-baseline-fixture.sql` writes its SUBMITTED anchor with `chain_tx_id` NULL — the exact row `recover_stuck_broadcasts()` (0379) reclaims to PENDING every 2 min. **Every** rig it seeds fails preflight Check 5 ~7 minutes after provisioning. |

## Product / correctness

| Finding | One-line lesson |
|---|---|
| [FD-GATE-1](FD-GATE-1-api-v1-killswitch-gap-2026-08-20.md) | Three `/api/v1` route trees mount **before** the catch-all with no `verificationApiGate()`, so §1.9's kill switch does not cover them. |
| [FD-FERPA-1](FD-FERPA-1-directory-opt-out-not-honored-2026-08-20.md) | `anchors.directory_info_opt_out` is read by **no** public projection; opted-out records are still publicly served. |
| [FD-SDK-1](FD-SDK-1-sdk-prs-cannot-reach-the-unsoakable-path.md) | SDK/package PRs are hard-**T2** but one `.github/workflows/` or `scripts/` file in the diff disqualifies them from the unsoakable-evidence path, demanding worker evidence that cannot truthfully exist. |
| [FD-CI-2](FD-CI-2-pull-request-workflow-dispatch-stalled.md) | **OPEN.** No `pull_request` workflow has dispatched repo-wide since 20:23:21Z. PR boards look green because the required checks are **absent**, not passing. Verify gate presence on the head SHA before trusting any PR. |
| [FD-TRAIN6-1](FD-TRAIN6-1-soak-driver-invalidates-its-own-preflight.md) | A driver can **destroy the precondition its own window is judged against**. Window voided and restarted, not waived. **Its named mechanism is CORRECTED by [FD-SEED-1](FD-SEED-1-baseline-fixture-self-reverts-in-7-minutes.md)** — the reclaimer was `recover_stuck_broadcasts()`, not the sweep probe; the general rule stands, the worked example's attribution did not. |
| [FD-GATE-2](FD-GATE-2-stale-base-sha-inflates-pr-tier.md) | **OPEN, systemic.** The gate two-dot-diffs from GitHub's *frozen* `pull_request.base.sha`, so `main`'s later commits are attributed to a stale PR and inflate its tier (#2215: 17 files → 77, T1 → T2). Merging `main` in resets it. |
| [FD-REORG-1](FD-REORG-1-detectreorgs-inprocess-cron-times-out.md) | `detectReorgs`' **in-process** cron times out ~3×/hour (151× in 48 h). The Cloud Scheduler path returned 288/288 × 200, so reorg detection was never actually down — but two paths share a name and only one is broken. |
| [FD-PROD-1](FD-PROD-1-0386-merged-but-unapplied-fingerprint-oracle-open.md) | **OPEN.** Migration 0386 is merged but **never applied to prod** — the fingerprint existence oracle it closed is still open live. Found by md5-comparing function bodies against prod, not by assuming repo head. |
| [FD-CI-1](FD-CI-1-actions-budget-exhausted-2026-08-21.md) | **RESOLVED 2026-08-21T15:51Z.** The Actions budget ran out 2026-08-21 ~15:32Z. Every job repo-wide is refused in 2–4 s, so no PR can go green and Mergify cannot merge. Soaks are unaffected. |
| [FD-CL-1](FD-CL-1-courtlistener-429-backoff-has-no-budget.md) | **OPEN.** `/jobs/fetch-courtlistener` has **no cumulative budget and no consecutive-429 cap**, so a sustained upstream 429 loops to `maxPages` (2000 x 30s) and Cloud Run kills it at the 3600s ceiling. **57% of runs for 8 days**, ~19 instance-days burned. |

## Traps that are now enforced in code, not prose

These were each found the expensive way and then encoded, because a checklist item gets
skipped and a check does not:

- **Evidence must be non-empty** — `scripts/staging/soak-liveness-check.sh` asserts an
  evidence file exists, is fresh, reports `ok > 0`, and the serving revision still matches
  the pinned clock. A soak producing nothing now fails loudly instead of looking green.
- **`ENABLE_VERIFICATION_API` is seeded at provisioning — enforced for real as of PR #2306
  (merged 2026-08-21T20:07Z).** `scripts/staging/seed-baseline-fixture.sql` now writes the
  `switchboard_flags` row. Verified after merge, by grep, not by reading this list.
  *History, kept deliberately:* this entry sat in the "enforced in code" section for weeks while
  the cited file contained **zero** occurrences of the flag — it was prose claiming to be
  enforcement. That gap cost wave2 its entire 12 h window and is why the migration-T3 soak
  returned 503 on every read. Without the row, `get_flag` fails closed and every `/api/v1`
  request 503s in under 10 ms *before reaching application code*, while the rig reports healthy.
  The claim is now true; the history stays so the next false "enforced" entry is easier to spot.
- **401/403 count as failure** in `wave3-load-loop.sh`. The classifier previously counted
  any 2xx–4xx as `ok`, so a run where **every request was rejected** reported
  `ok=61 fail=0`.

## Operational traps not yet enforced — check them by hand

- **A soak covers only what the driver probes.** wave3 soaked 9 members and probed 2.
  Anything unprobed must be written up as NOT covered, per member.
- **Cloud Run tags must match `pr-<digits>` or `train-*`** (`load-harness-env.ts:18-24`) or
  the load harness refuses to start. Tag `t1-2290` cost 31 minutes of unloaded clock.
- **`gcloud run deploy` preserves env vars**, and `/health` reads `git_sha` from
  `BUILD_SHA`. Deploy without `--update-env-vars BUILD_SHA=<head>` and `/health` reports
  the *previous* image's SHA — evidence captured then looks wrong on inspection.
- **Identity tokens minted with `--audiences=<tag URL>` are rejected** by Cloud Run — 401
  on every path including `/health`. Mint without `--audiences`.
- **`launchd` `StartInterval` schedules from job EXIT, not start.** A 25-minute run on
  `StartInterval=1800` yields ~55-minute cycles — a 45 % duty cycle, which capped wave2 at
  38.2 % coverage.
- **Stale branches break gate tier/path computation.** If a gate demands evidence for a
  tier or path that contradicts the actual diff, check how far behind `main` the branch is
  before rewriting the evidence block. But do not mass-rebase on that theory — most gate
  failures are genuine evidence gaps.
- **`DEPLOY_WORKER_PAUSED=true` means merging does not reach prod.** Pre-deploy checks
  still run and the workflow still reports success, so a green `deploy-worker` run does
  **not** mean anything shipped.
