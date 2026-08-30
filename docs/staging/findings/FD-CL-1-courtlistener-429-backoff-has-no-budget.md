# FD-CL-1 — `/jobs/fetch-courtlistener` burns a full Cloud Run hour on every 429 storm

**Filed:** 2026-08-22
**Severity:** Medium-High — not customer-facing and not data-corrupting, but it has been
failing **57 % of runs for 8 days** and each failure holds a Cloud Run instance for the full
3600 s request ceiling.
**Status:** OPEN. Mechanism established and verified in prod logs + source.

## The numbers

Last 24 h on `arkova-worker` (project `arkova1`):

| Outcome | Count |
|---|---|
| `504` | **52** |
| `200` | 40 |

**56.5 % failure rate.** Daily `504` counts since it started:

| Date | 504s |
|---|---|
| 2026-08-15 | 25 (partial day — this is where it begins) |
| 2026-08-16 | 77 |
| 2026-08-17 | 71 |
| 2026-08-18 | 59 |
| 2026-08-19 | 69 |
| 2026-08-20 | 71 |
| 2026-08-21 | 54 |
| 2026-08-22 | 36 (partial) |

**462 × 504 over 8 days.** Every one of them holds an instance for the full hour, so this is
roughly **19 instance-days of Cloud Run time consumed producing nothing.**

## Every 504 is pinned to the request ceiling

```
3600.004742525s
3599.695338977s
3599.695009731s
3599.694915813s
...
```

`gcloud run services describe arkova-worker --format='value(spec.template.spec.timeoutSeconds)'`
returns **3600**. These are not upstream timeouts — the job never returns, and Cloud Run
kills the request at its ceiling.

## The mechanism

`services/worker/src/jobs/courtlistenerFetcher.ts:294`:

```ts
if (response.status === 429) {
  logger.warn('CourtListener rate limited — backing off 30s');
  await delay(30_000);
  continue;
}
```

The backoff is **correct in isolation** — bounded, awaited, and it consumes one slot of the
`for (let page = 0; page < maxPages; page++)` loop. What is missing is any bound on the
*aggregate*:

- `BULK_MAX_PAGES = 2000` (line 49) is the default `maxPages` (line 223).
- The per-court path uses `maxPages: options.maxPagesPerCourt ?? 200` (line 452).
- There is **no cumulative deadline** and **no consecutive-429 cap** anywhere in the loop.
  Grepping the file for `deadline|budget|Date.now()|elapsed|startedAt` returns only a
  docstring about redirect hops — nothing in the retry path.

So under a sustained upstream 429, worst-case backoff time is **2000 × 30 s = 60,000 s** on
the bulk path and `N_courts × 200 × 30 s` on the state path. Both are far beyond the 3600 s
request ceiling, so the job **cannot terminate before Cloud Run kills it**. It makes zero
progress and returns nothing.

The file's own docstring (lines 29–32) already anticipates this: it notes the fetcher
"backs off on an explicit 429, so a single stalled page can pin a cron."

## Why the 429s are sustained — a positive feedback loop

The prod logs show roughly **six retry chains interleaved**. They are genuinely concurrent,
each correctly spaced 30 s apart:

```
15:51:12.442 auth check → 15:51:42.579 auth check   (30.1 s)
15:51:13.589 auth check → 15:51:43.698 auth check   (30.1 s)
15:51:17.387 auth check → 15:51:47.499 auth check   (30.1 s)
```

`fetchStateCourts` iterates courts with `await` inside a `for...of` (line 447), so a single
invocation is **not** self-concurrent. The concurrency therefore comes from **overlapping
invocations**: each run survives up to an hour, the scheduler fires the next before the
previous finishes, and concurrent callers accumulate. More concurrency produces more 429s,
which makes each run longer, which increases overlap. It is self-sustaining, which is why it
has not cleared on its own in 8 days.

## Correction to my own first reading — recorded deliberately

I first read the ~1 s spacing between `auth check` lines in the log and concluded the
backoff was **logged but never awaited** — a hot retry loop. **That was wrong.** The `await
delay(30_000)` on line 296 is real and is honored. The 1 s spacing is an artifact of six
independent chains interleaving in a single log stream; each individual chain is correctly
30.1 s apart.

The distinction matters, because the two readings imply opposite fixes. A missing `await`
would be a one-line fix in the backoff. The actual defect is an **unbounded aggregate**, and
fixing it requires a budget or a retry cap — changing the `delay` would do nothing. This is
the same failure mode the findings index exists to catch: a plausible mechanism that matches
the symptom is not the same as a verified one.

## Suggested fix (not yet written)

Any one of these closes it; the first is the smallest:

1. **Consecutive-429 cap** — bail after N consecutive 429s (`N = 5` is ~2.5 min) and return
   a partial result with `errors++` rather than looping to `maxPages`.
2. **Cumulative deadline** — capture `startedAt` before the loop and `break` once elapsed
   exceeds a budget set safely below the Cloud Run ceiling (e.g. 45 min).
3. **Overlap guard** — refuse to start if a previous invocation is still in flight. This
   attacks the feedback loop rather than the symptom and would likely reduce the 429s at
   source.

(2) and (3) together are the durable fix: (2) guarantees termination, (3) removes the cause.

## Class check — the same log shape exists in 9 other fetchers

`grep -rn "backing off" services/worker/src` matches `cmsPhysicianFetcher`, `brazilFetcher`,
`npiFetcher`, `samGovFetcher` (×2), `finraBrokerCheckFetcher`, `calbarFetcher`,
`fccUlsFetcher`, and `secIapdFetcher`. **Whether they share the unbounded-aggregate defect
is NOT established** — only CourtListener has been read and only CourtListener is failing in
prod. Per the "lint rule beats human census" rule, the right follow-up is a check that
asserts every retry loop has a cumulative budget, not a hand audit of nine files.

## What this finding does NOT claim

- No customer-facing impact. This is public-records ingestion; those feeder crons are
  already paused with a large pending backlog.
- No data corruption — the job inserts nothing when it fails.
- No causal link to the 2026-08-21 deploy. This begins **2026-08-15**, six days earlier, and
  is unrelated to FD-DAPIP-1 despite both being ingestion jobs on the same service.
