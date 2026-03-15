/**
 * Audit Log Tests
 *
 * @see P1-TS-06
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsert = vi.hoisted(() => vi.fn());
const mockGetUser = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getUser: mockGetUser,
    },
    from: vi.fn(() => ({
      insert: mockInsert,
    })),
  },
}));

import { logAuditEvent } from './auditLog';

describe('logAuditEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts audit event with user info', async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'test@test.com' } },
    });
    mockInsert.mockResolvedValue({ error: null });

    await logAuditEvent({
      eventType: 'ANCHOR_CREATED',
      eventCategory: 'ANCHOR',
      targetType: 'anchor',
      targetId: 'anchor-1',
      orgId: 'org-1',
      details: 'Created anchor',
    });

    expect(mockInsert).toHaveBeenCalledWith({
      event_type: 'ANCHOR_CREATED',
      event_category: 'ANCHOR',
      actor_id: 'user-1',
      actor_email: 'test@test.com',
      target_type: 'anchor',
      target_id: 'anchor-1',
      org_id: 'org-1',
      details: 'Created anchor',
    });
  });

  it('handles null user gracefully', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    mockInsert.mockResolvedValue({ error: null });

    await logAuditEvent({
      eventType: 'PAGE_VIEW',
      eventCategory: 'AUTH',
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: null,
        actor_email: null,
      }),
    );
  });

  it('never throws even when insert fails', async () => {
    mockGetUser.mockRejectedValue(new Error('Auth service down'));

    await expect(
      logAuditEvent({
        eventType: 'ANCHOR_CREATED',
        eventCategory: 'ANCHOR',
      }),
    ).resolves.toBeUndefined();
  });

  it('fills optional fields with null when not provided', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'e@e.com' } } });
    mockInsert.mockResolvedValue({ error: null });

    await logAuditEvent({
      eventType: 'LOGIN',
      eventCategory: 'AUTH',
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        target_type: null,
        target_id: null,
        org_id: null,
        details: null,
      }),
    );
  });
});
