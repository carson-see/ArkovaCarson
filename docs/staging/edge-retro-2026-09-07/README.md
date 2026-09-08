# Edge catch-up retro-soak — 2026-09-07

T2 retro-soak record for the `services/edge` catch-up deploy (SCRUM-3797).
Window sealed `2026-09-08T00:54:21Z` — 49 cycles, 0 failures.

## Why this window exists

`edge.arkova.ai` has no deploy pipeline. `services/edge/` ships only when a human
runs `wrangler deploy`; `DEPLOY_WORKER_PAUSED` governs Cloud Run and nothing else.
The consequence, verified 2026-09-07:

| | Live prod worker | `origin/main` |
|---|---|---|
| Cloudflare script | `arkova-edge` (route `edge.arkova.ai/*`) | — |
| Deployment | `16750862-68d7-4c8b-8e41-8e5372bf5150` | — |
| Built from | `68671aec370b4841f06a61ed9bfa6935418e3b24` (2026-06-07) | `61f04403d7802bb5fb882f473dc21357b5e4cacd` |
| Drift | 96 commits behind on `services/edge` | — |

So the release scope of the catch-up deploy is "every `services/edge` change merged
between 2026-06-07 and today", landed in **one** `wrangler deploy`. That is a large
blast radius for a surface with no staged rollout, which is why the CTO required a
12 h T2 retro-soak of the *exact* bundle before the catch-up ships.

## Release scope — what the catch-up actually turns on

Behaviour that is on `main` and **not** live today (each verified by grepping the
built bundle, not by reading the PR):

* **Audit-log P0.** `mcp-audit-log.ts` shipped `event_category: 'security'`
  (lowercase) against the `audit_events_event_category_valid` CHECK constraint for
  ~2.5 months. Every insert was rejected 400 and the MCP tool-call audit trail
  recorded **zero rows in production**. `main` sends `'SECURITY'` and adds
  `audit-event-category.ts` as a compile-time constraint plus a test that parses
  migration `0309` so the two cannot drift again.
* **Partial batch results (#2434 / DI-038).** `oracle_batch_verify` used to discard
  the whole batch when one member failed. On `main` a mixed batch returns per-member
  results in input order with the failed member represented rather than dropped.
* **Verify-by-fingerprint** via the `get_public_anchor_by_fingerprint` DEFINER RPC
  (migration `0339`), reached by the `verify` and `get_fingerprint` tools.
* **Keyed IP hash.** `MCP_IP_HASH_PEPPER` turns `audit_events.details.ip_hash` into
  a keyed HMAC; unset it records `null` rather than the enumerable bare digest.
* **`safeErrorText` sanitizer** on the MCP error path.
* **`bitcoin_block` in the public envelope** (#1106, `a270b2cb4`) — a 7-line
  additive field, admin-merged in June **over a red evidence gate**. This window
  covers it explicitly.
* Dependency bumps: `wrangler` 4.127.1, `@cloudflare/workers-types`, `vitest`,
  `qs`, `fast-uri`.

## What is NOT in the catch-up (corrects a common assumption)

* **The MCP `*_anchor` tool renames are NOT on `main`.** PR #2589
  (`fix/mcp-tool-naming-collision`) is **OPEN**, not merged. `TOOL_DEFINITIONS` on
  `main` still registers `verify_credential` / `search_credentials` / `get_anchor`,
  and no `verify_anchor` / `search_anchors` symbol exists anywhere in the tree.
  The soak asserts their **absence** so the assumption cannot be re-made from this
  evidence later.
* **ES256 signed-request auth is NOT on `main`** — same PR. The deployed auth
  surface is `X-API-Key` plus HS256 bearer (`validateBearer`, SCRUM-926).

## Rig and isolation

* Bundle deployed to a **throwaway** Cloudflare worker `arkova-edge-retro-0907`,
  `workers_dev = true`, **no `[[routes]]`** — it cannot answer for `edge.arkova.ai`.
* Its **own** KV namespaces (`1fd8e46d…`, `67fdac24…`). The prod ids
  `a8a78436…` / `5ace0a24…` are never bound.
* Backed by the **standing shared staging rig** `fizyjojbebyalirtjjht`.
* Traffic is read-only verification. The only rows the window creates are the edge
  worker's own `MCP_TOOL_CALL` audit rows, plus one pre-window `api_keys` row
  (`edge-retro-0907`) needed to authenticate at all.
* `arkova-edge` prod is not touched. No route is deployed. No running soak or rig
  belonging to another session is touched.

## Files

| File | What it is |
|---|---|
| `wrangler.retro.toml` | throwaway deploy config (`main = "src/index.ts"`, so the bundle hash matches the canonical dry-run byte-for-byte) |
| `driver.py` | detached 15-min-cycle driver |
| `status.json` | window state (start / earliest end / cycles / failures / bundle sha) |
| `cycles/NNNNN.json` | per-cycle assertion record |
| `input-hashes.json` | frozen hashes of every soaked input; drift under the window voids it |
| `preflight.json` | `staging-honesty-preflight` output for the rig |
| `EVIDENCE.md` | the T2 evidence block |
| `driver.log` | driver stdout for both the retired and the sealed window |
| `restart-note.json` | why the first window was retired (driver defect, not a product regression) |
| `status-failed-1.json`, `cycles-retired-window/` | the retired window's state and its 2 passing cycles |
| `driver-patch-20260907T1300Z.diff` | the audit-row assertion fix applied at relaunch |
| `edge-prs.jsonl`, `edge-pr-gates.jsonl`, `edge-pr-soakgate.jsonl` | raw GitHub data behind the catch-up PR table |
