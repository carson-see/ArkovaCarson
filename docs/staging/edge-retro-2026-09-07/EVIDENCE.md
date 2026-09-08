# Edge catch-up — T2 retro-soak evidence

Window for the `services/edge` catch-up deploy (SCRUM-3797). Not a PR body yet: the
catch-up deploy is an operator action on Cloudflare, so this block is the artifact the
CTO signs off before `wrangler deploy --name arkova-edge` is run against `main`.

## Staging Soak Evidence

**Tier:** T2
- **Soaked source SHA:** `61f04403d7802bb5fb882f473dc21357b5e4cacd` (`origin/main` head at window open, 2026-09-07T09:55:58-04:00)
- **Base SHA:** `68671aec370b4841f06a61ed9bfa6935418e3b24` — the commit the LIVE prod `arkova-edge` deployment `16750862-68d7-4c8b-8e41-8e5372bf5150` was built from (2026-06-07). The soak diff is therefore exactly the catch-up release scope: 96 commits touching `services/edge`.
- **Staging project ref:** `fizyjojbebyalirtjjht` (standing shared rig) — **preflight: `soak_artifact`, NOT `clean_mirror`.** See *Residual risks* R1.
- **Cloud Run service / tag URL:** **N/A — Cloudflare worker.** The soaked artifact is a Cloudflare Worker, not a Cloud Run revision. Throwaway worker `arkova-edge-retro-0907` at <https://arkova-edge-retro-0907.carson-182.workers.dev> (`workers_dev = true`, **no `[[routes]]`**, its own KV namespaces `1fd8e46dca01412ea099c0b9be86b531` / `67fdac2426a5412c864fee4e10480fd3` — never the prod ids `a8a7843630e84c5aa22cf20ea8a8c5e8` / `5ace0a24154a4731b263285890ae3a10`).
- **Worker revision / image digest:** deployment `69d42679-9379-4559-b914-555538697a73`, version `fb093cd8-304a-4bb1-90b2-cab730f0b110`. **Image digest = bundle sha256 `b5a8942e0650b9ee3e40bc1e3e4a4b6175f8e4854a36b7140bad239998daf365`** — a Cloudflare Worker has **no container image**, so the digest field carries the sha256 of the `wrangler deploy --dry-run --outdir` bundle (`index.js`, 1,471,744 bytes, "Total Upload: 1437.25 KiB / gzip: 243.66 KiB"), which is the artifact actually uploaded. Same wording used on #2434.
- **Deploy log id:** `wrangler deploy --config wrangler.retro.toml` → "Uploaded arkova-edge-retro-0907 (5.75 sec) / Deployed arkova-edge-retro-0907 triggers (0.73 sec) / Current Version ID: b7084709-4733-4067-8026-816f9f18d2e3"; secrets applied in a second version, final deployment `69d42679-9379-4559-b914-555538697a73` created `2026-09-07T12:12:21.916156Z` (Cloudflare `.../workers/scripts/arkova-edge-retro-0907/deployments`).
- **Soak start → end:** `2026-09-07T12:54:21Z` → `2026-09-08T00:54:21Z` — **12 h 00 m, complete.** 49 cycles at a 15-minute cadence, **0 failures**, `status.json` sealed `window_complete_pending_review`. Clock = the deployed Cloudflare worker's uptime; the driver is a detached observer, not the clock. **Window restart:** a first window opened `2026-09-07T12:18:03Z` and was retired at `12:48:12Z` after 2 passing cycles. Cause was a driver defect, not a product regression — the audit-row assertion used a sliding 30-minute window at a 15-minute cadence, so cycle-1 rows aged out exactly as cycle-3 rows landed and `before == after == 10`. Cycles 1 and 2 had each written 5 `SECURITY` `MCP_TOOL_CALL` rows (9→14, 14→19). The driver was patched to count rows created after a DB-side cycle-start timestamp and assert ≥ 5 per cycle, and a **fresh 12 h clock** was started. Retired-window artifacts are kept in this directory (`restart-note.json`, `status-failed-1.json`, `cycles-retired-window/`, `driver-patch-20260907T1300Z.diff`) rather than discarded.
- **Behaviour exercised:** see *Per-cycle assertions*.
- **Health/smoke:** `GET /health` → `200 {"status":"ok","service":"arkova-edge"}`; `tools/list` → 15 tools (the 16 `TOOL_DEFINITIONS` minus `anchor_document`, which registers only under `MCP_ENABLE_ANCHOR_DOCUMENT=true`). Cycle 1 green at `2026-09-07T12:18:10Z`.
- **E2E / CI:** `services/edge` at the soaked SHA — `npm ci` clean, `npm test` **60/60 passed** (2 files, vitest 4.1.11), `npm run typecheck` (`tsc --noEmit`) clean, `wrangler deploy --dry-run` bundle sha256 equals the expected `b5a8942e…` value byte-for-byte.
- **Rollback plan:** `npx wrangler rollback --name arkova-edge` to deployment `16750862-68d7-4c8b-8e41-8e5372bf5150` (the current pre-June build). Cloudflare keeps prior versions, so the rollback is a control-plane operation with no rebuild.
- **Rollback rehearsal:** see *Residual risks* R2 — **not rehearsed on prod**, and cannot be without touching `arkova-edge`.
- **Risk rationale:** T2. `services/edge` is worker behaviour + public MCP/SDK contract surface (CLAUDE.md §1.12 T2 row). It is not T3: no migration, no RLS, no chain/treasury, no anchor lifecycle, no cron-on-anchors — the soak drives read-only verification paths and writes only the edge's own audit rows.
- **Approver:** CTO — decision to ship the catch-up on this evidence, accepting residual risks R1 and R2, relayed to release engineering `2026-09-08`. Recorded as the operator decision of record; this is **not** a GitHub review event and is **not** agent self-attestation (`carson-see` is the shared gh CLI identity and is not attribution).

