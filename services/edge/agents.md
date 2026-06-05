# agents.md — services/edge
_Last updated: 2026-06-05 (Edge MCP Truthfulness PR-3)._

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
_Last updated: 2026-06-05 (Edge MCP Truthfulness PR-2)._

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

## Edge MCP Truthfulness PR-2 — verify-by-fingerprint via DEFINER RPC (2026-06-05)

BUG-1: the `verify` / `verify_document` / `get_fingerprint` tools returned
HTTP 400 universally. `handleVerifyDocument` fetched
`/rest/v1/public_records?content_hash=eq...&select=id,public_id,...` — a
column set that does not match the table shape, so PostgREST 400'd every call.

- **New RPC `get_public_anchor_by_fingerprint(text)`** (migration
  `0335_get_public_anchor_by_fingerprint.sql`, prefix 0335 — 0327–0334 were
  already reserved). `LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path
  = public`. Lowercases input, matches `lower(a.fingerprint) =
  lower(p_fingerprint)`, filters `status IN ('SECURED','SUBMITTED','PENDING')
  AND deleted_at IS NULL`, takes the LATEST by `created_at DESC LIMIT 1`, then
  **delegates the whole jsonb projection to `get_public_anchor(public_id)`** so
  redaction (recipient SHA-256 hash, provenance strip, PENDING evidence
  gating, no `org_id`/internal id) lives in exactly one place. Unknown
  fingerprint → `{"error":"Record not found"}`, same envelope as
  `get_public_anchor`. Granted to `anon, authenticated`. Validated locally
  (rolled-back txn): SECURED→ACTIVE w/ receipt, UPPERCASE input still matches,
  PENDING gates receipt+anchor_ts to null, unknown/empty→error, latest-wins,
  soft-deleted excluded.
- **`handleVerifyDocument` (mcp-tools.ts)** now POSTs the RPC and maps through
  the PR-1-fixed `shapeAnchorRow` (passing `data.public_id` so the envelope
  echoes `public_id` and builds the correct `record_uri`). Verify now returns
  the SAME canonical worker-v2 anchor shape as `get_anchor` /
  `verify_credential` (§1.8 fix-to-spec, PO-approved). Unknown fingerprint →
  `{verified:false, status:'UNKNOWN', public_id:null, network_receipt_id:null,
  message}` at HTTP 200, never a 400/error result. The `message` is retained
  so `handleAgentSearch(type:'fingerprint')`'s found-guard still treats a miss
  as not-found.
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
