# FD-REORG-1 — `detectReorgs` times out on its only production path

**Found:** 2026-08-21, closing the chain-pair soak's pre-mortem controls over its 48 h log window.
**Extended:** 2026-08-22, production sweep.
**Severity:** high. Chain-safety code on the anchor lifecycle (CLAUDE.md §1.12 T3 surface) fails
intermittently in production, and production has no second path to fall back on.

## What is happening

`detectReorgs` opens with an unguarded chain-tip fetch:

```ts
// services/worker/src/jobs/chain-maintenance.ts:365
const tipResp = await fetch(`${baseUrl}/api/blocks/tip/height`, {
  signal: AbortSignal.timeout(10000),
});
```

That fetch times out. The escaping error is always the same:

```
TimeoutError: The operation was aborted due to timeout
  at node:internal/deps/undici/undici:14976:13
  at async detectReorgs (file:///app/dist/jobs/chain-maintenance.js:290:25)
```

It is the *tip* fetch by elimination: the per-TX fetch later in the function
(`chain-maintenance.ts:485`) has its own `try/catch` that logs at `debug`, so a timeout there
cannot propagate. Only the tip fetch can reach the cron's `catch`.

| Environment | Window | `Reorg detection cron failed` |
|---|---|---|
| `arkova-worker-fullsoak-2026-08-staging` (signet) | 2026-08-19T16:51:23Z → 2026-08-21T16:51:23Z | **151** |
| `arkova-worker` (mainnet, prod) | 2026-07-22 → 2026-08-21 | **313** |

All 151 and all 313 carry the identical `TimeoutError` signature. Both environments are affected;
two different mempool.space paths (`/signet` and mainnet) rule out an upstream-specific fault.

## The two paths, and why only one of them logs this string

`'Reorg detection cron failed'` is emitted from exactly one call site — the in-process node-cron
at `services/worker/src/routes/scheduled.ts:256`. The HTTP route
(`services/worker/src/routes/cron.ts:1245`) logs a *different* string, `'Reorg detection failed'`,
and returns **500**. The two strings differ by one word and by which subsystem is broken.

The failures land at minute `:00 / :10 / :20 / :30 / :40 / :50` — the in-process `*/10` schedule.
Cloud Scheduler on the rig fires at `3-59/10` (`:03 / :13 / …`). **They are different invocations
three minutes apart, not one invocation that throws and 200s anyway.**

## The correction that matters: production has no scheduled path

On the rig the scheduled path masks the defect — 288 × HTTP 200 over the window, and the rig's
Cloud Scheduler job `arkova-worker-fullsoak-2026-08-staging-detect-reorgs` exists. **Production has
no such job.** Verified 2026-08-22:

- `gcloud scheduler jobs list --project=arkova1 --location=us-central1` contains
  `arkova-worker-fullsoak-2026-08-staging-detect-reorgs` and **no** bare `detect-reorgs`.
- `arkova-worker` served **0** requests to `/jobs/detect-reorgs` in 30 days. Same for
  `/jobs/monitor-stuck-txs`, `/jobs/rebroadcast-txs`, `/jobs/consolidate-utxos`, `/jobs/monitor-fees`.
- `DISABLE_IN_PROCESS_ANCHOR_CRON` is unset on `arkova-worker`, and the
  `'Skipping in-process anchor cron in production…'` line appears **0** times — so the in-process
  cron is live and is the *only* reorg detector prod has.

So the reassuring "the primary path works" reading holds for the rig only. In production the
unreliable path is the sole path. See FD-PROD-2 for the provisioning gap behind this.

## Why the same instance succeeds over HTTP and fails on the timer

Not upstream flakiness, not DNS, not egress, and not a wedged instance — the same process does both:

| Instance (prefix) | in-process failures | `/jobs/detect-reorgs` requests served, all 200 |
|---|---|---|
| `00a41e8c1d40` | 26 | 77 |
| `001548f72988` | 22 | 79 |
| `00a41e8c1db5` | 12 | 73 |
| `00a41e8c1da5` | 26 | 59 |

Identical code, identical upstream, identical process. The only variable is **execution context**:
the fetch fails from the background timer and succeeds from inside a request. That much is
established.

**What the mechanism is, is not established.** An earlier draft asserted Cloud Run CPU throttling:
`run.googleapis.com/cpu-throttling` is unset on both services (the throttled default), so a
background timer would run starved while `AbortSignal.timeout(10000)` counts wall-clock. That
rested on the "node-cron is dormant under Cloud Run CPU throttling" reading, which **PR #2429
(SCRUM-3384) explicitly retracts** — node-cron fires normally on a warm instance, and prod
`minScale=2` means every instance runs every tick.

