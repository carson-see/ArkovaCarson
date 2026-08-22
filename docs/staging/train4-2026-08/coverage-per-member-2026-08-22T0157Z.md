# TRAIN-4 — per-member coverage record, FINAL (window closed 2026-08-22T01:57:35Z)

**Rig:** `arkova-worker-wave3-2026-08-staging`, revision `00005-rib`, tag `train-4`
**Supabase project:** `jiotjhqmedkajdsojsbn` (`arkova-wave3-2026-08`, isolated)
**Union head:** `0333464d7b22e140c07b049718b1214ea98633e1`
**Clock (FD-CLOCK-1):** revision `creationTimestamp` = 2026-08-21T13:57:35.121840Z → closed 2026-08-22T01:57:35Z (T2, 12.00 h)
**Supersedes:** `coverage-per-member-2026-08-21T1530Z.md` (interim, written while the window was open)

This is the close-out. Everything below was **re-verified against Cloud Run request logs
after the window closed**, not carried over on the strength of the interim note. Where the
interim record made a claim, the server-side timestamp that proves it is now quoted.

## Why per-member accounting exists

A soak covers only what the driver probes. wave3 soaked nine members and probed two. The
standing rule is that anything unprobed at close is written up as NOT covered **per member**,
never as a blanket window claim. Two members here are genuinely partial and one of those is
partial for a reason no Cloud Run soak can ever fix.

## Coverage summary

| Member | Surface | What was actually probed | Verdict |
|---|---|---|---|
| **#2220** FD-P7 key revoke/delete | `/api/v1/keys` | full create→auth→revoke→refuse→delete loop, plus 330 anonymous reachability probes | **COVERED** |
| **#2211** ORG_ADMIN verification gate | `/api/v1/org/*` | both identities against all four routes, incl. the selectivity control | **COVERED** |
| **#2230** Drive connect deny-reason | `/api/v1/integrations/google_drive/oauth/start` | authenticated `403 org_scope_required` | **COVERED** |
| **#2236** Nessie fail-closed | `/api/v1/nessie/query` | `503` × 115, sustained the whole window | **COVERED** |
| **#2233** ingestion response contract | `/jobs/fetch-*` | `503 flag_not_configured` × 315 | **PARTIAL** — one branch of four |
| **#2232** MCP audit log + proof-keys | `/.well-known/arkova-keys.json` | `200` × 2,646 | **PARTIAL — and architecturally so** |

**Probe fires in-window:** 1,190 recorded member-probe results across 23 driver cycles,
**zero deviations** from declared expectation. Per key: `2220-keys-list` 110,
`2220-keys-revoke` 110, `2220-keys-delete` 110, `2230-drive-oauth` 110,
`2236-nessie-failclosed` 110, `2232-proof-keys` 110, `2211-verification-status` 105,
`2211-verify-ein` 105, `2233-ingest-{sam,uspto,openstates}` 105 each, and
`2211-org-verification` 5 (the original probe, retired at 15:34Z once FD-PROBE-1 showed the
route did not exist).

---

## #2220 — FD-P7 API-key revocation/deletion — COVERED

The full loop was driven end to end against the soaking revision and is visible **in the
Cloud Run request log**, five requests inside 2.6 seconds:

| Step | Server-side timestamp | Request | Result |
|---|---|---|---|
| A | `15:40:30.475Z` | `POST /api/v1/keys` | **201** — fresh key minted |
| B | `15:40:31.274Z` | `GET /api/v1/verify/STG-ANC-DEADBEEF` with the **active** key | **404** — the key **authenticated**; 404 is "anchor not found", **not** an auth rejection |
| C | `15:40:31.997Z` | `PATCH /api/v1/keys/9fb2747d-…` `{is_active:false, revocation_reason:…}` | **200**, `revoked_at` and reason persisted |
| D | `15:40:32.780Z` | same verify request with the **revoked** key | **401 `{"error":"api_key_revoked","message":"This API key has been revoked."}`** |
| E | `15:40:33.122Z` | `DELETE /api/v1/keys/9fb2747d-…` | **204** |

**Step B is what makes step D meaningful.** Without a request proving the key worked while
active, the 401 in step D could equally mean the key never worked at all. That is the whole
FD-P7 claim: revocation/deletion is *reachable and effective*, not merely absent.

Two earlier passes are also in the log and are recorded rather than hidden: at
`15:28:53.744Z` a `PATCH` returned **400** (malformed revocation payload, corrected on the
next attempt) and at `15:29:10.599Z` a `PATCH` returned **200** followed by `GET /api/v1/keys`
**200** and `DELETE` **204**. Three keys were minted and all three deleted; none survives.

