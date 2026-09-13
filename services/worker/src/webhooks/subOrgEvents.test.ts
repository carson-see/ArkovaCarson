/**
 * SCRUM-3972 — the affiliated-organization event emitter.
 *
 * The route tests pin WHEN an event fires; this file pins WHAT leaves the
 * building:
 *
 *  - public slugs only. The two internal org uuids are arguments and must never
 *    appear anywhere in the payload (CLAUDE.md §6);
 *  - which org ids each event is dispatched on — parent always, affiliate for
 *    the four that change something the affiliate owns;
 *  - no fail-open: a lookup failure, a missing slug or a rejected dispatch is
 *    logged at error level, captured, and returned as a typed non-ok result;
 *  - it never throws and never rejects, because the call sites are
 *    `void`-dispatched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger, mockSentry, mockFrom, mockDispatch } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockSentry: { captureException: vi.fn(), captureMessage: vi.fn() },
  mockFrom: vi.fn(),
  mockDispatch: vi.fn(async () => ({ ok: true, ownEndpointCount: 1, descendantEndpointCount: 0, failures: [] })),
}));

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/sentry.js', () => ({ Sentry: mockSentry }));
vi.mock('../utils/db.js', () => ({ db: { from: mockFrom } }));
vi.mock('./delivery.js', () => ({ dispatchWebhookEvent: mockDispatch }));

import { emitSubOrgEvent, CHILD_NOTIFIED_SUBORG_EVENTS, type SubOrgEventType } from './subOrgEvents.js';

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const PARENT_PUBLIC = 'ORG-PARENT-0001';
const CHILD_PUBLIC = 'ORG-CHILD-0001';
const OCCURRED_AT = '2026-09-12T10:00:00.000Z';

interface OrgsFixture {
  rows?: Array<Record<string, unknown>>;
  error?: string;
}

function installOrgs(fixture: OrgsFixture = {}) {
  mockFrom.mockImplementation((table: string) => {
    if (table !== 'organizations') throw new Error(`unexpected table ${table}`);
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.in = () => chain;
    chain.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
      Promise.resolve(
        fixture.error
          ? { data: null, error: { message: fixture.error } }
          : {
              data: fixture.rows ?? [
                { id: PARENT, public_id: PARENT_PUBLIC, display_name: 'Parent Co', parent_approval_status: null },
                { id: CHILD, public_id: CHILD_PUBLIC, display_name: 'Nairobi Legal Aid', parent_approval_status: 'APPROVED' },
              ],
              error: null,
            },
      ).then(onOk, onErr);
    return chain;
  });
}

const ALL_EVENTS: SubOrgEventType[] = [
  'suborg.created',
  'suborg.approved',
  'suborg.revoked',
  'suborg.credits_allocated',
  'suborg.credits_reclaimed',
  'suborg.suspended',
  'suborg.offboarded',
];

/** Extra fields each event's schema requires, so every case is dispatchable. */
const EXTRA: Partial<Record<SubOrgEventType, Record<string, unknown>>> = {
  'suborg.credits_allocated': { amount: 100, parent_balance: 900, child_balance: 100, note: null },
  'suborg.credits_reclaimed': { amount: -100, parent_balance: 1000, child_balance: 0, note: null },
  'suborg.suspended': { reason: null },
  'suborg.offboarded': { reclaimed: 100, reason: null },
};

function dispatchArgs() {
  return mockDispatch.mock.calls as unknown as Array<
    [string, string, string, Record<string, unknown>]
  >;
}

