# FD-CLOCK-1 — instance uptime is the wrong soak clock on a min-instances service

**Found 2026-08-20T17:37Z on the chain-pair T3 soak. Left uncorrected, this would have
produced a false "the soak reset" conclusion at clock close and triggered an unnecessary
48-hour re-run.**

## What was observed

Probing the chain-pair rig's `/health` returned `uptime ≈ 14,841s` (~4.1h) on all three
probes, against a soak clock that started 2026-08-19T16:51:23Z — i.e. ~24.8h earlier. Three
hours earlier the same probe had returned `78,337s` on one instance. The obvious reading is
"the service restarted and the clock is broken."

## What is actually true

| Check | Result |
|---|---|
| Serving revision | `arkova-worker-fullsoak-2026-08-staging-00022-suy`, **unchanged** |
| Revision created | 2026-08-19T16:51:23Z — exactly the clock start |
| Traffic | 100% to that revision, continuously |
| HTTP 5xx since clock start | **zero** |
| Container terminations / crashes / CRITICAL | **zero** |
| Instance starts | 2026-08-20T13:28Z and 17:33Z, reason `MANUAL_OR_CUSTOMER_MIN_INSTANCE` |

The service never went down. Cloud Run **recycles instances by design** on a service with
`minScale >= 1`: it starts a replacement, drains the old one, and the service stays up
throughout. What expired was an instance, not the soak.

## The methodology error

Our standing rule says "soak clock = worker uptime" (adopted because probe loops die when a
session ends, so process-local timers are unreliable). That rule is right about probe loops
and wrong about what to substitute. On any service with min-instances configured, **no single
instance will survive long enough to evidence a 48h window** — instance uptime is
architecturally incapable of measuring a multi-day soak. It happened to work for the 7-day
soak only because that rig ran `minScale=1` and got lucky with recycle timing. The chain-pair
and Wave rigs run `minScale=2` for cross-instance evidence, which makes recycles routine.

## Corrected definition

**Primary clock: revision age.** `metadata.creationTimestamp` of the revision that has served
100% of traffic for the whole window, to now.

**Integrity conditions that must ALSO hold** (any failure invalidates or amends the window):
1. Serving revision unchanged and never rolled back.
2. No HTTP 5xx attributable to the service.
3. No container termination, crash, or CRITICAL log.
4. Health green across the periodic checks, with their real timestamps recorded.

**Instance uptime is a supporting signal only.** It is still useful for one thing: if EVERY
instance reads ~0 simultaneously AND a new revision exists, that is a genuine redeploy and
the clock does reset. A single low reading among several is the already-documented
multi-instance false positive; all-low readings with an unchanged revision are a recycle.

## Consequence for the running soaks

None of the four current soaks are invalidated. Chain-pair has 24.8h of continuous
single-revision service with zero errors as of this writing, against a 48h target ending
2026-08-21T16:51:23Z. The same correction applies to Wave 2, Wave 3, and migration-T3, all
of which run min-instances services.
