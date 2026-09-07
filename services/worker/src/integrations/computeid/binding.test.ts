/**
 * Passport ↔ agent binding (stored in `agents.metadata.computeid` for v1) and
 * the pure state-transition decision for inbound passport events.
 *
 * Ordering floor instead of a nonce table: an event is stale if older than the
 * last applied event, or — before any event — older than the admitting receipt
 * (`receipt_issued_at`, then `bound_at`). Exact replays (same ts + same event)
 * are stale; a different event at the same ts is not. `revoked` is terminal.
 * Only a suspension WE applied can be lifted by `passport.reinstated`.
 */
import { describe, it, expect } from 'vitest';
import { readBinding, writeBinding, decidePassportEvent, applyPassportEvent, orderingFloor } from './binding.js';

const PASSPORT = '0d8f7c1e-2a1b-4c3d-9e8f-1a2b3c4d5e6f';
const T0 = '2026-09-07T09:00:00.000Z';
const T1 = '2026-09-07T10:00:00.000Z';
const T2 = '2026-09-07T11:00:00.000Z';
const T3 = '2026-09-07T12:00:00.000Z';

const bound = (extra: Record<string, unknown> = {}) => ({
  computeid: { issuer: 'computeid', passport_id: PASSPORT, bound_at: T1, receipt_expires_at: T3, receipt_issued_at: T1, ...extra },
  unrelated: { keep: 'me' },
});
const ev = (event: 'passport.revoked' | 'passport.suspended' | 'passport.reinstated', timestamp = T2) => ({ event, timestamp });

describe('readBinding / writeBinding', () => {
  it('returns null for missing, null, non-object, foreign-issuer or non-UUID metadata', () => {
    expect(readBinding(null)).toBeNull();
    expect(readBinding(undefined)).toBeNull();
    expect(readBinding('str')).toBeNull();
    expect(readBinding({})).toBeNull();
    expect(readBinding({ computeid: { issuer: 'other', passport_id: PASSPORT } })).toBeNull();
    expect(readBinding({ computeid: { issuer: 'computeid', passport_id: 'not-a-uuid' } })).toBeNull();
  });
  it('normalizes the passport id to lowercase and drops unparseable timestamps instead of trusting them', () => {
    const b = readBinding({ computeid: { issuer: 'computeid', passport_id: PASSPORT.toUpperCase(), last_event_at: 'never', receipt_issued_at: 'garbage', bound_at: T1 } });
    expect(b?.passport_id).toBe(PASSPORT);
    expect(b?.last_event_at).toBeUndefined();
    expect(b?.receipt_issued_at).toBeUndefined();
    expect(b?.bound_at).toBe(T1);
  });
  it('round-trips and preserves unrelated metadata keys and ownership marker', () => {
    const b = readBinding(bound({ suspended_by: 'computeid' }));
    expect(b?.suspended_by).toBe('computeid');
    const next = writeBinding(bound(), { ...b!, last_event: 'passport.suspended', last_event_at: T2 });
    expect(next.unrelated).toEqual({ keep: 'me' });
    expect(readBinding(next)?.last_event_at).toBe(T2);
  });
  it('orderingFloor prefers last_event_at, then receipt_issued_at, then bound_at', () => {
    expect(orderingFloor(readBinding(bound({ last_event_at: T2 }))!)).toBe(Date.parse(T2));
    expect(orderingFloor(readBinding(bound())!)).toBe(Date.parse(T1));
    expect(orderingFloor(readBinding(bound({ receipt_issued_at: undefined, bound_at: T0 }))!)).toBe(Date.parse(T0));
  });
});

describe('decidePassportEvent — transitions', () => {
  it('unbound agent → noop/unbound', () => {
    expect(decidePassportEvent({ status: 'active', metadata: {} }, ev('passport.revoked'))).toEqual({ action: 'noop', reason: 'unbound' });
  });
  it('active + revoked → revoke; active + suspended → suspend; active + reinstated → noop/already_in_state', () => {
    expect(decidePassportEvent({ status: 'active', metadata: bound() }, ev('passport.revoked'))).toEqual({ action: 'revoke', reason: 'applied' });
    expect(decidePassportEvent({ status: 'active', metadata: bound() }, ev('passport.suspended'))).toEqual({ action: 'suspend', reason: 'applied' });
    expect(decidePassportEvent({ status: 'active', metadata: bound() }, ev('passport.reinstated'))).toEqual({ action: 'noop', reason: 'already_in_state' });
  });
  it('suspended BY US + reinstated → reinstate; suspended by the org (no marker) + reinstated → noop/suspended_by_org', () => {
    expect(decidePassportEvent({ status: 'suspended', metadata: bound({ suspended_by: 'computeid' }) }, ev('passport.reinstated'))).toEqual({ action: 'reinstate', reason: 'applied' });
    expect(decidePassportEvent({ status: 'suspended', metadata: bound() }, ev('passport.reinstated'))).toEqual({ action: 'noop', reason: 'suspended_by_org' });
  });
  it('suspended + suspended → noop/already_in_state; suspended + revoked → revoke', () => {
    expect(decidePassportEvent({ status: 'suspended', metadata: bound() }, ev('passport.suspended'))).toEqual({ action: 'noop', reason: 'already_in_state' });
    expect(decidePassportEvent({ status: 'suspended', metadata: bound() }, ev('passport.revoked'))).toEqual({ action: 'revoke', reason: 'applied' });
  });
  it('revoked is terminal — every newer event is noop/already_revoked', () => {
    for (const e of ['passport.revoked', 'passport.suspended', 'passport.reinstated'] as const) {
      expect(decidePassportEvent({ status: 'revoked', metadata: bound() }, ev(e, T3))).toEqual({ action: 'noop', reason: 'already_revoked' });
    }
  });
});

