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

  it('returns ok=false code=guard_lookup_failed on data=null without error (CodeRabbit fail-closed)', async () => {
    // is_org_suspended is `coalesce(.., false)` so the SQL itself never
    // returns null. An RPC giving back data=null AND error=null is an
    // anomaly — a half-broken pooler, a serialized payload that didn't
    // round-trip, etc. CodeRabbit (PR #689) flagged the prior fail-open
    // here as letting a write path proceed against a degraded DB. The
    // guard now reports the anomaly so the caller's existing
    // `guard_lookup_failed` handling (fail-closed on write paths) fires.
    rpcMock.mockResolvedValueOnce({ data: null, error: null });
    const result = await ensureOrgNotSuspended(ORG_ID);
    if (result.ok) throw new Error('expected guard_lookup_failed');
    expect(result.code).toBe('guard_lookup_failed');
    expect(result.message).toContain('non-boolean');
  });

  it('returns ok=false code=guard_lookup_failed when the RPC promise rejects (CodeRabbit fail-closed)', async () => {
    rpcMock.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await ensureOrgNotSuspended(ORG_ID);
    if (result.ok) throw new Error('expected guard_lookup_failed');
    expect(result.code).toBe('guard_lookup_failed');
    expect(result.message).toContain('socket hang up');
  });
});
