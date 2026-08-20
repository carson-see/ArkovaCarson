/**
 * Canonical `audit_events.event_category` values for the edge worker.
 *
 * BUG-2026-08-13-016 — the edge is a standalone package (its own
 * `tsconfig.json` with `include: ["src/**\/*.ts"]`), so it cannot import the
 * worker's `services/worker/src/types/audit-event-category.ts`. Until this
 * file existed, the edge had NO compile-time constraint on the column and
 * `mcp-audit-log.ts` shipped `event_category: 'security'` (lowercase) for
 * 2.5 months. Every insert was rejected by the CHECK constraint with HTTP
 * 400 and the MCP tool-call audit trail recorded zero rows in production.
 *
 * This list MUST stay byte-identical to the CHECK constraint
 * `audit_events_event_category_valid`, whose current definition lives in
 * `supabase/migrations/0309_expand_audit_event_category_constraint.sql`.
 * `src/tests/edge/mcp-audit-log.test.ts` parses that migration and fails if
 * the two drift — a human census of call sites is not a control, a detector is.
 */

export const AUDIT_EVENT_CATEGORIES = [
  'AUTH',
  'ANCHOR',
  'PROFILE',
  'ORG',
  'ADMIN',
  'SYSTEM',
  'ORGANIZATION',
  'WEBHOOK',
  'API',
  'AI',
  'BILLING',
  'VERIFICATION',
  'USER',
  'COMPLIANCE',
  'NOTIFICATION',
  'PLATFORM',
  'SECURITY',
] as const;

export type AuditEventCategory = (typeof AUDIT_EVENT_CATEGORIES)[number];

/** Runtime guard for values that are not statically known. */
export function isAuditEventCategory(value: unknown): value is AuditEventCategory {
  return typeof value === 'string'
    && (AUDIT_EVENT_CATEGORIES as readonly string[]).includes(value);
}