**Not covered:** nothing material. The raw key existed only in a shell variable for the
duration of each probe and was never written to disk, logged, or echoed (§1.4).

**Anonymous reachability**, independently, all window: `GET /api/v1/keys` 401 × 116,
`PATCH`/`DELETE /api/v1/keys/{id}` 401 × 230 — mounted and gated, never 404.

---

## #2211 — ORG_ADMIN gate on the self-serve verification writers — COVERED

Both directions plus the control, all four in the request log:

| Caller | Server-side timestamp | Route | Result |
|---|---|---|---|
| ORG_ADMIN | `15:28:33.727Z` | `GET /org/verification-status` | **200** |
| ORG_ADMIN | `15:28:34.187Z` | `POST /org/verify-ein` (33-char EIN) | **400** "Valid EIN/Tax ID is required (5–32 characters)" — **admitted past the gate**, then rejected by validation. This is a two-for-one: it proves the admin is not blocked, *and* it proves #2211's new `MAX_EIN_LENGTH` bound is live on the running code. |
| ORG_MEMBER | `15:42:04.891Z` | `POST /org/verify-ein` | **403** "Organization admin access required" |
| ORG_MEMBER | `15:42:05.357Z` | `POST /org/verify-domain` | **403** |
| ORG_MEMBER | `15:42:05.743Z` | `POST /org/confirm-domain` | **403** |
| ORG_MEMBER | `15:42:06.199Z` | `GET /org/verification-status` | **200** |

**The last row is the one that makes the other three mean anything.** The member is not being
rejected wholesale — the member-level read still succeeds. The gate is *selective*, on
exactly the three writers #2211 gates, which is precisely the contract. A blanket-deny bug
would produce the same three 403s and be indistinguishable without this control.

Both identities are in the **same org** (`org_id 5eed0000-…-b1`), so this is a role
distinction and not an org-scope distinction — the fixture
`member-fixture@seed-fixture.invalid` (ORG_MEMBER) was already on the rig; no seeding was
needed and the soak clock was never disturbed.

**Not covered:** the ORG_ADMIN grant precedence chain is exercised only through the
`org_members` path that these fixtures carry. The profile-`ORG_ADMIN`-fallback and
platform-admin grants are covered by unit tests at the frozen head, not by this window.

---

## #2230 — Drive connect deny-reason — COVERED

`15:27:38.039Z` — `POST /api/v1/integrations/google_drive/oauth/start` with an authenticated
caller returned **403 `org_scope_required`**. That exact deny-reason — as distinct from
`not_admin` — is the whole of #2230's change, and it is the value the running code produced.

Anonymous reachability all window: 401 × 115, plus 3 × 429 during the FD-LOAD-1 burst.

---

## #2236 — Nessie fails closed — COVERED

`POST /api/v1/nessie/query` returned **503** on all **115** probe fires spread across the
whole 12 hours, with zero deviations. For this member 503 is not an error, it *is* the fix:
the changed behaviour is that Nessie must never serve. A 200 here would be the regression,
and none occurred at any point in the window.

**Not applicable:** there is no positive path to exercise — the correct behaviour is refusal.

---

## #2233 — ingestion must not report total failure as HTTP 200 — PARTIAL

Covered: **`503 flag_not_configured`** on all three routes, 105 fires each (315 total),
zero deviations:

- `POST /jobs/fetch-sam-entities` → 503 × 105
- `POST /jobs/fetch-uspto` → 503 × 105
- `POST /jobs/fetch-state-bills` → 503 × 105

This **is** the changed behaviour on the branch that is reachable here: before #2233 these
same conditions returned HTTP **200**. A `200` on these routes is now the regression signal
and the probe treats it as a deviation.

### What is NOT covered, and why

The contract is four-way: `total_failure` → **502**, `partial_failure` → **207**,
unconfigured → **503**, success/disabled → **200**.

**`502 total_failure` and `207 partial_failure` were NOT reachable on this rig.** It carries
no ingestion source API keys and no `ENABLE_PUBLIC_RECORDS_INGESTION` row in
`switchboard_flags`, so every `/jobs/fetch-*` call short-circuits at the configuration check
before any fetch is attempted — the 503 branch is the only one the code can reach here.
Exercising 502 and 207 would require seeding the flag plus at least one configured source
(and, for 207, a source that partially fails). **Neither status was observed once in 21,023
requests, and #2233's evidence block says so.**

Three additional 404s at 15:17:34–15:17:41Z are route discovery — the un-prefixed
`/fetch-sam-entities`, `/fetch-uspto`, `/fetch-state-bills` before the `/jobs` prefix was
established. Recorded so they are not mistaken for a mounting failure.

---

## #2232 — MCP audit log + unmounted proof-keys route — PARTIAL, and architecturally so

