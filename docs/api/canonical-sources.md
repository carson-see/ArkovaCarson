# Arkova API Engineering Source Map

> Status: Engineering mirror/index | Stories: SCRUM-1584, SCRUM-1585

This page maps the repository files that implement and mirror the current API behavior. It does not replace Arkova's product/documentation policy: Confluence remains the documentation source of truth, every backlog item must exist in `docs/BACKLOG.md`, and detailed story artifacts must live in `docs/stories/*` when a story exists.

Use this page as an engineering index for code review and drift checks. If code behavior changes, update the implementation, repo mirror, Confluence source page, and relevant backlog/story artifacts together.

## API Contract Engineering Mirrors

| Surface | Repo mirror or implementation | Notes |
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

## Redirect-Only Or Historical Repo Artifacts

| Path or page | Status | Replacement |
|---|---|---|
| `packages/python-sdk/README.md` | Redirect-only; package body removed. | `packages/arkova-py` |
| `sdks/python/README.md` | Redirect-only; package body removed. | `packages/arkova-py` |
| `docs/guides/API_GUIDE.md` | Historical March 2026 setup guide. | `docs/api/README.md` |
| `docs/guides/Arkova_API_Guide.docx` | Historical exported copy of the old setup guide. | `docs/api/README.md` |
| Root roadmap/backlog `.docx` files | Historical planning exports in this repo; not API implementation. | Confluence/Jira plus current repo mirrors |
| Confluence `API Changelog` page | Source-of-truth page may need updates when repo mirrors change. | Keep aligned with this PR's API docs and release notes |
| Confluence `SCRUM-1049 - API-V2 ... AUDIT` pages | Audit/planning evidence. | Keep linked from Jira/story artifacts |
| Confluence `API-V2-07 - v1 -> v2 deprecation calendar` | Historical plan; contains stale host/spec claims. | `docs/api/v1-deprecation-communication-plan.md`, `docs/api/v2-migration.md`, and Confluence update |

## SCRUM-1584 SDK Contract Decision

Arkova does not currently have an SDK generation toolchain in this repository. There is no checked-in OpenAPI generator, orval, swagger-codegen, or openapi-typescript workflow.

SCRUM-1584 is satisfied by the contract-tested SDK path rather than generated SDKs. This is not a deferred cleanup item: for the current API v2 read-only surface, generated SDKs would add another artifact with no owner and no stable write/admin surface to amortize the tooling cost.

The accepted SDK contract strategy is:

- TypeScript SDK tests assert v2 request paths, rich verification fields, `application/problem+json`, and `Retry-After` behavior.
- Python SDK tests assert the same behavior for sync and async clients.
- `npm run ci:api-contract-drift` prevents duplicate SDK package bodies and generated planning artifacts from returning.
- Worker tests pin OpenAPI operation IDs, MCP aliases, SDK method names, and canonical workflow docs.

If Arkova later wants generated SDKs, that is a new product/engineering decision with explicit generator ownership, not unfinished acceptance criteria for SCRUM-1584.

## Maintenance Rules

1. New API behavior must update the route, OpenAPI source, SDK tests, and the relevant `docs/api/*` page in the same PR.
2. New API key scopes must update `services/worker/src/api/apiScopes.ts`, agent delegation validation, frontend labels, and the SQL CHECK migration.
3. Historical docs should receive a clear redirect note instead of being silently edited to look current.
4. Do not add generated `.docx`, cache folders, SDK copies, or temporary worktree output to normal source paths.
