# SCRUM-2643 — Rate-limit posture (SPEC)

**Lane 2 · 2026-07-20 · SPEC ONLY (implementation post-train). Engineering note, not Confluence doc.**

Exit target (Lane 2 plan row 14): **limits live; verifier paths load-tested at KPI-2/3 patterns, NOT throttled.**

## Current state (verified in source)

`services/worker/src/utils/rateLimit.ts` `rateLimiters` (all `windowMs = 60_000`, per-IP unless noted):

| Limiter | Limit / min | Key | Applied to |
|---|---|---|---|
| `api` | **60** / IP | IP | general `/api` mounts |
| `stripeWebhook` | 100 | global (`'stripe'`) | Stripe + reused for DocuSign/Adobe webhooks |
| `checkout` | 10 / IP | IP | checkout |
| `auth` | 5 / IP (skips failed) | IP | auth |
| `quotaCheck` | 10 / IP | IP | quota checks |

Additional layers (not in the table above):
- **Upstash Redis** distributed limiter (`initUpstashRateLimiting`, `utils/upstashRateLimit.ts`) — cross-instance limiting when configured.
- **API v2 per-scope limits** (env, `docs/reference/ENV.md`): `API_V2_RATE_LIMIT_READ_SEARCH_PER_MIN=1000`, `READ_RECORDS=500`, `READ_ORGS=500`, `WRITE_ANCHORS=100`, `ADMIN_RULES=50` — per API key per scope.
- **Per-org** (`middleware/perOrgRateLimit.ts`) and **x402 payer** (`middleware/x402PayerRateLimit.ts`, 60/min default) limiters.

## Discrepancy to reconcile (§1.5)

CLAUDE.md §1.10 asserts the posture: **anonymous 100 req/min/IP, API key 1,000 req/min, batch 10 req/min**, `Retry-After` on 429, headers on every response.

Reality diverges:
- The general `api` limiter is **60/min per IP**, not 100.
- There is no single "API key = 1,000/min" limiter; API-key limiting is the **v2 per-scope** matrix (read-search 1,000, but write-anchors 100, admin-rules 50), which is a finer-grained model than §1.10's flat 1,000.
- "Batch 10/min" maps to `checkout`/`quotaCheck` (10/min) but there is no limiter literally named/scoped "batch".

**Action:** the implementation must EITHER bring the limiters in line with §1.10 OR update §1.10 to describe the actual (finer-grained) posture. Recommend the latter — the per-scope model is better than the flat one — and correct §1.10 to match, so the constitution stops asserting a posture prod doesn't have.

> **Process note (Architect review):** editing §1.10 is a **`CLAUDE.md` rule change** → per §0-rule-8 it goes through PR review and **rides the implementation PR**, NOT the docs direct-commit carve-out. Also note: the config-drift gate (R-5) does **not** cover rate-limit values, so after this reconciliation there is no automated guard keeping §1.10 and `rateLimit.ts` in sync — the header/limit regression-test in Acceptance is the only guard; keep it.

## Target posture

| Caller class | Identity | Limit | Notes |
|---|---|---|---|
| Anonymous (public verification reads) | IP | generous (see verifier carve-out) | must survive KPI-2/3 load un-throttled |
| Anonymous (general/unauthed API) | IP | 60–100 / min | pick one, reconcile §1.10 |
| API key (read scopes) | key + scope | 500–1,000 / min | v2 per-scope |
| API key (write anchors) | key | 100 / min | v2 per-scope |
| Batch endpoints | IP/key | 10 / min | |
| Auth | IP | 5 / min (skip failed) | brute-force guard |
| Webhooks (inbound) | global/provider | 100 / min | Stripe/DocuSign/Adobe |

### CRITICAL — the limiter is PER-INSTANCE unless Upstash is configured (Performance review)

The default store is a **per-instance in-memory `Map`** (`rateLimit.ts`). `initUpstashRateLimiting()` swaps to a shared Redis store **only if** `UPSTASH_REDIS_REST_URL`/`_TOKEN` are set; otherwise it logs "using in-memory rate limiting" and every limit is enforced per Cloud Run instance. Under autoscaling with a load balancer that spreads one client's requests across instances:

> **effective per-IP limit = N_instances × maxRequests**, applied independently per instance — so a client can be throttled on instance A while B/C are wide open. The enforced ceiling is both **higher than stated** and **non-deterministic** (floats with autoscale count + LB stickiness).

Consequences the spec must carry:
- **This partly explains the §1.10 discrepancy for the wrong reason:** with in-memory + N instances, the real ceiling is N×60, not 60 or 100. Any nominal number in §1.10 or below is only enforced if a **shared (Redis) store** is configured.
- **Verify prod Upstash config in-session** before trusting any limit value: if `UPSTASH_REDIS_REST_URL/_TOKEN` are unset in prod, the limits are nominal, not enforced.
- Add a row to the §1.10 reconciliation: *"stated limits assume a shared store; in-memory deployment multiplies every limit by the instance count."*

### Verifier-path carve-out (the row-14 requirement)

Public verification endpoints (`/api/v1/verify*`, public-anchor reads, the verification API surface used by KPI-2 "verify" and KPI-3 patterns) MUST NOT be throttled at expected KPI load. Spec:
- Load-test the verifier paths at KPI-2/3 request patterns (sustained + burst) and confirm **zero 429s** at target QPS.
- If the general `api` 60/min/IP limiter covers a verifier path, the verifier path needs a **higher dedicated limit** (or exemption) sized to KPI-3 peak — a shared verifier IP (e.g. a partner gateway) must not hit the anon limit.
- **The load test MUST run with the same store backend and instance topology as prod.** Testing verifier paths against a single staging instance (in-memory) measures a *different* limiter than an autoscaled multi-instance prod fleet — "0 throttled" on one instance is not merge-grade evidence for N-instance prod behavior (and vice-versa). State prod's Upstash config and test *that* config. Whatever dedicated verifier limit is chosen, size it against **per-instance** semantics (it is silently multiplied by the instance count under in-memory).
- 429 responses (when they do fire elsewhere) MUST carry `Retry-After` + `X-RateLimit-Limit`/`-Remaining` (already implemented in `rateLimit.ts` — keep).

## Acceptance (implementation PR)

- Every rate-limited response carries `Retry-After` (on 429) + `X-RateLimit-*` headers (regression-test).
- Verifier paths load-tested at KPI-2/3 patterns: **0 throttled** at target QPS (evidence in PR).
- §1.10 and the code agree (one is corrected to match the other; recommend correcting §1.10 to the per-scope reality).
- No limiter regressions on auth (5/min) / webhooks (100/min) / batch (10/min).

## Tier / rollout

Public-API-contract-adjacent (limits affect the published API behavior) → **T2** when implemented, with the verifier load-test as required evidence. Implementation post-train.

## §1.5

Limiter values above are read from committed source on 2026-07-20. The §1.10 discrepancy is stated as measured, not asserted-resolved — reconciliation is an implementation decision (Carson/CTO), not done here.
