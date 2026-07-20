---
name: verify-record
description: Retrieve public-safe Arkova verification metadata for a record by public ID. Use this when a user wants to confirm a record's current status.
version: 1.0.0
---

# Verify an Arkova record

Use this skill when a user supplies an Arkova public ID and asks whether the
corresponding record is active, revoked, superseded, expired, or unknown.

## Input

- `public_id` (required): an Arkova public identifier, such as
  `ARK-DOC-ABCDEF`.

## HTTP

```http
GET /v2/anchors/{public_id}
Host: api.arkova.ai
Authorization: Bearer YOUR_ARKOVA_API_KEY
Accept: application/json
```

The API key requires the `read:records` scope. Provision a scoped key at
<https://app.arkova.ai/settings/api-keys>.

## MCP

Call `get_anchor` at <https://edge.arkova.ai/mcp> with:

```json
{ "public_id": "ARK-DOC-ABCDEF" }
```

## Safety

- Treat `REVOKED`, `SUPERSEDED`, and `EXPIRED` as non-current states.
- A current Arkova status confirms the published verification record; it does
  not independently prove that every statement in an underlying document is
  true.
- Never request or expose internal user, organization, or database identifiers.

Full schema: <https://api.arkova.ai/v2/openapi.json>
