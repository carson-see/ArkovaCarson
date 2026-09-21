# Arkova MCP Server — Tool Reference

> **Status:** Production | **Story:** [INT-02 / SCRUM-643](https://arkova.atlassian.net/browse/SCRUM-643) | **Endpoint:** `https://edge.arkova.ai/mcp`

The Arkova [Model Context Protocol](https://modelcontextprotocol.io) server exposes sixteen default launch tools plus three conditionally registered submission-lifecycle tools. They let AI agents (Claude, LangChain, AutoGen, custom agents) verify credentials, query verified public records, organize records, submit client-computed fingerprints, import bounded spreadsheet rows, and inspect caller-scoped submission state through the same authorization checks as the REST API. SCRUM-1107 + SCRUM-1132 + SCRUM-1584 add the v2 agent aliases (`arkova_search`, `arkova_verify`, `arkova_list_orgs`, `arkova_get_anchor`, `arkova_get_organization`, `arkova_get_record`, `arkova_get_fingerprint`, `arkova_get_document`) that match the OpenAPI 3.1 operation IDs published at `https://api.arkova.ai/v2/openapi.json`.

`arkova_anchor_document`, `arkova_get_submission_status` and `arkova_import_rows` are intentionally outside the default MCP launch surface. All three are registered only when `MCP_ENABLE_ANCHOR_DOCUMENT=true` and the authenticated caller has a canonical write-capable scope (`write:anchors` or `anchor:write`). `mcp:anchor` is not a public API-key scope and is not mintable for launch keys. Folder mutations remain separately available through `arkova_manage_folders` only to callers with `anchor:write` and the exact folder/record authority checked by the REST API. When the hosted feature flag is off, callers that still hold `anchor:write` or its `write:anchors` alias can read historical submission status through the authenticated REST API, TypeScript/Python SDK status method, or API CLI; read-only callers cannot use another transport to bypass that authorization requirement.

The hosted tool name is `arkova_anchor_document`; the separately maintained npm stdio server exposes the equivalent submission operation as `arkova_submit_anchor`. Registration documents capability, not production enablement: both hosted submission tools remain absent from default discovery unless the flag and scope checks pass. The npm stdio server registers its submit and status tools independently of the hosted edge gate.

This is the verification layer for the agentic economy. Same infrastructure as the REST API; just exposed through the MCP transport so any tool-using LLM can call it natively.

---

## Connection

**Transport:** Streamable HTTP (`@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport`)

**Endpoint:** `https://edge.arkova.ai/mcp`

**Discovery:** `https://app.arkova.ai/.well-known/mcp/server-card.json` (the only discovery document that resolves; `edge.arkova.ai/.well-known/mcp.json` does not exist)

**Authentication:** `X-API-Key: ak_live_...` or `Authorization: Bearer ak_live_...`

```json
// Example MCP client config (Claude Desktop, Cline, Continue, etc.)
{
  "mcpServers": {
    "arkova": {
      "url": "https://edge.arkova.ai/mcp",
      "headers": {
        "X-API-Key": "ak_live_..."
      }
    }
  }
}
```

---

## Tool index

| # | Tool | Purpose | Story |
|---|---|---|---|
| 1 | **`arkova_search`** | **Agent-friendly v2 search across orgs, records, fingerprints, and documents** | **SCRUM-1107** |
| 2 | **`arkova_verify`** | **Verify a SHA-256 document fingerprint** | **SCRUM-1107** |
| 3 | **`arkova_list_orgs`** | **List org context for the authenticated caller** | **SCRUM-1107** |
| 4 | **`arkova_get_anchor`** | **Fetch redacted public anchor metadata by public ID** | **SCRUM-1107** |
| 5 | **`arkova_get_organization`** | **Public-safe organization detail by public_id** | **SCRUM-1132 / SCRUM-1584** |
| 6 | **`arkova_get_record`** | **Public-safe record detail by public_id** | **SCRUM-1132 / SCRUM-1584** |
| 7 | **`arkova_get_fingerprint`** | **Public-safe latest-anchor lookup by SHA-256 fingerprint** | **SCRUM-1132 / SCRUM-1584** |
| 8 | **`arkova_get_document`** | **Public-safe document detail by public_id** | **SCRUM-1132 / SCRUM-1584** |
| 9 | `arkova_verify_anchor` | Verify a single credential by public ID | P8-S19 |
| 10 | `arkova_search_anchors` | Keyword (lexical substring) search across credentials | P8-S19 |
| 11 | `nessie_query` | **DISABLED** — returns `nessie_disabled`, never results | PH1-SDK-03 |
| 12 | `arkova_verify_document` | Verify a document by its fingerprint | PH1-SDK-03 |
| 13 | **`arkova_verify_batch`** | **Verify up to 100 credentials in one call** | **INT-02** |
| 14 | `arkova_oracle_batch_verify` | Batch-verify up to 25 credentials with signed query-envelope metadata | SCRUM-1107 |
| 15 | `arkova_list_agents` | List AI agents registered to the caller's organization | SCRUM-1107 |
| 16 | **`arkova_manage_folders`** | **List and manage nested personal or organization record folders** | **SCRUM-5142** |
| 17 | **`arkova_get_submission_status`** | **Read caller-scoped durable queue/instant state; hosted edge registration is conditional on the same flag and write scope as submission** | **UAT-12** |
| 18 | `arkova_anchor_document` | Submit a client-computed fingerprint; hosted edge registration is conditional on `MCP_ENABLE_ANCHOR_DOCUMENT=true` plus `write:anchors` or `anchor:write` | UAT-12 |
| 19 | **`arkova_import_rows`** | **Import up to 100 client-computed spreadsheet rows in one call (`queue` or `instant`); hosted edge registration is conditional on the same flag and write scope as submission** | **UAT-23 / SCRUM-5265** |

> **CLE compliance tool deferred:** `cle_verify` was scoped for INT-02 but pulled before merge — the underlying `rpc/cle_verify` does not exist in the schema. The HTTP route at `/api/v1/cle/verify` is live and usable via the REST API or `arkova`. Tracked as follow-up **INT-02b** (expose it through MCP by threading caller API keys through the edge handler context).

### `arkova_manage_folders`

Uses the same authenticated `/api/v1/folders` routes as the app and SDKs. The
`action` is `list`, `create`, `update`, `bind_connector`, `delete`, or
`bulk_move`. Folder mutations require `anchor:write`; listing requires
`anchor:read`. An organization API key stays bounded to its key organization,
including when its issuer owns unrelated personal or other-organization rows.
Globally personal folders have no `context_org_id` and remain owner-private;
authorized administrators can view personal folders only when the folder has an
explicit approved organization context.

Bulk moves accept one to 100 internal `anchor_ids` or API-visible
`record_public_ids`, preserve the caller's identifier in each outcome, and keep successful rows when other
rows fail, and return partial results inside the MCP tool response. Omit
`folder_id` to move records to Unfiled. Connector bindings require `provider`,
`source_id`, and an active same-scope `connection_id`; omit the three values to
clear a binding.

All tool responses follow the MCP convention:

```json
{ "content": [{ "type": "text", "text": "<JSON-encoded payload>" }] }
```

When an error occurs, the response also includes `"isError": true`.

---

## v2 Agent Aliases

The aliases below are intentionally named like OpenAPI function-call operations. Prefer them for new agent integrations; the legacy tool names remain stable for existing clients.

### `arkova_search`

Input:

| Field | Type | Required | Description |
|---|---|:---:|---|
| `q` | string | yes | Natural language query or exact SHA-256 fingerprint |
| `type` | `all`, `org`, `record`, `fingerprint`, `document` | no | Default `all` |
| `limit` | number | no | Default 50, max 50. Matches the RPC-backed search ceiling |
| `max_results` | number | no | Deprecated compatibility alias for older MCP prompts; prefer `limit` |

Example:

```json
{ "q": "Acme compliance certificate", "type": "document", "limit": 5 }
```

### `arkova_verify`

Input:

| Field | Type | Required | Description |
|---|---|:---:|---|
| `fingerprint` | string | yes | 64-character SHA-256 document fingerprint |

### `arkova_list_orgs`

No input fields. Returns the caller's organization context as derived from the authenticated user and `org_members`.

### `arkova_get_anchor`

Input:

| Field | Type | Required | Description |
|---|---|:---:|---|
| `public_id` | string | yes | Arkova public ID, for example `ARK-DOC-ABCDEF` |

---

## 1. `arkova_verify_anchor`

Verify the authenticity and current status of a single credential by its public identifier.

### Input

| Field | Type | Required | Description |
|---|---|:---:|---|
| `public_id` | string | ✅ | Credential public ID, e.g. `ARK-2026-001` |

### Output (success)

```json
{
  "verified": true,
  "status": "ACTIVE",
  "issuer_name": "University of Michigan",
  "recipient_identifier": "abc123...",
  "credential_type": "DEGREE",
  "issued_date": "2025-05-15",
  "expiry_date": null,
  "anchor_timestamp": "2026-04-11T10:30:00.000Z",
  "network_receipt_id": "tx-abcdef...",
  "record_uri": "https://app.arkova.ai/verify/ARK-2026-001",
  "jurisdiction": "MI"
}
```

`status` is one of `ACTIVE | REVOKED | SUPERSEDED | EXPIRED | UNKNOWN`. The `jurisdiction` field is omitted when null (frozen API contract).

### Example agent prompt

> "Use the arkova_verify_anchor tool to check ARK-2026-001 and tell me if it's still valid."

---

## 2. `arkova_search_anchors`

Keyword search across anchored credentials.

**The served behaviour is lexical** (BUG-026): a case-insensitive substring
match on credential title/description, with no relevance score and no
understanding of meaning. A query matches only text that literally appears in
the record — so an English paraphrase of a document will find nothing, while a
non-word fragment of a longer word (`aten` → `Patent_Application_AI_Method.pdf`)
will match.

Semantic (vector) similarity is served **only when** the deployment has semantic
search enabled and reachable. It is not guaranteed, and callers must not assume
it: with the gate closed the worker answers `503 Semantic search is not
currently enabled` and the tool degrades to the lexical path.

Every result carries `search_mode` — `lexical_substring` or `semantic_vector`.
**Read it before presenting results as semantically ranked.** Only the
`semantic_vector` path carries a `similarity` score.

### Input

| Field | Type | Required | Description |
|---|---|:---:|---|
| `query` | string | ✅ | Keyword query. Literal substring; keep it short |
| `max_results` | number | ❌ | Default 10, max 50 |

### Output (success)

```json
{
  "query": "University of Michigan",
  "search_mode": "lexical_substring",
  "total": 3,
  "results": [
    {
      "rank": 1,
      "public_id": "ARK-2026-007",
      "title": "Computer Science PhD",
      "credential_type": "DEGREE",
      "status": "ACTIVE",
      "anchor_timestamp": "2026-04-11T...",
      "record_uri": "https://app.arkova.ai/verify/ARK-2026-007"
    }
  ]
}
```

---

## 3. `nessie_query` — **DISABLED**

> **Status: disabled and not served.** CTO ruling R-1 (2026-08-12). Nessie is
> permanently disabled by standing founder directive.
>
> The endpoint (`GET /api/v1/nessie/query`) and this MCP tool both fail
> **closed**: they answer `503` with
> `{"error":"capability_disabled","code":"nessie_disabled","enabled":false, …}`.
> That response is **not** an empty result — no query is executed. Do not read
> an absent answer from this tool as "no matching documents exist".
>
> Previously the endpoint was mounted with no capability check and returned
> `200 {"results":[],"count":0}` (and, in `context` mode, a fluent
> `{"answer":"No relevant verified documents were found…","confidence":0}`), so
> "disabled" and "found nothing" were indistinguishable. That is the defect
> BUG-008/BUG-027 records.

The two modes below are documented for reference only; neither is currently
reachable.

- `retrieval` (default): raw ranked documents with anchor proofs
- `context`: Gemini-synthesized answer with citations linking back to anchored documents

### Input

| Field | Type | Required | Description |
|---|---|:---:|---|
| `query` | string | ✅ | Natural language query |
| `mode` | `"retrieval"` \| `"context"` | ❌ | Default `retrieval` |
| `limit` | number | ❌ | Default 10, max 50 |

### Output (retrieval)

```json
{
  "results": [
    {
      "record_id": "...",
      "source": "edgar",
      "source_url": "https://sec.gov/filing/...",
      "record_type": "10-K",
      "title": "Apple 2025 Annual Report",
      "relevance_score": 0.92,
      "anchor_proof": { "chain_tx_id": "tx-...", "content_hash": "..." }
    }
  ]
}
```

### Output (context)

```json
{
  "answer": "Apple reported $394 billion in revenue in 2025...",
  "citations": [{ "title": "...", "anchor_proof": { ... }, "excerpt": "..." }],
  "confidence": 0.88,
  "model": "gemini-2.5-flash"
}
```

> Every citation links back to a network-anchored source document, so agents can verify the model didn't hallucinate.

---

## 4. `arkova_anchor_document` — gated write tool

`arkova_anchor_document`, `arkova_get_submission_status` and `arkova_import_rows` are not exposed by the default public MCP launch manifest. They are gated tools for controlled write-capable deployments only. To expose any of these hosted tools, operators must set `MCP_ENABLE_ANCHOR_DOCUMENT=true` and authenticate with a caller whose auth result includes `write:anchors` or `anchor:write`.

When enabled, it submits a document's SHA-256 fingerprint to the public ledger. The document itself is never sent — only its fingerprint.

### Input

| Field | Type | Required | Description |
|---|---|:---:|---|
| `content_hash` | string | ✅ | SHA-256 fingerprint (64 lowercase hex chars) |
| `record_type` | string | ❌ | E.g. `patent_grant`, `10-K`, `regulatory_notice` |
| `source` | string | ❌ | E.g. `edgar`, `uspto`, `federal_register` |
| `title` | string | ❌ | Document title |
| `source_url` | string | ❌ | URL of the original document |
| `idempotency_key` | UUID string | ❌ | Client-supplied retry key for 5-minute dedupe |

### Output

```json
{
  "status": "submitted",
  "record_id": "uuid",
  "public_id": "ARK-2026-001",
  "content_hash": "abc123...",
  "message": "Document fingerprint submitted for batch anchoring. Check status with arkova_verify_document."
}
```

---

## 5. `arkova_verify_document`

Verify a document by its SHA-256 fingerprint. Returns the anchor proof if found.

### Input

| Field | Type | Required | Description |
|---|---|:---:|---|
| `content_hash` | string | ✅ | SHA-256 fingerprint to verify |

### Output

```json
{
  "verified": true,
  "status": "ANCHORED",
  "public_id": "ARK-DOC-...",
  "record_id": "uuid",
  "content_hash": "abc123...",
  "anchor_proof": {
    "chain_tx_id": "tx-...",
    "merkle_root": "...",
    "content_hash": "abc123...",
    "anchored_at": "2026-04-11T..."
  }
}
```

> **Note** — The agent-friendly `arkova_get_fingerprint` alias returns the same shape **without `record_id`** (it is the internal `public_records.id` UUID and never appears on the public-safe agent surface).

---

## 6. `arkova_verify_batch` 🆕 INT-02

Verify multiple credentials in a single call. Accepts up to 100 public IDs and returns each result in input order. Use this when an agent needs to validate a list of credentials (e.g., a candidate portfolio, a screening pipeline batch, an audit sample).

### Input

| Field | Type | Required | Description |
|---|---|:---:|---|
| `public_ids` | string[] | ✅ | Array of credential public IDs (max 100) |

### Output

```json
{
  "total": 3,
  "results": [
    {
      "public_id": "ARK-2026-001",
      "verified": true,
      "status": "ACTIVE",
      "issuer_name": "University of Michigan",
      "credential_type": "DEGREE",
      "issued_date": "2025-05-15",
      "expiry_date": null,
      "anchor_timestamp": "2026-04-11T10:30:00.000Z",
      "network_receipt_id": "tx-abcdef...",
      "record_uri": "https://app.arkova.ai/verify/ARK-2026-001"
    },
    {
      "public_id": "ARK-2026-missing",
      "verified": false,
      "error": "HTTP 404"
    },
    {
      "public_id": "ARK-2026-003",
      "verified": false,
      "status": "REVOKED",
      "issuer_name": "Stanford",
      "credential_type": "CERTIFICATE",
      "anchor_timestamp": "2026-04-11T..."
    }
  ]
}
```

### Errors

| Condition | Result |
|---|---|
| `public_ids` empty | `isError: true` — "must be a non-empty array" |
| `public_ids` > 100 | `isError: true` — "at most 100 public_ids per call" |
| Any id is empty/whitespace | `isError: true` — "must be a non-empty string" |
| Individual lookup fails | Single result has `verified: false` + `error` field; batch overall succeeds |

### Example agent prompt

> "Verify these candidate credentials in one batch: ARK-2026-001, ARK-2026-002, ARK-2026-003. Then tell me which are revoked."

### Why a separate tool from `arkova_verify_anchor`?

Calling `arkova_verify_anchor` 100 times in a loop creates 100 turns of agent overhead (100 prompt re-evaluations, 100 tool dispatches, 100 result-parsing steps). `arkova_verify_batch` collapses that to **one** turn — far cheaper for the model and far faster wall-clock. Use `arkova_verify_batch` whenever you have a known list of IDs.

---

## Error format

All tool failures follow MCP's error convention:

```json
{
  "content": [{ "type": "text", "text": "Error: <message>" }],
  "isError": true
}
```

Agents should check `isError` before parsing `content[0].text` as JSON.

---

## Rate limits

Tool calls share the per-API-key rate limits with the REST API:

| Tool | Limit |
|---|---|
| `arkova_verify_anchor`, `arkova_verify_document` | 1,000 req/min |
| `arkova_anchor_document` | Gated write tool; not exposed in default launch manifest |
| `arkova_search_anchors`, `nessie_query` | 30 req/min (AI-rate-limited) |
| `arkova_verify_batch` | 10 req/min (batch tier) |

Rate limit responses include `Retry-After`. Agents should back off and retry.

---

## Privacy and security

- No raw PII in tool responses — `recipient_identifier` is always a hash.
- Tools call the public verification API; nothing bypasses RLS.
- Document content never leaves your machine — only the SHA-256 fingerprint is submitted.
- Tool calls are logged to `audit_events` for compliance.

---

## Testing your integration

```bash
# Verify one credential
curl -X POST https://edge.arkova.ai/mcp \
  -H "X-API-Key: ak_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "arkova_verify_anchor",
      "arguments": { "public_id": "ARK-2026-001" }
    }
  }'

# Batch verify
curl -X POST https://edge.arkova.ai/mcp \
  -H "X-API-Key: ak_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "arkova_verify_batch",
      "arguments": { "public_ids": ["ARK-2026-001", "ARK-2026-002"] }
    }
  }'

```

> CLE compliance lookup is available via the REST API today (see [`/api/v1/cle/verify`](./openapi.yaml)) and the [`arkova`](../../packages/sdk/README.md). It will be exposed through MCP in a follow-up (INT-02b).

---

## Other registered tools

`arkova_oracle_batch_verify` — batch-verify up to 25 credentials with signed query-envelope metadata. Use when the consuming surface (e.g., a programmatic oracle) needs cryptographic proof of which IDs were checked at what time. Mirrors the v1 oracle batch endpoint; not part of the canonical agent v2 workflow.

`arkova_list_agents` — list AI agents registered to the authenticated caller's organization. Used by management surfaces, not part of the per-credential agent flow.

## Changelog

| Version | Date | Story | Change |
|---|---|---|---|
| v3.0 | 2026-09-02 | SCRUM-3894 | Every tool renamed with the `arkova_` prefix (`nessie_query` keeps its namespace); `verify_credential`/`search_credentials` → `arkova_verify_anchor`/`arkova_search_anchors`, no aliases — the old names caused an agent to sweep local secrets (BUG-2026-09-02-001). OAuth no longer advertised (D3); Bearer accepts ES256 via JWKS (BUG-2026-09-02-002). |
| v1.2 | 2026-05-03 | SCRUM-1132 + SCRUM-1584 | Added v2 detail aliases `get_organization`, `get_record`, `get_fingerprint`, `get_document`, plus `oracle_batch_verify` and `list_agents`. Total tools: 16. |
| v1.1 | 2026-04-11 | INT-02 (SCRUM-643) | Added `verify_batch` tool (cle_verify deferred to INT-02b) |
| v1.0 | 2026-03-22 | PH1-SDK-03 | Added `nessie_query`, `anchor_document`, `verify_document` |
| v0.9 | 2026-03-08 | P8-S19 | Initial release with `verify_credential` + `search_credentials` |

---

## Related documentation

- [Webhooks developer guide](./webhooks.md)
- [API docs index](./README.md)
- [arkova](../../packages/sdk/README.md) — TypeScript SDK
- [@arkova/embed](../../packages/embed/README.md) — Embeddable widget
