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

## Measured result of the fix — a partial win, stated as such

The migration-T3 leg was switched from `--mode mixed` to `--mode reads` + `--mode cron`
at 15:34Z. First post-fix cycle (`20260821T153410Z`) versus the last mixed cycle:

| | before (mixed) | after (reads + cron) |
|---|---|---|
| total requests | 4,011 | 1,272 |
| 429s | **3,437** | **622** |
| successful requests | 25 (cron only) | 25 (cron only) |
| reads `byStatus` | `401:17 429:973 503:257` | `401:43 429:622 503:582` |

**What improved:** self-inflicted 429s fell 82 %, and the dominant response is now `503`
— a real answer from application code rather than the limiter swallowing the request.

**What did NOT improve, and why:** `reads` is still `ok=0`. That is *not* the driver's
fault and no rate change fixes it — this rig's Supabase project has no
`ENABLE_VERIFICATION_API` row in `switchboard_flags`, so `get_flag` fails closed and every
`/api/v1` request returns a sub-10 ms `503` before reaching application logic. The wave3
maturity record documents the same condition on this rig. `/api/admin/pipeline-stats`
answers `401` (its auth gate, working correctly).

622 residual 429s at an offered 50/min against a documented 100/min/IP bucket also says the
effective budget is lower than the headline number for these paths — worth a follow-up, but
it is no longer the dominant failure mode.

**Consequence for the migration-T3 window, stated plainly:** its HTTP evidence covers the
middleware, auth and rate-limit path plus cron — it does **not** cover `/api/v1` behaviour,
because that surface is dark on this rig. Migrations 0410–0414 are DB-level changes
(`partner_accounts`, a cleanup `lock_timeout`, a stale-estimate sentinel, a calibration view,
anon revokes), and the right acceptance instrument for them is targeted SQL against the rig
database, not anonymous HTTP load. This window should not be cited as exercising them.

## Correction — the real anonymous ceiling is **60/min**, not 100

CLAUDE.md §1.10 states "Anonymous: 100 req/min/IP", and `anonRateLimiter`
(`services/worker/src/api/v1/router.ts:195`) is indeed `windowMs: 60_000, maxRequests: 100`.
**But it is not the first limiter an anonymous request meets.**

`services/worker/src/index.ts:413` mounts `apiIpShadowGuard` on the whole `/api` prefix:

```ts
const apiIpShadowGuard = rateLimit({
  windowMs: 60000,
  maxRequests: 60,
  skip: (req) => req.originalUrl.startsWith('/api/v1/') && hasApiKeyCredential(req),
});
app.use('/api', apiIpShadowGuard, badgeRouter);
```

The `skip` exempts only `/api/v1/*` requests **carrying an API key**. An anonymous request is
not skipped, so it is capped at **60/min** before `anonRateLimiter` is ever consulted. The
code's own comment says as much: *"still capped here at 60/min per IP."*

**Consequences:**
- `--mode mixed`'s 160/min is **2.7×** the real ceiling, not 1.6×. The finding above understated it.
- Any driver sized to §1.10's 100/min — the documented number — will still 429. A soak driver
  written from the constitution alone is guaranteed to trip the limiter. A run at 36/min drew ten
  429s on a fresh rig, which is consistent with a 60/min bucket shared with other probe traffic.
- Everything **outside** `/api/v1` (badge, checkout, verify-anchor, treasury, admin) is capped at
  60/min for every caller including API-key holders, because the skip is `/api/v1`-scoped.

**§1.10 is inaccurate as written** and should say that anonymous callers are governed by the
60/min `/api` guard, with the 100/min `/api/v1` anon limiter sitting behind it. Filed as a
separate CLAUDE.md rule change (rule changes go through PR review per §0 rule 8, even though
CLAUDE.md is a `.md` file).

**Practical guidance for anyone writing a soak driver: budget under 60/min of anonymous traffic
per egress IP, not 100** — and remember every concurrent driver on the same machine shares that IP.

## The rule this is a case of

A soak covers only what the driver **successfully** probes. `ok=0` with a four-figure 429
count is not "load under backpressure" — it is the harness measuring its own rate limiter.
Related: [[FD-WAVE3-1]] (empty bearer, every request rejected, reported as success).
