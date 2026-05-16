/**
 * Auto-Queue Notification (SCRUM-1973 / SCRUM-1126)
 *
 * Emits a `document.auto_queued` notification to org admins when a rule
 * adds a document to the anchoring queue. Only fires for rule-triggered
 * events, not manual uploads.
 */

import { logger } from '../utils/logger.js';
import { emitOrgAdminNotifications } from '../notifications/dispatcher.js';

export interface AutoQueuedNotificationInput {
  org_id: string;
  filename?: string;
  source: string;
  rule_name: string;
  rule_id: string;
}

export async function emitAutoQueuedNotification(input: AutoQueuedNotificationInput): Promise<void> {
  try {
    await emitOrgAdminNotifications({
      type: 'document.auto_queued',
      organizationId: input.org_id,
      payload: {
        filename: input.filename ?? null,
        source: input.source,
        rule_name: input.rule_name,
        rule_id: input.rule_id,
      },
    });
  } catch (err) {
    logger.warn({ error: err, org_id: input.org_id, rule_id: input.rule_id },
      'Auto-queue notification failed (non-fatal)');
  }
}
