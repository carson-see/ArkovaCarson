# services/edge/src/agents.md

Cloudflare Worker (`arkova-edge`) — Zero-Trust edge layer for x402 facilitator + MCP server. Deployed via wrangler. NOT the production REST API (that's `services/worker/`).

## Files
- `index.ts` — main fetch handler. Routes `/mcp` → `mcp-server.ts`. Internal cron routes (`/report`, `/ai-fallback`, `/crawl`) require `X-Cron-Secret`.
- **`mcp-server.ts`** — MCP JSON-RPC server speaking MCP protocol 2024-11-05 over HTTPS. Wraps `@modelcontextprotocol/sdk` + `WebStandardStreamableHTTPServerTransport`. Authenticates via `validateApiKey()` (Supabase RPC `validate_api_key` — see migration 0299, SCRUM-1793) OR `validateBearer()` (Supabase JWT, fail-closed if `SUPABASE_JWT_SECRET` is unset).
- **`mcp-origin-allowlist.ts`** — per-API-key allowlist read from `MCP_ORIGIN_ALLOWLIST_KV` at key `allow:<api_key_id>`. Default = challenge mode when no entry exists. Wildcard CIDRs (`0.0.0.0/0` + `::/0`) allow any IP. Operators write entries via `wrangler kv key put` directly OR (when `MCP_ALLOWLIST_HMAC_SECRET` is set) via `tools/edge/sign-allowlist-entry.ts` for HMAC-signed envelopes (SCRUM-1283 sub-issue A).
- `mcp-rate-limit.ts` — per-user rate limiter via `MCP_RATE_LIMIT_KV`.
- `mcp-anomaly-detection.ts` — heuristics for unusual MCP tool-call patterns.
- `mcp-tools.ts`, `mcp-tool-schemas.ts` — tool catalog and schemas.
- `mcp-audit-log.ts` — fire-and-forget audit log writer via `ctx.waitUntil(...)`. Caller IPs are **keyed** HMAC-SHA256 (`MCP_IP_HASH_PEPPER`), not bare sha256 — see below.
- **`audit-event-category.ts`** — canonical `audit_events.event_category` values. The edge is a standalone tsconfig, so it CANNOT import `services/worker/src/types/audit-event-category.ts`; this is the edge's own copy, pinned to the DB CHECK by a test (see below).
- `mcp-kill-switch.ts` — checks switchboard flag `ENABLE_MCP_SERVER`. **Fails CLOSED on a fresh/empty switchboard — CTO ruling, see below. Do not pass `p_default: true`.**

## Fresh-switchboard behaviour is fail-CLOSED (BUG-021 investigation + CTO ruling, 2026-08)

`get_flag(p_flag_key text, p_default boolean DEFAULT false)` returns `p_default` when the row is
absent — it does **not** return NULL for a missing row. This file calls it with only `p_flag_key`, so a
fresh, never-seeded `switchboard_flags` resolves to `false` and the gate serves `mcp_disabled` (503).
The in-file `data === null → true` branch is therefore unreachable from a real database (it only covers
a malformed response), and the "missing flag row → fail-open" comment next to it overstates what
happens. That mismatch was investigated as BUG-021, and a fix passing `p_default: true` was drafted —
then **REVERSED by CTO ruling**: Arkova's established posture is fail-closed on an empty switchboard.
A fresh environment's `/api/v1` is deliberately dark for exactly this reason (`get_flag` fails closed
on an empty `switchboard_flags`), and a kill switch that self-enables its surface on missing config
would invert that posture and §1.4. Serving MCP on a new environment is an explicit operator action:
seed the `ENABLE_MCP_SERVER` row.

The rule this generalises to still holds: **`get_flag` collapses "absent" into `p_default`, so the fail
direction is the caller's declaration, not the function's** — and every Arkova gate (`featureGate.ts`,
`partnerProvisioningGate.ts`, this file) declares `false`. "Fail-open" in this file's header refers
only to **transient read failures** (RPC error/timeout → uncached `null` → serve this request, retry
next), never to absent configuration. A caller that must tell "absent" from "explicitly false" cannot
use this RPC at all and has to read `switchboard_flags` directly;
`services/worker/src/routes/ingestionResponse.ts` is the worked example. Fail-closed-on-absent is
pinned by `services/worker/src/mcp-kill-switch.test.ts`, which asserts the request body (no
`p_default` override), not just the resolved boolean.

