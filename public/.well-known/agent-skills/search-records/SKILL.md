---
name: search-records
description: Search public-safe Arkova organization, record, fingerprint, and document metadata using a bounded natural-language query.
version: 1.0.0
---

# Search Arkova records

Use this skill to locate public-safe Arkova metadata before retrieving a
specific record.

## Inputs

- `q` (required): natural-language query or exact fingerprint.
- `type` (optional): `all`, `org`, `record`, `fingerprint`, or `document`.
- `limit` (optional): integer from 1 through 50.

## HTTP

```http
GET /v2/search?q={query}&type=all&limit=10
Host: api.arkova.ai
Authorization: Bearer YOUR_ARKOVA_API_KEY
Accept: application/json
```

The API key requires the `read:search` scope. Provision a scoped key at
<https://app.arkova.ai/settings/api-keys>.

## MCP

Call `search` at <https://edge.arkova.ai/mcp> with:

```json
{ "q": "licensed nurses", "type": "record", "limit": 10 }
```

Use a returned `public_id` with the `get_anchor` MCP tool or the
`verify-record` skill. Do not infer identity or authorization from similarity
ranking alone.

Full schema: <https://api.arkova.ai/v2/openapi.json>