describe('decidePassportEvent — ordering floor', () => {
  it('an event OLDER than the last applied one is stale', () => {
    const m = bound({ last_event: 'passport.suspended', last_event_at: T2 });
    expect(decidePassportEvent({ status: 'suspended', metadata: m }, ev('passport.reinstated', T1))).toEqual({ action: 'noop', reason: 'stale_event' });
  });
  it('an exact replay (same timestamp AND same event) is stale; a DIFFERENT event at the same timestamp is applied', () => {
    const m = bound({ last_event: 'passport.suspended', last_event_at: T2 });
    expect(decidePassportEvent({ status: 'suspended', metadata: m }, ev('passport.suspended', T2))).toEqual({ action: 'noop', reason: 'stale_event' });
    expect(decidePassportEvent({ status: 'suspended', metadata: m }, ev('passport.revoked', T2))).toEqual({ action: 'revoke', reason: 'applied' });
  });
  it('before any event, a delivery older than the admitting receipt is stale (pre-admission replay cannot revoke a fresh agent)', () => {
    expect(decidePassportEvent({ status: 'active', metadata: bound() }, ev('passport.revoked', T0))).toEqual({ action: 'noop', reason: 'stale_event' });
    expect(decidePassportEvent({ status: 'active', metadata: bound() }, ev('passport.revoked', T2))).toEqual({ action: 'revoke', reason: 'applied' });
  });
  it('an unparseable event timestamp is treated as stale, never applied', () => {
    expect(decidePassportEvent({ status: 'active', metadata: bound() }, { event: 'passport.revoked', timestamp: 'not a date' })).toEqual({ action: 'noop', reason: 'stale_event' });
  });
});

describe('applyPassportEvent', () => {
  it('revoke → status revoked + revoked_at + clock advanced + keys deactivated; ownership marker cleared', () => {
    const r = applyPassportEvent({ status: 'suspended', metadata: bound({ suspended_by: 'computeid' }) }, ev('passport.revoked'));
    expect(r.decision.action).toBe('revoke');
    expect(r.keyEnforcement).toBe('deactivate');
    expect(r.update).toMatchObject({ status: 'revoked', revoked_at: T2 });
    expect(r.update).not.toHaveProperty('updated_at');
    const b = readBinding(r.update?.metadata);
    expect(b).toMatchObject({ last_event: 'passport.revoked', last_event_at: T2 });
    expect(b?.suspended_by).toBeUndefined();
    expect((r.update?.metadata as Record<string, unknown>).unrelated).toEqual({ keep: 'me' });
  });
  it('suspend → suspended + suspended_at + suspended_by=computeid + keys deactivated', () => {
    const s = applyPassportEvent({ status: 'active', metadata: bound() }, ev('passport.suspended'));
    expect(s.update).toMatchObject({ status: 'suspended', suspended_at: T2 });
    expect(readBinding(s.update?.metadata)?.suspended_by).toBe('computeid');
    expect(s.keyEnforcement).toBe('deactivate');
  });
  it('reinstate → active + suspended_at null + marker cleared + keys reactivated', () => {
    const a = applyPassportEvent({ status: 'suspended', metadata: bound({ suspended_by: 'computeid' }) }, ev('passport.reinstated', T3));
    expect(a.update).toMatchObject({ status: 'active', suspended_at: null });
    expect(readBinding(a.update?.metadata)?.suspended_by).toBeUndefined();
    expect(a.keyEnforcement).toBe('reactivate');
  });
  it('stale / unbound → no write at all', () => {
    expect(applyPassportEvent({ status: 'active', metadata: {} }, ev('passport.revoked'))).toMatchObject({ update: null, keyEnforcement: 'none' });
    expect(applyPassportEvent({ status: 'active', metadata: bound() }, ev('passport.revoked', T0))).toMatchObject({ update: null, keyEnforcement: 'none' });
  });
  it('already_revoked → metadata-only clock advance + keys re-deactivated (self-heals a failed earlier deactivation)', () => {
    const r = applyPassportEvent({ status: 'revoked', metadata: bound() }, ev('passport.reinstated', T3));
    expect(r.decision).toEqual({ action: 'noop', reason: 'already_revoked' });
    expect(r.update).toEqual({ metadata: expect.any(Object) });
    expect(r.keyEnforcement).toBe('deactivate');
  });
  it('already_in_state → clock advance; keys re-asserted toward the target state', () => {
    const s = applyPassportEvent({ status: 'suspended', metadata: bound() }, ev('passport.suspended'));
    expect(s.update).toEqual({ metadata: expect.any(Object) });
    expect(s.keyEnforcement).toBe('deactivate');
    const a = applyPassportEvent({ status: 'active', metadata: bound() }, ev('passport.reinstated'));
    expect(a.keyEnforcement).toBe('reactivate');
  });
  it('suspended_by_org → clock advance only; keys untouched', () => {
    const o = applyPassportEvent({ status: 'suspended', metadata: bound() }, ev('passport.reinstated'));
    expect(o.decision.reason).toBe('suspended_by_org');
    expect(o.update).toEqual({ metadata: expect.any(Object) });
    expect(o.keyEnforcement).toBe('none');
  });
});
