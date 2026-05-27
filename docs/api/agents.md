# docs/api/agents.md

Developer-facing API documentation. Engineering mirrors and guides for the Arkova Verification API.

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
