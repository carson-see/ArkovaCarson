/**
 * Account Deletion Tests — GDPR Art. 17 (PII-02)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { handleAccountDelete, type AccountDeleteDeps } from './account-delete.js';

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

function mockReq(): Request {
  return {} as Request;
}

describe('handleAccountDelete', () => {
  let deps: AccountDeleteDeps;
  let mockRpc: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRpc = vi.fn().mockResolvedValue({ data: { success: true }, error: null });

    deps = {
      db: {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: 'user-123', deleted_at: null },
                error: null,
              }),
            }),
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        }),
        rpc: mockRpc,
        auth: {
          admin: {
            deleteUser: vi.fn().mockResolvedValue({ error: null }),
          },
        },
      } as unknown as AccountDeleteDeps['db'],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    };
  });

  it('returns 404 for non-existent profile', async () => {
    deps.db = {
      ...deps.db,
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } }),
          }),
        }),
      }),
    } as unknown as AccountDeleteDeps['db'];

    const res = mockRes();
    await handleAccountDelete('user-404', deps, mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Account not found' });
  });

  it('returns 409 for already-deleted account', async () => {
    deps.db = {
      ...deps.db,
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({
              data: { id: 'user-123', deleted_at: '2026-03-16T00:00:00Z' },
              error: null,
            }),
          }),
        }),
      }),
    } as unknown as AccountDeleteDeps['db'];

    const res = mockRes();
    await handleAccountDelete('user-123', deps, mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'Account already deleted' });
  });

  it('successfully deletes account and returns success', async () => {
    const res = mockRes();
    await handleAccountDelete('user-123', deps, mockReq(), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it('calls anonymize_user_data RPC with correct user ID', async () => {
    const res = mockRes();
    await handleAccountDelete('user-123', deps, mockReq(), res);
    expect(mockRpc).toHaveBeenCalledWith('anonymize_user_data', { p_user_id: 'user-123' });
  });

  it('returns 500 when anonymization RPC fails', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'RPC failed' } });

    const res = mockRes();
    await handleAccountDelete('user-123', deps, mockReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to process account deletion' });
  });

  it('logs info on successful deletion without PII', async () => {
    const res = mockRes();
    await handleAccountDelete('user-123', deps, mockReq(), res);
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-123' }),
      expect.stringContaining('Account deleted'),
    );

    // Negative assertions: ensure no PII leaks into log payload
    const infoMock = deps.logger.info as ReturnType<typeof vi.fn>;
    const logPayload = infoMock.mock.calls[0][0] as Record<string, unknown>;
    expect(logPayload).not.toHaveProperty('actor_email');
    expect(logPayload).not.toHaveProperty('actor_ip');
    expect(logPayload).not.toHaveProperty('actor_user_agent');
    expect(logPayload).not.toHaveProperty('email');
    expect(logPayload).not.toHaveProperty('ip');
    expect(logPayload).not.toHaveProperty('user_agent');
    expect(logPayload).not.toHaveProperty('anonymizeResult');
  });

  it('continues even if auth user deletion fails (non-fatal)', async () => {
    (deps.db.auth.admin.deleteUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      error: { message: 'auth delete failed' },
    });

    const res = mockRes();
    await handleAccountDelete('user-123', deps, mockReq(), res);
    // Should still return success since profile was soft-deleted
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(deps.logger.error).toHaveBeenCalled();
  });
});
