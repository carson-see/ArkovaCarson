# FD-REORG-1 — `detectReorgs` in-process cron times out ~3×/hour; the alerting path cannot see it

**Found:** 2026-08-21, closing the chain-pair soak's pre-mortem controls over its 48 h log window.
**Severity:** medium. Chain-safety code failing repeatedly. **Not** a production outage — the primary path works.

## What is actually happening

Across the chain-pair window (2026-08-19T16:51:23Z → 2026-08-21T16:51:23Z), **151** entries of
`Reorg detection cron failed` on `arkova-worker-fullsoak-2026-08-staging` — roughly 3 per hour
for 48 hours. The underlying error, recovered from the log payload:

```
TimeoutError: The operation was aborted due to timeout
  at node:internal/deps/undici/undici:14976:13
  at async detectReorgs (file:///app/dist/jobs/chain-maintenance.js:290:25)
```

An outbound fetch inside `detectReorgs` exceeds its abort timeout.

## Two corrections to how this was first reported

**1. It is NOT "the handler throws but the route still 200s."** That framing is wrong and was
checked against the source. `cronRouter.post('/detect-reorgs')` (`services/worker/src/routes/cron.ts:1245`)
has a correct `try/catch` that returns **`500`** with `logger.error({ error }, 'Reorg detection failed')`.

The 151 failures carry a *different* string — `'Reorg detection cron failed'` — which comes from
`scheduleInProcess('detect-reorgs', '*/10 * * * *', …)` in `services/worker/src/routes/scheduled.ts:249`.
So there are **two** reorg paths, and only the in-process one is failing:

| Path | Result in window |
|---|---|
| Cloud Scheduler → `POST /jobs/detect-reorgs` | **288 × HTTP 200** |
| in-process `node-cron` duplicate | **151 failures** |

The scheduled path — the one that actually governs reorg detection — worked throughout. That is
why nothing alerted, and it is the correct outcome, not a missed alert.

**2. The error serializer is NOT broken.** At first glance the logged `error` object looks like
garbage — 25 `DOMException` static constants (`ABORT_ERR: 20`, `DATA_CLONE_ERR: 25`, …). It is
noisy, but `name`, `message`, `stack`, `code` and `type` **are all present** in the payload. The
diagnosis above was recovered from it directly. No logging fix is needed; the constants just bury
the useful fields in any log viewer that shows the first few keys.

## Why it matters anyway

- `scheduleInProcess` is a known-unreliable pattern here. Per
  `memory/project_cloudrun_inprocess_cron_gotcha.md`, node-cron does not fire on a throttled
  Cloud Run instance, and the same window measured **7,072 missed in-process executions**
  (~3,536/day) against prod's 242 over the identical window, root-caused to `cpuIdle: true`.
  So the in-process scheduler is both missing executions *and* timing out when it does fire.
- 151 recurring `logger.error` entries on chain-safety code is exactly the noise floor that
  hides a real failure. Someone scanning errors on this service learns to ignore the string.
- The timeout itself is real: an outbound call in `detectReorgs` is too slow against this rig's
  signet node at least 3×/hour.

## Recommended

1. Decide whether the in-process duplicate should exist at all. Cloud Scheduler already drives
   `/jobs/detect-reorgs` reliably (288/288). If it is redundant, deleting it removes the noise
   and the missed-execution accounting in one move.
2. If it stays, give the `detectReorgs` fetch an explicit, longer timeout and a bounded retry,
   and downgrade a single timeout to `warn` so only sustained failure reaches `error`.
3. Consider trimming `DOMException` constants in the pino error serializer — cosmetic, but it
   is the reason this looked unreadable and was nearly filed as a broken logger.

## The rule this is a case of

Two code paths can share a name and a purpose and have completely different reliability. Match the
**exact log string** to its emitting call site before concluding which one failed — `'Reorg
detection failed'` and `'Reorg detection cron failed'` differ by one word and by which subsystem
is broken.
