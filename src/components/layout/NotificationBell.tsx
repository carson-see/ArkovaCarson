/**
 * NotificationBell — SCRUM-1094 (ADMIN-VIEW-03).
 *
 * Bell icon + unread badge in the header. Click opens an inline panel
 * listing the latest 100 notifications with deep links + mark-as-read.
 *
 * Polling cadence + RLS scoping live in `useNotifications`. This component
 * is the presentation layer.
 *
 * Implementation note: uses a controlled boolean + click-outside instead of
 * Radix's portal-based DropdownMenu so the panel is reachable in jsdom for
 * unit tests and screen readers don't lose focus to a portal.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  useNotifications,
  notificationDeepLink,
  type Notification,
} from '@/hooks/useNotifications';

const PANEL_LABELS = {
  HEADING: 'Notifications',
  EMPTY_TITLE: 'No notifications yet',
  EMPTY_BODY: "We'll let you know when there's an update on your records, rules, or treasury.",
  MARK_ALL_READ: 'Mark all read',
} as const;

const TYPE_TITLE: Record<string, string> = {
  queue_run_completed: 'Queue run finished',
  rule_fired: 'A rule fired',
  version_available_for_review: 'New version ready for review',
  treasury_alert: 'Treasury alert',
  anchor_revoked: 'Record revoked',
};

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.max(1, Math.floor(diff / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

interface RowProps {
  notification: Notification;
  onSelect: (n: Notification) => void;
}

function NotificationRow({ notification, onSelect }: Readonly<RowProps>) {
  const unread = notification.read_at === null;
  const { title, body } = notification.payload ?? {};
  const heading = title || TYPE_TITLE[notification.type] || 'Notification';
  return (
    <button
      type="button"
      onClick={() => onSelect(notification)}
      className={`w-full text-left px-3 py-2 hover:bg-muted/50 focus:bg-muted/50 focus:outline-none border-b border-border/50 last:border-b-0 ${
        unread ? 'bg-primary/5' : ''
      }`}
      aria-label={`${heading} — ${unread ? 'unread' : 'read'}`}
    >
      <div className="flex items-start gap-2">
        {unread && (
          <span
            className="mt-1.5 h-2 w-2 rounded-full bg-primary shrink-0"
            aria-hidden="true"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${unread ? 'font-medium' : 'font-normal'}`}>{heading}</p>
          {body && (
            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{body}</p>
          )}
          <p className="text-[11px] text-muted-foreground mt-1">{formatRelative(notification.created_at)}</p>
        </div>
      </div>
    </button>
  );
}

export function NotificationBell() {
  const navigate = useNavigate();
  const { notifications, unreadCount, loading, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const handleSelect = async (n: Notification) => {
    if (n.read_at === null) {
      await markRead(n.id);
    }
    const href = notificationDeepLink(n);
    setOpen(false);
    if (href) navigate(href);
  };

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={
          unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium leading-none text-destructive-foreground"
            aria-hidden="true"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-96 max-h-[80vh] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <p className="text-sm font-semibold">{PANEL_LABELS.HEADING}</p>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => void markAllRead()}
              >
                <CheckCheck className="mr-1 h-3.5 w-3.5" />
                {PANEL_LABELS.MARK_ALL_READ}
              </Button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {loading && notifications.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
            ) : notifications.length === 0 ? (
              <div className="p-6 text-center">
                <p className="text-sm font-medium">{PANEL_LABELS.EMPTY_TITLE}</p>
                <p className="text-xs text-muted-foreground mt-1">{PANEL_LABELS.EMPTY_BODY}</p>
              </div>
            ) : (
              notifications.map((n) => (
                <NotificationRow
                  key={n.id}
                  notification={n}
                  onSelect={handleSelect}
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
