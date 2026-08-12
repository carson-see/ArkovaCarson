# Bound the body read, and bound the run — a TTL cannot do either

**Rule.** Two liveness guards that look complete and are not:

1. **`AbortSignal.timeout(...)` passed to `fetch()` does NOT bound `await response.json()`.**
   The signal covers the request; the body read is a separate await with no timer of its own.
   Every `fetch(...)` → `.json()` / `.text()` against an external provider in
   `services/worker/src/**` must go through `readJsonBounded` / `readTextBounded`
   (`utils/body-read-timeout.ts`).
2. **A heartbeat-renewed TTL lease cannot bound a hung run.** The TTL answers only "how long
   does a *dead* holder block the job". Bound the run body separately — `maxRunMs` on
   `RunLeaseSpec` (`jobs/run-lease.ts`).

## Why

F-D0-5, found 2026-08-12 on the fullsoak rig running **prod's image digest** (revision
`arkova-worker-fullsoak-2026-08-staging-00012-f45`). Evidence:
`docs/staging/fullsoak-2026-08/day0-bl2-secured-e2e-evidence.md` §2.6a / §4. Fixed in PR #2216.

A `check-confirmations` run parked on an awaited provider body and never returned.
`SUBMITTED → SECURED` promotion was disabled for **every tenant** for 35+ minutes, with
**zero warn/error logs**, while 31 forced `POST /jobs/check-confirmations` calls each answered
`{"checked":0,"confirmed":0}` — byte-identical to a healthy idle run.

Nothing could recover it:

- the heartbeat renewed on schedule (`14:27:50` / `14:39:30` / `14:51:10`, exactly `ttlMs/3`
  apart), so the TTL never expired;
- `releaseRunLease` lives only in `withRunLease`'s `finally`, which a parked body never reaches;
- the per-process `inFlight` Set is checked *before* the store, so the holding instance
  self-blocked every later local call;
- the lease is a global `job_queue` row, and prod runs `minScale=2, maxScale=10`, so one hung
  instance blocked the job for everyone.

The heartbeat's regular cadence is what makes this deceptive: it firing exactly on time *looks*
like health and *rules out* timer starvation, while being the mechanism sustaining the outage.

## How to apply

- **Reviewing any lease, lock, or mutex, ask the two questions separately:** "what bounds a
  holder that DIED?" and "what bounds a holder that is ALIVE but never finishes?" If the answer
  to the second is the same TTL, there is no answer.
- **Never fix a hang by shortening the TTL.** A TTL at or below the job's cadence lets the next
  tick steal the lease from a run that is still working — the cross-instance overlap the lease
  exists to prevent (SCRUM-3031, and the 2026-08-01 double-drain that created it). `maxRunMs`
  is the knob for a hung run; `ttlMs` is the knob for a dead one. `maxRunMs >= ttlMs` is
  asserted for every registered spec.
- **A deadline abandons, it does not kill** — nothing cancels a promise in JS. Observe the
  abandoned promise (`.then(noop, noop)`) or a late rejection becomes an unhandled rejection
  and takes the worker down.
- **Make a blocked run distinguishable in its RESPONSE, not just its logs.** 31 forced POSTs
  returning the idle-run body is what turned a 35-minute outage into an invisible one; hence
  `skipped: 'run-lease-held'` (F-D0-2), and a skip streak that outlives a full TTL escalating
  to `warn`.

## Enforcement

`scripts/ci/feedback-rules/bounded-body-reads.ts` (R0-7 orchestrator) flags a raw `.json()` /
`.text()` on a fetch response under `services/worker/src/**`. Deliberately narrow — worker
source only, response-bound receivers only, tests and the primitive's own implementation
exempt. Override label: `unbounded-body-read-reviewed`.

The `maxRunMs >= ttlMs` half is enforced by test, not lint:
`services/worker/src/jobs/__tests__/run-lease.deadline.test.ts` asserts it across
`RUN_LEASE_SPECS`, so a new lease spec cannot ship without a body bound.
