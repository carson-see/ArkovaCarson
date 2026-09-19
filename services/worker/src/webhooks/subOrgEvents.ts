/**
 * SCRUM-3972 (CTO rulings R16a / R19 / R20) — emitter for the seven
 * affiliated-organization lifecycle events.
 *
 * This module exists so `api/v1/orgSubOrgs.ts` gains ONE line per transition
 * (`void emitSubOrgEvent({...})`) instead of a block of payload assembly. That
 * is a deliberate merge property, not just tidiness: PR #2844 (SCRUM-3971) is
 * refactoring the same file into extracted handlers, and a one-line call site
 * union-resolves; an inlined twenty-line block does not.
 *
 * WHO RECEIVES WHAT
 *
 * All seven are dispatched on the PARENT organization's id. They describe the
 * parent's own actions on its own affiliations, so a default `scope: 'self'`
 * endpoint receives them with no configuration change and no boundary crossed.
 *
 * Four are ALSO dispatched on the CHILD organization's id —
 * `suborg.credits_allocated`, `suborg.credits_reclaimed`, `suborg.suspended`,
 * `suborg.offboarded` — because each of those changes something the child owns
 * (its budget, its tenancy) and the child cannot see its parent's feed. The
 * other three (`created` / `approved` / `revoked`) are announcements about the
 * relationship that the parent initiates and are parent-only, matching the
 * existing REST surface where a child has no read on them.
 *
 * These are NOT gated by `ENABLE_SUBORG_WEBHOOK_FANOUT`. That flag gates the
 * separate cross-organization fan-out of `anchor.*` events in
 * `suborg-fanout.ts`, which reverses decision D2. Nothing here reveals what a
 * child SECURED; these events carry only the affiliation facts the counterparty
 * already holds.
 *
 * NO FAIL-OPEN, AND NO EFFECT ON THE HTTP RESPONSE. Every failure path logs at
 * error level, captures to Sentry, and returns a typed non-ok result the caller
 * (or a test) can count. Nothing here throws: the call sites are
 * `void`-dispatched AFTER the response-determining work, and a rejected promise
 * from a `void` call would be an unhandled rejection, not a handled failure.
 * `emitSubOrgEventNeverThrows` is pinned by a test.
 */

import { logger } from '../utils/logger.js';
import { Sentry } from '../utils/sentry.js';
import { db as _db } from '../utils/db.js';
import { dispatchWebhookEvent } from './delivery.js';

// Sub-org columns from migration 0128 are not in the generated types yet —
// the same cast api/v1/orgSubOrgs.ts uses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = _db as any;

export type SubOrgEventType =
  | 'suborg.created'
  | 'suborg.approved'
  | 'suborg.revoked'
  | 'suborg.credits_allocated'
  | 'suborg.credits_reclaimed'
  | 'suborg.suspended'
  | 'suborg.offboarded';

/**
 * The four events the affiliated organization is also told about, on its own
 * org id. Exported so the test can assert the set rather than re-listing it.
 */
export const CHILD_NOTIFIED_SUBORG_EVENTS: ReadonlySet<SubOrgEventType> = new Set([
  'suborg.credits_allocated',
  'suborg.credits_reclaimed',
  'suborg.suspended',
  'suborg.offboarded',
]);

export interface EmitSubOrgEventInput {
  eventType: SubOrgEventType;
  /** Internal uuid of the parent organization. Never leaves this module. */
  parentOrgId: string;
  /** Internal uuid of the affiliated organization. Never leaves this module. */
  childOrgId: string;
  /**
   * Event-specific fields (amount / parent_balance / child_balance / note /
   * reason / reclaimed). Merged over the base block and validated by the
   * `.strict()` schema in payload-schemas.ts, so an unexpected key here is a
   * loud dispatch failure, not a leak.
   */
  data?: Record<string, unknown>;
  /** Override the occurrence clock. Tests pass it; production does not. */
  occurredAt?: string;
}

export type SubOrgEmitFailureKind =
  | 'org_lookup_failed'
  | 'org_not_found'
  | 'public_id_missing'
  | 'dispatch_failed';

export interface SubOrgEmitResult {
  ok: boolean;
  /** How many org ids this event was successfully dispatched on (0, 1 or 2). */
  dispatched: number;
  failures: Array<{ kind: SubOrgEmitFailureKind; message: string }>;
}

interface OrgRow {
  id: string;
  public_id: string | null;
  display_name: string | null;
  parent_approval_status: string | null;
}

function fail(
  failures: SubOrgEmitResult['failures'],
  kind: SubOrgEmitFailureKind,
  message: string,
  context: Record<string, unknown>,
): void {
  logger.error(
    { ...context, subOrgEmitFailure: kind, err: message },
    'Affiliated-organization webhook event was NOT emitted',
  );
  Sentry.captureMessage('suborg_event_emit_failed', {
    level: 'error',
    tags: { subsystem: 'webhooks', stage: 'suborg_emit', failure_kind: kind },
    extra: { ...context, message },
  });
  failures.push({ kind, message });
}

