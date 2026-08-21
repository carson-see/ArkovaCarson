# FD-LOAD-1 — `--mode mixed` offers 160 req/min into a 100 req/min anonymous limiter, so three of its four modes report 100% failure

**Found:** 2026-08-21, during the migration-T3 window (`arkova-worker-staging-00300-few`, tag `train-migration-t3`).
**Class:** evidence integrity. A soak can run for a full window, write a well-formed evidence file every cycle, pass a freshness check, and still have measured nothing on the HTTP surface.

## The finding

`runMixedMode` in `scripts/staging/load-harness.ts` hardcodes its component rates:

```
runWebhooksMode(opts, 10)     //  10/min
runEventsMode(opts, 100)      // 100/min
runCronMode(opts, 5 * 60)     //  every 5 min
runReadsMode(opts, 50)        //  50/min
```

That is **160 requests/min of anonymous traffic**. CLAUDE.md §1.10 sets the anonymous
limit at **100 req/min/IP**. Mixed mode without `STAGING_API_KEY` therefore cannot
succeed: it offers 1.6x the allowance from a single egress IP, trips the limiter within
the first minute, and then stays tripped for the rest of the run.

Only `cron` survives, because it authenticates with `STAGING_CRON_SECRET` and does not
consume the anonymous bucket.

## What it measured over the observed window

Twenty consecutive 25-minute cycles on the migration-T3 rig, 05:02Z -> 14:34Z on
2026-08-21. Every cycle is identical to within noise:

| cycle | total | events ok | cron ok | webhook ok | reads ok | 429s |
|---|---|---|---|---|---|---|
| 20260821T050222Z | 4011 | 0 | 25 | 0 | 0 | 3436 |
| 20260821T093311Z | 4011 | 0 | 25 | 0 | 0 | 3437 |
| 20260821T143358Z | 4011 | 0 | 25 | 0 | 0 | 3437 |
| *(all 20 cycles)* | ~4011 | **0** | 25 | **0** | **0** | ~3437 |

Roughly **86% of every cycle was the limiter rejecting our own traffic.** Per-mode
`errorRate` was exactly `1` for events, webhook and reads in all twenty cycles. The
25 cron successes per cycle are the only genuine load the window produced.

## Why it survived the existing guards

The anti-hollow-soak guards added after FD-WAVE3-1 assert that an evidence file **exists**,
is **fresh**, and reports **`ok > 0`**. This run satisfies all three: `cron.ok = 25` is
non-zero, so the aggregate `ok` count is non-zero and the liveness check passes. The
guard cannot tell that three of the four modes are identically dead, because it looks at
a total rather than per-mode error rates.

## Fix

- Immediate, for a soak already running: switch the leg off `--mode mixed`. `--mode reads`
  runs at a hardcoded 50/min, comfortably under the anonymous cap, and produces real
  responses; `--mode cron` is unaffected by the limiter.
- Note that `--rate` does **not** help: `case 'reads'` and `case 'events'` ignore `args.rate`
  and pass literals (`50`, `100`), and `runMixedMode` takes no rate argument at all. Passing
  `--rate` to those modes is silently a no-op — itself worth fixing.
- Durable: either lower the mixed composition below 100/min, or have mixed mode require
  `STAGING_API_KEY` (the API-key allowance is 1,000 req/min) and fail loudly without it.
- Guard: extend the liveness check from "aggregate `ok > 0`" to "**no mode** has
  `errorRate == 1`". A mode that never once succeeded is a dead probe, not load.

## The rule this is a case of

A soak covers only what the driver **successfully** probes. `ok=0` with a four-figure 429
count is not "load under backpressure" — it is the harness measuring its own rate limiter.
Related: [[FD-WAVE3-1]] (empty bearer, every request rejected, reported as success).