The retraction is consistent with what is measured here: the cron plainly fires, roughly 6×/hour
per instance, and it is the *fetch* that fails, not the tick. So the dormancy framing was never
what these logs showed. But dropping it also removes the support for the throttling explanation,
and nothing has replaced it — no direct CPU measurement, and no upstream latency measurement from
either context.

Traffic volume does not explain it either: prod's worst day in the original window (2026-07-26,
143 failures) carried 4,070 requests, more than 2026-07-24 (3,760 requests, 1 failure).

Treat the mechanism as **open**, owned by SCRUM-3384. The remediation in this document does not
depend on resolving it — provisioning the prod scheduler job moves reorg detection onto the
execution context that is empirically reliable, whatever the underlying reason turns out to be.

## Escalation (re-measured 2026-08-29)

The rate has climbed by an order of magnitude, and nothing has been fixed: `main` (`f576e2f64`)
still carries the unguarded tip fetch and the silent catch, and none of the 11 scheduler jobs are
provisioned (`arkova-worker` served 0 requests to `/jobs/detect-reorgs` since 08-22).

| Date | `Reorg detection cron failed` |
|---|---|
| 08-22 | 1 |
| 08-27 | 9 |
| 08-28 | **116** |
| 08-29 (to 15:10Z) | **64** |

On 08-28, **94 of 144 ten-minute ticks (65%)** logged at least one failure across both instances.
Against a ~10/day baseline over 2026-07-22 → 08-21. Reorg detection on mainnet is close to fully
dark, with migration 0347 reorg handling live behind it. See SCRUM-3191 for the full record.

## Two adjacent defects this uncovered

**1. The sibling job fails silently.** `monitorFeeRates` (`chain-maintenance.ts:936`) runs on the
same `*/10` in-process schedule and fetches the same host with a *tighter* 5 s timeout, but wraps
it in `} catch {` (`:957`) that returns zeros with **no log line at all**. It reported 0 failures
in the same window on the same instances. It is not healthy — it is unobservable.
`monitorStuckTransactions` returns before it ever fetches when no anchors are stuck. `detectReorgs`
is the only one of the three whose first fetch is unguarded, which is why it is the only one
visible. It is the canary, not the outlier.

**2. HTTP 200 is not evidence detection ran.** `detectReorgs` returns
`{ checked: 0, reorgsDetected: 0, reverted: 0 }` — and the route replies **200** — when the tip
fetch returns non-OK (`:369`, `warn` only). Success is logged at `logger.debug`
(`:495`, `'Reorg detection complete — no reorgs'`), and both services run `LOG_LEVEL=info`. So
there is no info-level signal anywhere that distinguishes "checked N anchors" from "did nothing."
The rig's 288 × 200 proves the endpoint answered, not that reorg detection happened.

## Recommended

1. **Provision the prod Cloud Scheduler job** (`detect-reorgs`, `monitor-stuck-txs`,
   `rebroadcast-txs`). This is FD-PROD-2 and is the highest-value single action — it gives prod the
   request-context path that already runs 288/288 on the rig.
2. Once prod has the scheduled path, set `DISABLE_IN_PROCESS_ANCHOR_CRON=true` in prod (the
   allowlist at `scheduled.ts:38` already covers `detect-reorgs`) to remove the duplicate and its
   noise. Do **not** reach for `run.googleapis.com/cpu-throttling=false` as the fix — that was an
   earlier draft's recommendation and it assumed the throttling mechanism this document no longer
   claims. It would be a guess with a standing cost.
3. Give `monitorFeeRates` a log line on its swallowed catch. A silent `catch {}` on a chain call is
   worse than the failure it hides.
4. Emit reorg-detection outcome at `info` (`checked`, `reorgsDetected`), and return a distinguishable
   result on the tip-fetch-failed path so a 200 cannot be read as a clean sweep.
5. Trim the 25 `DOMException` constants from the pino error serializer — cosmetic, but they bury
   `name`/`message`/`stack` in any log viewer showing the first few keys.

## The rule this is a case of

Two code paths can share a name and a purpose and have completely different reliability — match the
**exact log string** to its emitting call site before concluding which one failed. And a green
staging path proves nothing about prod until you have checked that prod *has* that path: the rig's
288/288 was doing the reassuring, and prod was never wired to it.
