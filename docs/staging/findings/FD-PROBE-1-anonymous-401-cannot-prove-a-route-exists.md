# FD-PROBE-1 — an anonymous 401 under `/api/v1` cannot distinguish "mounted and gated" from "route does not exist"

**Found:** 2026-08-21, during the TRAIN-4 T2 window, while closing the authenticated-coverage gap.
**Class:** evidence integrity. This one is worse than a missing probe: it is a probe that reports **pass** for a surface that is not there.

## The finding

The TRAIN-4 member probes assert that a route answers `401`, on the reasoning that
`401` proves the route is **mounted and gated** rather than **missing** (`404`). That
reasoning is sound for a router that authenticates per-route. It is **false** for
`/api/v1`, because the auth middleware is mounted on the path prefix and runs *before*
routing:

```ts
// services/worker/src/index.ts:470
app.use('/api/v1/org', rateLimiters.api, requireAuthMw, orgVerificationRouter);
```

`requireAuthMw` rejects an unauthenticated request before Express ever tries to match a
sub-path. So **every** path under a gated prefix returns `401` anonymously — including
paths that do not exist.

## Demonstrated

`/api/v1/org` was probed as `2211-org-verification`, expecting `401`, and recorded a pass
on every cycle of the window.

| Request | Result |
|---|---|
| `GET /api/v1/org` — anonymous | `401` (recorded as "mounted + gated") |
| `GET /api/v1/org` — **authenticated ORG_ADMIN** | **`404` `{"error":"not_found"}`** |

The route does not exist. `orgVerificationRouter` defines
`verify-ein`, `verify-domain`, `confirm-domain`, `verification-status` and `dev-verify` —
there is no root `GET`. The probe was green for the entire window against nothing.

Control, proving the technique fails only for absent routes and not generally: `/api/v1/keys`
returns `401` anonymously and `200` authenticated — a real, mounted route.

## Fix

- Corrected the probe to the real routes: `/api/v1/org/verification-status` (member-level)
  and `/api/v1/org/verify-ein` (ORG_ADMIN-gated).
- **An anonymous probe cannot establish reachability under a prefix-gated router.** Prove
  reachability with an *authenticated* request, where `404` and `200`/`400`/`403` are
  distinguishable. See the TRAIN-4 coverage record for how to obtain a real user token
  against a Cloud Run rig that also requires IAM (`X-Serverless-Authorization` carries the
  IAM token so `Authorization` is free for the user JWT).
- When only an anonymous probe is possible, the honest claim is "the prefix is gated", **not**
  "this route exists".

## The rule this is a case of

A probe's expected status must be one that could actually **fail** if the thing under test
were broken or absent. `401` under a prefix-gated router is returned unconditionally, so
asserting it tests nothing about the route. Related: [[FD-WAVE3-1]] (a classifier that
counted rejections as successes), [[FD-LOAD-1]] (a driver measuring its own rate limiter).
