# Arkova API Documentation

> **Audience:** Developers integrating with Arkova programmatically — without ever opening the Arkova web app.

This directory is the canonical home for Arkova's developer-facing API documentation. Everything here is written for engineers shipping integrations: REST endpoints, MCP tools, SDKs, embeddable widgets, and the webhook lifecycle.

The full machine-readable v1 API spec is at [`openapi.yaml`](./openapi.yaml). The API v2 agent spec is published at `https://api.arkova.ai/v2/openapi.json` and mirrored by the worker at `/api/v2/openapi.json`. Hosted Swagger UI is at [`https://app.arkova.ai/api/docs`](https://app.arkova.ai/api/docs).

---

## Quick links

| What you want to do | Read this |
|---|---|
| Anchor + verify credentials from TypeScript / JavaScript | [`@arkova/sdk`](../../packages/sdk/README.md) |
| Search, verify fingerprints, and inspect v2 resources from Python | [`arkova`](../../packages/arkova-py/README.md) |
| Move from API v1 to v2 | [v1 to v2 migration guide](./v2-migration.md) |
| Drop a verification badge on any third-party site | [`@arkova/embed`](../../packages/embed/README.md) |
| Register and manage webhooks programmatically | [Webhooks developer guide](./webhooks.md) |
| Let an AI agent (Claude / LangChain / AutoGen) verify credentials | [MCP tool reference](./mcp-tools.md) |
| Read the raw OpenAPI spec | [`openapi.yaml`](./openapi.yaml) |
| Import the API v2 agent OpenAPI spec | `https://api.arkova.ai/v2/openapi.json` |
| Browse interactively | [`https://app.arkova.ai/api/docs`](https://app.arkova.ai/api/docs) |

---

## Surfaces at a glance

Arkova exposes its verification platform through five complementary surfaces. Pick the one that matches your environment:

### 1. REST API — `https://arkova-worker-270018525501.us-central1.run.app/api/v1`

The foundation. v1 is frozen and now publishes a 12-month deprecation calendar. Public endpoints (verify, batch verify) require no auth. Authenticated endpoints take an API key via `X-API-Key` or `Authorization: Bearer ak_live_...`.

| Group | Endpoints | Auth | Docs |
|---|---|---|---|
| Verification | `GET /verify/{publicId}`, `POST /verify/batch` | Optional API key (rate-limit boost) | [OpenAPI](./openapi.yaml) |
| Anchoring | `POST /anchor` | API key | [OpenAPI](./openapi.yaml) |
| Webhooks | `POST/GET/PATCH/DELETE /webhooks`, `POST /webhooks/test`, `GET /webhooks/deliveries` | API key | [Webhooks guide](./webhooks.md) |
| API key management | `POST/GET/PATCH/DELETE /keys` | Supabase JWT | [OpenAPI](./openapi.yaml) |
| Nessie RAG | `POST /nessie/query` | API key + x402 | [OpenAPI](./openapi.yaml) |
| CLE compliance | `GET /cle/verify`, `GET /cle/credits`, `POST /cle/record` | API key + x402 | [OpenAPI](./openapi.yaml) |
| Attestations | `POST/GET/PATCH /attestations` | Supabase JWT | [OpenAPI](./openapi.yaml) |

### 2. API v2 — `https://api.arkova.ai/v2`

Agent-ready REST surface for search, post-search resource detail, fingerprint verification, public anchor lookup, and organization context. API v2 uses scoped API keys and RFC 7807 `application/problem+json` errors.

| Scope | Default quota | Endpoints |
|---|---:|---|
| `read:search` | 1,000 req/min | `/search`, `/organizations`, `/records`, `/fingerprints`, `/documents` search aliases |
| `read:records` | 500 req/min | `/verify/{fingerprint}`, `/anchors/{public_id}`, `/records/{public_id}`, `/fingerprints/{fingerprint}`, `/documents/{public_id}` |
| `read:orgs` | 500 req/min | `/orgs`, `/organizations/{public_id}` |
| `write:anchors` | 100 req/min | Reserved for v2 write endpoints |
| `admin:rules` | 50 req/min | Reserved for v2 admin endpoints |

📖 [v1 to v2 migration guide](./v2-migration.md)

### 3. TypeScript SDK — `@arkova/sdk`

A thin wrapper around the REST API. Three lines of code to anchor and verify. Includes a programmable webhooks namespace, batch verify, error handling, and x402 micropayment support.

```typescript
import { Arkova } from '@arkova/sdk';
const arkova = new Arkova({ apiKey: process.env.ARKOVA_API_KEY });
const receipt = await arkova.anchor('document content');
const result = await arkova.verify(receipt.publicId);
```

📖 [Full SDK reference](../../packages/sdk/README.md)

### 4. Python SDK — `arkova`

Typed Python 3.10+ client for the API v2 read-only surface. Install with `pip install arkova`.

```python
from arkova import Arkova

with Arkova(api_key="ak_live_...") as arkova:
    results = arkova.search("registered nurse", type="record")
```

Current methods: `search`, `verify_fingerprint`, `get_anchor`, `list_orgs`, `get_organization`, `get_record`, `get_fingerprint`, and `get_document`, with matching async methods on `AsyncArkova`. The Python SDK preserves API v2 `application/problem+json` errors, honors `Retry-After` during retries, and maps nullable rich verification fields when the API returns them.

For anchoring, webhook management, and other v1 write/admin workflows, use the REST API directly or the TypeScript SDK until equivalent v2 Python methods are published.

📖 [Full Python SDK reference](../../packages/arkova-py/README.md) and [example notebook](./arkova-py-example.ipynb)

### 5. Embeddable widget — `@arkova/embed`

A vanilla-JS, zero-dependency, CSP-safe `<script>` tag that drops a verification badge on any third-party site.

```html
<div data-arkova-credential="ARK-2026-001"></div>
<script src="https://cdn.arkova.ai/embed.js"></script>
```

📖 [Full embed reference](../../packages/embed/README.md)

### 6. MCP server — `https://edge.arkova.ai/mcp`

Model Context Protocol endpoint for AI agents. New integrations should prefer the v2 aliases `search`, `verify`, `list_orgs`, and `get_anchor`; legacy tools remain available as `verify_credential`, `search_credentials`, `nessie_query`, `anchor_document`, `verify_document`, and `verify_batch`. (A `cle_verify` tool was scoped for INT-02 but deferred — the HTTP CLE route remains available via the REST API and the SDK. Tracked as INT-02b.)

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

### 7. Webhooks (outbound) — your URL

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
| API v2 `read:records` / `read:orgs` | 500 req/min per API key per scope | v2 record and organization tools |
| API v2 `write:anchors` | 100 req/min per API key per scope | v2 write endpoints |
| API v2 `admin:rules` | 50 req/min per API key per scope | v2 admin endpoints |
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

API v2 uses RFC 7807 `application/problem+json` on every error path:

```json
{
  "type": "https://arkova.ai/problems/invalid-scope",
  "title": "Insufficient Scope",
  "status": 403,
  "detail": "This API key does not have the required scope: read:records.",
  "instance": "/api/v2/anchors/ARK-DOC-ABCDEF"
}
```

---

## Versioning policy

The `/api/v1/*` schema is **frozen**. Per [Constitution 1.8](../../CLAUDE.md#18-api-versioning):

- Additive nullable fields are allowed without bumping the version.
- Breaking changes require a `/api/v2/` prefix and a 12-month deprecation period.
- Existing fields are never renamed, removed, or have their types changed.

v1 responses now include `Deprecation: Sun, 23 Apr 2027 00:00:00 GMT; link="<https://arkova.ai/docs/v2-migration>; rel=successor-version"`. See the [migration guide](./v2-migration.md) for the full calendar.

---

## Documentation index

| File | What's in it |
|---|---|
| [`README.md`](./README.md) | This file — top-level developer docs index |
| [`v2-migration.md`](./v2-migration.md) | v1 deprecation calendar and v2 migration guide |
| [`v1-deprecation-communication-plan.md`](./v1-deprecation-communication-plan.md) | Customer email plan and SOC 2 evidence checklist |
| [`webhooks.md`](./webhooks.md) | Comprehensive webhook CRUD guide: schemas, HMAC verification (Node/Python/Go), retry policy, SSRF rules |
| [`mcp-tools.md`](./mcp-tools.md) | MCP server tool reference for AI agents |
| [`openapi.yaml`](./openapi.yaml) | Machine-readable OpenAPI 3.0 spec — all REST endpoints |

External:

- [`packages/sdk/README.md`](../../packages/sdk/README.md) — `@arkova/sdk` TypeScript SDK
- [`packages/embed/README.md`](../../packages/embed/README.md) — `@arkova/embed` embeddable widget
- [`packages/arkova-py/`](../../packages/arkova-py/) — Python SDK
- [`https://app.arkova.ai/api/docs`](https://app.arkova.ai/api/docs) — Hosted Swagger UI

---

## Recent changes

| Date | Story | What shipped |
|---|---|---|
| 2026-05-01 | SCRUM-1132 | API v2 resource detail endpoints for organizations, records, fingerprints, and documents, plus SDK/OpenAPI coverage. |
| 2026-04-24 | SCRUM-1110 | v1 deprecation calendar, migration guide, and production `Deprecation` header wiring. |
| 2026-04-24 | SCRUM-1111 | API v2 per-scope rate limits backed by Upstash Redis with documented env overrides. |
| 2026-04-24 | SCRUM-1112 | Python SDK package (`pip install arkova`) with sync/async typed clients and publish workflow. |
| 2026-04-11 | INT-09 (SCRUM-645) | Webhook CRUD via API — register, list, update, delete webhooks programmatically. Closes the API-only loop. |
| 2026-04-11 | INT-01 (SCRUM-642) | TypeScript SDK extended with `verifyBatch` + full `webhooks` namespace + enriched `ArkovaError`. |
| 2026-04-11 | INT-03 (SCRUM-644) | Embeddable verification bundle (`@arkova/embed`) — vanilla JS, single script tag. |
| 2026-04-11 | INT-02 (SCRUM-643) | MCP server tool added: `verify_batch`. Total: 6 tools. (`cle_verify` deferred to INT-02b.) |
