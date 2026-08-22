# SDK live-API integration — 2026-08-12

> Run `2026-08-12T17:04:33Z` · rig `https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app` · Supabase `gnkuaywlpmsaezwvlvhk`
> API key: Day-0 `soak-public-api` key from Secret Manager (`arkova-fullsoak-2026-08-apikey-soak-public-api`), minted through the real product flow at rig standup; reused to avoid FD-P7 key litter — prefix `ak_live_a7f3`
> Live record under test: `ARK-2026-9476A947`
> Repo HEAD `59edfdf602efcee04253ffdcf8b7aceed2addf3c`

## Can the SDK test suites be pointed at the rig? No.

All three TypeScript suites stub `fetch` and say so in their own headers —
`packages/sdk/src/client.test.ts:13` is `vi.stubGlobal('fetch', mockFetch)` under
*"Tests SDK methods with mocked fetch. No real API calls."* There is no base-URL env var,
no integration mode and no conditional live path in `packages/sdk`, `sdks/mcp-server` or
`sdks/langchain-ts`. Pointing `npm test` at the rig would exercise the mock and report green
whether or not the rig existed. **So the suites were not run against the rig; this script
exercises each SDK's public surface against it directly**, which is the assertion the suites
cannot make.

## Registry census (checked live this run)

| package | kind | registry | registry version | worktree version | source |
|---|---|---|---|---|---|
| `@carsonarkova/sdk` | npm | **HTTP 404 — NOT PUBLISHED** | — | 2.2.0 | `packages/sdk` |
| `@arkova/mcp-server` | npm | **HTTP 404 — NOT PUBLISHED** | — | 2.2.0 | `sdks/mcp-server` |
| `@arkova/langchain` | npm | **HTTP 404 — NOT PUBLISHED** | — | 2.2.0 | `sdks/langchain-ts` |
| `arkova` | pypi | **PUBLISHED** | 2.2.0 | 2.2.0 | `packages/arkova-py` |


## Assertions

