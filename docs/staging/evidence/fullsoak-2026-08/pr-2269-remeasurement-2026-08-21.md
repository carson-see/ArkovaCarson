# PR #2269 (rate-limit cluster) — on-clock re-measurement attempt

**Window:** 2026-08-19T16:51:23Z → 2026-08-21T16:51:23Z
**Clock revision:** `arkova-worker-fullsoak-2026-08-staging-00022-suy`
**Written:** 2026-08-21T19:05Z

## The problem this was meant to fix

#2269's three headline proofs — cross-instance shared counting, the Upstash
blackhole window, and the namespace SCAN — were all gathered on revisions
`-00018` / `-00020` between 16:24Z and 16:51Z on 2026-08-19, i.e. **before** the
48 h clock started on `-00022-suy`. Pre-clock evidence does not count toward the
soak. The intent was to re-run those probes live against `-00022-suy`.

## Live probes: NOT RUN

**No request was sent to the rig. No probe traffic was generated.** Two reasons,
both blocking:

1. **The rig was reclaimed.** By 18:39Z on 2026-08-21 — 1 h 48 m after the
   chain-pair clock closed — 100 % of traffic moved to `-00024-kaj` (tag
   `train-5`), a new 10-PR soak train mid-standup. `-00022-suy` is now a tag-only
   route with no traffic percentage. Full detail in
   `rollback-rehearsal-2026-08-21.md`.

2. **Probing `-00022-suy` would contaminate the train-5 soak's rate-limit state.**
   `resolveEnvironmentNamespace()` derives the Redis key prefix from `K_SERVICE`
   — the Cloud Run **service** name — which is identical for `-00022-suy` and
   `-00024-kaj`. Both revisions therefore read and write the *same* counter keys:

   ```
   arkova:rl:arkova-worker-fullsoak-2026-08-staging:<client-ip>
   arkova:rl:arkova-worker-fullsoak-2026-08-staging:cron-jobs
   ```

   Probe traffic aimed at `-00022-suy` consumes train-5's rate-limit budget and
   corrupts any limiter observation they make — and if their load generator runs
   from the same host, we collide on the identical `<client-ip>` key. This is
   `memory/feedback_no_live_soak_rig_as_validation_target.md` exactly: do not
   write to a soaking rig to validate a fix.

Anything measured under those conditions would not have been the controlled
measurement asked for, so it was not attempted.

## What *was* recovered — from in-window logs on the clock revision

This is a genuine upgrade on the pre-clock evidence for one of the three proofs,
because it is on `-00022-suy`, inside the 48 h clock.

### 1. Namespace proof — **on-clock, PASSED**

Four distinct instances of `-00022-suy` logged limiter initialisation in-window,
each carrying the correct namespace:

| Timestamp | Instance (suffix) | Message |
|---|---|---|
| 2026-08-19T16:51:38Z | `…1768b825315d` | `Upstash Redis rate limiting initialized (shared counters via INCR)` |
| 2026-08-19T16:51:42Z | `…33c28e0ff814` | same |
| 2026-08-20T13:28:32Z | `…8afd2773bf0d` | same |
| 2026-08-20T17:33:59Z | `…34a318d350f8` | same |

all with `"environmentNamespace": "arkova-worker-fullsoak-2026-08-staging"`.

Zero in-window occurrences of `Upstash Redis not configured — using in-memory
rate limiting` on `-00022-suy` (the one such line in the dataset is at
19:39:41Z on the superseded `-0021-jah`). So the Upstash-backed limiter was live,
correctly namespaced, on every instance start of the clock revision, for the whole
window.

**Minor defect noticed:** the `Rate limit exceeded` log line prints
`"key": "187.14.236.159"` — the bare client IP, without the namespace prefix that
`counterKey()` actually applies. The stored Redis key is namespaced; the log field
is not. Harmless today, but it is the kind of field an operator would reasonably
mistake for the real key during an incident.

### 2. Live limiter enforcement — **observed in-window**

Four real 429s, all on `-00022-suy`:

| Timestamp | `count` | `maxRequests` | key |
|---|---|---|---|
| 2026-08-20T13:23:35Z | 11 | 10 | `187.14.236.159` |
| 2026-08-20T13:23:55Z | 13 | 10 | `187.14.236.159` |
| 2026-08-21T13:23:29Z | 11 | 10 | `187.14.236.159` |
| 2026-08-21T13:23:50Z | 13 | 10 | `187.14.236.159` |

`maxRequests: 10` is the §1.10 batch tier. Request logs independently show exactly
4 × HTTP 429 in the window. The limiter demonstrably rejects over-limit traffic on
the clock revision — which the pre-clock evidence never showed, since it only
demonstrated header decrement, never an actual rejection.