describe('emitSubOrgEvent (SCRUM-3972)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatch.mockResolvedValue({
      ok: true,
      ownEndpointCount: 1,
      descendantEndpointCount: 0,
      failures: [],
    });
  });

  it('projects both organizations to public slugs and carries no internal identifier', async () => {
    installOrgs();
    const result = await emitSubOrgEvent({
      eventType: 'suborg.approved',
      parentOrgId: PARENT,
      childOrgId: CHILD,
      occurredAt: OCCURRED_AT,
    });

    expect(result.ok).toBe(true);
    const [orgId, eventType, eventId, payload] = dispatchArgs()[0];
    expect(orgId).toBe(PARENT);
    expect(eventType).toBe('suborg.approved');
    expect(payload).toEqual({
      public_id: CHILD_PUBLIC,
      display_name: 'Nairobi Legal Aid',
      parent_public_id: PARENT_PUBLIC,
      parent_approval_status: 'APPROVED',
      occurred_at: OCCURRED_AT,
    });
    // CLAUDE.md §6 — belt and braces over the field-by-field assertion above.
    const serialised = JSON.stringify({ eventId, payload });
    expect(serialised).not.toContain(PARENT);
    expect(serialised).not.toContain(CHILD);
  });

  it.each(ALL_EVENTS)('dispatches %s on the parent organization', async (eventType) => {
    installOrgs();
    await emitSubOrgEvent({
      eventType,
      parentOrgId: PARENT,
      childOrgId: CHILD,
      occurredAt: OCCURRED_AT,
      data: EXTRA[eventType],
    });
    expect(dispatchArgs().map((c) => c[0])).toContain(PARENT);
  });

  it.each(ALL_EVENTS)('tells the affiliate about %s only when it owns the change', async (eventType) => {
    installOrgs();
    await emitSubOrgEvent({
      eventType,
      parentOrgId: PARENT,
      childOrgId: CHILD,
      occurredAt: OCCURRED_AT,
      data: EXTRA[eventType],
    });

    const targets = dispatchArgs().map((c) => c[0]);
    const shouldNotifyChild = CHILD_NOTIFIED_SUBORG_EVENTS.has(eventType);
    expect(targets.includes(CHILD)).toBe(shouldNotifyChild);
    expect(targets).toHaveLength(shouldNotifyChild ? 2 : 1);
  });

  it('pins exactly which four events reach the affiliate', () => {
    // A future event added to the child-notified set is a new cross-tenant
    // disclosure and must be a deliberate edit here, not a side effect.
    expect([...CHILD_NOTIFIED_SUBORG_EVENTS].sort()).toEqual([
      'suborg.credits_allocated',
      'suborg.credits_reclaimed',
      'suborg.offboarded',
      'suborg.suspended',
    ]);
  });

  it('sends both copies under one event id, distinct across transitions', async () => {
    installOrgs();
    await emitSubOrgEvent({
      eventType: 'suborg.suspended',
      parentOrgId: PARENT,
      childOrgId: CHILD,
      occurredAt: OCCURRED_AT,
      data: { reason: null },
    });
    const ids = dispatchArgs().map((c) => c[2]);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBe(`suborg.suspended:${CHILD_PUBLIC}:${OCCURRED_AT}`);

    // A second suspension later must NOT reuse the id — the delivery
    // idempotency key is `${endpoint.id}-${event_id}`, so a repeated id would
    // make the later event a silent no-op.
    mockDispatch.mockClear();
    await emitSubOrgEvent({
      eventType: 'suborg.suspended',
      parentOrgId: PARENT,
      childOrgId: CHILD,
      occurredAt: '2026-09-13T10:00:00.000Z',
      data: { reason: null },
    });
    expect(dispatchArgs()[0][2]).not.toBe(`suborg.suspended:${CHILD_PUBLIC}:${OCCURRED_AT}`);
  });

  it('reads parent_approval_status from the row rather than inferring it from the event', async () => {
    installOrgs({
      rows: [
        { id: PARENT, public_id: PARENT_PUBLIC, display_name: 'Parent Co', parent_approval_status: null },
        { id: CHILD, public_id: CHILD_PUBLIC, display_name: 'Child Co', parent_approval_status: 'REVOKED' },
      ],
    });
    await emitSubOrgEvent({
      eventType: 'suborg.revoked',
      parentOrgId: PARENT,
      childOrgId: CHILD,
      occurredAt: OCCURRED_AT,
    });
    expect(dispatchArgs()[0][3].parent_approval_status).toBe('REVOKED');
  });

  it('does not emit — and says so — when the organization lookup fails', async () => {
    installOrgs({ error: 'connection terminated unexpectedly' });
    const result = await emitSubOrgEvent({
      eventType: 'suborg.approved',
      parentOrgId: PARENT,
      childOrgId: CHILD,
    });

    expect(result.ok).toBe(false);
    expect(result.dispatched).toBe(0);
    expect(result.failures.map((f) => f.kind)).toEqual(['org_lookup_failed']);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
    expect(mockSentry.captureMessage).toHaveBeenCalledWith(
      'suborg_event_emit_failed',
      expect.anything(),
    );
  });

  it('refuses rather than degrades when a public slug is missing', async () => {
    // organizations.public_id is nullable on this base. A payload that named an
    // organization by uuid instead would violate CLAUDE.md §6, so there is no
    // acceptable fallback — only a loud refusal.
    installOrgs({
      rows: [
        { id: PARENT, public_id: null, display_name: 'Parent Co', parent_approval_status: null },
        { id: CHILD, public_id: CHILD_PUBLIC, display_name: 'Child Co', parent_approval_status: 'APPROVED' },
      ],
    });
    const result = await emitSubOrgEvent({
      eventType: 'suborg.approved',
      parentOrgId: PARENT,
      childOrgId: CHILD,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.kind)).toEqual(['public_id_missing']);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('counts a missing organization row instead of emitting a half-named event', async () => {
    installOrgs({
      rows: [{ id: PARENT, public_id: PARENT_PUBLIC, display_name: 'Parent Co', parent_approval_status: null }],
    });
    const result = await emitSubOrgEvent({
      eventType: 'suborg.approved',
      parentOrgId: PARENT,
      childOrgId: CHILD,
    });

    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.kind)).toEqual(['org_not_found']);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('counts a rejected dispatch and still tries the other recipient', async () => {
    installOrgs();
    mockDispatch
      .mockRejectedValueOnce(new Error('payload failed schema validation'))
      .mockResolvedValueOnce({ ok: true, ownEndpointCount: 1, descendantEndpointCount: 0, failures: [] });

    const result = await emitSubOrgEvent({
      eventType: 'suborg.offboarded',
      parentOrgId: PARENT,
      childOrgId: CHILD,
      data: { reclaimed: 0, reason: null },
    });

    expect(result.ok).toBe(false);
    expect(result.dispatched).toBe(1);
    expect(result.failures.map((f) => f.kind)).toEqual(['dispatch_failed']);
  });

  it('never rejects, even when the database client itself throws', async () => {
    mockFrom.mockImplementation(() => {
      throw new Error('client exploded');
    });
    // A rejection here would become an unhandled rejection at the `void` call
    // sites rather than a handled failure.
    await expect(
      emitSubOrgEvent({ eventType: 'suborg.approved', parentOrgId: PARENT, childOrgId: CHILD }),
    ).resolves.toMatchObject({ ok: false, dispatched: 0 });
  });

  it('samples one clock for the payload and the event id', async () => {
    installOrgs();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse(OCCURRED_AT));
      await emitSubOrgEvent({
        eventType: 'suborg.approved',
        parentOrgId: PARENT,
        childOrgId: CHILD,
      });
      const [, , eventId, payload] = dispatchArgs()[0];
      expect(payload.occurred_at).toBe(OCCURRED_AT);
      expect(eventId).toContain(OCCURRED_AT);
    } finally {
      vi.useRealTimers();
    }
  });
});
