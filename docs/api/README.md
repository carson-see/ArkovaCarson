# Arkova API Documentation

> **Audience:** Developers integrating with Arkova programmatically — without ever opening the Arkova web app.

This directory is the canonical home for Arkova's developer-facing API documentation. Everything here is written for engineers shipping integrations: REST endpoints, MCP tools, SDKs, embeddable widgets, and the webhook lifecycle.

The full machine-readable API spec is at [`openapi.yaml`](./openapi.yaml). Hosted Swagger UI is at [`https://app.arkova.ai/api/docs`](https://app.arkova.ai/api/docs).

---

## Quick links

| What you want to do | Read this |
|---|---|
| Anchor + verify credentials from TypeScript / JavaScript | [`@arkova/sdk`](../../packages/sdk/README.md) |
| Anchor + verify from Python | [`sdks/python`](../../sdks/python/) |
| Drop a verification badge on any third-party site | [`@arkova/embed`](../../packages/embed/README.md) |
| Register and manage webhooks programmatically | [Webhooks developer guide](./webhooks.md) |
| Let an AI agent (Claude / LangChain / AutoGen) verify credentials | [MCP tool reference](./mcp-tools.md) |
| Read the raw OpenAPI spec | [`openapi.yaml`](./openapi.yaml) |
| Browse interactively | [`https://app.arkova.ai/api/docs`](https://app.arkova.ai/api/docs) |

---

## Surfaces at a glance

Arkova exposes its verification platform through five complementary surfaces. Pick the one that matches your environment:

### 1. REST API — `https://arkova-worker-270018525501.us-central1.run.app/api/v1`

The foundation. Everything else wraps this. Public endpoints (verify, batch verify) require no auth. Authenticated endpoints take an API key via `X-API-Key` or `Authorization: Bearer ak_live_...`.

| Group | Endpoints | Auth | Docs |
|---|---|---|---|
| Verification | `GET /verify/{publicId}`, `POST /verify/batch` | Optional API key (rate-limit boost) | [OpenAPI](./openapi.yaml) |
| Anchoring | `POST /anchor` | API key | [OpenAPI](./openapi.yaml) |
| Webhooks | `POST/GET/PATCH/DELETE /webhooks`, `POST /webhooks/test`, `GET /webhooks/deliveries` | API key | [Webhooks guide](./webhooks.md) |
| API key management | `POST/GET/PATCH/DELETE /keys` | Supabase JWT | [OpenAPI](./openapi.yaml) |
| Nessie RAG | `POST /nessie/query` | API key + x402 | [OpenAPI](./openapi.yaml) |
| CLE compliance | `GET /cle/verify`, `GET /cle/credits`, `POST /cle/record` | API key + x402 | [OpenAPI](./openapi.yaml) |
| Attestations | `POST/GET/PATCH /attestations` | Supabase JWT | [OpenAPI](./openapi.yaml) |

### 2. TypeScript SDK — `@arkova/sdk`

A thin wrapper around the REST API. Three lines of code to anchor and verify. Includes a programmable webhooks namespace, batch verify, error handling, and x402 micropayment support.

```typescript
import { Arkova } from '@arkova/sdk';
const arkova = new Arkova({ apiKey: process.env.ARKOVA_API_KEY });
const receipt = await arkova.anchor('document content');
const result = await arkova.verify(receipt.publicId);
```

📖 [Full SDK reference](../../packages/sdk/README.md)

### 3. Embeddable widget — `@arkova/embed`

A vanilla-JS, zero-dependency, CSP-safe `<script>` tag that drops a verification badge on any third-party site.

```html
<div data-arkova-credential="ARK-2026-001"></div>
<script src="https://cdn.arkova.ai/embed.js"></script>
```

📖 [Full embed reference](../../packages/embed/README.md)

### 4. MCP server — `https://edge.arkova.ai/mcp`

Model Context Protocol endpoint for AI agents. Six tools: `verify_credential`, `search_credentials`, `nessie_query`, `anchor_document`, `verify_document`, `verify_batch`. (A `cle_verify` tool was scoped for INT-02 but deferred — the HTTP CLE route remains available via the REST API and the SDK. Tracked as INT-02b.)

```json
{
  "mcpServers": {
    "arkova": {
      "url": "https://edge.arkova.ai/mcp",
      "headers": { "X-API-Key": "ak_live_..." }
    }
  }
}
```

📖 [Full MCP tool reference](./mcp-tools.md)

### 5. Webhooks (outbound) — your URL

Arkova POSTs HMAC-SHA256-signed JSON to your endpoint when anchors transition state. Three event types:

- `anchor.secured` — network confirmation complete
- `anchor.revoked` — Org admin revoked the credential
- `anchor.expired` — `expires_at` passed

Register, list, update, and delete webhook endpoints **programmatically** via `POST/GET/PATCH/DELETE /api/v1/webhooks` — no UI needed.

📖 [Full webhooks guide with HMAC verification examples (Node, Python, Go)](./webhooks.md)

---

## Authentication overview

| Surface | Method | Header | Used by |
|---|---|---|---|
| REST | API key | `X-API-Key: ak_live_...` or `Authorization: Bearer ak_live_...` | All `/api/v1/*` (some endpoints public) |
| REST (key management) | Supabase JWT | `Authorization: Bearer eyJ...` | `/api/v1/keys`, `/api/v1/credits` |
| MCP | API key | `X-API-Key: ak_live_...` or `Authorization: Bearer ak_live_...` | All MCP tool calls |
| Webhooks (inbound to your server) | HMAC-SHA256 | `X-Arkova-Signature` + `X-Arkova-Timestamp` | Every event Arkova sends |
| x402 micropayments | Signed payment header | `X-Payment: ...` | Optional alternative for paid endpoints |

API keys are scoped to a single organization. RLS enforces isolation server-side — you cannot read or modify another org's data with your key.

---

## Rate limits

| Tier | Limit | Applies to |
|---|---|---|
| Anonymous | 100 req/min per IP | Public verify without API key |
| Authenticated | 1,000 req/min per API key | Most authenticated endpoints |
| Batch | 10 req/min per API key | `POST /verify/batch`, webhook CRUD, batch attestations |
| AI | 30 req/min per user | Nessie query, AI extraction, semantic search |

Every response includes `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. When exceeded you get `429 Too Many Requests` with `Retry-After`.

---

## Error envelope

Every endpoint returns errors in the same shape:

```json
{
  "error": "machine_readable_code",
  "message": "Human-readable description",
  "details": { "fieldErrors": { "url": ["url must use HTTPS"] } }
}
```

Common codes: `validation_error`, `invalid_url`, `verification_failed`, `authentication_required`, `not_found`, `rate_limit_exceeded`, `internal_error`.

---

## Versioning policy

The `/api/v1/*` schema is **frozen**. Per [Constitution 1.8](../../CLAUDE.md#18-api-versioning):

- Additive nullable fields are allowed without bumping the version.
- Breaking changes require a `/api/v2/` prefix and a 12-month deprecation period.
- Existing fields are never renamed, removed, or have their types changed.

If you build against `/api/v1`, your integration will keep working.

---

## Documentation index

| File | What's in it |
|---|---|
| [`README.md`](./README.md) | This file — top-level developer docs index |
| [`webhooks.md`](./webhooks.md) | Comprehensive webhook CRUD guide: schemas, HMAC verification (Node/Python/Go), retry policy, SSRF rules |
| [`mcp-tools.md`](./mcp-tools.md) | MCP server tool reference for AI agents |
| [`openapi.yaml`](./openapi.yaml) | Machine-readable OpenAPI 3.0 spec — all REST endpoints |

External:

- [`packages/sdk/README.md`](../../packages/sdk/README.md) — `@arkova/sdk` TypeScript SDK
- [`packages/embed/README.md`](../../packages/embed/README.md) — `@arkova/embed` embeddable widget
- [`sdks/python/`](../../sdks/python/) — Python SDK
- [`https://app.arkova.ai/api/docs`](https://app.arkova.ai/api/docs) — Hosted Swagger UI

---

## Recent changes

| Date | Story | What shipped |
|---|---|---|
| 2026-04-11 | INT-09 (SCRUM-645) | Webhook CRUD via API — register, list, update, delete webhooks programmatically. Closes the API-only loop. |
| 2026-04-11 | INT-01 (SCRUM-642) | TypeScript SDK extended with `verifyBatch` + full `webhooks` namespace + enriched `ArkovaError`. |
| 2026-04-11 | INT-03 (SCRUM-644) | Embeddable verification bundle (`@arkova/embed`) — vanilla JS, single script tag. |
| 2026-04-11 | INT-02 (SCRUM-643) | MCP server tool added: `verify_batch`. Total: 6 tools. (`cle_verify` deferred to INT-02b.) |
