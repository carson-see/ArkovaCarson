# Edge catch-up — production deploy record, 2026-09-08

The deploy this window's evidence authorised. `edge.arkova.ai` had been serving a
2026-06-07 build for three months; this is the catch-up.

## What was deployed

| | |
|---|---|
| Source | `61f04403d7802bb5fb882f473dc21357b5e4cacd` — the exact soaked SHA, an ancestor of `origin/main` |
| Bundle sha256 | `b5a8942e0650b9ee3e40bc1e3e4a4b6175f8e4854a36b7140bad239998daf365`, 1,471,744 bytes |
| Config | the committed prod `services/edge/wrangler.toml` (`name = "arkova-edge"`, route `edge.arkova.ai/*`, prod KV ids) |
| Deployment id | `7af4cd88-8d8d-4970-8b15-04b54aacc5eb`, version `078e6ee8-a052-48c6-8b9b-ce18f1e40a98`, 100% |
| Deployed at | `2026-09-08T01:03:13.431389Z` (upload 01:03:05Z → 01:03:17Z) |
| Replaced | deployment `16750862-68d7-4c8b-8e41-8e5372bf5150`, version `bc380943-1443-4b8b-a2a5-24046f92da18`, built `2026-06-07T14:26:41Z` from `68671aec370b4841f06a61ed9bfa6935418e3b24` |

**Not** `origin/main`'s head. Four dependency-only commits landed on `services/edge`
after the window opened (`zod` 4.4.3→4.5.4, `vitest` 4.1.11→5.0.0, `wrangler`, and
`@cloudflare/workers-types`); `zod` and the bundler change the bundle, so shipping the
head would have shipped an unsoaked artifact. The diff `61f04403d..origin/main` over
`services/edge` is `package.json` + `package-lock.json` only — **no source change** —
so that drift is a dependency refresh owed a later, much smaller window.

## Bundle reproduction

`npm ci` from the lockfile at `61f04403d` in a fresh worktree, then
`wrangler deploy --config wrangler.toml --dry-run --outdir …` → sha256
`b5a8942e…`, **byte-identical** to the soaked artifact. The retro window built with
`wrangler.retro.toml`; the prod config differs only in name, `workers_dev`, routes and
KV ids, none of which reach the JS, and the match proves it.

After deploying, the live script was read back off the Cloudflare API and re-hashed:
`b5a8942e…`. What is running is what was soaked.

## Binding parity — no binding had to be created

Every binding the code reads was checked against the live worker. `wrangler deploy`
inherited all five secrets untouched; the four plain vars in `wrangler.toml` already
matched prod exactly, so all 11 bindings are byte-identical before and after.

