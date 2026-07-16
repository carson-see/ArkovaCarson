# Arkova AI Agent Integration

> Guide for AI agents, ATS systems, and automated verification tools to integrate with Arkova.

## MCP Server

Arkova exposes a Model Context Protocol (MCP) server for AI agent access to credential verification and semantic search.

**Endpoint:** `https://edge.arkova.ai/mcp`

### Connection

Connect using any MCP-compatible client (Claude, Cursor, custom agents):

```json
{
  "mcpServers": {
    "arkova": {
      "url": "https://edge.arkova.ai/mcp",
      "transport": "streamable-http"
    }
  }
}
```

### Authentication

Agent access uses a scoped API key or an approved user-delegated bearer token:

1. Provision a scoped key at `https://app.arkova.ai/settings/api-keys`
2. Obtain an API key
3. Pass the key via `X-API-Key` header or OAuth bearer token

## Discovery Documents

The application publishes machine-readable discovery resources at:

- `/.well-known/api-catalog` — RFC 9727 linkset for API and MCP surfaces
- `/.well-known/openid-configuration` — redirect to the canonical production OIDC issuer
- `/.well-known/oauth-protected-resource` — RFC 9728 protected-resource metadata
- `/.well-known/mcp/server-card.json` — remote MCP server card
- `/.well-known/agent-skills/index.json` — Agent Skills Discovery v0.2.0 index
- `/auth.md` — administrator-mediated API-key provisioning and OIDC instructions

Requests to `/` with `Accept: text/markdown` receive `/index.md`; browser requests
continue to receive the React application. `vercel.json` owns the response Link
headers, media types, conditional rewrite, caching, and CORS for these files.

## Available Tools

### `verify_credential`

Verify a credential's authenticity and current status by its public identifier.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "public_id": {
      "type": "string",
      "description": "The credential's public identifier (e.g., ARK-2026-001)"
    }
  },
  "required": ["public_id"]
}
```

**Returns:** Verification status including issuer, credential type, dates, and network anchoring proof.

### `search_credentials`

Search for credentials using natural language queries. Uses semantic similarity matching against the credential database.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Natural language search query (e.g., 'University of Michigan computer science degree')"
    },
    "max_results": {
      "type": "number",
      "description": "Maximum number of results to return (default: 10, max: 50)"
    }
  },
  "required": ["query"]
}
```

**Returns:** Ranked list of matching credentials with verification status and relevance scores.

## Usage Examples

### Verify a specific credential
```
Tool: verify_credential
Input: { "public_id": "ARK-2026-001" }
```

### Search for credentials from a specific institution
```
Tool: search_credentials
Input: { "query": "Stanford University computer science master's degree 2025" }
```

### Bulk verification workflow
```
1. Use search_credentials to find matching credentials
2. For each result, use verify_credential with the public_id
3. Check the "status" field: ACTIVE = valid, REVOKED/EXPIRED = invalid
```

## Rate Limits

| Tier | Limit |
|------|-------|
| Free API key | 1,000 req/min |
| Enterprise | Custom |
| Anonymous | 100 req/min per IP |

## Privacy

- Arkova never returns raw PII. Recipient identifiers are always hashed.
- Documents never leave the holder's device. Only cryptographic fingerprints are stored.
- The `jurisdiction` field is informational metadata — Arkova does not verify jurisdiction correctness.
