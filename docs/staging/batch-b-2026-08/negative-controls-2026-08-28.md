# Batch B — pre-fix negative controls captured on the rig

Captured 2026-08-28 against `https://pr-2434---arkova-worker-staging-kvojbeutfa-uc.a.run.app`
(Cloud Run revision `arkova-worker-staging-00354-wod`, image built from PR #2434 head
`1095e647e0d8df02ea38c3b41018b504680ad615`). PR #2434 touches only `services/edge/`, so this
revision's **worker** tree is byte-identical to base `main` `0f0eda6528728c051a7e62b785168ea3605d5021`.
That makes it a live, in-rig control for the two worker PRs whose fixes are in this batch.

These are the UNFIXED behaviours. The fixed revisions must not reproduce them.

## SCRUM-3569 (PR #2437) — GET /api/queue/pending is not gated

    JWT for batchb-member-b1@seed-fixture.invalid (profiles.role = ORG_MEMBER, org b1)
    GET /api/queue/pending
    -> HTTP 200
    {"items":[{"public_id":"ARK-DOC-BBQ001",
               "external_file_id":"batchb-file-1",
               "filename":"batchb-org1-pending-alpha.pdf",
               "fingerprint":"aaaa…(64)", …}], …}

A non-admin org member reads the whole review queue, including every other member's
`filename` and `fingerprint`. On the fixed revision the same token must return
`403 {"error":{"code":"forbidden", …}}` with no filename and no `ARK-DOC-BBQ` in the body.

## SCRUM-3418 / SCRUM-2603 (PR #2441) — anonymous public verify is capped far below §1.10

    anonymous GET /api/v1/verify/ARK-BBSEC-000001, sequential, 80ms apart
    -> X-RateLimit-Limit: 100   (the header advertises the contract)
    -> first HTTP 429 at request #20; 19 admitted

The header claims the §1.10 anonymous tier of 100 req/min while the request is actually bound
by the shared bare-IP bucket — `apiIpShadowGuard` counts it twice (two mounts) alongside every
other unscoped limiter, so the effective budget is a fraction of the published contract, and it
is *not even a stable fraction*: it depends on what else that IP touched in the same window.
(The map records ~31 for a cold bucket; this run measured 20 because earlier probes in the same
minute had already spent part of the shared counter — which is precisely the defect.)

On the fixed revision the same burst must admit **≥ 100** before the first 429, and exhausting it
must leave the 60/min `/api/*` backstop, the 10/min adminRouter bucket and the 1,000/min keyed
tier untouched.

## SCRUM-3514 (PR #2439) — JWT-claims scopes are not enforced

Same base-main revision, driven with the #2439 driver
(`evidence/pr-2439/pre-window/negative-control-on-base-main.json`):

    ORG_ADMIN JWT with "scopes":["usage:read"]  + x-org-id: <own org>
    GET /api/v1/emergency-access/
    -> HTTP 200 {"grants":[]}

    same, "scopes":["compliance:write"]                        -> HTTP 200
    same, "scopes":[]                                          -> HTTP 200
    sufficient JWT + X-API-Key whose scopes are ["verify"]     -> HTTP 200

The scope claim is ignored entirely, and a presented API key without the required scope does not
constrain the request either. On the fixed revision all four must be
`403 {"error":"insufficient_scope","required":"compliance:read","granted":[…]}` with `granted`
being the *intersection*, not the union.

Note the two boundaries that already held on base main and must keep holding after the change:
cross-org (`403 Not authorized for this organization`) and role (`403 Organization administrator
role required` for an ORG_MEMBER on `/api/v1/hipaa/audit`). The driver asserts both every cycle,
so a scope guard that accidentally short-circuits them would be caught.

### Full #2441 driver run against base main (the shared bucket, demonstrated)

`evidence/pr-2441/pre-window/negative-control-on-base-main.json`, same base-main revision:

| probe | base main | required after the fix |
|---|---|---|
| anonymous verify burst | **admitted 20**, first 429 at #21, `X-RateLimit-Limit: 100` | admit >= 100 before the first 429 |
| `GET /api/badge/...` immediately after | **429** | not 429 (own `api-ip-shadow-guard` bucket, limit 60) |
| `GET /api/queue/pending` (ORG_ADMIN) immediately after | **429** | 200 (own `checkout` bucket, limit 10) |
| `GET /API/v1/verify/...` (upper case) | `X-RateLimit-Limit: **60**` | `100` — the case-insensitive carve-out |
| keyed verify immediately after | not 429, limit 1000 | unchanged |

Three unrelated surfaces 429 because an anonymous verify burst exhausted a counter they all
share. That is the SCRUM-3418 defect stated as a measurement rather than as prose, and it is the
per-cycle assertion set the fixed revision has to satisfy for twelve hours.
