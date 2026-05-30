# agents.md — services/worker/src/api/

_Last updated: 2026-05-30 (SCRUM-2213 queue/pending auth.uid()-via-service-role fix)_

## 2026-05-30 RPCs that read `auth.uid()` fail when called from the worker (SCRUM-2213)

- `handleListPendingResolution` (`queue-resolution.ts`) called RPC `list_pending_resolution_anchors_v2`, which resolves the caller via `SELECT … FROM profiles WHERE id = auth.uid()` and raises `'Profile not found'` otherwise. But the worker invokes RPCs through the **service-role** `db` client, where `auth.uid()` is **NULL** → the RPC raised on every call → `/api/queue/pending` returned **500** every time (Review Queue page hung on "Loading…"). A perfect index (`idx_anchors_org_status_created`) existed, so it was never a timeout — purely an auth-context mismatch.
- **Rule:** never call an `auth.uid()`-dependent RPC from the worker's service-role client. Resolve the caller's org from the authenticated userId (passed by the route via `extractAuthUserId`) and query org-scoped directly, or pass an explicit `p_user_id` into the RPC. Fix: the handler now takes `callerUserId`, resolves `profiles.org_id`, queries `anchors` org-scoped (`.eq('org_id', …).eq('status','PENDING_RESOLUTION')`), and computes `sibling_count` in TS — no `auth.uid()` dependency and no exact-count scan (the R0-8 planner-safe rule).

## 2026-05-29 Phantom-column filters silently zero out counts (SCRUM-1984)

- `admin-stats.ts` filtered `.is('deleted_at', null)` on `organizations`, which has **no** `deleted_at` column. PostgREST does not throw on a filter against a missing column — it resolves with `{ count: null, error: <column missing> }`. Under `Promise.allSettled` the promise is *fulfilled* (carrying the error), so `val(i)?.count ?? 0` collapsed to `0` and Total Orgs always showed 0 despite real orgs existing.
- Before filtering soft-deletes, confirm the table actually has `deleted_at`. `organizations` soft-deletes via `suspended`, not `deleted_at` (CLAUDE.md §1.2). `profiles` and `anchors` do have `deleted_at`.

## 2026-05-22 Anchor Write Scope Compatibility

- `apiScopes.ts` treats `anchor:write` and `write:anchors` as equivalent write-capable anchor scopes. Keep this central in `scopeSatisfies()` instead of duplicating route-specific aliases.

## What This Folder Contains

Express route handlers for the worker's HTTP API. Covers admin endpoints, anchor operations, proof packets, audit events, compliance, rules CRUD, treasury, and the v1/v2 versioned sub-APIs.

| File | Purpose |
|------|---------|
| `_org-auth.ts` | Shared org-auth helpers for service_role handlers (single source of truth for org_id scoping) |
| `badge.ts` | Public `/api/badge/:publicId` SVG endpoint; resolves status from `get_public_anchor` and fails closed for unknown states |
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
