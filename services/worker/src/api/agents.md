# agents.md — services/worker/src/api/

_Last updated: 2026-05-16_

## What This Folder Contains

Express route handlers for the worker's HTTP API. Covers admin endpoints, anchor operations, proof packets, audit events, compliance, rules CRUD, treasury, and the v1/v2 versioned sub-APIs.

| File | Purpose |
|------|---------|
| `_org-auth.ts` | Shared org-auth helpers for service_role handlers (single source of truth for org_id scoping) |
| `anchor-lineage.ts` | Anchor parent/child lineage traversal endpoint |
| `anchor-revoke.ts` | Anchor revocation endpoint |
| `verify-anchor.ts` | Public anchor verification endpoint |
| `proof-packet.ts` | Proof package generation (Bitcoin TX + metadata + timestamps) |
| `proof-keys.ts` | Proof signing key management |
| `audit-event.ts` | Audit event creation and query |
| `admin-stats.ts` / `admin-lists.ts` / `admin-pipeline-stats.ts` | Admin dashboard data endpoints |
| `admin-actions.ts` / `admin-health.ts` | Admin action + health check endpoints |
| `rules-crud.ts` / `rules-draft.ts` | Rules engine CRUD and draft management |
| `queue-resolution.ts` | Review queue resolution endpoint |
| `rules-templates.ts` | Public rules templates discovery endpoint (SCRUM-1973) |
| `version-resolution.ts` | Version conflict resolution API — list/resolve for org admins (SCRUM-1971) |
| `recipients.ts` | Credential recipient management |
| `treasury.ts` | Treasury balance and fee account endpoints |
| `apiScopes.ts` | API key scope definitions and validation |
| `account-delete.ts` / `account-export.ts` | GDPR account deletion and data export |
| `collision-context.ts` | Fingerprint collision context endpoint |
| `compliance-inbox-summary.ts` | Compliance inbox summary aggregation |
| `connector-health.ts` | Integration connector health status |
| `demo-event-injector.ts` | Demo/test event injection (non-production) |
| `notifications.ts` | Notification delivery endpoint |
| `rpc-error-status.ts` | RPC error → HTTP status code mapping |
| `v1/` / `v2/` | Versioned API sub-routers |

## Do / Don't Rules

- **DO** scope every cross-tenant write by `org_id` using `_org-auth.ts` helpers
- **DO NOT** expose `user_id`, `org_id`, or `anchors.id` publicly — use `public_id` only
- **DO NOT** set `anchor.status = 'SECURED'` from client code — worker-only via service_role