## Nessie worker proxy timeout (2026-06-07)

`mcp-tools.ts` keeps Supabase REST/RPC fetches on the 10s timeout, but
worker-proxied `nessie_query` calls use a separate 30s timeout. Context-mode
Gemini generation through the worker can exceed 10s; aborting it early forces
the edge into `text_fallback`, invalidating MCP context/citation soak evidence.

## Auth chain (verified live 2026-05-08)
1. `X-API-Key` header → `validateApiKey()` calls `validate_api_key` RPC (migration 0299 applied to prod + staging this session).
2. RPC HMACs the raw key with `private.api_key_settings.hmac_secret` and looks up `api_keys.key_hash`.
3. Returns `{user_id, tier, api_key_id, scopes}` or NULL (fail-closed).
4. Origin allowlist check via `enforceOriginAllowlist()` against `MCP_ORIGIN_ALLOWLIST_KV` at `allow:<api_key_id>`.
5. MCP `initialize` handshake → tool dispatch.

## MCP audit-log IP hashing is KEYED (2026-08-10, DPA)

`mcp-audit-log.ts` hashed caller IPs from day one, but with an **unsalted** `sha256(ip)`. That does not back the DPA's "hashed IP addresses" warranty: the IPv4 space is ~4.3e9 addresses, so the digest is a rainbow-table lookup away from the plaintext — an encoding, not a pseudonymisation control.

`pseudonymizeIp()` now uses `hmacSha256Hex(ip, env.MCP_IP_HASH_PEPPER)` (new helper in `mcp-crypto-utils.ts`, WebCrypto `HMAC`/`SHA-256`).

- **Fail closed, do not downgrade.** With no pepper the row records `ip_hash: null` plus a one-time `console.warn` — it never reverts to the enumerable bare digest. An honest null beats a digest that only looks protective.
- Unlike the worker's `IP_HASH_PEPPER`, this does **not** block startup: the edge has no config-validation stage, and failing the MCP server closed over an audit field is the worse trade.
- Provision with `wrangler secret put MCP_IP_HASH_PEPPER --name arkova-edge`. Until then MCP audit rows carry no caller identifier.
- `args_hash` is deliberately still a bare `sha256` — args are attacker-chosen high-entropy JSON, not a bounded enumerable space. If a tool ever hashes a low-cardinality argument on its own, that one needs the keyed helper too.
- Tests: `src/tests/edge/mcp-security.test.ts` pins keyed-vs-bare and the null-on-missing-pepper path.

## The edge suite is CI-gated (2026-08-15) — it was not, for ~10 weeks

`services/edge/vitest.config.ts` has existed since Story D PR-1 (2026-06-05), but **nothing in CI ever invoked it** until 2026-08-15. The only edge step was `tsc -p services/edge/tsconfig.json --noEmit` in the `typecheck-lint` job — a typecheck, not a test run. The root suite could not pick these up either: root `vitest.config.ts` globs `tests/**`, `src/**`, `scripts/**` relative to the **repo root**, so `services/edge/src/*.test.ts` matched no pattern in any runner.

