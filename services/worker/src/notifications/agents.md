# services/worker/src/notifications/

In-app notification dispatch for the worker. Writes notification rows to the `notifications` table for UI consumption.

## Files

- **dispatcher.ts** — Notification dispatcher. Supports user-targeted and org-admin-targeted notifications. Types include `queue_run_completed`, `rule_fired`, `version_available_for_review`, `treasury_alert`, `anchor_revoked`. Writes to DB via service_role.
- **dispatcher.test.ts** — Tests for notification dispatch, payload serialization, and org-admin fan-out.

## Rules

- Service-role DB access only — no anon/authenticated path.
- Notification payloads must be JSON-serializable (`Json` type from database.types).
