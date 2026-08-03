/**
 * useNotifications Hook Tests
 *
 * No test file existed for this hook prior to the 2026-08-03 bug sprint.
 * Covers the initial fetch/poll-init path plus markRead/markAllRead,
 * including the silent-failure bug fix: both mutations previously awaited
 * their Supabase `.update()` call without capturing `{ error }` at all, so a
 * failed write left the optimistic "read" state on screen — lying to the
 * user — until the next 30s poll silently reverted it with no explanation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mockFrom = vi.hoisted(() => vi.fn());
const mockGetUser = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mockFrom,
    auth: { getUser: mockGetUser },
  },
}));

import { useNotifications, notificationDeepLink, type Notification } from './useNotifications';

function selectChain(data: unknown[] | null, error: { message: string } | null = null) {
  return {
    select: vi.fn().mockReturnValue({
      order: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({ data, error }),
      }),
    }),
  };
}

const unreadNotification: Notification = {
  id: 'notif-1',
  user_id: 'user-1',
  organization_id: null,
  type: 'rule_fired',
  payload: { title: 'Rule fired' },
  read_at: null,
  created_at: '2026-08-01T00:00:00.000Z',
};

const readNotification: Notification = {
  id: 'notif-2',
  user_id: 'user-1',
  organization_id: null,
  type: 'queue_run_completed',
  payload: { title: 'Queue done' },
  read_at: '2026-07-31T00:00:00.000Z',
  created_at: '2026-07-31T00:00:00.000Z',
};

describe('useNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  });

  it('loads notifications on mount and computes unreadCount', async () => {
    mockFrom.mockReturnValue(selectChain([unreadNotification, readNotification]));

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.notifications).toHaveLength(2);
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('sets loading false and empty notifications when there is no authenticated user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.notifications).toEqual([]);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('sets error when the initial fetch fails', async () => {
    mockFrom.mockReturnValue(selectChain(null, { message: 'permission denied' }));

    const { result } = renderHook(() => useNotifications());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('permission denied');
    expect(result.current.notifications).toEqual([]);
  });

  it('markRead optimistically marks the notification read and persists the update', async () => {
    mockFrom.mockReturnValueOnce(selectChain([unreadNotification]));

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const mockEq = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValueOnce({ update: vi.fn().mockReturnValue({ eq: mockEq }) });

    await act(async () => {
      await result.current.markRead('notif-1');
    });

    expect(result.current.notifications[0].read_at).not.toBeNull();
    expect(result.current.unreadCount).toBe(0);
    expect(mockEq).toHaveBeenCalledWith('id', 'notif-1');
  });

  // BUG (2026-08-03 bug sprint): markRead's `.update()` result was previously
  // discarded entirely — not even `{ error }` was captured — so a failed
  // write left the optimistic "read" state on screen indefinitely (until the
  // next 30s poll silently reverted it with zero explanation to the user).
  it('markRead reverts the optimistic read state and surfaces the error when the update fails', async () => {
    mockFrom.mockReturnValueOnce(selectChain([unreadNotification]));

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFrom.mockReturnValueOnce({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: { message: 'network error' } }),
      }),
    });

    await act(async () => {
      await result.current.markRead('notif-1');
    });

    expect(result.current.notifications[0].read_at).toBeNull();
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.error).toBe('network error');
  });

  it('markAllRead optimistically marks every unread notification read and persists the update', async () => {
    mockFrom.mockReturnValueOnce(selectChain([unreadNotification, readNotification]));

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const mockIs = vi.fn().mockResolvedValue({ error: null });
    mockFrom.mockReturnValueOnce({ update: vi.fn().mockReturnValue({ is: mockIs }) });

    await act(async () => {
      await result.current.markAllRead();
    });

    expect(result.current.unreadCount).toBe(0);
    expect(mockIs).toHaveBeenCalledWith('read_at', null);
  });

  it('markAllRead reverts the optimistic read state and surfaces the error when the update fails', async () => {
    mockFrom.mockReturnValueOnce(selectChain([unreadNotification]));

    const { result } = renderHook(() => useNotifications());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockFrom.mockReturnValueOnce({
      update: vi.fn().mockReturnValue({
        is: vi.fn().mockResolvedValue({ error: { message: 'permission denied' } }),
      }),
    });

    await act(async () => {
      await result.current.markAllRead();
    });

    expect(result.current.notifications[0].read_at).toBeNull();
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.error).toBe('permission denied');
  });
});

describe('notificationDeepLink', () => {
  it('links anchor_revoked to the record detail route', () => {
    const n: Notification = { ...unreadNotification, type: 'anchor_revoked', payload: { target_id: 'anchor-1' } };
    expect(notificationDeepLink(n)).toContain('anchor-1');
  });

  it('returns null when there is no target_id for a detail-linked type', () => {
    const n: Notification = { ...unreadNotification, type: 'version_available_for_review', payload: {} };
    expect(notificationDeepLink(n)).toBeNull();
  });

  it('returns null for unknown types', () => {
    const n = { ...unreadNotification, type: 'unknown_type' } as unknown as Notification;
    expect(notificationDeepLink(n)).toBeNull();
  });
});