### 3. Cross-instance shared counting — **NOT re-established**

The 429 bursts looked like a candidate natural experiment, but they are not. Both
events in each pair were served by a **single** instance:

- 08-20 pair → instance `00a41e8c…5315d` (both)
- 08-21 pair → instance `001548f7…f0d` (both)

A counter reaching 11 and 13 within one instance is equally consistent with shared
Redis counting and with a purely local bucket. **It proves nothing about sharing.**
No in-window log evidence distinguishes the two. The only evidence for cross-
instance counting remains the pre-clock 16:24–16:51Z probe (monotonic
`59,58,57,56,55` across a `min-instances=2` service) plus the unit suite.

### 4. Upstash blackhole / degradation — **not repeatable, and clean in-window**

Zero in-window occurrences of `Upstash rate limit unavailable — degrading to
per-instance bucket`. The two occurrences in the dataset are both pre-clock, on
`-0020-gag`, during the deliberate ~9-minute blackhole. Reproducing it requires
re-pointing `UPSTASH_REDIS_REST_URL` at an unreachable host — a service mutation,
which is exactly what must not happen while train-5 is standing up.

## The two proofs #2269's soak plan requires and that still do not exist

### Circuit breaker opening live — **CANNOT PRODUCE. Genuinely unexercised.**

Searched the full 48 h app-log record (51,689 entries) for the breaker vocabulary:

```
/circuit/i    → 0
/breaker/i    → 0
/half-open/i  → 0
/halfOpen/i   → 0
/open/i       → 0
```

**The circuit breaker never opened during the 48 h window.** Not once. Upstash
stayed reachable for the whole soak, so the 5-consecutive-failure threshold was
never approached. This is not a measurement gap in the logs — it is a genuine
absence of the event.

The breaker's state machine (`open` at 5 consecutive failures, `half-open` probe
after `RECOVERY_MS=30_000`) remains **unit-test-proven only**, via
`upstashRateLimit.circuitBreaker.test.ts`.

*What would be needed:* a rig nobody else is soaking on, plus a sustained
Upstash-unreachable window longer than 5 consecutive limiter calls, with the
breaker's state transitions logged. Note the structural obstacle recorded in the
soak-start doc and still true: a redeploy restarts the process and constructs a
fresh `closed` breaker, so the `open → half-open → closed` recovery replay is not
reachable by env-var flipping alone. It needs either an in-process fault injector
or a network-level block applied to a running instance.

### p95 latency delta, limiter engaged vs not — **CANNOT PRODUCE. One arm only.**

The limiter was engaged for 100 % of the 48 h window. There is no
limiter-disabled arm to difference against, and none can be reconstructed from
logs. **No delta is reported, and none should be inferred.**

For completeness, the engaged-arm baseline (all 40,675 in-window requests, from
`httpRequest.latency`):

| Scope | n | p50 | p95 | p99 |
|---|---|---|---|---|
| **All requests** | 40,675 | 256.1 ms | **932.7 ms** | 1,122.7 ms |
| `/health` | 17,326 | 138.7 ms | 208.6 ms | 257.4 ms |
| `/api/v1/anchor` | 15,972 | 781.7 ms | 1,024.2 ms | 1,229.5 ms |

Status distribution: 24,691 × 200 · 15,966 × 201 · 7 × 401 · 1 × 403 · 4 × 429 ·
6 × 503. The six 503s are the known Trigger B ramp burst
(01:40:47Z–01:42:11Z, all `POST /api/v1/anchor`, 8.4 s–82.2 s latency).

This is a useful baseline to difference *against later*. It is not the requested
comparison.

*What would be needed:* two runs on an exclusively-held rig at matched load — one
with the limiter middleware engaged, one with it bypassed — same revision, same
concurrency, same duration. That is a ~2× soak-hours cost and cannot be salvaged
from a window where the limiter was always on.

## Summary

| Proof | Pre-clock status | After this pass |
|---|---|---|
| Namespace correctness | pre-clock probe | **PASSED on-clock** (4 instances, in-window) |
| Live 429 enforcement | not evidenced | **PASSED on-clock** (4 events, in-window) |
| Cross-instance shared counting | pre-clock probe | **still pre-clock only** |
| Upstash blackhole / fail-open | pre-clock probe | **still pre-clock only** |
| Circuit breaker opens live | never | **UNEXERCISED — cannot produce** |
| p95 delta, limiter on vs off | never | **CANNOT PRODUCE — one arm only** |

Two of six moved from pre-clock to on-clock without touching the rig. Two remain
pre-clock. Two remain genuinely unproven and need an exclusively-held rig.

---
_Derived from Cloud Logging over the stated window. No probe traffic, no service
mutation, no Upstash or Supabase write was performed against the rig._
