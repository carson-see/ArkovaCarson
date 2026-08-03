# agents.md — services/edge
_Last updated: 2026-07-28 (L2-A6 MCP discovery-manifest parity)._

## L2-A6 — MCP discovery-manifest parity + drift guard (2026-07-28)

Founder finding: the public discovery manifest
(`public/.well-known/mcp/server-card.json`) advertised only 2 tools
(`search`, `get_anchor`) while the live server registers all 16 from
`TOOL_DEFINITIONS` (`mcp-tools.ts`) — an agent or a founder reading the
manifest before installing the connector had no way to discover
`verify_batch`, `nessie_query`, `anchor_document`, or the other 12 real
tools. "MCP must be useful + easy to install" fails hard if the discovery
surface undercounts by 8x.

- **Manifest synced** (`public/.well-known/mcp/server-card.json`): all 16
  tools now listed with `inputSchema` (`properties`/`required`) matching
  `TOOL_DEFINITIONS` exactly, plus the numeric/pattern bounds from
  `mcp-tool-schemas.ts`'s Zod registry (`PUBLIC_ID_RE`, `SHA256_HEX_RE`,
  length/min/max) as extra agent-facing hints. `anchor_document` is
  listed with an explicit note that it's registered conditionally
  (`MCP_ENABLE_ANCHOR_DOCUMENT=true` + `write:anchors`/`anchor:write`
  scope — see `isMcpAnchorDocumentAllowed`) rather than omitted, since
  the manifest documents capability, not per-request gating.