Net effect: `src/mcp-tools.test.ts` (36 assertions over the MCP tool surface, incl. the BUG-2 `shapeAnchorRow` regressions) **gated nothing** and could have sat red indefinitely without failing a PR. It was found while fixing BUG-2026-08-13-016 (PR #2232), whose P0 tests were parked in the ROOT suite (`src/tests/edge/`, `tests/infra/`) purely to be sure CI would run them.

**Now:** the `Tests` job runs `Install edge dependencies` (`npm ci --ignore-scripts` in `services/edge`) then `Run edge worker tests` (`npm test`), both wired into that job's `Aggregate test suite results` gate. Baseline when wired: **36/36 green** — the gate was not merged red.

- Run it locally exactly as CI does: `cd services/edge && npm ci --ignore-scripts && npm test`.
- `services/edge` has its **own** `package-lock.json` and is **not** part of the root npm workspace — deps must be installed separately or the suite cannot run at all.
- It lives in the `Tests` job on purpose. `Tests` is an enumerated `check-success` merge condition in `.mergify.yml` (5 occurrences) and a required status check; a NEW top-level job would gate nothing until branch protection and `.mergify.yml` were updated too — i.e. it would recreate this exact bug.
- **Adding a test under `services/edge/`? It runs here, not in the root suite.** Modules using ambient CF globals (`Ai` in `mcp-tools.ts:1049`, `KVNamespace`, …) can only be tested here, since the root tsconfig deliberately omits `@cloudflare/workers-types` from global `types`. See `src/tests/edge/agents.md` for the split.

## The MCP audit log never wrote a row (BUG-2026-08-13-016, P0)

From 2026-05-26 to 2026-08-15 `mcp-audit-log.ts` sent `event_category: 'security'` — lowercase — against a CHECK constraint that accepts uppercase only. Every insert returned HTTP 400. Prod holds 409,885 audit rows and **zero** `MCP_TOOL_CALL`: a SOC 2 audit-trail control that never operated once.

Three rules came out of it. Do not relax any of them:

- **Never write a bare string to `event_category` here.** Use the `AuditEventCategory` type from `audit-event-category.ts` so a wrong-case literal is a compile error. The worker gets this for free via `database-overrides.ts`; the edge had no equivalent, which is why the edge is where it broke.
- **The category list is pinned to the migration, not to a promise.** `src/tests/edge/mcp-audit-log.test.ts` parses the highest-numbered migration defining `audit_events_event_category_valid` (currently `0309`) and fails if the edge constant drifts. Change the constraint → that test tells you to change this file.
- **A failed audit write must stay loud and classified.** `reportAuditWriteFailure()` emits a structured `MCP_AUDIT_WRITE_FAILED` record splitting `permanent` (4xx — a code defect that will never self-heal) from `credential` and `transient`, and increments a counter readable via `getAuditWriteFailureCount()`. The old code did `console.error` with unclassified prose, so a permanent contract break was indistinguishable from a blip. `AUDIT_WRITE_FAILED` is an alerting token — do not reword it.

**It does not fail the request, deliberately.** `fireAndForgetAudit` runs from `withTelemetry` after the tool result exists and is handed to `ctx.waitUntil()`, so the write completes after the response has left; there is no request left to fail. Making it blocking would add a Supabase round-trip to every tool call and turn an audit-store outage into a full MCP outage. Detection was the missing control, not refusal.

**Only the SQLSTATE may be logged from an error body.** PostgREST returns `details: "Failing row contains (...)"`, i.e. the audit row including `actor_id`. `postgrestErrorCode()` whitelists `/^[0-9A-Z]{1,10}$/` so nothing else can escape into Logpush.

**Historical note (superseded 2026-08-15):** at the time this fix was written, `services/edge/**/*.test.ts` was NOT run by CI, so this PR's own P0 tests were deliberately parked in the root suite (`src/tests/edge/` or `tests/infra/`) to be sure CI would run them. **That gap is now closed** — see "The edge suite is CI-gated (2026-08-15)" above; do not treat this paragraph as current guidance for where a new edge test belongs.

## KV namespaces
- `MCP_RATE_LIMIT_KV` (`a8a7843630e84c5aa22cf20ea8a8c5e8`)
- `MCP_ORIGIN_ALLOWLIST_KV` (`5ace0a24154a4731b263285890ae3a10`)

## `TOOL_DEFINITIONS` descriptions are CI-guarded (BUG-026, 2026-08-15)

`TOOL_DEFINITIONS` in `mcp-tools.ts` is the canonical text for five published surfaces: this file, `public/.well-known/mcp/server-card.json`, `public/AGENTS.md`, `public/llms.txt` + `public/llms-full.txt`, and `docs/api/mcp-tools.md`. Nothing compared the description TEXT between them, which is how BUG-026 — `search_anchors` advertising semantic/vector matching over an ILIKE substring scan — survived on six surfaces at once.

`scripts/ci/check-mcp-claim-parity.ts` now enforces it (ci.yml `policy-lints`). What this means when you edit a description here:

- The manifest description must still START WITH your new canonical text. Editing one side alone fails the build. The manifest may APPEND discovery-only guidance (8 of the 16 tools do); it may not restate the mechanism.
- A new tool must be documented in `docs/api/mcp-tools.md` in the same PR (`reference-coverage`, strict, no baseline).
- `CLAIM_RULES` in the gate declares assertions a description may not make about a given tool, with a qualifier that makes the claim honest — `search_anchors` may not claim semantic/vector retrieval unless the same text also discloses `search_mode` or the lexical/substring fallback, and `nessie_query` may not be described in the present tense without a DISABLED marker. Adding a rule is the intended way to close the next instance; deleting one asserts the behaviour changed, and needs the code that changed it.
- Known outstanding, in `scripts/ci/mcp-claim-parity-baseline.json`: this file's `nessie_query` description still makes a present-tense capability claim (owned by PR #2236), and `oracle_batch_verify` / `list_agents` carry one-word hand-copy drift against the manifest that is UNOWNED. The gate could not fix them — every published surface is above T0.
- The gate scopes text by tool NAME. A module-header comment that names no tool is out of scope; `mcp-tools.ts`'s own header was one of BUG-026's six surfaces and would not be caught.
## 2026-08-15 BUG-008/027 — `nessie_query` fails CLOSED; BUG-026 — `search_anchors` describes itself honestly

**`nessie_query`.** Gated on `SupabaseConfig.nessieEnabled`, sourced from the `ENABLE_NESSIE_QUERY`
edge var (`env.ENABLE_NESSIE_QUERY === 'true'`). **Absent means disabled** — Nessie is permanently
disabled by standing founder directive (CTO ruling R-1). Two fail-open paths were closed:

1. The tool ran unconditionally. It now returns `nessieDisabledResult()` before any network call.
2. On **any** non-2xx from the worker it degraded to `nessieTextFallback` — a lexical scan of
   `public_records` — and answered `{total, results}`. So even once the worker started refusing, the
   MCP tool would have reported a disabled capability as a completed search. `nessieWorkerQuery` now
   inspects a 503 for `code: 'nessie_disabled'` / `enabled: false` and returns a ToolResult (not
   `null`), which stops the caller's fallback dead. **Any other non-2xx still returns `null` and still
   falls back** — a transient worker fault is not a disabled capability, and the labelled lexical path
   is the honest answer there. Do not collapse those two cases.

The disabled result carries `isError: true`, `enabled: false`, `code: 'nessie_disabled'`, and **none**
of `total`/`results`/`answer`/`confidence`/`citations`. The absence is the contract: an agent reading
only `total` would otherwise conclude "0 results".

**`search_anchors` (BUG-026).** The description used to LEAD with "Uses semantic (vector)
similarity matching". In practice the vector path needs a configured worker AND an open
`ENABLE_SEMANTIC_SEARCH` gate; with the gate closed the worker answers 503 and every call is served
lexically. Reproduced on the rig: the non-word fragment `aten` matched
`Patent_Application_AI_Method.pdf` while an English paraphrase of the same document returned nothing.
The description now leads with the served behaviour and marks the semantic path conditional.
**No behaviour changed — this was a false description, not a broken search.** `search_mode` labelling
is unchanged and still correct.

Tests pin the literals `search_mode` / `lexical_substring` / `semantic_vector` in the description
(`mcp-tools.test.ts` (h)) — keep all three in any future rewrite. The server card
(`public/.well-known/mcp/server-card.json`) carries a copy of this description and has **no**
automated text-parity check with `TOOL_DEFINITIONS`; `tests/infra/mcp-manifest-parity.test.ts` checks
names/schemas only. Update both by hand, together.

## DI-038 (SCRUM-3398) — batch verification goes through a STRUCTURED seam, never a text round-trip

`oracle_batch_verify` used to fan each member out through `handleVerifyCredential` and then
`JSON.parse(result.content[0].text)`. That handler does **not** always return JSON: its catch branches
return `errorResult('Verification lookup timed out')` / `errorResult('Verification lookup failed: …')`,
and `errorResult` puts that BARE PROSE straight into `content[0].text`. `JSON.parse` therefore threw a
SyntaxError, the rejection escaped `Promise.all`, and the tool's outer catch returned
`safeErrorText(...)` — **one transient per-credential timeout discarded every credential in the batch
that had already verified**, on a public agent-facing tool documented for bulk (max-25) workflows.
`publicIdSchema` guards the empty-id branch; it does nothing about the timeout / transport branch.

The fix is the seam, not a `try` around the parse:

- **`verifyCredentialRecord(publicId, config)` (`mcp-tools.ts`)** is now the ONLY per-ID lookup, and it
  never throws and never returns a `ToolResult`. Success → `shapeAnchorRow(data, publicId)`; failure →
  `{ public_id, verified: false, error }`.
- **`handleVerifyBatch` (`verify_batch`) and `buildOracleBatchEnvelope` (`oracle_batch_verify`) both map
  over it**, so the two batch paths cannot drift in either the success shape or the failure shape. That
  was already `handleVerifyBatch`'s behaviour — `oracle_batch_verify` is the one that was wrong.
- The failure `error` strings are deliberately FIXED prose, never `error.message`. A transport failure
  message can carry the resolved host/port and this envelope is public output. Note this is *stricter*
  than single-credential `handleVerifyCredential`, which still interpolates `error.message`; do not
  "harmonise" the batch path back onto that.
- **`buildOracleBatchEnvelope` is exported from `mcp-server.ts` for tests** (same rationale as
  `shouldFailClosedWhenSigningKeyMissing` / `applyMcpSecurityHeaders`); the tool registration is now a
  one-line delegation. The envelope contract — `query_id` / `queried_at`, HMAC signing, the
  `signed: false` marker, and the `EDGE_REQUIRE_MCP_SIGNING` fail-closed branch — is unchanged and pinned
  by tests in the new `mcp-server.test.ts`.

One deliberate shape alignment: `record_uri` for `oracle_batch_verify` members now derives from the
REQUESTED public_id (via `shapeAnchorRow(data, id)`) rather than the RPC row's own `public_id`. These
are the same value for a lookup keyed on that id, and it is what `verify_batch` has always done.

An all-failed batch is deliberately **not** an MCP-level error: the envelope stays well-formed and each
row carries its own reason, so an agent can retry exactly the ids that failed. `mcp-server.test.ts`
pins `isError` falsy for that case on purpose — flipping it back to a batch-wide `isError` would
re-create the DI-038 collapse by a different route. The suite also pins the fix at the tool's
documented max (25 ids, one timeout → 24 rows survive), which is the bulk workflow the tool is sold on.

**Post-review cleanup (same PR):** `handleVerifyCredential` and `verifyCredentialRecord` both used to
inline their own copy of the `supabaseFetch` → `response.ok` check → `response.json()` sequence — real
duplication, flagged independently by a `/code-review` altitude pass and a `/simplify` pass. The fetch
mechanics are now shared via a private `fetchAnchorRow(id, config)` helper; each caller still does its
OWN error shaping on top (unchanged): `handleVerifyCredential` still returns MCP-level `errorResult`s
and still interpolates `error.message` on generic failures, `verifyCredentialRecord` still returns a
data row and still scrubs to fixed prose. `fetchAnchorRow` throws the raw error rather than swallowing
it — that's what lets the two callers keep diverging on purpose. Zero behavior change; both test files
pass unmodified (60/60).

## Open work
- SCRUM-1793 (PR #741 NEW) — `validate_api_key` RPC migration committed to repo; already applied to prod + staging via Supabase MCP.
- HakiChain sandbox key (`api_key_id=c75d84b9-…`) has wildcard CIDR allowlist entry written 2026-05-08.
- BUG-026 residue: `oracle_batch_verify` and `list_agents` descriptions here disagree with `server-card.json` by one word each (`an envelope` vs `a response envelope`; `caller organization` vs `caller's organization`). Baselined, unowned, needs a T2 PR.
- No CI check enforces text parity across the five published MCP claim surfaces (`mcp-tools.ts`,
  `server-card.json`, `public/AGENTS.md`, `public/llms*.txt`, `docs/api/mcp-tools.md`). They can drift
  freely today; a parity script is the durable fix for the BUG-026 class.

## 2026-09-02 — tool rename, D3, ES256 Bearer, safeErrorText (SCRUM-3894)

See `services/edge/agents.md` (same date) for the full entry. File-level notes:
- **`mcp-tools.ts`** — all `TOOL_DEFINITIONS` names `arkova_`-prefixed except `nessie_query`; `API_ONLY_NOTE` appended to `arkova_verify_anchor` / `arkova_search_anchors` (do not drop it); every catch block returns `safeErrorText(...)`.
- **`mcp-tool-schemas.ts`** — registry keys follow the new names.
- **`mcp-server.ts`** — `TOOL_DESC` keys renamed; `handleProtectedResourceMetadata` has no `authorization_servers` (D3); `validateBearer` tolerates a missing `SUPABASE_JWT_SECRET` (ES256 path needs none).
- **`mcp-jwt-verify.ts`** — ES256 via JWKS + HS256 fallback; exports `jwksUrlFor`, `resetJwksCacheForTests`, `JwksFetcher`. (`supabase-jwt.ts`, the HS256-only duplicate this line flagged for removal, was deleted 2026-09-05 — see below.)
- **`mcp-error-utils.ts`** — `safeErrorText` home (was in `mcp-server.ts`; moved to avoid an import cycle).

## 2026-09-05 — unauthenticated JWKS refreshes must be bounded (PR #2589)

An unknown `kid` is attacker-controlled and reaches local JWT verification before
authenticated tool rate limiting. Never force a network request for each unknown
key. Share in-flight JWKS refreshes and retain both successful and failed attempts
for a 30-second cooldown. The successful-key cache remains valid for 10 minutes;
known cached keys continue working during an unknown-key refresh outage. A newly
rotated key can be fetched after the short cooldown, and unknown keys always fail
closed. The default fetch and response-body read are bounded by a five-second
abort timer. `resetJwksCacheForTests` clears both cache and refresh-attempt state.

Regression tests reproduce request amplification, concurrent cold fetches, and
outage retries, and verify the timeout, legitimate rotation, and outage recovery.
The current review and release record is Confluence page `137101729`; the same
finding is recorded in master bug tracker `88768514`. Auth changes require T3
qualification on the final frozen source; older T2 wording is superseded.

## 2026-09-05 — review fixes on PR #2589 (edge MCP surface)

Six findings from the code review of `5bd5f754b`. All are in this directory
plus `src/tests/edge/` and `tests/infra/edge-wrangler-vars-parity.test.ts`.

**A malformed bearer token must not reach the runtime as a thrown exception.**
`base64UrlDecode` in `mcp-jwt-verify.ts` called `atob` unguarded. Every byte of
a bearer token is attacker-controlled and `atob` raises a DOMException on a
non-base64url segment; the HS256 branch had no try/catch, and neither
`validateBearer`, `handleMcpRequest`, nor `index.ts` catches above it, so
`<HS256 header>.<payload>.$$$$` produced a generic Workers error instead of the
401 the auth contract promises. The decoder now returns `null` and both
signature branches read that as `bad_signature`. The ES256 path decodes
**before** any JWKS work, so an undecodable signature also cannot buy an
unauthenticated caller a request to the authentication service.

**The ES256-only pin is deliberate and asymmetric with the worker.**
`services/worker/src/auth.ts` accepts `ASYMMETRIC_ALGS = ['ES256', 'RS256']` on
its JWKS path. This module accepts ES256 (JWKS) and legacy HS256 (secret) only:
RS256 is rejected as `wrong_alg` before any JWKS fetch. That is not drift to
"fix" by widening — Supabase signs with ES256, RS256 buys the edge nothing, and
the narrower set means one fewer alg an attacker can steer an unauthenticated
request into. A test pins it.

**A thrown tool error was published verbatim.** `withTelemetry` re-threw the
handler's error, and the MCP SDK's `createToolError`
(`@modelcontextprotocol/sdk` `server/mcp.js`) copies `err.message` onto the
wire. It now returns the `safeErrorText` envelope, the same one every other
tool-error path uses. Four raw upstream bodies in `mcp-tools.ts` went the same
way — the two search fallbacks and both anchor-submission paths interpolated
the PostgREST response body, which names columns and can echo row content. The
body goes to Logpush; the client gets `{error, code:'TOOL_ERROR'}`. **Never
interpolate a response body, an `Error.message`, or `String(err)` into
`content[0].text`.**

**`TOOL_LIMITS_RPM` is exported so a test can pin it.** A key that is not a real
tool name falls through to `default: 1000` in silence — the per-tool cap simply
never applies. The 2026-09-02 `arkova_` rename is exactly the edit that strands
one. A test asserts every key but `default` is a `TOOL_DEFINITIONS` name.

**The `api-overview` resource is derived, not typed.** It listed tools as hand-
written literals and had already drifted: `arkova_verify_batch` was registered
but absent, so an agent reading the resource never learned it existed.
`buildApiOverviewText` renders padded name + first sentence of the canonical
description (a very short lead sentence carries its follow-on, so `nessie_query`
still reads "DISABLED. …"), keeping the `anchor_document` enabled/disabled
conditional. `arkova_oracle_batch_verify` and `arkova_list_agents` also stopped
passing inline description literals and now read `TOOL_DESC[...]` like the other
13. **Do not re-inline either one** — an inline literal is a sixth, unguarded
copy of text `check-mcp-claim-parity.ts` pins across five published surfaces,
and it is the shape the baselined BUG-026 one-word drift took. Canonical
descriptions in `mcp-tools.ts` were not touched, and the gate still exits 0 with
the same 3 baselined violations.

**`supabase-jwt.ts` is gone.** It was a second Supabase JWT verifier, HS256-only,
whose sole importer was `src/tests/edge/mcp-security.test.ts`. It would have
rejected every current Supabase token (BUG-2026-09-02-002) — and because it was
what the tests exercised, they could stay green while the shipped verifier
broke. Those tests now run against `mcp-jwt-verify.ts` with the specific
failure reason asserted, not just "returns null".

**`wrangler.soak.toml` `[vars]` keys are pinned to `wrangler.toml`'s**
(`tests/infra/edge-wrangler-vars-parity.test.ts`, keys only — values differ per
environment). Nothing compared them. A var present only in prod makes the rig
take the other branch of a gate read as `env.X === 'true'`, since an absent var
is `undefined`; `EDGE_REQUIRE_MCP_SIGNING` is the worked example, where the rig
would emit unsigned oracle envelopes while prod fails closed and the soak still
reports green (§1.11A: a hollow soak).
## 2026-08-30 SCRUM-3818 — `shapeAnchorRow` dropped `fingerprint_source` entirely; every MCP verify tool read as uniform evidence strength

A security review of the DocuSign inbound go-live path (`ENABLE_DOCUSIGN_INBOUND`) found `shapeAnchorRow` (the shared mapper behind `verify_credential`, `get_anchor`/`get_record`/`get_document` (all via `handleAgentGetAnchor` → `handleVerifyCredential`), `verify`/`get_fingerprint` (via `handleAgentVerify` → `handleVerifyDocument`), `verify_batch`, and `oracle_batch_verify`) never read the RPC's `fingerprint_source` key at all — an anchor whose fingerprint was never independently measured by Arkova from a document (`fingerprint_source: 'issuer_record_attestation'`, set for CSV bulk-import issuer attestation AND for the DocuSign Recipient-Connect inbound declared-hash path) was indistinguishable to a calling agent from a real document-bytes anchor. §1.5 / R-7.

**Fix:** `shapeAnchorRow` now passes `fingerprint_source` through (omitted, never `null`, when absent/unclassified — same "TRI-STATE, never guessed" convention as `jurisdiction`) and adds a `fingerprint_evidence_note` field ONLY for `issuer_record_attestation`, stating the measured/asserted/NOT-asserted triad without claiming Arkova independently measured anything. All nine tool descriptions above were also updated to tell a calling agent to check `fingerprint_source` instead of assuming uniform verification confidence. Regression pinned: a `document_bytes` (or absent) fixture renders with NO `fingerprint_evidence_note` — see `mcp-tools.test.ts` "fingerprint evidence class (SCRUM-3818)".

**Known gap, not fixed here — flagged rather than silently worked around:** `get_public_anchor` does NOT project `metadata->>'connector_source'` (deliberately service_role-write-guarded per the docusign-bilateral CTO decision record R1), so this mapper cannot compute the finer worker-side `fingerprint_rederivability` class (`FETCH_TIME_SNAPSHOT` vs `DECLARED_UNVERIFIED`, `services/worker/src/constants/connectorFingerprint.ts`) or distinguish a DocuSign-inbound record from a CSV-attested one — that would need the RPC's projection extended, i.e. a migration. Not written as part of this fix; `fingerprint_source` alone is sufficient to stop the false "Arkova measured this" claim, which is the R-7 violation this fix closes.

The `__fixtures__/publicAnchor.ts` `PublicAnchorRow` (pinned to the `get_public_anchor` contract) gained a required `fingerprint_source` field — the fixture's own doc comment previously listed keys current only as of migration `0311`; it was already stale (missing `fingerprint_source` from `0376`, and `cpe_metadata`/`cle_metadata`) before this fix and is corrected only for the field this PR needed.
## SCRUM-4035 — narrow ES256 confirmation dependency

The OAuth confirmation candidate imports the reviewed ES256/HS256 verifier and
bounded JWKS cache from PR2589 commit `69e24d83cfbc7a8a68f07c3c286cc870ea04de9e`,
composed with its signed pending-role rejection after either signature path.
Only the missing-secret/`validateBearer` auth hunk is taken from `mcp-server.ts`;
current tool/SDK names, discovery metadata and unrelated contract files remain
under PR2589 ownership. This is not a full PR2589 integration.

`email-confirmation.test.ts` exercises the actual `validateBearer` boundary with
real WebCrypto signatures: pending HS256/ES256 cannot reach getUser, ordinary
ES256 works without the shared secret, returned subject mismatch denies, and
the legacy ordinary control remains. Retain all imported verifier tests for
shared JWKS fetches, cooldown on failures, timeout, cache and key rotation. The
separate `supabase-jwt.ts` helper has no runtime importer; preserve its existing
pending guard without inventing an unused ES256 implementation.

## PR #2589 — verified Bearer origin allowlist

After local JWT signature/claim checks and a matching Supabase user lookup,
`handleMcpRequest` can select `allow-user:<user_id>` in `MCP_ORIGIN_ALLOWLIST_KV`.
This is separate from API keys' existing `allow:<api_key_id>` namespace. A Bearer
user needs an explicit operator entry: absent, malformed, incorrectly signed,
denied, or nonmatching entries cannot grant access. The existing signed-envelope
contract applies in both namespaces when `MCP_ALLOWLIST_HMAC_SECRET` is set.
API-key no-entry behavior is unchanged; an API-key result lacking its id cannot
fall back to a user entry. No production entries are created by this change.

`mcp-bearer-allowlist.test.ts` drives the actual HTTP handler and tool dispatch
with real HS256/ES256 signatures. It covers valid user entries, namespace
separation, missing/forged subjects, returned-subject mismatch, and terminal
signed pending-role rejection before any user/KV/tool lookup can rescue it.

## 2026-09-11 — UAT-04 hosted MCP bearer tokens

Hosted MCP Supabase bearer verification requires AAL2 for human JWTs and rejects
email/MFA pending roles. `X-API-Key` machine authentication is unchanged.

## 2026-09-14 — SCRUM-5142 hosted folder management

`arkova_manage_folders` forwards validated list/create/update/bind/delete/bulk actions to the canonical worker routes. Forward only the verified request credential (`X-API-Key` or the locally verified bearer header), never tool arguments as authorization.
## 2026-09-19 — UAT-12 MCP status parity

The write-gated MCP surface includes `arkova_get_submission_status`, proxied to the caller-scoped worker route with the caller API key. Descriptions are public verification metadata; user/org tags remain private. Keep tool definition, Zod registry, live registration, and server card synchronized.
Status-handler tests retain safe string error codes but collapse structured upstream bodies to the
HTTP status; internal provider messages must never reach MCP output.
