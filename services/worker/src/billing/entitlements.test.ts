/**
 * Verified-Identity Entitlement Service Tests (PAY-01 / SCRUM-2384)
 *
 * TDD (Constitution §1.1, §1.7):
 *   - verified  → granted (entitlement row written)
 *   - declined / canceled / requires_input → NOT granted
 *   - lapsed (subscription deleted) → revoked (open window closed)
 *   - read gate resolves on the CURRENT period (valid_from <= now < valid_until)
 *     AND the subscription's current period (SCRUM-1791) — never a stale row
 *
 * No real Stripe / DB — the db client is mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger, mockDbFrom, handles } = vi.hoisted(() => {
  const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  // entitlements read: select(...).eq('entitlement_type', x).eq('user_id'|'org_id', y)
  //   first .eq() returns a chain; second .eq() resolves to { data, error }.
  const entitlementsInsert = vi.fn();
  const entitlementsReadResolve = vi.fn(); // terminal: the second .eq()
  const entitlementsSelectChain = { eq: vi.fn(() => ({ eq: entitlementsReadResolve })) };
  const entitlementsSelect = vi.fn(() => entitlementsSelectChain);

  // close-the-window UPDATE (exact chain order in entitlements.ts):
  //   update(patch).eq('entitlement_type', x).is('valid_until', null).eq('user_id'|'org_id', y)
  // entitlementsUpdateEq2 is the terminal that resolves { error }.
  const entitlementsUpdateEq2 = vi.fn((_col?: string, _val?: unknown) => undefined as unknown);
  const entitlementsUpdateIs = vi.fn((_col?: string, _val?: unknown) => ({ eq: entitlementsUpdateEq2 }));
  const entitlementsUpdateEq1 = vi.fn((_col?: string, _val?: unknown) => ({ is: entitlementsUpdateIs }));
  const entitlementsUpdate = vi.fn((_patch?: Record<string, unknown>) => ({ eq: entitlementsUpdateEq1 }));

  // subscriptions: select(...).eq('user_id', x).order(...).limit(1).maybeSingle()
  const subsMaybeSingle = vi.fn();
  const subsLimit = vi.fn(() => ({ maybeSingle: subsMaybeSingle }));
  const subsOrder = vi.fn(() => ({ limit: subsLimit }));
  const subsEq = vi.fn(() => ({ order: subsOrder, maybeSingle: subsMaybeSingle, limit: subsLimit }));
  const subsSelect = vi.fn(() => ({ eq: subsEq }));

  const handles = {
    entitlementsInsert,
    entitlementsSelect,
    entitlementsSelectChain,
    entitlementsReadResolve,
    entitlementsUpdate,
    entitlementsUpdateEq1,
    entitlementsUpdateEq2,
    entitlementsUpdateIs,
    subsSelect,
    subsEq,
    subsOrder,
    subsLimit,
    subsMaybeSingle,
  };

  const mockDbFrom = vi.fn((table: string) => {
    switch (table) {
      case 'entitlements':
        return {
          insert: entitlementsInsert,
          select: entitlementsSelect,
          update: entitlementsUpdate,
        };
      case 'subscriptions':
        return { select: subsSelect };
      default:
        throw new Error(`Unexpected table in entitlements test: ${table}`);
    }
  });

  return { mockLogger, mockDbFrom, handles };
});

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/db.js', () => ({ db: { from: mockDbFrom } }));

import {
  VERIFIED_IDENTITY_ENTITLEMENT,
  grantVerifiedIdentityEntitlement,
  revokeVerifiedIdentityEntitlement,
  resolveVerifiedEntitlement,
  hasActiveVerifiedEntitlement,
} from './entitlements.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-06-23T12:00:00.000Z');

function setupDefaults() {
  handles.entitlementsInsert.mockResolvedValue({ error: null });
  // close-the-window UPDATE chain: update().eq().is().eq() — eq2 is terminal.
  handles.entitlementsUpdateEq2.mockResolvedValue({ error: null });
  handles.entitlementsUpdateIs.mockReturnValue({ eq: handles.entitlementsUpdateEq2 });
  handles.entitlementsUpdateEq1.mockReturnValue({ is: handles.entitlementsUpdateIs });
  handles.entitlementsUpdate.mockReturnValue({ eq: handles.entitlementsUpdateEq1 });
  handles.entitlementsSelectChain.eq.mockReturnValue({ eq: handles.entitlementsReadResolve });
  // entitlements select default: one open active row
  handles.entitlementsReadResolve.mockResolvedValue({
    data: [{ entitlement_type: VERIFIED_IDENTITY_ENTITLEMENT, valid_from: '2026-06-01T00:00:00Z', valid_until: null }],
    error: null,
  });
  // subscription default: active, current period spans NOW
  handles.subsMaybeSingle.mockResolvedValue({
    data: {
      status: 'active',
      current_period_start: '2026-06-15T00:00:00Z',
      current_period_end: '2026-07-15T00:00:00Z',
    },
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDefaults();
});

// ─── grant (verified → granted) ──────────────────────────────────────────

describe('grantVerifiedIdentityEntitlement', () => {
  it('verified → closes any open window then inserts one fresh active row (idempotent)', async () => {
    await grantVerifiedIdentityEntitlement({ userId: USER, orgId: ORG }, NOW);

    expect(mockDbFrom).toHaveBeenCalledWith('entitlements');
    // idempotency: close-the-window first (re-verify must not leave two open rows)
    expect(handles.entitlementsUpdate).toHaveBeenCalledTimes(1);
    expect(handles.entitlementsUpdateEq1).toHaveBeenCalledWith('entitlement_type', VERIFIED_IDENTITY_ENTITLEMENT);
    expect(handles.entitlementsUpdateIs).toHaveBeenCalledWith('valid_until', null);
    // then insert the fresh open row
    expect(handles.entitlementsInsert).toHaveBeenCalledTimes(1);
    const [row] = handles.entitlementsInsert.mock.calls[0]!;
    expect(row).toMatchObject({
      user_id: USER,
      org_id: ORG,
      entitlement_type: VERIFIED_IDENTITY_ENTITLEMENT,
      source: 'subscription',
      valid_from: NOW.toISOString(),
      valid_until: null,
    });
  });

  it('grants with a null org (individual user) without throwing', async () => {
    await grantVerifiedIdentityEntitlement({ userId: USER, orgId: null }, NOW);
    const [row] = handles.entitlementsInsert.mock.calls[0]!;
    expect(row.user_id).toBe(USER);
    expect(row.org_id).toBeNull();
  });

  it('rejects an invalid (non-UUID) userId via Zod — no DB write', async () => {
    await expect(
      grantVerifiedIdentityEntitlement({ userId: 'not-a-uuid', orgId: ORG }, NOW),
    ).rejects.toThrow();
    expect(handles.entitlementsInsert).not.toHaveBeenCalled();
    expect(handles.entitlementsUpdate).not.toHaveBeenCalled();
  });

  it('throws when the insert fails so the webhook is retried', async () => {
    handles.entitlementsInsert.mockResolvedValue({ error: { message: 'boom', code: 'XX000' } });
    await expect(
      grantVerifiedIdentityEntitlement({ userId: USER, orgId: ORG }, NOW),
    ).rejects.toBeTruthy();
  });
});

// ─── revoke (lapsed → revoked) ───────────────────────────────────────────

describe('revokeVerifiedIdentityEntitlement', () => {
  it('lapsed → closes the open window (valid_until = now) for the user', async () => {
    await revokeVerifiedIdentityEntitlement({ userId: USER, orgId: null }, NOW);

    expect(handles.entitlementsUpdate).toHaveBeenCalledTimes(1);
    const [patch] = handles.entitlementsUpdate.mock.calls[0]!;
    expect(patch).toMatchObject({ valid_until: NOW.toISOString() });
    // only targets the OPEN window (valid_until IS NULL) for this entitlement type
    expect(handles.entitlementsUpdateEq1).toHaveBeenCalledWith('entitlement_type', VERIFIED_IDENTITY_ENTITLEMENT);
    expect(handles.entitlementsUpdateIs).toHaveBeenCalledWith('valid_until', null);
    expect(handles.entitlementsUpdateEq2).toHaveBeenCalledWith('user_id', USER);
  });

  it('scopes revoke to org_id when no userId is present', async () => {
    await revokeVerifiedIdentityEntitlement({ userId: null, orgId: ORG }, NOW);
    expect(handles.entitlementsUpdateEq2).toHaveBeenCalledWith('org_id', ORG);
  });

  it('no-ops (no DB call) when neither userId nor orgId is provided', async () => {
    await revokeVerifiedIdentityEntitlement({ userId: null, orgId: null }, NOW);
    expect(handles.entitlementsUpdate).not.toHaveBeenCalled();
  });

  it('throws when the revoke UPDATE fails', async () => {
    handles.entitlementsUpdateEq2.mockResolvedValue({ error: { message: 'no', code: 'XX000' } });
    await expect(
      revokeVerifiedIdentityEntitlement({ userId: USER, orgId: null }, NOW),
    ).rejects.toBeTruthy();
  });
});

// ─── pure resolver (current-period window) ───────────────────────────────

describe('resolveVerifiedEntitlement (pure)', () => {
  const within = [{ entitlement_type: VERIFIED_IDENTITY_ENTITLEMENT, valid_from: '2026-06-01T00:00:00Z', valid_until: null }];
  const currentSub = { status: 'active', current_period_start: '2026-06-15T00:00:00Z', current_period_end: '2026-07-15T00:00:00Z' };

  it('grants when an open row covers now AND subscription period is current', () => {
    expect(resolveVerifiedEntitlement({ rows: within, subscription: currentSub, now: NOW })).toBe(true);
  });

  it('denies when there is no entitlement row (declined/never granted)', () => {
    expect(resolveVerifiedEntitlement({ rows: [], subscription: currentSub, now: NOW })).toBe(false);
  });

  it('denies when the entitlement window is already closed (valid_until <= now) — lapsed/revoked', () => {
    expect(
      resolveVerifiedEntitlement({
        rows: [{ entitlement_type: VERIFIED_IDENTITY_ENTITLEMENT, valid_from: '2026-06-01T00:00:00Z', valid_until: '2026-06-20T00:00:00Z' }],
        subscription: currentSub,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('denies when valid_from is in the future', () => {
    expect(
      resolveVerifiedEntitlement({
        rows: [{ entitlement_type: VERIFIED_IDENTITY_ENTITLEMENT, valid_from: '2026-07-01T00:00:00Z', valid_until: null }],
        subscription: currentSub,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('SCRUM-1791: denies on a STALE subscription period even if the entitlement row is open', () => {
    // current_period_end is 18 days in the past — must NOT gate on this stale window
    expect(
      resolveVerifiedEntitlement({
        rows: within,
        subscription: { status: 'active', current_period_start: '2026-05-01T00:00:00Z', current_period_end: '2026-06-05T00:00:00Z' },
        now: NOW,
      }),
    ).toBe(false);
  });

  it('denies when the subscription is not active (e.g. canceled/past_due)', () => {
    expect(
      resolveVerifiedEntitlement({
        rows: within,
        subscription: { ...currentSub, status: 'canceled' },
        now: NOW,
      }),
    ).toBe(false);
  });

  it('denies (fail-closed) when there is no subscription row at all', () => {
    expect(resolveVerifiedEntitlement({ rows: within, subscription: null, now: NOW })).toBe(false);
  });

  it('grants when subscription has no period end yet but is active and within start (trialing-style open end)', () => {
    // current_period_end null but active + started → not stale; entitlement window governs.
    expect(
      resolveVerifiedEntitlement({
        rows: within,
        subscription: { status: 'active', current_period_start: '2026-06-15T00:00:00Z', current_period_end: null },
        now: NOW,
      }),
    ).toBe(true);
  });

  it('ignores unrelated entitlement_type rows', () => {
    expect(
      resolveVerifiedEntitlement({
        rows: [{ entitlement_type: 'credential_source_import', valid_from: '2026-06-01T00:00:00Z', valid_until: null }],
        subscription: currentSub,
        now: NOW,
      }),
    ).toBe(false);
  });
});

// ─── db-backed read gate ─────────────────────────────────────────────────

describe('hasActiveVerifiedEntitlement (db-backed)', () => {
  it('reads the entitlement rows + current subscription period and grants', async () => {
    const ok = await hasActiveVerifiedEntitlement({ userId: USER, orgId: ORG }, NOW);
    expect(ok).toBe(true);
    expect(mockDbFrom).toHaveBeenCalledWith('entitlements');
    expect(mockDbFrom).toHaveBeenCalledWith('subscriptions');
  });

  it('denies when the subscription period is stale (SCRUM-1791) even with an open entitlement', async () => {
    handles.subsMaybeSingle.mockResolvedValue({
      data: { status: 'active', current_period_start: '2026-05-01T00:00:00Z', current_period_end: '2026-06-05T00:00:00Z' },
      error: null,
    });
    const ok = await hasActiveVerifiedEntitlement({ userId: USER, orgId: ORG }, NOW);
    expect(ok).toBe(false);
  });

  it('fails closed (false) when the entitlements read errors', async () => {
    handles.entitlementsReadResolve.mockResolvedValue({ data: null, error: { message: 'db down' } });
    const ok = await hasActiveVerifiedEntitlement({ userId: USER, orgId: ORG }, NOW);
    expect(ok).toBe(false);
  });

  it('fails closed (false) when the subscription read errors', async () => {
    handles.subsMaybeSingle.mockResolvedValue({ data: null, error: { message: 'db down' } });
    const ok = await hasActiveVerifiedEntitlement({ userId: USER, orgId: ORG }, NOW);
    expect(ok).toBe(false);
  });
});
