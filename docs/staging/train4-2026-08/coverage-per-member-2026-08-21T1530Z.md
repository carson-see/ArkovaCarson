# TRAIN-4 — per-member coverage record (interim, window still open)

**Rig:** `arkova-worker-wave3-2026-08-staging`, revision `00005-rib`, tag `train-4`
**Supabase project:** `jiotjhqmedkajdsojsbn` (`arkova-wave3-2026-08`, isolated)
**Union head:** `0333464d7b22e140c07b049718b1214ea98633e1`
**Clock (FD-CLOCK-1):** revision `creationTimestamp` = 2026-08-21T13:57:35.121840Z -> closes 2026-08-22T01:57:35Z (T2, 12 h)
**Captured:** 2026-08-21T15:30Z. Window is **open**; this is the running record, not the close-out.

## Why this document exists

A soak covers only what the driver probes. wave3 soaked 9 members and probed 2. The
standing rule is that anything unprobed at close is written up as NOT covered **per
member** — never as a blanket claim over the window. This is that per-member accounting.

## Coverage table

| Member | Surface | Anonymous reachability | Authenticated behaviour | Verdict |
|---|---|---|---|---|
| **#2220** FD-P7 key revoke/delete | `/api/v1/keys` | `401` on list/PATCH/DELETE | **CREATE 201 -> revoke 200 -> DELETE 204**, full lifecycle | **COVERED** |
| **#2211** ORG_ADMIN verification gate | `/api/v1/org/*` | corrected — see FD-PROBE-1 | `verification-status` **200**; `verify-ein` over-length **400** (gate admitted admin) | **COVERED (positive case only)** |
| **#2230** Drive connect deny-reason | `/api/v1/integrations/google_drive/oauth/start` | `401` | **403 `org_scope_required`** — the exact deny-reason distinction | **COVERED** |
| **#2236** Nessie fail-closed | `/api/v1/nessie/query` | **`503`** fail-closed, sustained all window | not applicable — must never serve | **COVERED** |
| **#2232** proof-keys + MCP audit log | `/.well-known/arkova-keys.json` | **`200`** sustained | n/a (public) | **PARTIAL — see below** |
| **#2233** ingestion response contract | `/jobs/fetch-*` | n/a (cron-gated) | **503 `flag_not_configured`** on sam/uspto/openstates | **COVERED (unconfigured branch only)** |

## What is NOT covered, stated per member

**#2232 — the MCP audit-log write path cannot be soaked on this rig at all.**
This is architectural, not an omission. The audit-log fix lives in `services/edge/`
(`mcp-audit-log.ts`, `audit-event-category.ts`) — the **Cloudflare Worker** `arkova-edge`,
deployed by `wrangler` per `services/edge/wrangler.toml`. The TRAIN-4 rig is a **Cloud Run**
service running `services/worker`. No Cloud Run soak can exercise a Cloudflare-edge surface.
What this rig *does* cover is #2232's worker-side half — the previously-unmounted proof-keys
route, confirmed serving `200`. The `MCP_TOOL_CALL` audit row write (the P0 that recorded
zero rows in prod from 2026-05-26 to 2026-08-15) needs an edge-side verification, and this
window must not be cited as evidence for it.

**#2233 — only the `flag_not_configured` branch is reachable here.**
The contract is `total_failure` -> 502, `partial_failure` -> 207, unconfigured -> 503,
success/disabled -> 200. This rig has no ingestion source API keys and no
`ENABLE_PUBLIC_RECORDS_INGESTION` row, so the truthful answer for every `/jobs/fetch-*`
route is `503 flag_not_configured` — which *is* the changed behaviour (the bug reported
these conditions as HTTP **200**). **502 and 207 were NOT exercised** and would require
seeding the flag plus at least one configured source. A `200` on these routes is now the
regression signal, and the probe treats it as a deviation.

**#2211 — the negative case was NOT exercised.**
`verify-ein` returning `400` on an over-length value proves the ORG_ADMIN gate **admitted**
an admin caller and that #2211's new 32-char `MAX_EIN_LENGTH` bound is live. It does **not**
prove a non-admin org member is rejected with `403`: the rig has exactly one seeded fixture
user, `seed-fixture-user@seed-fixture.invalid`, and that user is `ORG_ADMIN`. Proving the
denial half needs a second, non-admin fixture user.

**#2220 — the revoked-key rejection path was NOT re-exercised.**
The lifecycle (create -> revoke -> delete) is proven. What is not proven in this window is
that a *revoked key is subsequently refused* on a request — that is the FD-P7 behaviour the
earlier wave3 key was minted for, and its key is already revoked.

## How the authenticated probes were obtained

Two obstacles, both worth recording because they will recur:

1. **The rig requires IAM** (`roles/run.invoker`, no `allUsers`), and the worker reads the
   user JWT from the same `Authorization` header Cloud Run consumes. Resolution: send the
   IAM token in **`X-Serverless-Authorization`**, which Cloud Run accepts for invocation
   and which leaves `Authorization` free to carry the Supabase user JWT. No rig config or
   revision change — the soak clock is untouched.
2. **A real user token** was minted against the wave3 project with
   `POST /auth/v1/admin/generate_link` + `/auth/v1/verify` for the seeded ORG_ADMIN fixture
   user, using `supabase-service-role-key-wave3`. The resulting token is **ES256**.

## Incidental finding — the rig's `SUPABASE_JWT_SECRET` does not match its project

`supabase-jwt-secret` (the generic secret the rig is wired to) does **not** verify the
wave3 service-role key, whose `ref` is `jiotjhqmedkajdsojsbn`. This is secret drift from the
shared staging template.

**It is not blocking, and it did not invalidate anything.** `services/worker/src/auth.ts`
verifies in three tiers: HS256 with `SUPABASE_JWT_SECRET`, then ES256/RS256 via the
project's JWKS (which uses `SUPABASE_URL`, correctly wave3), then an `auth.getUser()`
network fallback. The fixture token is ES256, so it verifies on the JWKS path and the
mismatched HS256 secret is never consulted for it. The cost is a per-request warning and a
degraded path for any HS256 token, not a failure. Worth correcting on the next rig build;
not worth disturbing a running soak for.

## Cross-references

- [FD-PROBE-1](../findings/FD-PROBE-1-anonymous-401-cannot-prove-a-route-exists.md) — the
  `/api/v1/org` probe was green all window against a route that does not exist.
- [FD-LOAD-1](../findings/FD-LOAD-1-mixed-mode-exceeds-anonymous-rate-limit.md) — why member
  probes are throttled to 5 min rather than fired every pass.
