# docs/api/agents.md

Developer-facing API documentation. Engineering mirrors and guides for the Arkova Verification API.

## 2026-07-28 v1 spec canonical source flip (pentest-prep API contract audit)

- `openapi.yaml` is DEMOTED — no longer canonical. It had drifted 12+ mounted `/api/v1` routes behind the runtime-served spec (`services/worker/src/api/v1/docs.ts`, served at `GET /api/docs/spec.json`), which is what a pen tester enumerating the API actually sees. `docs.ts` is now canonical, matching the v2 pattern (`services/worker/src/api/v2/openapi.ts`). See `docs/api/canonical-sources.md`.
- New CI guard: `services/worker/src/api/v1/docs.routeParity.test.ts` extracts real routes from a set of v1 leaf routers (via `router.stack`, not a hand-transcribed list) and fails when a mounted route is missing from `openApiSpec`. It also re-reads `router.ts` to confirm its assumed mount prefixes still hold. Currently covers the routers touched by this audit (`verify-proof`, `attestations`, `webhooks`, `cle-verify`, `ai-review`, `ai-integrity`, `ai-embed`, `ai-feedback`) — the extraction logic is router-agnostic, so widening coverage to the rest of `/api/v1` is additive follow-up, not a rewrite.
- Fixed a real spec bug found in the same audit: `POST /ai/integrity` never matched anything — the router actually mounts `POST /ai/integrity/compute`. Also added the previously-undocumented `GET /ai/integrity/{anchorId}`.
- `openapi.yaml` is kept (not deleted) because `scripts/ci/check-api-scope-vocabulary.ts` still reads it for `API_KEY_SCOPES` vocabulary parity, and `docs/api/README.md` / `packages/sdk/README.md` link it as an offline/Swagger-import convenience. Its endpoint list is NOT guaranteed complete — do not add new hand-written entries there expecting them to be authoritative.

## 2026-05-22 Scope Notes

- Document anchor submit with both accepted write scopes: `anchor:write` and `write:anchors`.
- `POST /api/v1/anchor/submit` is a compatibility alias for `POST /api/v1/anchor`; new integrations should prefer `/anchor`.
- `GET /api/v1/usage` requires `usage:read`. General read/search scopes do not include usage analytics.

## Files
- **`openapi.yaml`** — frozen OpenAPI 3.0.3 spec for API v1 (authentication, rate limits, all endpoints).
- **`v2-migration.md`** — v1-to-v2 migration guide with deprecation calendar (v1 sunset 2027-04-23).
- **`webhooks.md`** — webhook developer guide: registration, HMAC verification, retry policy, SSRF protection.
- **`agent-workflows.md`** — canonical agentic call sequence for REST v2, MCP, TypeScript, and Python SDKs.
- **`mcp-tools.md`** — MCP server tool reference (15 read-oriented tools, `anchor_document` gated).
- **`canonical-sources.md`** — engineering source map linking repo files to API surfaces.
- **`v1-deprecation-communication-plan.md`** — customer communication plan for v1 deprecation.
- **`arkova-py-example.ipynb`** — Jupyter notebook example for the Python SDK.

## Conventions
- v1 schema is frozen; additive nullable fields only. Breaking changes require v2+ prefix.
- Confluence is the documentation source of truth; these files are engineering mirrors/notes.
- A published description is a CLAIM (§1.13 R-7), governed like any other. When runtime behaviour and
  a description disagree, one of them is a defect — say which. 2026-08-15: `/nessie/query` is marked
  DISABLED + `deprecated: true` in `openapi.yaml` with the 503 `nessie_disabled` envelope documented
  as its only reachable response (CTO ruling R-1), and `search_credentials` in `mcp-tools.md` now
  leads with lexical substring matching rather than semantic similarity (BUG-026 — a false
  description, not a broken search; no behaviour changed).
- `mcp-tools.md` mirrors the live tool descriptions in `services/edge/src/mcp-tools.ts`, and
  `public/.well-known/mcp/server-card.json` mirrors them again. **Nothing checks the three for text
  parity** (`tests/infra/mcp-manifest-parity.test.ts` covers names and schemas only), so edit them
  together, by hand, in the same change.

## 2026-08-31 — M2: `ProofBundle` in `openapi.yaml` had drifted from the implementation

When migration 0427 added `tx_inclusion_branch` / `tx_block_index` to the emitted
`proof_bundle`, only the in-worker prose blob in
`services/worker/src/api/v1/docs.ts` changed. This file's `ProofBundle` schema —
which carries an explicit `properties` map AND a `required` list — was untouched,
so the published contract and the implementation disagreed and nothing in CI
compared them.

- Both fields are now in `properties` AND in `required`, with `nullable: true`.
  The route always EMITS the keys; nullability is expressed by `nullable`, not by
  omitting them, so publishing them as optional would misdescribe the response.
- The descriptions state the byte orientation, the fold rule, and — explicitly —
  that `tx_block_index` does NOT arm the CVE-2012-2459 guard on the bitcoin tree
  (that needs the block's total transaction count, which the bundle does not
  carry). Contrast `leaf_count`, which does arm the equivalent app-tree guard.
- `services/worker/src/api/v1/openapi-proof-bundle-contract.test.ts` now compares
  this schema's key set against what the API's own `buildProofBundle` emits, in
  both directions, so the next drift fails CI instead of shipping. It lives in
  the WORKER suite on purpose: a first version sat in the root suite and compared
  against the frontend `buildProofPacket`, which carries the same keys today but
  would not have caught a field added to the API bundle alone.
