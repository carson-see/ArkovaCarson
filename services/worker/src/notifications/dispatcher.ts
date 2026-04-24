import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

export type NotificationType =
  | 'queue_run_completed'
  | 'rule_fired'
  | 'version_available_for_review'
  | 'treasury_alert'
  | 'anchor_revoked';

export interface NotificationPayload {
  type: NotificationType;
  userId: string;
  organizationId?: string;
  payload: Record<string, unknown>;
}

function toRow(n: NotificationPayload) {
  return {
    user_id: n.userId,
    organization_id: n.organizationId ?? null,
    type: n.type,
    payload: n.payload,
  };
}

export async function emitNotification(notification: NotificationPayload): Promise<void> {
  try {
    const { error } = await db.from('notifications').insert(toRow(notification));

    if (error) {
      logger.error({ error, type: notification.type }, 'Failed to emit notification');
    }
  } catch (err) {
    logger.error({ error: err, type: notification.type }, 'Notification dispatch threw');
  }
}

export async function emitBulkNotifications(
  notifications: NotificationPayload[],
): Promise<void> {
  if (notifications.length === 0) return;

  try {
    const { error } = await db.from('notifications').insert(notifications.map(toRow));

    if (error) {
      logger.error({ error, count: notifications.length }, 'Bulk notification insert failed');
    }
  } catch (err) {
    logger.error({ error: err }, 'Bulk notification dispatch threw');
  }
}

export async function getUnreadCount(userId: string): Promise<number> {
  const { count, error } = await db.from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('read_at', null);

  if (error) {
    logger.error({ error }, 'Failed to get unread notification count');
    return 0;
  }

  return count ?? 0;
}

export async function markRead(notificationIds: string[], userId: string): Promise<void> {
  const { error } = await db.from('notifications')
    .update({ read_at: new Date().toISOString() })
    .in('id', notificationIds)
    .eq('user_id', userId);

  if (error) {
    logger.error({ error }, 'Failed to mark notifications as read');
  }
}