## Per-cycle assertions (15-minute cycles)

Each cycle writes `cycles/NNNNN.json` and fails the window on the first miss.

1. **`/health`** → `200 {"status":"ok","service":"arkova-edge"}`.
2. **Anti-hollow — bundle identity re-asserted.** `/health` on `main` carries **no build or version field** (see R3), so each cycle re-reads the live Cloudflare deployment and asserts `deployment_id == 69d42679…` **and** `version_id == fb093cd8…`. A redeploy or rollback under the window fails the cycle rather than passing silently on a different bundle.
3. **`tools/list` contract.** Exact set equality against the 15 expected names, **plus** an absence guard on `verify_anchor` / `search_anchors` / `anchor_status` / `arkova_verify_anchor` / `arkova_search_anchors` — the renames are not on `main` (PR #2589 is OPEN), and this pins that fact so the evidence cannot later be read as covering them.
4. **`verify_batch` mixed batch (#2434).** `[ARK-BBSEC-000001 (SECURED), ARK-BBUNK-999999 (schema-valid, no row), ARK-BBPEN-000001 (PENDING)]` → 3 results, **input order preserved**, `verified` `true/false/false`, statuses `ACTIVE/UNKNOWN/PENDING`. Partial results survive; no member is dropped.
5. **`bitcoin_block` (#1106).** The key is asserted **present on every member of every envelope** — `880001` for the SECURED row, `null` for the unknown and the PENDING rows. Present-or-null, never `undefined`. This is the field admin-merged over a red gate; it is now covered on both the batch and single-record paths.
6. **`oracle_batch_verify` signed envelope.** Shape `{alg, key_id, payload, signature}`, `alg = HMAC-SHA256`; the signature is recomputed locally over the canonical payload and compared constant-time (**positive**), then the payload is mutated and the recomputed HMAC asserted **not** to match the returned signature (**negative / tamper**). Same partial-results and `bitcoin_block` assertions as (4)–(5).
7. **Schema-invalid member sanitised.** `[good, "not-an-id!!", pending]` → `isError` with `MCP error -32602: … public_id must match ARK-<TYPE>-<SUFFIX> at public_ids[1]`, and the message is scanned for `supabase.co`, `service_role`, `eyJ`, `at Object.`, `/private/tmp`, `stack` — none present. (Note: a *schema-invalid* id is rejected at the Zod boundary before the batch runs; the #2434 partial-results path is exercised by the *lookup-failure* member in (4), which is the correct shape for that fix.)
8. **Verify-by-fingerprint.** Both `verify` and `get_fingerprint` on fingerprint `1111…1111` resolve to `ARK-BBSEC-000001`, `verified: true`, `bitcoin_block: 880001` — exercising the `get_public_anchor_by_fingerprint` DEFINER RPC that is not live today.
9. **Worker envelope parity.** The edge `get_anchor` envelope for `ARK-BBSEC-000001` is compared field-by-field against the staging worker's `GET /api/v1/verify/ARK-BBSEC-000001` (same rig, IAM-authenticated) across `verified, status, anchor_timestamp, bitcoin_block, network_receipt_id, record_uri, issuer_name, issued_date, expiry_date`. Cycle 1: **9 fields compared, 0 divergences.**
10. **Auth positive and negative.** Positive: every tool call in the cycle authenticates with a real `X-API-Key` validated by the rig's `validate_api_key` HMAC RPC. Negatives, all asserted `401`: no key, bad key, HS256 bearer signed with the wrong secret, HS256 bearer signed with the *right* secret but expired. **ES256 is not part of this surface** — see R4.
11. **Audit rows written and re-counted.** `audit_events` is counted before and after the cycle's traffic; the cycle fails unless the count **increases** and unless every `MCP_TOOL_CALL` row in the window carries `event_category = 'SECURITY'` (uppercase). Cycle 1: `4 → 9`, delta 5, all `SECURITY`. This is the direct proof of the audit-log P0 fix — prod today writes lowercase `'security'` and is rejected by the CHECK constraint, so prod's count is 0.
12. **Input freeze.** Every soaked file (`git ls-files services/edge` at the SHA, `wrangler.retro.toml`, `driver.py`) is sha256'd at window open into `input-hashes.json` and re-hashed each cycle. Any edit under the window fails it.

Transport hardening per prior forensics: a status-0 / `URLError` transport drop is retried **once** and both attempts recorded; an unexpected HTTP status or a semantic miss is never retried. Driver temp is under `/Volumes/Extreme/offload/`, not `$TMPDIR`.

## Residual risks — CTO decisions required

**R1 — the rig is not `clean_mirror`.** `scripts/ci/staging-honesty-preflight.ts --project-ref fizyjojbebyalirtjjht --prod-project-ref vzwyaatejekddvltxyye` returns `environment_type = soak_artifact`. Seven of eight checks pass; the failing one is `prod_divergence`: `Unexplained extras (not in repo or prod): [0420]` — a PR-only ledger row left on the standing rig by PR #2442 (credit ledger). §1.11A says evidence is merge-grade only at `clean_mirror`. **Argument for accepting it here:** row 0420 is a credit-ledger migration; this window executes no migration, no DDL, no RLS change and no write to any table the row touches. The soaked paths are `get_public_anchor` / `get_public_anchor_by_fingerprint` reads over a fixed 10-row anchor fixture plus the edge's own audit inserts. The contaminating row cannot influence any assertion made here. Provisioning a fresh isolated Supabase project would remove the caveat but was outside this task's authorization (standing rig named explicitly; "do not create Supabase projects"). **Decision needed: accept the residual, or re-run on an isolated rig.**

**R2 — rollback is planned but not rehearsed.** `wrangler rollback` to `16750862…` cannot be rehearsed without deploying to, and then rolling back, the live `arkova-edge` — which this task is explicitly forbidden from touching. The throwaway worker only has the versions this window created, so a rehearsal on it would prove the CLI works, not that the prod rollback target is intact. What *is* verified: deployment `16750862-68d7-4c8b-8e41-8e5372bf5150` is still Cloudflare's current deployment for `arkova-edge` and is therefore a live rollback target. **Decision needed: accept, or authorise a rehearsal window on prod.**

**R3 — no build identity in `/health`.** The edge `/health` returns only `{"status":"ok","service":"arkova-edge"}`. There is no `git_sha`, version, or bundle-hash field, so a running worker cannot be asked what it is — which is precisely how the June build went unnoticed for three months. Mitigated in-window by re-reading the Cloudflare deployment id each cycle, but that is an out-of-band control the product does not have. **Recommend a follow-up: add a build field to the edge `/health` (SCRUM-3907's version-parity check has nothing to read today).**

**R4 — the brief's assumed scope was wider than reality.** The catch-up does **not** include the MCP `*_anchor` renames or ES256 signed-request auth: both live in PR **#2589**, which is **OPEN** (`fix/mcp-tool-naming-collision`), not merged. Verified by grep — no `verify_anchor` / `search_anchors` symbol exists anywhere in the worktree at `61f04403d`. The soak asserts their absence rather than pretending to cover them. Anyone citing this window for rename coverage would be wrong.

**R5 — one pre-window write to the shared rig.** No raw API key for the rig existed in reachable state (`api_keys.key_hash` is an HMAC), so authenticating at all required inserting one row: `api_keys` id `8b353184-da64-4065-afcf-8367ec4bc6d5`, name `edge-retro-0907`, org `5eed0000-…-b1`, scopes `verify, verify:batch, read:records, read:search, anchor:read`, tier `free`. Additive, named for this window, no schema or ledger change. Delete on teardown.

**R6 — origin-allowlist gate is pass-through.** A request with `Origin: https://evil.example` and a valid key returns `200`. That is the documented design (`mcp-origin-allowlist.ts` reads per-key `allow:<api_key_id>` KV entries and passes through when none exists), and the retro worker's KV namespaces are empty, so the gate is untested by this window. Prod's KV may hold entries; this window says nothing about them.

**R7 — bearer positive path unproven.** The rig's real Supabase JWT secret is not exposed by the Management API, so `SUPABASE_JWT_SECRET` on the retro worker is a value this window generated. Bearer auth is therefore proven only in the negative (wrong-secret and expired both `401`). The positive auth path proven is `X-API-Key`, which is the path every MCP client actually uses (`edge.arkova.ai`'s advertised OAuth authorization server is not deployed).

## Edge PRs in the catch-up range

96 commits touching `services/edge` between `68671aec…` and `61f04403d`. PR attribution and gate results below.

**Attribution honesty.** The catch-up range contains **96 commits** touching
`services/edge`. Only **27 PRs** are mechanically attributable to them (merge-commit
subjects plus `GET /repos/.../commits/{sha}/pulls`); the remainder are squash-merged or
direct commits whose subject carries no PR number, so a "60 PRs" figure could not be
reproduced from the git history and is not asserted here. Two PRs are added by hand
because neither method found them: **#1106** (`a270b2cb4`, the `bitcoin_block` commit —
verified `NOT ancestor of 68671aec`, i.e. genuinely inside the catch-up range) and
**#1776**.

Gate column shows every distinct `Staging Soak Evidence Gate` conclusion GitHub still
holds for that PR. A `CANCELLED` alongside a `SUCCESS` is a superseded speculative
Mergify run, not a failure. Two PRs have **no** successful gate run:

* **#1106** — `FAILURE` only. The 7-line additive `bitcoin_block` field, admin-merged
  over a red evidence gate on 2026-06-21. **This window covers it explicitly** (per-cycle
  assertion 5, on both the batch and single-record envelopes, present-and-880001 /
  present-and-null).
* **#1776** — `CANCELLED` only. Touches `services/edge/server.json` and
  `docs/reference/MCP_REGISTRY_PUBLISH.md`; `server.json` is read by the external
  `mcp-publisher` CLI at publish time and is **never** read by the deployed Worker, so it
  has **no bundle impact** and nothing in it can be exercised by a runtime soak.

Every other PR in the range reached a `SUCCESS` on the gate.

| PR | Merged | Title | Staging Soak Evidence Gate | Verdict |
|---|---|---|---|---|
| #1106 | 2026-06-21 | chore(SCRUM-2226): edge worker test harness + red test for shapeAnchorRow key  | `FAILURE` | **RED — never passed** |
| #1119 | 2026-06-07 | fix(edge-mcp): truthful anchor mapping + nessie source casing + edge test harn | `FAILURE/SUCCESS` | PASS (final run SUCCESS) |
| #1121 | 2026-06-08 | fix(edge-mcp): re-route nessie_query to worker Gemini-space search + forward c | `FAILURE/SUCCESS` | PASS (final run SUCCESS) |
| #1122 | 2026-06-13 | fix(edge-mcp): verify-by-fingerprint via DEFINER RPC (PR-2: BUG-1) | `CANCELLED/FAILURE/SUCCESS` | PASS (final run SUCCESS) |
| #1130 | 2026-06-08 | chore(deps-edge): bump @cloudflare/workers-types from 4.20260602.1 to 4.202606 | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #1171 | 2026-06-15 | chore(deps-edge): bump @cloudflare/workers-types from 4.20260608.1 to 4.202606 | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #1386 | 2026-07-02 | chore(deps-edge): bump wrangler from 4.103.0 to 4.106.0 in /services/edge | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #1419 | 2026-07-06 | chore(deps-edge): bump @cloudflare/workers-types from 4.20260702.1 to 5.202607 | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #1638 | 2026-07-22 | chore(deps-edge): bump fast-uri from 3.1.2 to 3.1.4 in /services/edge | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #1714 | 2026-07-27 | chore(deps-edge): bump @cloudflare/workers-types from 5.20260719.1 to 5.202607 | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #1776 | 2026-08-02 | fix(edge): correct MCP registry server.json schema + republish with connection | `CANCELLED` | **CANCELLED — never ran to completion** |
| #1981 | 2026-08-03 | chore(deps-edge): bump @modelcontextprotocol/sdk from 1.29.0 to 1.30.0 in /ser | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #1982 | 2026-08-03 | chore(deps-edge): bump @cloudflare/workers-types from 5.20260727.1 to 5.202607 | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #2068 | 2026-08-10 | fix(dpa): stop persisting raw IPs, HMAC them, redact the 16 existing rows (mig | `SUCCESS` | PASS (final run SUCCESS) |
| #2089 | 2026-08-10 | chore(deps-edge): bump @cloudflare/workers-types from 5.20260731.1 to 5.202608 | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #2164 | 2026-08-11 | fix(edge): route MCP search_credentials through real semantic search + correct | `FAILURE/SUCCESS` | PASS (final run SUCCESS) |
| #2232 | 2026-08-23 | fix(mcp): audit log has never written a row + unmount'd proof-keys + anchor_do | `CANCELLED/FAILURE/SUCCESS` | PASS (final run SUCCESS) |
| #2233 | 2026-08-23 | fix(ingestion): stop reporting total failure as HTTP 200; fix OpenStates 422 a | `CANCELLED/FAILURE/SUCCESS` | PASS (final run SUCCESS) |
| #2236 | 2026-08-23 | fix(claims): Nessie fails closed + priced offer retracted; Drive individual sc | `FAILURE/SUCCESS` | PASS (final run SUCCESS) |
| #2237 | 2026-08-15 | ci: run the services/edge vitest suite (it gated nothing for ~10 weeks) | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #2240 | 2026-08-15 | ci(mcp): enforce tool-claim parity across the five published MCP surfaces (BUG | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #2397 | 2026-08-23 | chore(deps-edge): Bump @cloudflare/workers-types from 5.20260817.1 to 5.202608 | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #2434 | 2026-09-06 | fix(edge): stop oracle_batch_verify discarding the whole batch on one bad memb | `CANCELLED/FAILURE/SUCCESS` | PASS (final run SUCCESS) |
| #2443 | 2026-08-24 | chore(deps-edge): Bump @cloudflare/workers-types from 5.20260820.1 to 5.202608 | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #2546 | 2026-08-31 | chore(deps-edge): bump wrangler from 4.125.0 to 4.127.1 in /services/edge | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #2607 | 2026-09-05 | chore(deps-edge): bump fast-uri from 3.1.5 to 3.1.7 in /services/edge | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |
| #2608 | 2026-09-05 | chore(deps-edge): bump qs from 6.15.2 to 6.16.0 in /services/edge | `CANCELLED/SUCCESS` | PASS (final run SUCCESS) |

## Teardown

`TEARDOWN.sh` in this directory. The command the CTO asked for is step 2:

```bash
cd <worktree>/services/edge && npx wrangler delete --name arkova-edge-retro-0907 --force
```

Run **only** after `status.json` reads `window_complete_pending_review`. Steps 3-6 also
drop the two throwaway KV namespaces, delete the one pre-window `api_keys` row (R5),
remove the git worktree, and shred the credential files. Do **not** remove the worktree
or edit any file under `services/edge` while the window is open — the driver re-hashes
every soaked input each cycle and will void the window on drift.
