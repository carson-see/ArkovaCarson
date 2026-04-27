/**
 * NotificationBell tests — SCRUM-1094 (ADMIN-VIEW-03).
 *
 * Asserts:
 *   - Bell renders with no badge when unread count is 0
 *   - Badge renders with the unread count when > 0; clamps to "99+"
 *   - Open panel renders empty state when there are no notifications
 *   - Open panel renders rows for each notification with relative timestamp
 *   - Clicking an unread row marks it read AND navigates to the deep link
 *   - "Mark all read" calls markAllRead and only shows when unread > 0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import type { Notification } from '@/hooks/useNotifications';

const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

const markReadMock = vi.fn();
const markAllReadMock = vi.fn();
const refreshMock = vi.fn();

let mockNotifications: Notification[] = [];
let mockUnread = 0;
let mockLoading = false;

vi.mock('@/hooks/useNotifications', async () => {
  const actual = await vi.importActual<typeof import('./../../hooks/useNotifications')>(
    '@/hooks/useNotifications',
  );
  return {
    ...actual,
    useNotifications: () => ({
      notifications: mockNotifications,
      unreadCount: mockUnread,
      loading: mockLoading,
      error: null,
      markRead: markReadMock,
      markAllRead: markAllReadMock,
      refresh: refreshMock,
    }),
  };
});

import { NotificationBell } from './NotificationBell';

beforeEach(() => {
  navigateMock.mockReset();
  markReadMock.mockReset();
  markAllReadMock.mockReset();
  refreshMock.mockReset();
  mockNotifications = [];
  mockUnread = 0;
  mockLoading = false;
});

const baseRow: Notification = {
  id: 'n1',
  user_id: 'u1',
  organization_id: null,
  type: 'rule_fired',
  payload: {},
  read_at: null,
  created_at: new Date(Date.now() - 30_000).toISOString(),
};

describe('<NotificationBell />', () => {
  it('renders the bell with no badge when unread count is 0', () => {
    const { getByRole, queryByText } = render(<NotificationBell />);
    const trigger = getByRole('button', { name: /Notifications$/ });
    expect(trigger).toBeInTheDocument();
    expect(queryByText(/99\+/)).toBeNull();
  });

  it('renders an unread badge with the count when > 0', () => {
    mockUnread = 3;
    const { getByText, getByRole } = render(<NotificationBell />);
    expect(getByText('3')).toBeInTheDocument();
    // Aria label includes count for screen readers
    expect(getByRole('button', { name: /3 unread/ })).toBeInTheDocument();
  });

  it('clamps badge text to "99+" when there are 100+ unread', () => {
    mockUnread = 250;
    const { getByText } = render(<NotificationBell />);
    expect(getByText('99+')).toBeInTheDocument();
  });

  it('opens the panel and shows empty-state messaging when there are no notifications', async () => {
    const { getByRole, findByText } = render(<NotificationBell />);
    fireEvent.click(getByRole('button', { name: /Notifications/ }));
    expect(await findByText(/No notifications yet/i)).toBeInTheDocument();
  });

  it('opens the panel and lists rows for each notification', async () => {
    mockNotifications = [
      { ...baseRow, id: 'n1', type: 'anchor_revoked', payload: { title: 'Record revoked', target_id: 'a1' } },
      { ...baseRow, id: 'n2', type: 'rule_fired', payload: { title: 'Rule X fired', target_id: 'r1' } },
    ];
    mockUnread = 2;
    const { getByRole, findByText } = render(<NotificationBell />);
    fireEvent.click(getByRole('button', { name: /Notifications/ }));
    expect(await findByText('Record revoked')).toBeInTheDocument();
    expect(await findByText('Rule X fired')).toBeInTheDocument();
  });

  it('clicking an unread row marks it read AND navigates to its deep link', async () => {
    mockNotifications = [
      { ...baseRow, id: 'n1', type: 'anchor_revoked', payload: { title: 'Record revoked', target_id: 'anchor-42' } },
      { ...baseRow, id: 'n2', type: 'rule_fired', payload: { title: 'Rule fired' } },
      { ...baseRow, id: 'n3', type: 'queue_run_completed', payload: { title: 'Queue run' } },
      { ...baseRow, id: 'n4', type: 'treasury_alert', payload: { title: 'Treasury' } },
    ];
    mockUnread = 1;
    const { getByRole, findByLabelText } = render(<NotificationBell />);
    fireEvent.click(getByRole('button', { name: /Notifications/ }));
    const row = await findByLabelText(/Record revoked.*unread/i);
    fireEvent.click(row);
    await waitFor(() => {
      expect(markReadMock).toHaveBeenCalledWith('n1');
      expect(navigateMock).toHaveBeenCalledWith('/records/anchor-42');
    });
  });

  it('"Mark all read" does NOT render when there are zero unread', () => {
    mockUnread = 0;
    const { getByRole, queryByRole } = render(<NotificationBell />);
    fireEvent.click(getByRole('button', { name: /Notifications$/ }));
    expect(queryByRole('button', { name: /Mark all read/i })).toBeNull();
  });

  it('"Mark all read" renders when unread > 0 and calls markAllRead on click', () => {
    mockUnread = 4;
    mockNotifications = [
      { ...baseRow, id: 'n1', type: 'rule_fired', payload: { title: 'Rule X fired', target_id: 'r1' } },
    ];
    const { getByRole } = render(<NotificationBell />);
    fireEvent.click(getByRole('button', { name: /4 unread/ }));
    const markAllBtn = getByRole('button', { name: /Mark all read/i });
    expect(markAllBtn).toBeInTheDocument();
    fireEvent.click(markAllBtn);
    expect(markAllReadMock).toHaveBeenCalled();
  });
});
