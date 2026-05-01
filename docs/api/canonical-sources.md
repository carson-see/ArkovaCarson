# Arkova API Canonical Sources

> Status: Canonical source map | Stories: SCRUM-1584, SCRUM-1585

This page defines which API documents and SDK paths are authoritative. Anything listed as historical can be useful background, but must not be treated as the current API contract.

## Canonical API Contract

| Surface | Canonical source | Notes |
|---|---|---|
| API documentation index | `docs/api/README.md` | Entry point for developer-facing API docs. |
| API v1 OpenAPI | `docs/api/openapi.yaml` | Frozen v1 REST contract and Swagger import source. |
| API v2 OpenAPI | `services/worker/src/api/v2/openapi.ts` and `/api/v2/openapi.json` | Machine-readable v2 agent contract. |
| API v2 migration | `docs/api/v2-migration.md` | Human migration guide for v1 to v2. |
| Agent workflow | `docs/api/agent-workflows.md` | Canonical call order for REST v2, MCP, TypeScript, and Python. |
| MCP tools | `docs/api/mcp-tools.md` plus `services/edge/server.json` | Human reference plus live MCP manifest. |
| Webhooks | `docs/api/webhooks.md` | Canonical outbound webhook guide. |
| API key scopes | `services/worker/src/api/apiScopes.ts` | Source of truth for worker, frontend display, and SQL CHECK migration. |
| TypeScript SDK | `packages/sdk` | Canonical TypeScript package. |
| Python SDK | `packages/arkova-py` | Canonical Python package published as `arkova`. |

## Historical Or Redirect-Only

| Path or page | Status | Replacement |
|---|---|---|
| `packages/python-sdk/README.md` | Redirect-only; package body removed. | `packages/arkova-py` |
| `sdks/python/README.md` | Redirect-only; package body removed. | `packages/arkova-py` |
| `docs/guides/API_GUIDE.md` | Historical March 2026 setup guide. | `docs/api/README.md` |
| `docs/guides/Arkova_API_Guide.docx` | Historical exported copy of the old setup guide. | `docs/api/README.md` |
| Root roadmap/backlog `.docx` files | Historical planning artifacts, not API contract. | Jira plus `docs/api/*` for API docs |
| `docs/stories/*` | Historical backlog/story archive. | Jira for live status, `docs/api/*` for current API behavior |
| Confluence `API Changelog` page | Historical planning/changelog page as of 2026-04-16. | This repo's `docs/api/*` and release PRs |
| Confluence `SCRUM-1049 - API-V2 ... AUDIT` pages | Audit/planning evidence. | This repo's `docs/api/*` and Jira issue status |
| Confluence `API-V2-07 - v1 -> v2 deprecation calendar` | Historical plan; contains stale host/spec claims. | `docs/api/v1-deprecation-communication-plan.md` and `docs/api/v2-migration.md` |

## SDK Contract Strategy

Arkova does not currently have an SDK generation toolchain in this repository. There is no checked-in OpenAPI generator, orval, swagger-codegen, or openapi-typescript workflow.

For the current API v2 read-only surface, the accepted strategy is contract-tested hand-written SDKs:

- TypeScript SDK tests assert v2 request paths, rich verification fields, `application/problem+json`, and `Retry-After` behavior.
- Python SDK tests assert the same behavior for sync and async clients.
- `npm run ci:api-contract-drift` prevents duplicate SDK package bodies and generated planning artifacts from returning.
- Worker tests pin OpenAPI operation IDs, MCP aliases, SDK method names, and canonical workflow docs.

Generated SDKs should be reconsidered only when API v2 has a larger stable write/admin surface or when Arkova commits to generator ownership. Until then, adding a generator would introduce another artifact that can drift.

## Maintenance Rules

1. New API behavior must update the route, OpenAPI source, SDK tests, and the relevant `docs/api/*` page in the same PR.
2. New API key scopes must update `services/worker/src/api/apiScopes.ts`, agent delegation validation, frontend labels, and the SQL CHECK migration.
3. Historical docs should receive a clear redirect note instead of being silently edited to look current.
4. Do not add generated `.docx`, cache folders, SDK copies, or temporary worktree output to normal source paths.