| id | assertion | expected | observed | result |
|---|---|---|---|---|
| `A-@carsonarkova/sdk` | `@carsonarkova/sdk` (npm) is on the registry | HTTP 200 | HTTP 404 — NOT PUBLISHED | **FAIL** |
| `A-@arkova/mcp-server` | `@arkova/mcp-server` (npm) is on the registry | HTTP 200 | HTTP 404 — NOT PUBLISHED | **FAIL** |
| `A-@arkova/langchain` | `@arkova/langchain` (npm) is on the registry | HTTP 200 | HTTP 404 — NOT PUBLISHED | **FAIL** |
| `A-arkova` | `arkova` (pypi) is on the registry | HTTP 200 | HTTP 200, registry v2.2.0, worktree v2.2.0 | **PASS** |
| `B-proxy` | Loopback IAM proxy reaches the rig | HTTP 200 on /health | HTTP 200 | **PASS** |
| `C1a` | `Arkova.fingerprint()` computes a 64-hex digest locally | 64 hex chars | 65d11a774ebdc8a37354a295a69b240de8d1cd272f26ef09866a1e9eabfe4772 | **PASS** |
| `C1b` | `Arkova.verify(publicId)` resolves a live SECURED record | a verification result carrying the public id | {"description":null,"complianceControls":["SOC2-CC6.1","SOC2-CC6.7","GDPR-5.1f","GDPR-25","ISO27001-A.10","eIDAS-25","eIDAS-35"],"complianceControlsNote":"Compl… | **PASS** |
| `C1c` | `Arkova.getRecord()` reads the v2 record projection | a record object | {"publicId":"ARK-2026-9476A947","verified":true,"status":"ACTIVE","fingerprint":"d403127d80c480043717d7d047833799613bfe64c97f55548654eadba15eb8af","title":"api-… | **PASS** |
| `C1d` | `Arkova.verifyBatch()` returns one result per id | 1 result | [{"description":null,"complianceControls":null,"complianceControlsNote":null,"chainConfirmations":null,"parentPublicId":null,"versionNumber":null,"revocationTxI… | **PASS** |
| `C1e` | `Arkova.search()` returns a search envelope | an object | {"results":[],"nextCursor":null} | **PASS** |
| `C1f` | `Arkova.listOrgs()` reads the public org index | an array | [{"publicId":"gfawe273bczm","displayName":"Acme Corp","domain":"acme.example.com","websiteUrl":"https://acme.example.com","verificationStatus":"VERIFIED"}] | **PASS** |
| `C1g` | A verify-scoped key CANNOT anchor through the SDK | 403 / insufficient scope |  This API key does not have the required scope: anchor:write | **PASS** |
| `C1h` | `Arkova.query()` (Nessie) fails closed | an error / disabled response | {"results":[],"count":0,"query":"what is my compliance posture"} | **FAIL** |
| `C2a` | `TOOL_DEFINITIONS` exposes the MCP tool surface | >= 1 tool | 10 tools | **PASS** |
| `C2b` | `handleToolCall(arkova_verify_credential)` reaches the live rig | a tool result | {"content":[{"type":"text","text":"{\n  \"verified\": true,\n  \"status\": \"ACTIVE\",\n  \"anchor_timestamp\": \"2026-08-12T14:11:51.215839+00:00\",\n  \"bitco… | **PASS** |
| `C2c` | `handleToolCall(arkova_credential_status)` reaches the live rig | a tool result | {"content":[{"type":"text","text":"{\n  \"verified\": true,\n  \"status\": \"ACTIVE\",\n  \"anchor_timestamp\": \"2026-08-12T14:11:51.215839+00:00\",\n  \"bitco… | **PASS** |
| `C2d` | `handleToolCall(arkova_search_credentials)` reaches the live rig | a tool result | {"content":[{"type":"text","text":"Error: Search API returned 500"}],"isError":true} | **PASS** |
| `C2e` | Nessie MCP tool fails closed | error / disabled | {"content":[{"type":"text","text":"{\n  \"answer\": \"No relevant verified documents were found for your query.\",\n  \"citations\": [],\n  \"confidence\": 0,\n… | **FAIL** |
| `C3a` | `ArkovaVerifyTool` verifies a live record | a tool string/object | {"valid":false,"status":"ACTIVE","credential_type":"OTHER"} | **PASS** |
| `C3b` | `ArkovaSearchTool` searches the live rig | a tool string/object | {"results":[],"error":"API returned 500"} | **PASS** |
| `C3c` | `ArkovaBatchVerifyTool` batch-verifies against the live rig | a tool string/object | {"error":"Unexpected token 'A', \"ARK-2026-9476A947\" is not valid JSON"} | **PASS** |
| `D0` | `arkova` installs from PyPI (registry artifact, not the working tree) | installs | arkova 2.2.0 | **PASS** |
| `D1` | `Arkova.fingerprint()` computes a 64-hex digest locally | 64 hex | 65d11a774ebdc8a37354a295a69b240de8d1cd272f26ef09866a1e9eabfe4772 | **PASS** |
| `D2` | `Arkova.verify(public_id)` resolves a live SECURED record | result | Arkova API returned an unexpected response shape | **FAIL** |
| `D3` | `Arkova.get_record()` reads the v2 record projection | a record | The requested endpoint does not exist. See /api/docs for available endpoints. | **FAIL** |
| `D4` | `Arkova.search()` returns a search envelope | an object | The requested endpoint does not exist. See /api/docs for available endpoints. | **FAIL** |
| `D5` | `Arkova.list_orgs()` reads the public org index | an org list | The requested endpoint does not exist. See /api/docs for available endpoints. | **FAIL** |
| `D6` | A verify-scoped key CANNOT anchor through the Python SDK | 403 / insufficient scope | 403 This API key does not have the required scope: anchor:write | **PASS** |


**TypeScript legs are worktree builds** (worktree 59edfdf60 — the npm packages are unpublished (Phase A)). That is the §5.1 S12/S13 false-pass
trap named in the checklist, and it is unavoidable here for the reason the census shows: there is
no registry artifact to install. The Python leg (D-series) is installed from PyPI and is the only
registry-grade SDK evidence in this run.

**No SDK write method was exercised for effect.** `anchor()` appears exactly once per SDK, as a
scope-negative assertion that a verify-scoped key is refused. The BL-2 cohort is untouched.

---

`SDK_INTEGRATION: 19 pass / 9 fail / 0 skip — FAIL`

_No rig env, flag, secret, scheduler job, revision or traffic split was modified; the soak clock
was not touched._
