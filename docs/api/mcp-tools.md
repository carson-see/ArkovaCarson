# Arkova MCP Server — Tool Reference

> **Status:** Production | **Story:** [INT-02 / SCRUM-643](https://arkova.atlassian.net/browse/SCRUM-643) | **Endpoint:** `https://edge.arkova.ai/mcp`

The Arkova [Model Context Protocol](https://modelcontextprotocol.io) server exposes ten tools that let AI agents (Claude, LangChain, AutoGen, custom agents) verify credentials, anchor documents, and query verified public records — all without writing HTTP requests. SCRUM-1107 adds the v2 agent aliases (`search`, `verify`, `list_orgs`, `get_anchor`) that match the OpenAPI 3.1 operation IDs published at `https://api.arkova.ai/v2/openapi.json`.

This is the verification layer for the agentic economy. Same infrastructure as the REST API; just exposed through the MCP transport so any tool-using LLM can call it natively.

---

## Connection

**Transport:** Streamable HTTP (`@modelcontextprotocol/sdk`'s `WebStandardStreamableHTTPServerTransport`)

**Endpoint:** `https://edge.arkova.ai/mcp`

**Discovery:** `https://edge.arkova.ai/.well-known/mcp.json`

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
| 1 | **`search`** | **Agent-friendly v2 search across orgs, records, fingerprints, and documents** | **SCRUM-1107** |
| 2 | **`verify`** | **Verify a SHA-256 document fingerprint** | **SCRUM-1107** |
| 3 | **`list_orgs`** | **List org context for the authenticated caller** | **SCRUM-1107** |
| 4 | **`get_anchor`** | **Fetch redacted public anchor metadata by public ID** | **SCRUM-1107** |
| 5 | `verify_credential` | Verify a single credential by public ID | P8-S19 |
| 6 | `search_credentials` | Semantic search across credentials | P8-S19 |
| 7 | `nessie_query` | RAG query over verified public records | PH1-SDK-03 |
| 8 | `anchor_document` | Submit a SHA-256 fingerprint for anchoring | PH1-SDK-03 |
| 9 | `verify_document` | Verify a document by its fingerprint | PH1-SDK-03 |
| 10 | **`verify_batch`** | **Verify up to 100 credentials in one call** | **INT-02** |

> **CLE compliance tool deferred:** `cle_verify` was scoped for INT-02 but pulled before merge — the underlying `rpc/cle_verify` does not exist in the schema. The HTTP route at `/api/v1/cle/verify` is live and usable via the REST API or `@arkova/sdk`. Tracked as follow-up **INT-02b** (expose it through MCP by threading caller API keys through the edge handler context).

All tool responses follow the MCP convention:

```json
{ "content": [{ "type": "text", "text": "<JSON-encoded payload>" }] }
```

When an error occurs, the response also includes `"isError": true`.

---

## v2 Agent Aliases

The aliases below are intentionally named like OpenAPI function-call operations. Prefer them for new agent integrations; the legacy tool names remain stable for existing clients.

### `search`

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

### `verify`

Input:

| Field | Type | Required | Description |
|---|---|:---:|---|
| `fingerprint` | string | yes | 64-character SHA-256 document fingerprint |

### `list_orgs`

No input fields. Returns the caller's organization context as derived from the authenticated user and `org_members`.

### `get_anchor`

Input:

| Field | Type | Required | Description |
|---|---|:---:|---|
| `public_id` | string | yes | Arkova public ID, for example `ARK-DOC-ABCDEF` |

---

## 1. `verify_credential`

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

> "Use the verify_credential tool to check ARK-2026-001 and tell me if it's still valid."

---

## 2. `search_credentials`

Semantic search across all anchored credentials. Returns ranked results with verification status and relevance scores.

### Input

| Field | Type | Required | Description |
|---|---|:---:|---|
| `query` | string | ✅ | Natural language query |
| `max_results` | number | ❌ | Default 10, max 50 |

### Output (success)

```json
{
  "query": "University of Michigan computer science",
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

## 3. `nessie_query`

Query Arkova's verified intelligence engine — semantic search over 1.4M+ anchored public records (SEC filings, patents, regulatory documents). Two modes:

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

## 4. `anchor_document`

Submit a document's SHA-256 fingerprint to the public ledger. The document itself is never sent — only its fingerprint.

### Input

| Field | Type | Required | Description |
|---|---|:---:|---|
| `content_hash` | string | ✅ | SHA-256 fingerprint (64 lowercase hex chars) |
| `record_type` | string | ❌ | E.g. `patent_grant`, `10-K`, `regulatory_notice` |
| `source` | string | ❌ | E.g. `edgar`, `uspto`, `federal_register` |
| `title` | string | ❌ | Document title |
| `source_url` | string | ❌ | URL of the original document |

### Output

```json
{
  "status": "submitted",
  "record_id": "uuid",
  "public_id": "ARK-2026-001",
  "content_hash": "abc123...",
  "message": "Document fingerprint submitted for batch anchoring. Check status with verify_document."
}
```

---

## 5. `verify_document`

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

---

## 6. `verify_batch` 🆕 INT-02

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

### Why a separate tool from `verify_credential`?

Calling `verify_credential` 100 times in a loop creates 100 turns of agent overhead (100 prompt re-evaluations, 100 tool dispatches, 100 result-parsing steps). `verify_batch` collapses that to **one** turn — far cheaper for the model and far faster wall-clock. Use `verify_batch` whenever you have a known list of IDs.

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
| `verify_credential`, `verify_document`, `anchor_document` | 1,000 req/min |
| `search_credentials`, `nessie_query` | 30 req/min (AI-rate-limited) |
| `verify_batch` | 10 req/min (batch tier) |

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
      "name": "verify_credential",
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
      "name": "verify_batch",
      "arguments": { "public_ids": ["ARK-2026-001", "ARK-2026-002"] }
    }
  }'

```

> CLE compliance lookup is available via the REST API today (see [`/api/v1/cle/verify`](./openapi.yaml)) and the [`@arkova/sdk`](../../packages/sdk/README.md). It will be exposed through MCP in a follow-up (INT-02b).

---

## Changelog

| Version | Date | Story | Change |
|---|---|---|---|
| v1.1 | 2026-04-11 | INT-02 (SCRUM-643) | Added `verify_batch` tool (cle_verify deferred to INT-02b) |
| v1.0 | 2026-03-22 | PH1-SDK-03 | Added `nessie_query`, `anchor_document`, `verify_document` |
| v0.9 | 2026-03-08 | P8-S19 | Initial release with `verify_credential` + `search_credentials` |

---

## Related documentation

- [Webhooks developer guide](./webhooks.md)
- [API docs index](./README.md)
- [@arkova/sdk](../../packages/sdk/README.md) — TypeScript SDK
- [@arkova/embed](../../packages/embed/README.md) — Embeddable widget
