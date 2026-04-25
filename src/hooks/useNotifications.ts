/**
 * useNotifications — SCRUM-1094 (ADMIN-VIEW-03).
 *
 * Polls `user_notifications` (migration 0240) every POLL_INTERVAL_MS for
 * the signed-in user's recent notifications + unread count. RLS enforces
 * that a user can only see/update their own rows.
 *
 * Read state is owned server-side (RLS-scoped UPDATE). The hook just
 * reflects what's there. Mark-read actions optimistically update the
 * local state for snappy UX, then re-poll on the next interval.
 *
 * Notification types (from migration 0240's enum):
 *   queue_run_completed, rule_fired, version_available_for_review,
 *   treasury_alert, anchor_revoked
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

export type NotificationKind =
  | 'queue_run_completed'
  | 'rule_fired'
  | 'version_available_for_review'
  | 'treasury_alert'
  | 'anchor_revoked';

export interface Notification {
  id: string;
  user_id: string;
  organization_id: string | null;
  kind: NotificationKind;
  title: string;
  body: string | null;
  /** Resource the notification points at (anchor id, rule id, etc.) for deep-link resolution. */
  target_id: string | null;
  /** Free-form extras the dispatcher emits. Always non-PII per CLAUDE.md §1.4. */
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

const POLL_INTERVAL_MS = 30_000;
const MAX_PANEL_ITEMS = 100;

interface UseNotificationsReturn {
  notifications: Notification[];
  unreadCount: number;
  loading: boolean;
  error: string | null;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useNotifications(): UseNotificationsReturn {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const userIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // The RLS policy `notifications_select_own` from migration 0240 already
      // scopes to auth.uid() — so we don't need an explicit user_id eq filter.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: fetchErr } = await (supabase as any)
        .from('user_notifications')
        .select('id, user_id, organization_id, kind, title, body, target_id, metadata, read_at, created_at')
        .order('created_at', { ascending: false })
        .limit(MAX_PANEL_ITEMS);
      if (fetchErr) {
        setError(fetchErr.message);
        return;
      }
      setNotifications((data ?? []) as Notification[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function init() {
      const { data } = await supabase.auth.getUser();
      if (!data.user) {
        if (!cancelled) {
          setLoading(false);
          setNotifications([]);
        }
        return;
      }
      userIdRef.current = data.user.id;
      if (cancelled) return;
      await refresh();
      timer = setInterval(() => {
        if (!cancelled) void refresh();
      }, POLL_INTERVAL_MS);
    }

    void init();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [refresh]);

  const markRead = useCallback(async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id && n.read_at === null ? { ...n, read_at: new Date().toISOString() } : n)),
    );
    // RLS policy `notifications_update_own` scopes the update to auth.uid().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from('user_notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id);
  }, []);

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    setNotifications((prev) => prev.map((n) => (n.read_at === null ? { ...n, read_at: now } : n)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any)
      .from('user_notifications')
      .update({ read_at: now })
      .is('read_at', null);
  }, []);

  const unreadCount = useMemo(
    () => notifications.reduce((acc, n) => (n.read_at === null ? acc + 1 : acc), 0),
    [notifications],
  );

  return { notifications, unreadCount, loading, error, markRead, markAllRead, refresh };
}

/**
 * Resolve a notification to its in-app deep-link route.
 * Centralized here so the panel doesn't need to know about route conventions.
 */
export function notificationDeepLink(n: Notification): string | null {
  switch (n.kind) {
    case 'anchor_revoked':
      return n.target_id ? `/records/${n.target_id}` : null;
    case 'rule_fired':
      return n.target_id ? `/admin/rules/${n.target_id}` : null;
    case 'version_available_for_review':
      return n.target_id ? `/records/${n.target_id}` : null;
    case 'queue_run_completed':
      return '/admin/queues';
    case 'treasury_alert':
      return '/admin/treasury';
    default:
      return null;
  }
}
