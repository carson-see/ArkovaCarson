/**
 * SCRUM-1652 ORG-HIER-02 / ORG-08 — orgSuspensionGuard tests.
 *
 * Covers the three decision branches the guard exposes to write-path callers:
 * active org -> ok, suspended org -> 403-shape with friendly message,
 * RPC failure -> guard_lookup_failed (caller fails closed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();

vi.mock('./db.js', () => ({
  db: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { ensureOrgNotSuspended } = await import('./orgSuspensionGuard.js');

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('ensureOrgNotSuspended (SCRUM-1652 ORG-08)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ok=true when is_org_suspended() returns false', async () => {
    rpcMock.mockResolvedValueOnce({ data: false, error: null });
    const result = await ensureOrgNotSuspended(ORG_ID);
    expect(result).toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith('is_org_suspended', { p_org_id: ORG_ID });
  });

  it('returns ok=false code=org_suspended with admin-friendly message when suspended', async () => {
    rpcMock.mockResolvedValueOnce({ data: true, error: null });
    const result = await ensureOrgNotSuspended(ORG_ID);
    if (result.ok) throw new Error('expected suspended');
    expect(result.code).toBe('org_suspended');
    expect(result.message).toContain('suspended');
    expect(result.message).toContain('parent');
  });

  it('returns ok=false code=guard_lookup_failed on RPC error (caller fails closed)', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'connection lost' } });
    const result = await ensureOrgNotSuspended(ORG_ID);
    if (result.ok) throw new Error('expected guard_lookup_failed');
    expect(result.code).toBe('guard_lookup_failed');
    expect(result.message).toContain('connection lost');
  });

  it('treats data=null (org row missing) as ok — not suspended (defensive default)', async () => {
    // is_org_suspended is `coalesce(.., false)` so data=null only happens
    // if the RPC itself returns null without error. Per the SQL, this
    // shouldn't occur, but the worker contract should fail-open here so
    // an RPC quirk doesn't break the entire write path of a valid org.
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    const result = await ensureOrgNotSuspended(ORG_ID);
    expect(result).toEqual({ ok: true });
  });
});