- **Alias dedupe (manifest-only, no server rename/removal this sprint):**
  the live server carries duplicate tool NAMES for identical underlying
  handlers — confirmed from the handler bodies, not guessed:
  - `get_record` and `get_document` both call `handleAgentGetAnchor`,
    which is itself a documented "agent-friendly alias" wrapper around
    `handleVerifyCredential` — byte-identical response to `get_anchor`
    (and to `verify_credential`, modulo the caller-supplied-`public_id`
    framing).
  - `get_fingerprint` calls `handleAgentVerify`, a documented alias of
    `handleVerifyDocument` — byte-identical response to `verify` (and
    near-identical to `verify_document`, which `handleAgentVerify` wraps
    with one defense-in-depth `record_id` strip that's a no-op today).
  - Per L2-A6 scope: did NOT rename/remove any tool server-side this
    sprint (server truthfully still exposes 16 names — an existing
    integration calling `get_document` keeps working). Instead, each
    alias's manifest `description` now says "Alias of `<canonical>`
    (identical response); prefer `<canonical>`" so an agent picking a
    tool for a NEW integration converges on one canonical name per
    capability without losing discoverability of the alias for
    already-wired callers. **Recommended post-launch consolidation**
    (not done here): deprecate then remove `get_record`, `get_document`,
    `get_fingerprint` from the server once no active integration depends
    on them (grep MCP audit log `tool_name` distribution first), leaving
    `verify_credential` + `get_anchor` (id-based family) and `verify` /
    `verify_document` (fingerprint-based family) as the two canonical
    lookup primitives. `search` vs `search_credentials` were evaluated
    and are NOT duplicates — `search` spans org/record/fingerprint/
    document, `search_credentials` is scoped to the credential corpus
    only; both stay.
- **Drift guard, wired as a test not a new CI job**
  (`tests/infra/mcp-manifest-parity.test.ts`, root-level, imports
  `TOOL_DEFINITIONS` from `../../services/edge/src/mcp-tools` the same
  way the pre-existing `tests/infra/mcp-server.test.ts` does): asserts
  manifest tool-name SET equality against the server registry (both
  directions — catches under-count AND over-claim), per-tool
  `required`/`properties` key-set equality, non-empty descriptions, and a
  Constitution 1.3 / R-7 scan over the manifest's `description` prose
  only (property/tool identifiers like `content_hash` are internal
  technical names, out of scope per §1.3). Runs inside the EXISTING
  `ci.yml` "Tests" job via root `npm run test:coverage` — `ci.yml` is
  RTE-owned this sprint, not touched. TDD: verified RED (73/88 failing)
  against the pre-fix 2-tool manifest via `git stash`, GREEN (88/88)
  after the sync.
- Mirrors the "one schema module feeds two consumers" pattern from
  `services/worker/src/api/v2/mcpParity.ts` (REST v2 ↔ MCP response-SHAPE
  parity) — applied here to the discovery-manifest ↔ server tool-LIST
  layer instead, a different axis of the same drift problem class.
- `public/AGENTS.md` (developer-facing markdown, not the JSON manifest)
  has the identical 2-tool undercount — out of scope for this PR (ticket
  named `server-card.json` specifically; markdown isn't mechanically
  diffable against `TOOL_DEFINITIONS` the way JSON is), flagged in the PR
  body as a fast-follow.
_Last updated: 2026-08-01 (MCP official-registry publish fix)._

## MCP official-registry publish fix — schema drift + missing connection info (2026-08-01)

Founder-directed task: get `edge.arkova.ai` MCP server discoverable via the
official MCP Registry (`registry.modelcontextprotocol.io`,
`github.com/modelcontextprotocol/registry`).

- **Finding: Arkova was already published, but broken.** `io.github.carson-see/arkova-verification`
  version `1.0.0` has been live in the official registry since
  `2026-03-25T02:56:13Z` — but the published record carried **no `remotes` and
  no `packages`**, so an MCP client discovering Arkova via the registry had no
  way to actually connect to it. Root cause: `services/edge/server.json` used a
  non-standard `remoteEndpoints` key (plus `tools`/`resources`/`prompts`/
  `authentication` fields) that don't exist in the official
  `server.schema.json` (`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`,
  `#/definitions/ServerDetail`) — the registry backend silently dropped every
  unrecognized field on the original publish, keeping only `name`/`description`/
  `version`/`repository`, i.e. a listing with zero connection information.
  Confirmed live via `GET https://registry.modelcontextprotocol.io/v0.1/servers?search=arkova`
  before the fix.
- **Fix**: `server.json` rewritten to the real schema shape — `remotes[]` with
  `type: streamable-http`, `url: https://edge.arkova.ai/mcp`, and a `headers[]`
  entry declaring the required `X-API-Key` (matches `mcp-server.ts`'s
  `validateApiKey` header name). Dropped the non-schema `tools`/`resources`/
  `prompts`/`authentication` fields — the official `server.schema.json` has
  **no field for a tool list at all** (`ServerDetail` properties are limited to
  `$schema`, `_meta`, `description`, `icons`, `name`, `packages`, `remotes`,
  `repository`, `title`, `version`, `websiteUrl`). Individual tool discovery
  happens via the live `tools/list` MCP call or the separate discovery card at
  `arkova.ai/.well-known/mcp/server-card.json` (see PR #1726 for that file's
  16-tool parity fix) — `_meta.io.modelcontextprotocol.registry/publisher-provided.toolListDoc`
  points there as a hint, but it is publisher-provided metadata, not a
  registry-indexed field.
- **Published**: version `1.0.1` via `mcp-publisher publish` (Homebrew
  `mcp-publisher@1.5.0`), authenticated `mcp-publisher login github -token`
  against the `Github_Token` secret in GCP Secret Manager (project `arkova1`;
  verified via `GET /user` → `carson-see`, personal account, matches the
  `io.github.carson-see/*` namespace already in use — no org-level auth or DNS
  domain verification needed). `1.0.1` is now `status: active`,
  `isLatest: true`, confirmed via the registry search API. The broken `1.0.0`
  was marked `status: deprecated` (`mcp-publisher status`) with a message
  pointing at `1.0.1` rather than deleted, so version history stays intact.
- **Runbook**: `docs/reference/MCP_REGISTRY_PUBLISH.md` (republish steps,
  version-bump reminder, optional future migration to a `arkova.ai`-domain
  namespace via DNS TXT record — not executed, DNS is founder-managed per
  §1.11).
- **No runtime code touched**: `server.json` is consumed only by the external
  `mcp-publisher` CLI at publish time; it is never read by the deployed
  Cloudflare Worker (`services/edge/src/`) or any other running service. Zero
  behavior change to `edge.arkova.ai` itself.

## Edge MCP Truthfulness PR-3 — nessie_query → worker Gemini-space proxy + caller-key forwarding (BUG-3a) (2026-06-05)

Stacked on PR-1. Closes BUG-3a: the edge used to embed `nessie_query` text with
Cloudflare `@cf/baai/bge-base-en-v1.5` (768-dim) and hit the pgvector RPC
directly — but the `public_record_embeddings` index is built in Gemini space
(`gemini-embedding-001`). Querying a Gemini index with BGE vectors returns
meaningless neighbours, so the tool silently degraded to `text_fallback`/total=0.

- **Re-route, don't re-embed (`mcp-tools.ts`):** `handleNessieQuery` no longer
  calls `nessieVectorSearch`/Workers-AI embeddings. When a worker base URL +
  caller key are present it calls `nessieWorkerQuery`, which issues
  `GET {WORKER_BASE_URL}/api/v1/nessie/query?q=&mode=&limit=` (param names match
  the worker `NessieQuerySchema`) and maps the worker JSON
  (`{results:[{record_id,source,...,relevance_score,anchor_proof}], count}`) →
  the MCP `{query, mode, total, results}` contract (worker `relevance_score` →
  edge `similarity`; `anchor_proof` citation preserved). The
  `nessieVectorSearch`/`hydratePublicRecords` functions and the bge-base
  embedding call are **removed** — the drift class is eliminated. The
  `NESSIE_EMBEDDING_MODEL` constant remains exported only so the worker
  drift-guard test keeps a target; it is no longer invoked.
- **AUTH — forward the caller's raw key (`mcp-server.ts`):** `validateApiKey`
  now retains the validated raw `X-API-Key` on `AuthResult.callerApiKey`
  (Bearer callers → `null`); it flows into `SupabaseConfig.callerApiKey` and is
  forwarded verbatim as `X-API-Key` to the worker. This preserves the caller's
  org-scoping, scopes, and **per-caller rate limits** — NOT a shared
  service-account key. Per-caller limiting is enforced by the worker's
  globally-mounted `keyedRateLimiter` (keyed on `req.apiKey.keyId`,
  `router.ts:161-173`), driven by the forwarded key. NOTE: the `/nessie/query`
  mount's `aiRateLimiter` does NOT provide per-caller isolation here — it keys
  on `ai:${req.authUserId ?? req.ip}` and `req.authUserId` is only set by
  `requireAuth` (JWT), which is NOT on the nessie mount, so for API-key callers
  it buckets on the edge IP (shared), not the caller key. The
  key is NEVER logged: worker-proxy failures log status/`err.name` only, never
  the key or full URL. Bearer callers (no raw key) degrade to text fallback.
- **Graceful degrade:** any worker network/HTTP/shape failure → `null` →
  `nessieTextFallback` (PR-1 lowercase sources). The tool never throws.
- **New env var `WORKER_BASE_URL`** (`env.ts`, `wrangler.toml`): OPTIONAL.
  When unset (local dev / preview) nessie_query stays on text fallback. Set the
  prod value at deploy — NOT hardcoded in source:
  `wrangler deploy --var WORKER_BASE_URL:https://api.arkova.ai`.
- **Tests (`mcp-tools.test.ts`, `describe('handleNessieQuery worker proxy')`):**
  (a) worker URL hit with forwarded caller `X-API-Key` (≠ service-role);
  (b) retrieval hit maps to mode + non-zero total + results w/ similarity+citation;
  (b2) **mode=context** maps the worker's `{answer, citations, confidence}`
  envelope (which has NO `results` field) → non-empty result carrying the
  synthesized answer + citations (regression guard against the prior total:0
  silent drop); (b3) context graceful-fallback (worker emits `results`) maps as
  retrieval; (c) worker error → text fallback; (d) caller key never logged.
  Fixture caller key uses the real `ak_live_*` prefix (worker `extractApiKey`
  only recognizes `ak_`). Red→green.
- **mode=context shape (`nessieWorkerQuery`):** the worker returns TWO shapes —
  retrieval → `{results, count, query}`, context → `{answer, citations,
  confidence, ...}` (NO `results`). `nessieWorkerQuery` branches on mode: context
  maps answer+citations (total = citation count); retrieval (and the worker's
  context→retrieval graceful-fallback that emits `results`) maps `results`.
- **§1.6 / §1.10:** read-only RAG over already-public records (no document
  processing); per-caller rate limiting enforced by the worker's global
  `keyedRateLimiter` on the forwarded caller key (see AUTH note above).

## Edge MCP Truthfulness PR-1 — anchor mapping + nessie casing + test harness (2026-06-05)

Part of the 3-PR "Edge MCP Truthfulness" stack (PR-1: BUG-2 + BUG-3b + test
harness; PR-2: BUG-1 RPC; PR-3: nessie proxy through the worker).

- **Test harness (Story D):** `services/edge` now has a Vitest runner —
  `vitest` devDependency, `vitest.config.ts` (plain-node env, no Miniflare
  needed for these pure-ish handler tests), `npm test` / `npm run test:watch`
  scripts. First edge unit suite: `src/mcp-tools.test.ts`.
- **Shared RPC fixture:** `src/__fixtures__/publicAnchor.ts` exports
  `realPublicAnchorRow()` / `pendingPublicAnchorRow()` whose KEYS come
  verbatim from `supabase/migrations/0311_scrum1599_public_anchor_provenance.sql`
  (`get_public_anchor` `jsonb_build_object` body). This is the **only**
  sanctioned source of RPC-shaped test rows for edge + worker MCP tests —
  hand-authored mocks with wrong keys (`org_name`, `chain_tx_id`,
  `recipient_hash`, `issued_at`, `expires_at`, `created_at`-as-anchor-time)
  are what masked BUG-2. The worker `src/mcp-tools.test.ts` now imports the
  same fixture.
- **BUG-2 (`shapeAnchorRow`, mcp-tools.ts):** now reads the keys the RPC
  actually emits — `issuer_name`, `network_receipt_id`, `anchor_timestamp`
  (network-observed time, §1.5; defaults to **null** not `''`),
  `recipient_identifier`, `issued_date`, `expiry_date`. Was reading six keys
  the RPC never returns, so every field silently defaulted. Fixes
  verify_credential / verify_batch / get_anchor / get_record / get_document
  (all route through `shapeAnchorRow`). `shapeAnchorRow` is now exported for
  direct unit testing.
- **BUG-3b (`nessieTextFallback`, mcp-tools.ts):** source literals lowercased
  (`edgar`/`uspto`/`federal_register`/`openalex`) to match what the worker
  ingestion fetchers (`src/jobs/*Fetcher.ts`) actually insert. The previous
  UPPERCASE `source=eq.EDGAR` filter never matched a row. Covers both the
  single `source=eq.` and multi `source=in.(...)` branches.
- **Cross-service drift guard (BUG-3a):** new
  `NESSIE_EMBEDDING_MODEL` exported constant (`@cf/baai/bge-base-en-v1.5`).
  Worker test `services/worker/src/nessie-embedding-drift.test.ts` asserts
  the edge query model family differs from the worker index model
  (Gemini `gemini-embedding-001`) — the tripwire for BUG-3a. Flip its `.not`
  assertion to equality when PR-3 unifies the model.

## 2026-08-02 — the fingerprint filter is a DATABASE invariant; our tests only mock it (0386)

Read this before trusting `mcp-tools.test.ts`'s two "filtered by RPC" cases.

`get_public_anchor_by_fingerprint` is documented below as filtering to
`status = 'SECURED'`. **Production had silently drifted** to
`status IN ('SECURED','SUBMITTED','PENDING')` — no migration on main redefined
the function after `0339`, so the running body had no source in the repo — and
3 PENDING + 48,149 SUBMITTED anchors were confirmable by an anonymous caller.
Migration `0386` restores it.

`mcp-tools.test.ts`'s `'PENDING fingerprint filtered by RPC → UNKNOWN'` and its
SUBMITTED twin passed throughout, because they **mock the RPC**: they assert
this layer's mapping of `{error:'Record not found'}` → `UNKNOWN`, while the
fixture supplies the premise that the database filters. They did not fail to
catch the drift — they certified it.

Division of ownership, keep both:
- **This package** owns the edge layer's *handling* of the RPC result. Mocking
  the RPC here is correct.
- **`tests/rls/fingerprint-lookup-secured-only.test.ts`** owns the SQL predicate,
  against a live database as a real `anon` client.

The general rule, and why it belongs in your head and not just in a file: **a
mock may stand in for a COLLABORATOR, never for the INVARIANT under test.** When
the assertion is "the database refuses to answer", the database has to be the
one refusing. Full statement, with the two test shapes that make such a suite
non-vacuous (positive control; assert indistinguishability rather than mere
refusal), is in `tests/rls/agents.md`.

## Edge MCP Truthfulness PR-2 — verify-by-fingerprint via DEFINER RPC (2026-06-05)

BUG-1: the `verify` / `verify_document` / `get_fingerprint` tools returned
HTTP 400 universally. `handleVerifyDocument` fetched
`/rest/v1/public_records?content_hash=eq...&select=id,public_id,...` — a
column set that does not match the table shape, so PostgREST 400'd every call.

- **New RPC `get_public_anchor_by_fingerprint(text)`** (migration
  `0339_get_public_anchor_by_fingerprint.sql`, prefix 0339 — 0327–0338 were
  already consumed by the release-drain lane). `LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path
  = public`. Lowercases input, matches `lower(a.fingerprint) =
  lower(p_fingerprint)`, filters `status = 'SECURED'
  AND deleted_at IS NULL`, takes the LATEST by `created_at DESC, id DESC LIMIT 1`, then
  **delegates the whole jsonb projection to `get_public_anchor(public_id)`** so
  redaction (recipient SHA-256 hash, provenance strip, PENDING evidence
  gating, no `org_id`/internal id) lives in exactly one place. Unknown or
  not-yet-secured
  fingerprint → `{"error":"Record not found"}`, same envelope as
  `get_public_anchor`. Granted to `anon, authenticated`. Validated locally
  (rolled-back txn): SECURED→ACTIVE w/ receipt, UPPERCASE input still matches,
  PENDING/SUBMITTED are hidden from fingerprint lookup, unknown/empty→error,
  latest-wins, soft-deleted excluded.
- **`handleVerifyDocument` (mcp-tools.ts)** now POSTs the RPC and maps through
  the PR-1-fixed `shapeAnchorRow` (passing `data.public_id` so the envelope
  echoes `public_id` and builds the correct `record_uri`). Verify now returns
  the SAME shape as the `get_anchor` / `verify_credential` (`get_public_anchor`)
  envelope (§1.8 fix-to-spec, PO-approved) — this is the get_public_anchor
  envelope, NOT the worker's leaner `/verify/:fingerprint` shape. Public-id
  verification may surface PENDING/SUBMITTED; fingerprint verification only
  resolves SECURED anchors to avoid exposing in-flight content hashes. Unknown
  or not-yet-secured fingerprint →
  `{verified:false, status:'UNKNOWN', fingerprint:<lowercased>, public_id:null,
  network_receipt_id:null, message}` at HTTP 200, never a 400/error result (the
  `fingerprint` echo matches the worker's not-found body). The `message` is
  retained so `handleAgentSearch(type:'fingerprint')`'s found-guard still treats
  a miss as not-found.
- **`handleAgentVerify`** keeps the `record_id` strip as defense-in-depth; the
  new `shapeAnchorRow` envelope never carries an internal id, so the strip is
  now belt-and-suspenders rather than load-bearing.
- Tests in `src/mcp-tools.test.ts`: SECURED→verified+receipt+record_uri,
  unknown→not-an-error, mixed-case→lowercased `p_fingerprint`, PENDING→gated,
  and a negative guard that the call hits the RPC (not
  `/rest/v1/public_records?...public_id`).
- **Pending the soak:** migration is NOT applied to any DB; `gen:types` regen
  is pending (the changed edge code consumes no `database.types.ts`, so the
  RPC types entry only matters for future worker/frontend consumers).

## Routine dependency consolidation (2026-05-12)

PR replacement branch `codex/deps-routine-20260512` bundles the edge `@cloudflare/workers-types` bump from #764 into the root/worker/edge routine dependency PR. Edge validation for this batch: `npm run typecheck`.

## SCRUM-926 — Local JWT verification on `validateBearer` (2026-04-27)

`services/edge/src/mcp-jwt-verify.ts` (new) verifies caller-supplied bearer JWTs locally with HS256 against `SUPABASE_JWT_SECRET` BEFORE the round-trip to `/auth/v1/user`. Defense-in-depth against compromise of the Supabase auth path forging a session for arbitrary user IDs. WebCrypto only — no `jose` dep on the edge bundle (matches `mcp-hmac.ts` convention). Module-scope `cachedKey` memoizes the imported `CryptoKey` so we don't re-derive HMAC bytes per request.

`validateBearer` flow now: (1) fail-closed if `SUPABASE_JWT_SECRET` is unset (one-shot warn); (2) `verifySupabaseJwt` checks `alg`, `exp`, `iat`, `aud`, `iss`, signature, `sub`; (3) belt-and-suspenders round-trip to `/auth/v1/user` (catches server-side revocations the JWT can't reflect); (4) `user.id` cross-check against JWT `sub` — symmetric distrust of both sides. Tests: `src/tests/edge/mcp-jwt-verify.test.ts` covers forged-signature, malformed, expired, iat-future, wrong-aud, wrong-iss, missing-sub all rejected without network call.

Note: the `[MCP-SEC-07]` Jira label is reused by SCRUM-926 (this ticket) — SCRUM-984 below also carries the MCP-SEC-07 tag from the earlier TRUST sprint. Two separate concerns under one tag; both shipped.

## What This Folder Contains

Cloudflare Workers deployment at `edge.arkova.ai`. Handles MCP server, AI fallback, domain crawling, and report generation. Deployed via `wrangler`.

## Endpoints

- **MCP server** — Streamable HTTP transport
- **AI fallback** — Nemotron via Workers AI, gated by `ENABLE_AI_FALLBACK` (default: `false`)
- **Domain crawler** — with SSRF protection (private IP range blocking)
- **Report generation** — on-demand report endpoint

## Auth & Security

- All internal routes require `X-Cron-Secret` header
- Secret comparison uses constant-time algorithm to prevent timing attacks
- No public ports — ingress via Cloudflare only
- MCP server: API key (`X-API-Key`) OR Supabase JWT (`Authorization: Bearer`). `validateApiKey` + `validateBearer` race in parallel; first success wins. `validateBearer` verifies the Supabase JWT locally with `SUPABASE_JWT_SECRET` (`HS256`, `exp`, `iat`, `aud=authenticated`, `iss={SUPABASE_URL}/auth/v1`) before it calls `/auth/v1/user`, then rejects any response whose `user.id` does not match the JWT `sub`. User-id is threaded into a `ScopedConfig` object and passed to every tool handler so tools can org-scope (see `get_agents_for_user` pattern below).
- MCP tool errors: pass through `safeErrorText(err, context)` — never return `String(err)` directly (stack traces + URLs leak). Detail goes to `console.error`; clients get `{error, code: 'TOOL_ERROR'}`.

## MCP — rogue-agent posture (2026-04-20 audit)

PR #455 closed the critical findings:
- `list_agents` previously used service-role + no org filter → cross-org leak. Now calls `get_agents_for_user(p_user_id)` SECURITY DEFINER RPC (migration 0221) joining through `org_members`.
- Zod input validators tightened: `public_id` → `/^ARK-[A-Z0-9-]{3,60}$/` + max 64; `content_hash` → 64 hex (reuses exported `SHA256_HEX_RE` from `mcp-tools.ts`); `max_results`/`limit` → int 1–50; `source_url` → URL + ≤2048.
- `oracle_batch_verify` description no longer claims HMAC-signed results. Real signing tracked as MCP-SEC-02.

Open (epic [SCRUM-918](https://arkova.atlassian.net/browse/SCRUM-918)):
- MCP-SEC-03 replace service-role with scoped role / JWT forwarding across ALL tools (not just `list_agents`)

### Landed 2026-04-21 (TRUST sprint)

- **MCP-SEC-07** (SCRUM-984) — centralized Zod tool-argument registry at
  `src/mcp-tool-schemas.ts`. `validateToolArgs(name, raw)` returns a
  discriminated union; `withTelemetry` runs it in strict mode before any
  handler fires. Error envelope drops `received` + stack-trace fields.
- **MCP-SEC-08** (SCRUM-985) — origin allowlist gate at
  `src/mcp-origin-allowlist.ts`. Reads `MCP_ORIGIN_ALLOWLIST_KV` entry
  keyed `allow:<api_key_id>`; supports `allowlist|challenge|deny` modes,
  IPv4 CIDRs + origin matches + CF bot-management verdict gate. Pure
  `computeAllowlistDecision` is fully unit-tested.
- **MCP-SEC-09** (SCRUM-987) — rolling-window anomaly detector at
  `src/mcp-anomaly-detection.ts`. Heuristics: rapid tool cycling, auth
  failure burst, cross-tenant enumeration, oversized args, rate-limit
  storm. Dedupe + severity levels + Sentry envelope shipper.

### Landed 2026-04-26 (edge bug-bounty review — SCRUM-1435..1438)

Source-level review + live probes against `edge.arkova.ai`. PR [#582](https://github.com/carson-see/ArkovaCarson/pull/582). Deployed `arkova-edge@16257677-a610-49e2-9ef9-f6b3d5b69d24`.

- **F-1 / MCP-SEC-01 + MCP-SEC-08 plumbing** (BUG-2026-04-26-009 / SCRUM-1435) —
  `MCP_RATE_LIMIT_KV` namespace was never created; `MCP_ORIGIN_ALLOWLIST_KV`
  namespace existed but was never bound. Both gate modules treat missing
  KV as pass-through (dev/preview default), so production was silently
  running with **no per-API-key rate limits and no origin pinning** since
  first deploy. Fix: created the missing namespace, bound both in
  `wrangler.toml`. Both now active in deployed bindings.
- **F-2 / x402 facilitator hardening** (BUG-2026-04-26-010 / SCRUM-1436)
  — `/x402/verify` was unauth + unrate-limited. Added
  `ENABLE_X402_FACILITATOR` kill-switch (default `"false"` → 404),
  strict `0x[0-9a-f]{64}` body regex, and a per-IP 30 req/min KV
  token-bucket rate limit that runs **before** any Base RPC call (caps
  denial-of-wallet on metered RPC quota). Flip the env var when
  `x402PaymentGate` is wired through edge.
- **F-3 / CORS drift** (BUG-2026-04-26-011 / SCRUM-1437) — production
  `Access-Control-Allow-Origin` was reflecting the legacy
  `arkova-carson.vercel.app`. Rotated `ALLOWED_ORIGINS` secret to
  `https://arkova-26.vercel.app,https://app.arkova.ai`; redeployed
  current source. Live ACAO now `arkova-26.vercel.app`. Open follow-up:
  redirect/take down the legacy Vercel project.
- **F-4 / MCP-SEC-02 real signing** (BUG-2026-04-26-012 / SCRUM-1438) —
  `oracle_batch_verify` silently returned bare payload when
  `MCP_SIGNING_KEY` was unset. Generated 48-byte random key + uploaded.
  Code change: missing-key fallback now wraps as
  `{payload, signature:null, alg:null, key_id:null, signed:false}` +
  one-shot `console.warn` so callers fail closed on future rotation
  gaps.

**Operational invariants from this round:**

- Production `wrangler.toml` MUST bind `MCP_RATE_LIMIT_KV` and
  `MCP_ORIGIN_ALLOWLIST_KV`. Both gates fail-OPEN when the KV is
  missing — this is a deliberate dev/preview default but a production
  foot-gun.
- `MCP_SIGNING_KEY` MUST be set as a secret. Verify with
  `npx wrangler@4 versions view <active> --name arkova-edge` and
  confirm the key appears under `Secrets:`.
- `ENABLE_X402_FACILITATOR` stays `"false"` until `x402PaymentGate`
  (in `services/worker/src/middleware/`) is repointed at
  `https://edge.arkova.ai/x402/verify`. The paywall currently defaults
  to `https://x402.org/facilitator`.
- `ALLOWED_ORIGINS` MUST NOT include `arkova-carson.vercel.app`
  (per `feedback_single_source_of_truth.md`). The first comma-separated
  value is what unmatched-origin requests get reflected as the ACAO.

## Do / Don't Rules

- **DO** gate AI fallback behind `ENABLE_AI_FALLBACK` switchboard flag
- **DO** validate and sanitize all crawler target URLs (SSRF protection)
- **DO** use `wrangler` for all deployments
- **DON'T** process documents server-side (Constitution 1.6 — client-side only)
- **DON'T** expose `X-Cron-Secret` in logs or error responses
- **DON'T** use `replicate` in production — QA only
- **DON'T** bypass SSRF protections for internal/private IP ranges
- **DON'T** move core anchor processing, Stripe webhooks, or cron jobs here
- **DON'T** call `@cloudflare/ai` as primary provider — fallback only (Constitution 1.1)
- **DON'T** ship a wrangler.toml without `[[kv_namespaces]]` for `MCP_RATE_LIMIT_KV` and `MCP_ORIGIN_ALLOWLIST_KV` — both gates silently pass-through when the binding is missing (F-1, 2026-04-26)
- **DON'T** flip `ENABLE_X402_FACILITATOR` to `"true"` until the paywall is wired through edge **and** the per-IP rate limit + body regex have been smoke-tested in staging (F-2, 2026-04-26)
- **DON'T** include `arkova-carson.vercel.app` in `ALLOWED_ORIGINS` — the canonical front-end is `arkova-26.vercel.app` only (F-3, 2026-04-26)

## Dependencies

- `@cloudflare/ai` — Workers AI inference (Nemotron fallback)
- `wrangler` — deploy tooling
- Supabase JS client — database reads

## Key Patterns

**Constant-time secret comparison:**
```typescript
const encoder = new TextEncoder();
const a = encoder.encode(provided);
const b = encoder.encode(expected);
if (a.byteLength !== b.byteLength) return false;
return crypto.subtle.timingSafeEqual(a, b);
```

**Org-scoped tool query (list_agents pattern):**
```typescript
// Don't: /rest/v1/<table>?filter with service-role — no user scoping.
// Do: SECURITY DEFINER RPC that takes p_user_id and joins through
// org_members. Migration 0221 is the template.
const resp = await fetch(
  `${config.supabaseUrl}/rest/v1/rpc/get_agents_for_user`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: config.supabaseKey,
      Authorization: `Bearer ${config.supabaseKey}`,
    },
    body: JSON.stringify({ p_user_id: config.userId }),
  },
);
```

**Error redaction (never leak stack traces to MCP clients):**
```typescript
return { content: [{ type: 'text', text: safeErrorText(error, 'tool_name') }] };
```