| Binding | Prod | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MCP_SIGNING_KEY`, `ALLOWED_ORIGINS` | secret, inherited | unchanged across the deploy |
| `MCP_RATE_LIMIT_KV` / `MCP_ORIGIN_ALLOWLIST_KV` | `a8a78436…` / `5ace0a24…` | prod ids, unchanged |
| `ARKOVA_AI` | bound | |
| `ENABLE_AI_FALLBACK`, `CF_AI_MODEL`, `ENABLE_X402_FACILITATOR`, `EDGE_REQUIRE_MCP_SIGNING` | `false`, `@cf/nvidia/nemotron`, `false`, `true` | from `[vars]`, identical to what prod already had |
| `SUPABASE_JWT_SECRET` | **unset** | bearer auth stays fail-closed (401). Same as before the deploy |
| `MCP_IP_HASH_PEPPER` | **unset** | `audit_events.details.ip_hash` records `null` — fail closed by design, never the enumerable bare digest |
| `CRON_SECRET` | **unset** | internal `/jobs` routes fail closed |
| `BASE_RPC_URL`, `USDC_CONTRACT_ADDRESS`, `X402_NETWORK` | unset | reached only from `x402-facilitator.ts`, gated off by `ENABLE_X402_FACILITATOR=false` |
| `R2_REPORT_DOWNLOAD_SECRET`, `ARKOVA_REPORTS` | unset | R2 is commented out of `wrangler.toml`; the report path is not mounted |
| `MCP_ALLOWLIST_HMAC_SECRET` | unset | allowlist accepts the legacy raw-JSON entry shape, as before |
| `WORKER_BASE_URL`, `ENABLE_NESSIE_QUERY` | unset | deliberate — Nessie is off by founder directive and fails closed |
| `SENTRY_DSN`, `MCP_ENABLE_ANCHOR_DOCUMENT` | unset | optional; `anchor_document` therefore does not register |

No module-level env assertion exists in the tree, so nothing prod lacks can fail the
worker at startup. The only `throw` on a missing secret is inside
`r2-signed-url.ts`, on a path R2 does not mount.

## Deploy anomaly (benign)

`wrangler deploy` uploaded and deployed the script, then failed on the *route* step:
`PUT /zones/…/workers/routes` → `Authentication error [code: 10000]`. The Secret
Manager `cloudflare-api-token` has Workers-Scripts edit but not Zone→Workers-Routes
edit. The `edge.arkova.ai/*` route already existed from the June deploy and points at
the script by name, so nothing needed changing — confirmed by `edge.arkova.ai`
answering on the new bundle within seconds. The non-zero exit is a permissions gap in
the token, not a partial deploy.

## Smoke — 2026-09-08T01:04Z–01:09Z, against `https://edge.arkova.ai`

| # | Check | Result |
|---|---|---|
| 1 | `GET /health` | `200 {"status":"ok","service":"arkova-edge"}` |
| 2 | `tools/list` | **15 tools**, exactly the expected set. `verify_anchor` / `search_anchors` / `anchor_status` **absent**, as the window asserted |
| 3 | `get_anchor ARK-SEC-RUJ2V7` | `verified: true`, `status: ACTIVE`, **`bitcoin_block: 944369`** — #1106 live and carrying a real value |
| 4 | `verify_batch` × 3 | 3 results, **input order preserved**, the unknown member returned as `verified:false/UNKNOWN` rather than dropped — #2434 live |
| 5 | verify by fingerprint | **FAILS — `isError: "Document verification timed out"`.** See below |
| 6 | `get_fingerprint` | **FAILS — same timeout** |
| 7 | no key / bad key / bad bearer | `401` / `401` / `401` |
| 8 | envelope parity vs `api.arkova.ai/api/v1/verify/ARK-SEC-RUJ2V7` | 8 of 9 fields identical; the 9th is a worker bug, not an edge one — see below |
| 9 | `MCP_TOOL_CALL` audit rows in prod | **6 rows, `event_category = 'SECURITY'`, the first in the table's history** |

### The audit-log P0 is fixed

`select count(*), min(created_at) from audit_events where event_type='MCP_TOOL_CALL'`
on prod `vzwyaatejekddvltxyye` returns **6 rows, earliest `2026-09-08T01:04:49.199215Z`** —
i.e. every `MCP_TOOL_CALL` row that has ever existed in production was written by this
smoke, after this deploy. For ~2.5 months the edge sent lowercase `'security'` into the
`audit_events_event_category_valid` CHECK and every insert was rejected. `details` carries
`api_key_id`, `args_hash`, `latency_ms`, `outcome`, `ip_hash` (`null`, pepper unset).

### Finding 1 — verify-by-fingerprint times out at production scale (new, blocking that feature)

`get_public_anchor_by_fingerprint` compares a `bpchar` column to a `text` parameter:

```sql
WHERE a.fingerprint = lower(p_fingerprint)   -- fingerprint is character(64), p_fingerprint is text
```

Postgres casts the **column** to text, so `idx_anchors_fingerprint_lookup`
(btree on the bare `bpchar`) cannot be used. The planner falls back to
`idx_anchors_status_secured_submitted` and filters — `EXPLAIN` cost **2,302,395** over
the SECURED partition, which exceeds `statement_timeout`. Adding one cast makes the
same query an index hit:

```sql
WHERE a.fingerprint = lower(p_fingerprint)::bpchar
```

`EXPLAIN (ANALYZE)` → `Index Scan using idx_anchors_fingerprint_lookup`, **3.0 ms**.

The soak could not have caught this: the rig fixture is 10 rows, where a sequential
scan is instant. Prod is ~3.5 M. This is the failure mode recorded in
`project_hollow_200_statement_timeout_swallow.md`, except it fails **closed** — the
caller gets `isError`, never a hollow success.

**This is not a regression.** `get_public_anchor_by_fingerprint` does not appear in the
June bundle at all (0 grep hits); the catch-up adds the path, and it is slow. The fix
is a one-line migration to the DEFINER function, not a rollback.

### Finding 2 — the *worker* API reports `created_at` as `anchor_timestamp`

Edge and worker disagree on one field for `ARK-SEC-RUJ2V7`: edge says
`2026-04-09T18:11:26Z`, worker says `2026-04-09T18:01:01.848397Z`. In prod that row has
`created_at = 18:01:01.848397` and `chain_timestamp = 18:11:26`, and
`get_public_anchor()` returns `anchor_timestamp = chain_timestamp`.

So the **edge is now right and the worker is wrong**: `api.arkova.ai/api/v1/verify/:id`
publishes row-creation time under a field named `anchor_timestamp`, understating the
anchoring moment by up to ten minutes on a frozen public contract (§1.8), against §1.5's
"Network Observed Time". The catch-up fixed the edge — the old bundle mapped
`anchor_timestamp: r.created_at`, the new one maps `r.anchor_timestamp` — and by fixing
it, exposed the worker. Owed: a bug-tracker row and a worker fix.

### Not asserted

* `bitcoin_block` on `ARK-DOC-6Y9RK6` is `null` because that row's `chain_block_height`
  is `null` in prod, not because the field is broken. Verified in the DB.
* Bearer **positive** auth is unproven — `SUPABASE_JWT_SECRET` is unset on prod, so the
  path is fail-closed. Only the negative is proven.
* The origin-allowlist gate was not exercised; prod KV contents are unexamined.
* `oracle_batch_verify` signature verification was proven on the rig, not re-proven here
  (it needs `MCP_SIGNING_KEY`, which is prod-only and was not read).
* Rate limiting was not exercised.

## Rollback

Armed, not used. Target `bc380943-1443-4b8b-a2a5-24046f92da18`; bundle and bindings
captured under `/Volumes/Extreme/offload/arkova-edge-prod-rollback-20260908/`
(`ROLLBACK.md`, `SHA256SUMS`).

```bash
npx wrangler rollback bc380943-1443-4b8b-a2a5-24046f92da18 --name arkova-edge
```

**Not rolled back, deliberately.** The single smoke failure is an additive path that did
not exist in the rollback target, fails closed, and has its root cause in the database
rather than the bundle. Rolling back would delete a newly-working security audit trail
and two verified fixes to remove a feature that is merely unavailable.

## Teardown

Throwaway worker `arkova-edge-retro-0907` deleted (API confirms `10007 does not exist`;
its workers.dev URL 404s). Both throwaway KV namespaces deleted; the prod ids
`a8a78436…` / `5ace0a24…` remain. Retro worktree removed, credential files shredded.

**Left undone on purpose:** `TEARDOWN.sh` step 4 deletes the window's one `api_keys` row
(`8b353184-da64-4065-afcf-8367ec4bc6d5`, name `edge-retro-0907`) from the **standing
shared rig** `fizyjojbebyalirtjjht`. That is a write to a rig other sessions may be
soaking against, so it was not executed. Whoever holds the rig should run:

```sql
delete from public.api_keys where id = '8b353184-da64-4065-afcf-8367ec4bc6d5';
```