**Covered:** the previously-unmounted proof-keys route. `GET /.well-known/arkova-keys.json`
served **200 on 2,646 requests** across the window (p50 6.4 ms, p95 13.6 ms) with 110
declared-expectation probe fires and zero deviations. The route is mounted and stable under
12 hours of continuous load. That is #2232's worker-side half, and it is genuinely proven.

### The MCP audit-log fix cannot be soaked on this rig at all — ever

This is not an omission, a scheduling miss, or something a longer window would have caught.

#2232's audit-log fix lives in **`services/edge/`** — `mcp-audit-log.ts`,
`audit-event-category.ts`, `mcp-tools.ts`. That is the **Cloudflare Worker `arkova-edge`**,
deployed by `wrangler` per `services/edge/wrangler.toml`, running at `edge.arkova.ai`. The
TRAIN-4 rig is a **Cloud Run** service running `services/worker`. They are different
runtimes on different infrastructure with different deploy tooling. **No Cloud Run soak can
exercise a Cloudflare-edge surface, and no amount of soak time changes that.**

The `MCP_TOOL_CALL` audit row write — the P0 that recorded **zero rows in prod from
2026-05-26 to 2026-08-15** — therefore has **no soak evidence from this window and cannot
acquire any from this rig**. It needs an edge-side verification against a `wrangler`
deployment. **This window must not be cited as evidence for it**, and #2232's evidence block
states the split explicitly so the PR cannot read as fully covered.

Of #2232's twelve changed files, four are `services/edge/`, three are edge tests under
`src/tests/edge/` and `tests/infra/`, and only `services/worker/src/index.ts` (plus its test
and two `agents.md`) is the worker-side mount this rig exercises.

---

## Artifact-legibility trap — read `requests`, not `memberProbes`

In `~/arkova-soak-evidence/wave3/load-auto-*.json` the **`memberProbes` field is reset at
each member block**, so what it shows is only the probes fired since the last member block —
not the cycle total, and certainly not the window total. `requests` and `cronFires` are
cumulative and are the fields to trust.

There is also **no `deviations` key anywhere in the schema.** "Zero deviations" is not read
off a field; it is computed by comparing all 1,190 recorded probe values against their
declared expectations, which is what was done for this record. Anyone auditing these
artifacts by scanning for a `deviations: 0` line will find nothing and should not conclude
either way from its absence.

---

## Obstacles worth recording, because they will recur

1. **The rig requires IAM** (`roles/run.invoker`, no `allUsers`), and the worker reads the
   user JWT from the same `Authorization` header Cloud Run consumes. Resolution: send the
   IAM token in **`X-Serverless-Authorization`**, which Cloud Run accepts for invocation and
   which leaves `Authorization` free to carry the Supabase user JWT. No rig config change, no
   revision change, soak clock untouched.
2. **A real user token** was minted against the wave3 project with
   `POST /auth/v1/admin/generate_link` + `/auth/v1/verify` for the seeded fixture users, using
   `supabase-service-role-key-wave3`. The resulting tokens are **ES256**.
3. **The rig's `SUPABASE_JWT_SECRET` does not match its project.** `supabase-jwt-secret` (the
   generic secret the rig is wired to) does not verify the wave3 service-role key, whose
   `ref` is `jiotjhqmedkajdsojsbn`. This is secret drift from the shared staging template.
   **It is not blocking and it invalidated nothing:** `services/worker/src/auth.ts` verifies
   in three tiers — HS256 with `SUPABASE_JWT_SECRET`, then ES256/RS256 via the project's JWKS
   (which uses `SUPABASE_URL`, correctly wave3), then an `auth.getUser()` network fallback.
   The fixture tokens are ES256 and verify on the JWKS path, so the mismatched HS256 secret is
   never consulted for them. The cost is a per-request warning and a degraded path for any
   HS256 token. Worth correcting on the next rig build; not worth disturbing a running soak.

## Cross-references

- [`maturity-2026-08-22T0157Z.md`](./maturity-2026-08-22T0157Z.md) — clock integrity, load
  coverage, the full 5xx accounting, and the §1.12 requirements this window did not meet.
- [FD-PROBE-1](../findings/FD-PROBE-1-anonymous-401-cannot-prove-a-route-exists.md) — the
  `/api/v1/org` probe was green all window against a route that returns **404** to an
  authenticated caller (`15:27:37.738Z`). Retired at 15:34Z and replaced with
  `verification-status` + `verify-ein`.
- [FD-LOAD-1](../findings/FD-LOAD-1-mixed-mode-exceeds-anonymous-rate-limit.md) — why member
  probes fire on the 5-minute cron cadence rather than every pass.
