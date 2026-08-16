# FD-RL-1 / FD-RL-2 — org-quota 429 lies in its headers, and its counter counts denials

**Found:** 2026-08-16 (Day 4), fullsoak-2026-08 rig, while injecting volume to make
Trigger B reachable. Both are **customer-facing** defects on `POST /api/v1/anchor`.
**Severity:** FD-RL-2 is the serious one — a naive client can lock itself out of its own
daily quota without creating anything.

## How they were found

3,100 anchor submissions were paced at 8/s against what §1.10 documents as a 1,000/min
API-key limit. 70 were accepted and **3,030 were rejected with HTTP 429**. The rejection
was correct — it just wasn't the limiter I expected, and the response misdescribes it.

## The control that worked — record this as evidence

The per-org **daily** quota (`perOrgRateLimit.ts`, SCRUM-2703) held under sustained load:
`TIER_QUOTAS.FREE.anchors_created = 100`, and the org was cut off at its cap and stayed cut
off across 3,030 consecutive attempts. The response body is exemplary:

```json
{"error":{"code":"ORG_QUOTA_EXCEEDED","message":"Your FREE plan limit for anchors_created is 100",
 "quota_type":"anchors_created","current":3132,"limit":100,"reset_at":"2026-08-17T00:00:00.000Z"}}
```

Correct code, correct limit, correct reset. **This is the first operating-effectiveness
evidence the per-org daily quota has had under real load.**

## FD-RL-1 — the 429's headers describe a different limiter than the one that denied it

```
HTTP/2 429
x-ratelimit-limit: 1000
x-ratelimit-remaining: 987      <-- on a DENIED request
x-ratelimit-reset: 1786897601
retry-after: 27217              <-- 7.6 hours
```

Two limiters run in sequence:

1. `utils/rateLimit.ts` — the per-minute API-key limiter. **Allowed** the request and set
   the `X-RateLimit-*` headers (987 of 1000 remaining).
2. `perOrgRateLimit.ts` — the per-org **daily** quota. **Denied** it, and does not overwrite
   the headers the first limiter already set.

So the response says "denied" while simultaneously advertising 987 requests of headroom.
A well-behaved SDK client that reads `X-RateLimit-Remaining: 987` concludes it has budget
and retries immediately — against a quota that does not reset for 7.6 hours. Of the four
rate-limit fields, only `Retry-After` is correct, and it contradicts the other three.

§1.10 requires rate-limit headers on every response. It is satisfied literally and violated
in substance: the headers are present and describe the wrong limiter.

**Fix:** whichever limiter issues the 429 must own the rate-limit headers on that response —
emit the org-quota limit/remaining/reset, or drop the per-minute headers on an org-quota
denial. Do not ship a response whose headers and body disagree.

## FD-RL-2 — `anchors_created` counts attempts, not anchors created

Verified directly against the rig database:

| Source | Value |
|---|---|
| `org_daily_usage` — `quota_kind='anchors_created'`, `usage_date=2026-08-16` | **3,132** |
| `anchors` actually created that day for the same org | **98** |

**32x overstated.** The counter increments on requests that were denied and created nothing.

Consequences, in order of severity:

1. **A client can lock itself out without creating anything.** A naive retry loop after a
   429 drives its own counter further past the cap. Once over, every retry deepens the hole
   until the daily reset. The customer sees "limit for anchors_created is 100" while having
   created far fewer than 100 anchors — and cannot get back under the cap by any means.
2. **The metric does not measure what it is named for.** `anchors_created` is a business
   event; this counts HTTP attempts.
3. **Usage-reporting risk.** If `org_daily_usage` feeds any billing, entitlement or customer
   usage display, that surface overstates by whatever share of traffic is rejected. *Not
   asserted:* I have not traced downstream consumers of this table, so this is a risk to
   check, not a confirmed billing defect.

**Fix:** increment the usage counter only when the underlying operation succeeds, or split
"requests" from "created" into distinct kinds. A regression test should assert that N denied
requests leave the counter unchanged.

## Consequence for this soak — Trigger B is unreachable at FREE tier

`batch-trigger-coverage.md` recorded that Trigger B needs 3,000 pending. The per-org daily
quota caps a FREE org at **100 anchors/day**, and both rig orgs are FREE. Two orgs give 200/day,
so 3,000 pending is **~15 org-days away** — structurally impossible inside this window
without changing tier.

Reaching Trigger B would require deliberately moving a rig org to `PAID`
(`anchors_created: 10,000`). That is a real state change to the software under test and is
**not** being done silently as part of a monitoring pass. Until it is done and documented,
the honest statement stands:

**Measured:** Trigger D (daily 03:00 flush); per-org daily quota enforcement under sustained
load (3,030 consecutive correct denials).
**NOT asserted:** Trigger A, Trigger B, or Trigger C fee-deferral — none reachable at FREE tier.

## Correction to my own earlier note

`batch-trigger-coverage.md` attributed the unreachability of Triggers A and B solely to
traffic *rate* (~36 anchors/day). That was incomplete: even at unlimited submission rate the
**FREE-tier daily quota of 100** is the binding constraint. The rate was never the ceiling.
