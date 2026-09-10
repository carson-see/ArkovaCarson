# Pre-mortem — PR #2589 (SCRUM-3894 MCP + SDK client-surface hardening)

Written before the soak, 2026-09-02. The question for each row is "it is two weeks from now and this went wrong — what was it?" Each risk names the trigger, the detection we rely on, and the mitigation that is in the PR or the soak plan. Rows marked **OPEN** have no mitigation yet and are accepted residual risk unless the soak changes the answer.

## Code

| # | It went wrong because… | Detection | Mitigation |
|---|---|---|---|
| C1 | A client integrated against the old tool names (`search_credentials`, bare `search`) and every call now returns "unknown tool". | Adopter check: 0 `MCP_TOOL_CALL` rows in prod audit_events; npm package 13 days old with source not on main; Zapier never registered. | Rename in place is a deliberate D1/D4 call. Release notes + the README rename table + the HakiChain brief §10 name both old and new. If a real adopter surfaces, the fallback is a `tools/call` shim that maps old→new with a deprecation error body — one file, no schema change. |
| C2 | The ES256/JWKS path accepts a token it should not (wrong `kid` binding, curve confusion, `alg` downgrade). | `mcp-jwt-verify.test.ts`: unknown kid, tampered signature, expired, wrong aud, `alg:none`, RS256 all rejected; HS256 without secret fails closed. Rig driver Bearer negative (tampered sig → 401). | Alg allow-list is exactly {ES256, HS256}; ES256 uses WebCrypto P-256 only; the existing `/auth/v1/user` round-trip still runs after local verification, so a forged-but-locally-accepted token still fails the `sub` cross-check. |
| C3 | The JWKS cache serves a stale key set after a Supabase rotation and Bearer breaks again silently. | Driver captures `bearerAlg` + Bearer 200 every cycle; SCRUM-3907 adds a signing-key read to the version-parity check. | One forced refetch on unknown `kid`; 10-min TTL. **OPEN:** no alert on Bearer failure rate in prod until SCRUM-3907 lands. |
| C4 | `safeErrorText` swallows a message an operator needed to debug a partner incident. | Structured `MCP_AUDIT_WRITE_FAILED` / tool audit rows still carry the internal error class server-side. | Sanitising applies to the agent-facing `content[0].text` only; server logs unchanged. |
| C5 | The parity gate passed because the baseline was moved, not because the surfaces agree. | Gate output shows the 3 pre-existing PR #2236 entries only; no entry added by this PR. | Reviewer instruction: reject any baseline addition in this PR. |
| C6 | Dropping the four `nessie_*` tools from the npm server removes something a partner used. | They were unreachable by API key (401) or 503 by directive — no successful call was possible. | D5; documented in the README rename table with the reason. |
| C7 | Retry-guard change in the TS SDK stops retrying something that was safe to retry. | `isSafeRetryMethod` gates only non-idempotent methods; GET/HEAD/PUT/DELETE behaviour unchanged; tests cover POST-503-once and GET-retries. | — |
| C8 | Bullhorn now rejects every event because no deployment sets the secret. | Fail-closed is the intent; nothing deployed imports the handler. | README + agents.md document the header + env var. |

## Soak

| # | It went wrong because… | Detection | Mitigation |
|---|---|---|---|
| S1 | The soak was hollow — health polls only, tools never called. | Driver asserts `MCP_TOOL_CALL` count increases every cycle and records every tool's status mix; a cycle with no tool calls fails `allExpected`. | §1.11A / SOC 2 Type 2 rule: evidence = the changed behaviour exercised, per cycle. |
| S2 | The rig's edge worker was deployed with the routed `wrangler.toml` and hijacked `edge.arkova.ai`. | `wrangler.soak.toml` has no `[[routes]]`; standup script substitutes it; `workers_dev` only. | Deploy command uses `--config` + `--name arkova-edge-<rig>`; never `npx wrangler deploy` bare in `services/edge`. |
| S3 | The kill switch killed every MCP call on the rig (`ENABLE_MCP_SERVER` row absent → fail closed). | First driver cycle fails on `initialize` with the kill-switch error. | Standup seeds `ENABLE_MCP_SERVER=true` (and `ENABLE_VERIFICATION_API=true` via the baseline fixture) before the clock. |
| S4 | The origin allowlist challenged every rig request (empty KV → `challenge` mode). | First cycle 4xx on every hosted call. | Standup writes an `allow:<api_key_id>` entry for the driver key (or sets the key to allowlist-off per `mcp-origin-allowlist.ts` semantics) before the clock; recorded in the evidence. |
| S5 | Bearer path untestable because the rig has no legacy secret. | — | By design: ES256 via JWKS needs no secret; the driver records `bearerAlg=ES256`. HS256 fallback is covered by unit tests only — **OPEN** residual, acceptable (prod key is `previously_used`). |
| S6 | The worker image was built from a different SHA than the PR head (evidence unbound). | Provisioner labels `arkova-source-head`; admission JSON pins image digest + head. | Build only after the final head; `standup.sh` refuses a non-40-char SHA. |
| S7 | Soak clock counted a window the driver was not running. | Clock basis = Cloud Run revision uptime; supervisor writes a heartbeat file each cycle; close-out filters cycles to the window. | Memory: supervisors drift 4h on macOS `date` without `-u` — the supervisor here uses UTC epoch arithmetic. |

## Release

| # | It went wrong because… | Detection | Mitigation |
|---|---|---|---|
| R1 | Merge landed but the edge was never deployed (again). | SCRUM-3797 open until `MCP_TOOL_CALL` rows are observed in prod. | Deploy via `scripts/deploy-edge-worker.sh` from `main` is a named close-out subtask, with a prod probe after. |
| R2 | npm 3.0.0 published from a non-main tree (repeat of 2.2.0). | `npm view … gitHead` / `repository.directory` checked after publish. | Publish only from a `main` checkout at the merge commit; recorded in SCRUM-3919/3922. |
| R3 | PyPI 2.3.0 tag pushed before the SDK soak evidence exists. | Tag is a release step listed after the evidence block. | — |
| R4 | HakiChain brief §10 still names the old tools after deploy. | SCRUM-3913/3931 close-out subtasks. | Brief is updated only after prod re-verification. |
| R5 | `DEPLOY_WORKER_PAUSED` blocked the worker half (test files only) — no runtime change in this PR touches the Node worker. | `git diff main -- services/worker/src` is tests + the v2 spec annotation only. | The v2 spec annotation change ships whenever the worker next deploys; MCP names on the spec are advisory metadata. |
