import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockInsert = vi.fn().mockResolvedValue({ error: null });
const mockSelect = vi.fn().mockReturnThis();
const mockUpdate = vi.fn().mockReturnThis();
const mockEq = vi.fn().mockReturnThis();
const mockIs = vi.fn().mockResolvedValue({ count: 3, error: null });
const mockIn = vi.fn().mockReturnThis();

vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn(() => ({
      insert: mockInsert,
      select: mockSelect,
      update: mockUpdate,
      eq: mockEq,
      is: mockIs,
      in: mockIn,
    })),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  emitNotification,
  emitBulkNotifications,
  getUnreadCount,
  markRead,
} from './dispatcher.js';

describe('emitNotification', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts a notification row', async () => {
    await emitNotification({
      type: 'queue_run_completed',
      userId: 'u1',
      organizationId: 'org1',
      payload: { jobId: 'j1', processedCount: 10 },
    });

    expect(mockInsert).toHaveBeenCalledWith({
      user_id: 'u1',
      organization_id: 'org1',
      type: 'queue_run_completed',
      payload: { jobId: 'j1', processedCount: 10 },
    });
  });

  it('does not throw on insert error', async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: 'DB error' } });
    await expect(emitNotification({
      type: 'rule_fired',
      userId: 'u1',
      payload: { ruleId: 'r1' },
    })).resolves.toBeUndefined();
  });
});

describe('emitBulkNotifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts multiple notifications in one call', async () => {
    await emitBulkNotifications([
      { type: 'rule_fired', userId: 'u1', payload: { ruleId: 'r1' } },
      { type: 'anchor_revoked', userId: 'u2', organizationId: 'org1', payload: { anchorId: 'a1' } },
    ]);

    expect(mockInsert).toHaveBeenCalledWith([
      { user_id: 'u1', organization_id: null, type: 'rule_fired', payload: { ruleId: 'r1' } },
      { user_id: 'u2', organization_id: 'org1', type: 'anchor_revoked', payload: { anchorId: 'a1' } },
    ]);
  });

  it('skips empty array', async () => {
    await emitBulkNotifications([]);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('getUnreadCount', () => {
  it('returns count of unread notifications', async () => {
    const count = await getUnreadCount('u1');
    expect(count).toBe(3);
  });
});

describe('markRead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEq.mockResolvedValue({ error: null });
  });

  it('updates read_at for specified notifications', async () => {
    await markRead(['n1', 'n2'], 'u1');
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockIn).toHaveBeenCalledWith('id', ['n1', 'n2']);
  });
});
