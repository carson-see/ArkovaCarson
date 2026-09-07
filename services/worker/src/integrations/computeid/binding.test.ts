/**
 * Passport ↔ agent binding (stored in `agents.metadata.computeid` for v1) and
 * the pure state-transition decision for inbound passport events.
 *
 * Ordering guard, not a nonce table: every decision is keyed on the SIGNED
 * event timestamp vs the last applied one, so a replayed delivery is a no-op
 * and a late `reinstated` can never undo a later `revoked`. `revoked` is
 * terminal (forward-only, per the partnership's audit model).
 */
import { describe, it, expect } from 'vitest';
import { readBinding, writeBinding, decidePassportEvent, applyPassportEvent } from './binding.js';

const PASSPORT = '0d8f7c1e-2a1b-4c3d-9e8f-1a2b3c4d5e6f';
const T1 = '2026-09-07T10:00:00.000Z';
const T2 = '2026-09-07T11:00:00.000Z';
const T3 = '2026-09-07T12:00:00.000Z';

const bound = (extra: Record<string, unknown> = {}) => ({
  computeid: { issuer: 'computeid', passport_id: PASSPORT, bound_at: T1, receipt_expires_at: T2, ...extra },
  unrelated: { keep: 'me' },
});

describe('readBinding / writeBinding', () => {
  it('returns null for missing, null, non-object or foreign-issuer metadata', () => {
    expect(readBinding(null)).toBeNull();
    expect(readBinding(undefined)).toBeNull();
    expect(readBinding('str')).toBeNull();
    expect(readBinding({})).toBeNull();
    expect(readBinding({ computeid: { issuer: 'other', passport_id: PASSPORT } })).toBeNull();
    expect(readBinding({ computeid: { issuer: 'computeid', passport_id: 'not-a-uuid' } })).toBeNull();
  });
  it('round-trips and preserves unrelated metadata keys', () => {
    const b = readBinding(bound());
    expect(b?.passport_id).toBe(PASSPORT);
    const next = writeBinding(bound(), { ...b!, last_event: 'passport.suspended', last_event_at: T2 });
    expect(next.unrelated).toEqual({ keep: 'me' });
    expect(readBinding(next)?.last_event_at).toBe(T2);
  });
});

describe('decidePassportEvent', () => {
  const ev = (event: 'passport.revoked' | 'passport.suspended' | 'passport.reinstated', timestamp = T2) => ({ event, timestamp });

  it('unbound agent → noop/unbound', () => {
    expect(decidePassportEvent({ status: 'active', metadata: {} }, ev('passport.revoked'))).toEqual({ action: 'noop', reason: 'unbound' });
  });
  it('active + revoked → revoke; active + suspended → suspend; active + reinstated → noop/already_in_state', () => {
    expect(decidePassportEvent({ status: 'active', metadata: bound() }, ev('passport.revoked'))).toEqual({ action: 'revoke', reason: 'applied' });
    expect(decidePassportEvent({ status: 'active', metadata: bound() }, ev('passport.suspended'))).toEqual({ action: 'suspend', reason: 'applied' });
    expect(decidePassportEvent({ status: 'active', metadata: bound() }, ev('passport.reinstated'))).toEqual({ action: 'noop', reason: 'already_in_state' });
  });
  it('suspended + reinstated → reinstate; suspended + suspended → noop; suspended + revoked → revoke', () => {
    expect(decidePassportEvent({ status: 'suspended', metadata: bound() }, ev('passport.reinstated'))).toEqual({ action: 'reinstate', reason: 'applied' });
    expect(decidePassportEvent({ status: 'suspended', metadata: bound() }, ev('passport.suspended'))).toEqual({ action: 'noop', reason: 'already_in_state' });
    expect(decidePassportEvent({ status: 'suspended', metadata: bound() }, ev('passport.revoked'))).toEqual({ action: 'revoke', reason: 'applied' });
  });
  it('revoked is terminal — every event is noop/already_revoked', () => {
    for (const e of ['passport.revoked', 'passport.suspended', 'passport.reinstated'] as const) {
      expect(decidePassportEvent({ status: 'revoked', metadata: bound() }, ev(e, T3))).toEqual({ action: 'noop', reason: 'already_revoked' });
    }
  });
  it('an event at or before the last applied timestamp is stale (replay / out-of-order) → noop', () => {
    const m = bound({ last_event: 'passport.revoked', last_event_at: T2 });
    expect(decidePassportEvent({ status: 'suspended', metadata: m }, ev('passport.reinstated', T1))).toEqual({ action: 'noop', reason: 'stale_event' });
    expect(decidePassportEvent({ status: 'suspended', metadata: m }, ev('passport.reinstated', T2))).toEqual({ action: 'noop', reason: 'stale_event' });
    expect(decidePassportEvent({ status: 'suspended', metadata: m }, ev('passport.reinstated', T3))).toEqual({ action: 'reinstate', reason: 'applied' });
  });
});

describe('applyPassportEvent', () => {
  it('revoke → status revoked + revoked_at = event ts + binding advanced', () => {
    const r = applyPassportEvent({ status: 'active', metadata: bound() }, { event: 'passport.revoked', timestamp: T2 });
    expect(r.decision.action).toBe('revoke');
    expect(r.update).toMatchObject({ status: 'revoked', revoked_at: T2 });
    expect(readBinding(r.update?.metadata)).toMatchObject({ last_event: 'passport.revoked', last_event_at: T2 });
    expect((r.update?.metadata as Record<string, unknown>).unrelated).toEqual({ keep: 'me' });
  });
  it('suspend → status suspended + suspended_at; reinstate → active + suspended_at null', () => {
    const s = applyPassportEvent({ status: 'active', metadata: bound() }, { event: 'passport.suspended', timestamp: T2 });
    expect(s.update).toMatchObject({ status: 'suspended', suspended_at: T2 });
    const a = applyPassportEvent({ status: 'suspended', metadata: bound() }, { event: 'passport.reinstated', timestamp: T3 });
    expect(a.update).toMatchObject({ status: 'active', suspended_at: null });
  });
  it('noop decisions produce no update', () => {
    const r = applyPassportEvent({ status: 'revoked', metadata: bound() }, { event: 'passport.reinstated', timestamp: T3 });
    expect(r.decision.action).toBe('noop');
    expect(r.update).toBeNull();
  });
});
