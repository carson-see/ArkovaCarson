import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../config.js', () => ({ config: { frontendUrl: 'https://app.test' } }));
vi.mock('../../email/templates.js', () => ({ buildInvitationEmail: vi.fn() }));
vi.mock('../../email/sender.js', () => ({ sendEmail: vi.fn() }));
vi.mock('../../webhooks/subOrgEvents.js', () => ({ emitSubOrgEvent: vi.fn().mockResolvedValue({ ok: true }) }));

import { db } from '../../utils/db.js';
import { emitSubOrgEvent } from '../../webhooks/subOrgEvents.js';
import { offboardSubOrgCore } from './orgSubOrgs.js';

const parent = '22222222-2222-4222-8222-222222222222';
const child = '44444444-4444-4444-8444-444444444444';
const actor = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('offboarding transaction boundary', () => {
  beforeEach(() => {
    vi.mocked(db.rpc).mockReset();
    vi.mocked(emitSubOrgEvent).mockClear();
    vi.mocked(db.from).mockReset();
    // A worker balance read would become stale before reclaim/suspend. SQL
    // must choose the amount while holding the child and credit row locks.
    vi.mocked(db.from).mockImplementation(() => { throw new Error('non-atomic balance read'); });
  });

  it.each(['user', 'api_key'] as const)('offboards a %s caller in one authenticated RPC', async (kind) => {
    let resolveRpc!: (value: never) => void;
    vi.mocked(db.rpc).mockImplementation(() => new Promise((resolve) => { resolveRpc = resolve; }) as never);
    const caller = kind === 'user'
      ? { kind, orgId: parent, userId: actor }
      : { kind, orgId: parent, apiKeyId: actor, keyPrefix: 'test' };
    const pending = offboardSubOrgCore(caller, child, 'engagement ended');
    expect(emitSubOrgEvent).not.toHaveBeenCalled();
    resolveRpc({ data: { success: true, reclaimed: 45, already_suspended: false, parent_balance: 145, child_balance: 0 }, error: null } as never);
    const result = await pending;
    expect(result).toEqual({ status: 200, body: { reclaimed: 45, suspended: true, alreadySuspended: false } });
    expect(db.from).not.toHaveBeenCalled();
    expect(emitSubOrgEvent).toHaveBeenCalledTimes(3);
    expect(emitSubOrgEvent).toHaveBeenNthCalledWith(1, {
      eventType: 'suborg.credits_reclaimed', parentOrgId: parent, childOrgId: child,
      data: { amount: -45, parent_balance: 145, child_balance: 0, note: 'offboarding: engagement ended' },
    });
    expect(emitSubOrgEvent).toHaveBeenNthCalledWith(2, {
      eventType: 'suborg.suspended', parentOrgId: parent, childOrgId: child, data: { reason: 'engagement ended' },
    });
    expect(emitSubOrgEvent).toHaveBeenNthCalledWith(3, {
      eventType: 'suborg.offboarded', parentOrgId: parent, childOrgId: child, data: { reclaimed: 45, reason: 'engagement ended' },
    });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith(
      kind === 'user' ? 'offboard_suborg' : 'offboard_suborg_as_api_key',
      { p_parent_org_id: parent, p_sub_org_id: child, p_reason: 'engagement ended',
        [kind === 'user' ? 'p_caller_user_id' : 'p_caller_api_key_id']: actor },
    );
  });

  it.each([null, {}, { success: false }, { success: true }, { success: true, reclaimed: -1 }, { success: true, reclaimed: 0.5 }])(
    'does not report suspension on an invalid upstream result %j', async (data) => {
      vi.mocked(db.rpc).mockResolvedValue({ data, error: null } as never);
      const result = await offboardSubOrgCore({ kind: 'user', orgId: parent, userId: actor }, child, null);
      expect(result.status).toBe(502);
      expect(result.body).toEqual({ error: 'unknown_error' });
      expect(emitSubOrgEvent).not.toHaveBeenCalled();
    },
  );

  it('maps a refused authority check without claiming credit movement', async () => {
    vi.mocked(db.rpc).mockResolvedValue({ data: { success: false, error: 'parent_admin_required' }, error: null } as never);
    expect(await offboardSubOrgCore({ kind: 'user', orgId: parent, userId: actor }, child, null))
      .toEqual({ status: 403, body: { error: 'parent_admin_required' } });
  });

  it.each([
    {}, { parent_balance: 145 }, { parent_balance: '145', child_balance: 0 },
    { parent_balance: Number.NaN, child_balance: 0 },
    { parent_balance: 145, child_balance: Number.POSITIVE_INFINITY },
    { parent_balance: -1, child_balance: 0 }, { parent_balance: 145, child_balance: 0.5 },
  ])('does not emit committed-state events with malformed credit balances %j', async (balances) => {
    vi.mocked(db.rpc).mockResolvedValue({ data: { success: true, reclaimed: 45, already_suspended: false, ...balances }, error: null } as never);
    expect(await offboardSubOrgCore({ kind: 'user', orgId: parent, userId: actor }, child, null))
      .toEqual({ status: 502, body: { error: 'unknown_error' } });
    expect(emitSubOrgEvent).not.toHaveBeenCalled();
    expect(db.from).not.toHaveBeenCalled();
  });

  it('does not invent a committed state on transaction or transport failure', async () => {
    vi.mocked(db.rpc).mockResolvedValue({ data: null, error: { message: 'private upstream fault' } } as never);
    expect(await offboardSubOrgCore({ kind: 'user', orgId: parent, userId: actor }, child, null))
      .toEqual({ status: 503, body: { error: 'offboard_unavailable' } });
    expect(emitSubOrgEvent).not.toHaveBeenCalled();
  });

  it.each(['user', 'api_key'] as const)('does not repeat a %s reclaim or suspension on retry', async (kind) => {
    vi.mocked(db.rpc).mockResolvedValue({ data: { success: true, reclaimed: 0, already_suspended: true, parent_balance: 145, child_balance: 0 }, error: null } as never);
    const caller = kind === 'user' ? { kind, orgId: parent, userId: actor } : { kind, orgId: parent, apiKeyId: actor, keyPrefix: 'test' };
    expect((await offboardSubOrgCore(caller, child, null)).status).toBe(200);
    expect(emitSubOrgEvent).toHaveBeenCalledExactlyOnceWith({
      eventType: 'suborg.offboarded', parentOrgId: parent, childOrgId: child, data: { reclaimed: 0, reason: null },
    });
  });
});
