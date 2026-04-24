/**
 * User notification API.
 *
 * Powers private org profile badges for queue/job/version-review activity.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUnreadCount, markRead } from '../notifications/dispatcher.js';

const MarkReadInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});

export async function handleUnreadNotificationCount(
  userId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  const count = await getUnreadCount(userId);
  res.json({ count });
}

export async function handleMarkNotificationsRead(
  userId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = MarkReadInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'invalid_request',
        message: 'Invalid body',
        details: parsed.error.flatten(),
      },
    });
    return;
  }

  await markRead(parsed.data.ids, userId);
  res.json({ ok: true });
}
