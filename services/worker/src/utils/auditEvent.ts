/**
 * Audit-event writer (SILENT-WRITE CLASS — see services/worker/src/middleware/agents.md).
 *
 * supabase-js query builders are LAZY PromiseLikes: `PostgrestBuilder.then()`
 * is where the HTTP request is issued. So this:
 *
 *     void db.from('audit_events').insert({ ... });
 *
 * constructs a builder, discards it, and sends NOTHING — no request, no error,
 * no row, no signal. Eight audit-event call sites shipped that way. Verified
 * against prod 2026-08-02: `audit_events` held ZERO rows for every event type
 * emitted by those sites (`VERIFICATION_QUERIED`, the API-key admin events, the
 * agent lifecycle events) while unrelated writers had hundreds of thousands of
 * rows — i.e. the table worked fine and only these writes vanished.
 *
 * Route every audit write through `recordAuditEvent`. It attaches `.then(...)`,
 * which is what actually issues the request, and reports failures instead of
 * swallowing them.
 *
 * FIRE-AND-FORGET IS DELIBERATE, LOGGING AT ERROR IS TOO. A failed audit write
 * must not fail the user's request (verification is an anonymous public path
 * and must stay available), but losing an audit row is a compliance event, not
 * a warning — so it logs at `error` with the event type attached.
 *
 * IT NEVER REJECTS — AND THAT IS WHY IT REPORTS `{ ok }`. Awaiting this
 * function used to look like the stronger guarantee and was not: a failed
 * insert resolved exactly like a successful one, so `await recordAuditEvent(…)`
 * proved only that the attempt finished. SCRUM-5023's expiry-notice job reads
 * `audit_events` back as its DEDUPE LEDGER, where a silently lost row is not a
 * compliance gap but a duplicate email every day until the write starts
 * working. Callers that depend on the row landing MUST check `ok`; floating
 * `void recordAuditEvent(…)` callers are unaffected and still cannot produce
 * an unhandled rejection.
 */
import { db } from './db.js';
import { logger } from './logger.js';

/** Columns accepted by `audit_events`; kept loose because call sites vary. */
export type AuditEventRow = Record<string, unknown>;

/** Whether the row actually landed. See the header: this never rejects. */
export interface AuditEventResult {
  ok: boolean;
}

/**
 * Insert an audit event, actually issuing the request.
 *
 * Returns the in-flight promise so a caller may await it, resolving to
 * `{ ok: false }` when the row did not land. Never rejects — failures are
 * logged, so a floating call cannot produce an unhandled rejection.
 */
export function recordAuditEvent(row: AuditEventRow): Promise<AuditEventResult> {
  const fail = (error: unknown) => {
    logger.error(
      { error, eventType: row.event_type, targetId: row.target_id },
      'audit_events insert failed — audit trail incomplete',
    );
    return { ok: false };
  };

  // The try/catch is load-bearing, not defensive dressing. Callers invoke this
  // as `void recordAuditEvent(...)` from inside a request handler, so anything
  // thrown SYNCHRONOUSLY here propagates out of the handler and 500s the user's
  // request — precisely what the contract above forbids. Two shapes throw
  // before any promise exists: `.insert()` raising outright, and `.insert()`
  // returning a non-thenable so `.then()` is a TypeError. Handling only the
  // async rejection would be a guard that merely looks like it works.
  try {
    // `any`: audit rows vary by call site. `missing-org-filter`: this is an
    // INSERT, not a read — the row carries whatever scope the caller supplies
    // (`org_id` when known, none for the anonymous public verify path), so
    // there is nothing to filter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, arkova/missing-org-filter
    const issued = (db.from('audit_events').insert(row as any) as PromiseLike<{ error: unknown }>)
      .then(({ error }) => (error ? fail(error) : { ok: true }), fail);

    // `.then()` on a supabase-js builder returns a PromiseLike, not a Promise.
    // Wrap so callers get the full Promise surface (`catch`/`finally`).
    return Promise.resolve(issued);
  } catch (error) {
    // Report, never swallow: a lost audit row is a compliance event.
    return Promise.resolve(fail(error));
  }
}
