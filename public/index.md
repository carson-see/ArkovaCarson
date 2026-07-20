# Arkova

Arkova is a privacy-first verification platform for credentials, records, and
documents. Public verification confirms whether an Arkova record is active,
revoked, superseded, expired, or unknown without exposing the original file.

## Agent entry points

- API catalog: <https://app.arkova.ai/.well-known/api-catalog>
- OpenAPI 3.1: <https://api.arkova.ai/v2/openapi.json>
- API documentation: <https://app.arkova.ai/developers>
- MCP server: <https://edge.arkova.ai/mcp>
- MCP server card: <https://app.arkova.ai/.well-known/mcp/server-card.json>
- Agent skills: <https://app.arkova.ai/.well-known/agent-skills/index.json>
- Authentication instructions: <https://app.arkova.ai/auth.md>

## Public verification

Open `https://app.arkova.ai/verify/{public_id}` to verify a record by its public
identifier. Protected API and MCP operations require a scoped Arkova API key or
an approved bearer token.

## Privacy

Arkova verification responses expose public-safe metadata only. Original files
remain with their holder and are not returned by the verification API.