/**
 * Emit one affiliated-organization lifecycle event.
 *
 * Resolves both organizations in a single read so the emitter — not every call
 * site — owns the public-id projection. CLAUDE.md §6: the two internal uuids
 * are arguments, never payload fields.
 *
 * Returns a result; never throws, never rejects.
 */
export async function emitSubOrgEvent(input: EmitSubOrgEventInput): Promise<SubOrgEmitResult> {
  const { eventType, parentOrgId, childOrgId } = input;
  const failures: SubOrgEmitResult['failures'] = [];

  try {
    // One clock for this event (builder contract §4) — the moment of the
    // transition, sampled once, used for both the payload and the event id.
    const occurredAt = input.occurredAt ?? new Date().toISOString();

    // TENANT SCOPE: the two org ids ARE the filter (a bare eslint-disable is
    // itself a lint error here — arkova/missing-org-filter is switched off for
    // this path in services/worker/eslint.config.js).
    // This reads exactly the parent and child rows named by the
    // caller, by primary key, to project their public slugs.
    const { data, error } = await db
      .from('organizations')
      .select('id, public_id, display_name, parent_approval_status')
      .in('id', [parentOrgId, childOrgId]);

    if (error) {
      fail(failures, 'org_lookup_failed', error.message ?? String(error), { eventType });
      return { ok: false, dispatched: 0, failures };
    }

    const rows = (data ?? []) as OrgRow[];
    const parent = rows.find((r) => r.id === parentOrgId);
    const child = rows.find((r) => r.id === childOrgId);

    if (!parent || !child) {
      fail(failures, 'org_not_found', 'parent and/or affiliated organization row not found', {
        eventType,
        parentFound: Boolean(parent),
        childFound: Boolean(child),
      });
      return { ok: false, dispatched: 0, failures };
    }

    // `organizations.public_id` is nullable on this base (SCRUM-3971's
    // migration 0453 makes it NOT NULL; this PR does not depend on that having
    // landed). Without both slugs the event cannot be expressed in public ids
    // at all, and a payload that named an organization by uuid would violate
    // CLAUDE.md §6 — so we refuse rather than degrade.
    if (!parent.public_id || !child.public_id || !child.display_name) {
      fail(
        failures,
        'public_id_missing',
        'parent public_id, affiliate public_id or affiliate display_name is null; refusing to emit a payload that cannot be expressed in public identifiers',
        { eventType },
      );
      return { ok: false, dispatched: 0, failures };
    }

    const payload: Record<string, unknown> = {
      public_id: child.public_id,
      display_name: child.display_name,
      parent_public_id: parent.public_id,
      // Mirrors organizations_parent_approval_status_check exactly:
      // NULL | 'PENDING' | 'APPROVED' | 'REVOKED'. Read from the row rather
      // than assumed from the event name, so a payload can never assert a
      // status the database would not have stored.
      parent_approval_status: child.parent_approval_status ?? null,
      occurred_at: occurredAt,
      ...(input.data ?? {}),
    };

    // Event id: stable for a retry of the SAME logical transition, distinct
    // across transitions. Deliberately NOT just the affiliate's public_id (the
    // convention the one-shot anchor events use) — an affiliate can be revoked,
    // re-approved and re-credited, and a repeated id would make the delivery
    // idempotency key (`${endpoint.id}-${event_id}`) swallow the later events.
    const eventId = `${eventType}:${child.public_id}:${occurredAt}`;

    const targets: string[] = [parentOrgId];
    if (CHILD_NOTIFIED_SUBORG_EVENTS.has(eventType)) targets.push(childOrgId);

    let dispatched = 0;
    for (const orgId of targets) {
      try {
        await dispatchWebhookEvent(orgId, eventType, eventId, payload);
        dispatched++;
      } catch (err) {
        // dispatchWebhookEvent throws only on schema rejection — i.e. we built
        // a payload the contract forbids. That is a defect, so it is loud.
        fail(failures, 'dispatch_failed', err instanceof Error ? err.message : String(err), {
          eventType,
          eventId,
          recipient: orgId === parentOrgId ? 'parent' : 'affiliate',
        });
      }
    }

    return { ok: failures.length === 0 && dispatched === targets.length, dispatched, failures };
  } catch (err) {
    // Last line of defence: the call sites are `void`-dispatched, so a rejected
    // promise here would surface as an unhandled rejection rather than a
    // counted failure.
    fail(failures, 'dispatch_failed', err instanceof Error ? err.message : String(err), {
      eventType,
    });
    return { ok: false, dispatched: 0, failures };
  }
}
