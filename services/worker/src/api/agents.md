# agents.md — services/worker/src/api/

_Last updated: 2026-07-21 (SCRUM-2990 partner-provisioning guard tests)_

## 2026-07-21 — Lane 2 PI-0.5: partner-provisioning skeleton is flag-gated + statically guarded (SCRUM-2990)

`partner-provisioning.ts` (pure request→approve→provision state machine, see PR #1606) is now protected by two invariants enforced in `partner-provisioning.guard.test.ts`:

- **No live provisioning / no secret handling in the skeleton.** The module's static import list must be EXACTLY `zod` + `node:crypto` (`randomUUID` only) + the type-only `./audit-event.js` — no DB client, no RPC, no fetch, no Stripe, no Secret Manager, no API-key/HMAC/proof-key modules. Its only outputs are its own record + audit event body; the API layer persists them. If you wire the provision step to real org/user/key creation, that code goes in a SEPARATE adapter module (behind the gate) — this guard is meant to go red if the skeleton itself grows side effects.
- **Flag wiring.** The reserved surface prefix `/api/partner-provisioning` must stay mounted behind `partnerProvisioningGate()` in `index.ts` (ENABLE_PARTNER_PROVISIONING, fail-closed → 404), and the flag must stay registered in `flagRegistry.ts` `DB_FLAGS`. Mount any future partner-provisioning router UNDER that prefix.

## 2026-07-06 — Lane 2 s3: OPS-03 SLO dashboard stats endpoint (SCRUM-2401)

`admin-ops-slo.ts` adds `GET /api/admin/ops-slo-stats` (`handleOpsSloStats`, platform-admin gated via the shared `isPlatformAdmin` DB-flag helper — DB never touched before the gate). Read-only rollup of FIVE SLO surfaces computed **live on every request** (deliberately NO new table/migration — the story is scoped non-migration T2): **anchorSecuredRate** (existing `get_anchor_status_counts_fast` RPC / mig 0324 cache; -1 sentinels map to `available:false`, never a fake zero), **connectorQueue** (`connector_artifact` status scan, bounded 20k; depth = pending|queued|processing|materialized, mirrors the drain's WORK_STATUSES; untyped `(db as any)` cast — 0343 not yet in generated types), **creditConservation** (the SAME `org_credit_ledger_divergence` RPC `credit-conservation-reconciler.ts` calls — the reconciler persists nothing, so the dashboard re-runs the identical live read; response carries org_id + counts ONLY, never raw balance/divergence — §1.4 PII rule matches the reconciler's bucket-only Sentry alert), **webhookDelivery** (`webhook_delivery_logs` 24h window, success-rate), **apiErrors** (`verification_events` 24h window, `result='error'` rate — the only durable per-request API outcome log; rate-limit/query stats are in-memory). Every surface is independently fail-OPEN: a read failure → `available:false, breach:false` (unknown ≠ breach) and never blanks the other four. `overallBreach` = OR of surface breaches. Breach thresholds are module constants (90% secured, 90% delivery, 5% API error, depth>500). Consumed by `src/pages/OpsSloDashboardPage.tsx` via `useOpsSloStats`.

## 2026-06-29 — Lane 2 s2: manual org queue run guard owner-inclusive + sub-org-aware (QUEUE-05 / SCRUM-2351)

`handleRunOrgAnchorQueue` (`queue-resolution.ts`) no longer carries a local `isOrgAdmin` doing a direct `org_members` probe — it now authorizes through the **canonical `_org-auth` resolver** (`isCallerOrgAdminResult`, owner-inclusive: owner/admin via `org_members` OR `ORG_ADMIN`/platform-admin via profile; fail-closed, 500 on operational error vs 403 true-negative). The endpoint accepts an optional `org_id` (`RunOrgQueueInput`, `.strict()` — unknown key → 400) so a caller can target a **specific** queue: their OWN org, or an **APPROVED sub-org** (`organizations.parent_org_id` = caller's org AND `parent_approval_status='APPROVED'`) whose parent the caller administers. The batch run is scoped to the resolved target org (never the parent), so a parent admin can't reach an unrelated org and a sub-org member/cross-org caller is 403. A `QUEUE_RUN_MANUAL` audit event (event_category `ANCHOR`, `relationship: self|sub_org`) is written on BOTH success and failure (non-fatal — the run is the source of truth). Route-level 401 stays in `routes/admin.ts` (`extractAuthUserId`).

## 2026-06-16 — version-resolution.ts fully typed (untypedDb removed)

The worker `database.types.ts` resync to head 0339 added `external_document_versions`
and `version_reviews`, so the `const untypedDb = db as unknown as SupabaseClient<any>`
escape hatch (and its `@supabase/supabase-js` `SupabaseClient` import) is gone — all six
`external_document_versions` / `version_reviews` reads/writes now run on the typed `db`
client. No runtime change (casts are type-erased); the win is compile-time column/shape
checking. Per the DON'T rule in `services/worker/agents.md`: don't reintroduce
`(db as any)` for a table that's in `database.types.ts` — run `gen:types` instead.

## 2026-06-01 Platform-admin org roster + add member (RLS-bypass via service_role)

- `admin-org-members.ts` adds three platform-admin-gated endpoints behind the org profile UI: `GET /api/admin/organizations/:id/members` (roster), `GET /api/admin/users/search?email=` (find a user for the add flow), `POST /api/admin/organizations/:id/members` (add member). The browser-side org views query Supabase directly under RLS, and `org_members` / `profiles` SELECT policies have **no platform-admin bypass** — a platform admin viewing an org they are not a member of saw "0 members" and "No user found". These use the service_role `db` client (bypasses RLS) and gate EVERY endpoint with `isPlatformAdmin(userId)` first (DB is never touched before the gate — asserted in tests).
- The roster intentionally reads **`org_members` first, then `profiles` by member user IDs**. This is the membership source of truth: `profiles.org_id` is only the user's primary/current org and will miss valid multi-org membership rows. Service-role access is still strictly platform-admin gated before either query.
- Add-member writes go **directly** through service_role (insert `org_members` + backfill `profiles.org_id` when null + `audit_events` MEMBER_ADDED row). We deliberately do **NOT** call the `add_org_member` RPC: it resolves the caller via `auth.uid()`, which is NULL under the worker's service_role client (same SCRUM-2213 trap below) → it would raise on every call. `org_members.role` is the `org_member_role` enum (owner/admin/member); map the UI's INDIVIDUAL/ORG_ADMIN → member/admin (owner is never assignable here).

## 2026-05-30 RPCs that read `auth.uid()` fail when called from the worker (SCRUM-2213)

- `handleListPendingResolution` (`queue-resolution.ts`) called RPC `list_pending_resolution_anchors_v2`, which resolves the caller via `SELECT … FROM profiles WHERE id = auth.uid()` and raises `'Profile not found'` otherwise. But the worker invokes RPCs through the **service-role** `db` client, where `auth.uid()` is **NULL** → the RPC raised on every call → `/api/queue/pending` returned **500** every time (Review Queue page hung on "Loading…"). A perfect index (`idx_anchors_org_status_created`) existed, so it was never a timeout — purely an auth-context mismatch.
- **Rule:** never call an `auth.uid()`-dependent RPC from the worker's service-role client. Resolve the caller's org from the authenticated userId (passed by the route via `extractAuthUserId`) and query org-scoped directly, or pass an explicit `p_user_id` into the RPC. Fix: the handler now takes `callerUserId`, resolves `profiles.org_id`, queries `anchors` org-scoped (`.eq('org_id', …).eq('status','PENDING_RESOLUTION')`), and computes `sibling_count` in TS — no `auth.uid()` dependency and no exact-count scan (the R0-8 planner-safe rule).

## 2026-05-29 Phantom-column filters silently zero out counts (SCRUM-1984)

- `admin-stats.ts` filtered `.is('deleted_at', null)` on `organizations`, which has **no** `deleted_at` column. PostgREST does not throw on a filter against a missing column — it resolves with `{ count: null, error: <column missing> }`. Under `Promise.allSettled` the promise is *fulfilled* (carrying the error), so `val(i)?.count ?? 0` collapsed to `0` and Total Orgs always showed 0 despite real orgs existing.
- Before filtering soft-deletes, confirm the table actually has `deleted_at`. `organizations` soft-deletes via `suspended`, not `deleted_at` (CLAUDE.md §1.2). `profiles` and `anchors` do have `deleted_at`.

## 2026-05-22 Anchor Write Scope Compatibility

- `apiScopes.ts` treats `anchor:write` and `write:anchors` as equivalent write-capable anchor scopes. Keep this central in `scopeSatisfies()` instead of duplicating route-specific aliases.

## 2026-05-29 Version Resolution Context

- `version-resolution.ts` exports `requireVersionOrgAdminContext`, but `index.ts` owns mounting it before `versionResolutionRouter`; keep the router itself free of implicit org-context middleware so app-level route order stays testable.

## What This Folder Contains

Express route handlers for the worker's HTTP API. Covers admin endpoints, anchor operations, proof packets, audit events, compliance, rules CRUD, treasury, and the v1/v2 versioned sub-APIs.

| File | Purpose |
|------|---------|
| `_org-auth.ts` | Shared org-auth helpers for service_role handlers (single source of truth for org_id scoping). `getCallerProfile`/`getCallerOrgId`, `isCallerOrgAdmin` (org_members owner/admin OR profile ORG_ADMIN/platform-admin), and `isUserMemberOfOrg(target, org)` (SCRUM-1863 — the cross-org gate for admin-acts-on-member flows; true if an `org_members` row OR `profiles.org_id` matches; fails closed). Each lookup also has a `*Result` variant (`getCallerOrgIdResult` / `isCallerOrgAdminResult` / `isUserMemberOfOrgResult`) returning `{ value, error }`: the boolean/string forms FAIL CLOSED (DB error → falsy), while `*Result` surfaces an operational `error` so a handler can return **500** instead of masking a fault as **403** (PR #1045 review, mirrors #1029). `isCallerOrgAdmin` now explicitly captures + logs the `org_members` lookup error it previously swallowed. Tested in `_org-auth.test.ts`. |
| `badge.ts` | Public `/api/badge/:publicId` SVG endpoint; resolves status from `get_public_anchor` and fails closed for unknown states |
| `anchor-lineage.ts` | Anchor parent/child lineage traversal endpoint |
| `anchor-revoke.ts` | Anchor revocation endpoint |
| `verify-anchor.ts` | Public anchor verification endpoint |
| `proof-packet.ts` | Proof package generation (Bitcoin TX + metadata + timestamps) |
| `proof-keys.ts` | Proof signing key management |
| `did-web.ts` | did:web identity docs — `GET /.well-known/did.json` (Arkova) + `GET /orgs/:id/.well-known/did.json` (issuing orgs). Public, no auth. Reuses the active proof key (PEM→Ed25519 JWK); org sub-DIDs are controlled by the Arkova DID. Strict org-public-id charset guard before lookup (SCRUM-1922) |
| `audit-event.ts` | Audit event creation and query |
| `admin-stats.ts` / `admin-lists.ts` / `admin-pipeline-stats.ts` | Admin dashboard data endpoints |
| `admin-org-members.ts` | Platform-admin org roster + user-search + add-member (service_role, RLS-bypass; backs the org profile UI when an admin views a non-member org) |
| `admin-actions.ts` / `admin-health.ts` | Admin action + health check endpoints |
| `rules-crud.ts` / `rules-draft.ts` | Rules engine CRUD and draft management |
| `queue-resolution.ts` | Review queue resolution endpoint |
| `rules-templates.ts` | Public rules templates discovery endpoint (SCRUM-1973). Re-exports `RULE_TEMPLATES` / `RuleTemplate` from `rule-templates-data.ts` |
| `rule-templates-data.ts` | Pure, dependency-free rule-template definitions (single source of truth). Split out of `rules-templates.ts` so non-HTTP consumers (e.g. the SCRUM-3027 DocuSign Completion auto-seed) share the canonical template shape without importing express |
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
