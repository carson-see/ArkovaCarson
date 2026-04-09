/**
 * Pipeline Health Monitor (SCALE-4 / SCRUM-548)
 *
 * Detects anchors stuck in transient statuses beyond expected thresholds:
 * - PENDING > 30 minutes
 * - SUBMITTED > 2 hours
 * - BROADCASTING > 1 hour
 *
 * Sends alert email via Resend when stuck anchors are detected.
 * Designed to run every 15 minutes via Cloud Scheduler.
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { sendEmail } from '../email/sender.js';
import { config } from '../config.js';

interface StuckAnchorGroup {
  status: string;
  count: number;
  thresholdMinutes: number;
  oldestCreatedAt: string | null;
}

export interface PipelineHealthResult {
  healthy: boolean;
  stuckGroups: StuckAnchorGroup[];
  totalStuck: number;
  checkedAt: string;
  alertSent: boolean;
}

const THRESHOLDS: Record<string, number> = {
  PENDING: 30,       // 30 minutes
  BROADCASTING: 60,  // 1 hour
  SUBMITTED: 120,    // 2 hours
};

export async function checkPipelineHealth(): Promise<PipelineHealthResult> {
  const checkedAt = new Date().toISOString();
  const stuckGroups: StuckAnchorGroup[] = [];

  for (const [status, thresholdMinutes] of Object.entries(THRESHOLDS)) {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();

    const { count, error } = await db
      .from('anchors')
      .select('id', { count: 'exact', head: true })
      .eq('status', status)
      .lt('updated_at', cutoff)
      .is('deleted_at', null);

    if (error) {
      logger.error({ error, status }, 'Pipeline health: failed to check stuck anchors');
      continue;
    }

    if (count && count > 0) {
      // Get the oldest stuck anchor for reporting
      const { data: oldest } = await db
        .from('anchors')
        .select('updated_at')
        .eq('status', status)
        .lt('updated_at', cutoff)
        .is('deleted_at', null)
        .order('updated_at', { ascending: true })
        .limit(1)
        .single();

      stuckGroups.push({
        status,
        count,
        thresholdMinutes,
        oldestCreatedAt: oldest?.updated_at ?? null,
      });
    }
  }

  const totalStuck = stuckGroups.reduce((sum, g) => sum + g.count, 0);
  const healthy = totalStuck === 0;
  let alertSent = false;

  if (!healthy) {
    logger.warn({ totalStuck, stuckGroups }, 'Pipeline health: stuck anchors detected');

    try {
      const lines = stuckGroups.map(
        (g) => `• ${g.count} anchors stuck in ${g.status} (>${g.thresholdMinutes}min, oldest: ${g.oldestCreatedAt ?? 'unknown'})`
      );

      await sendEmail({
        to: 'carson@arkova.ai',
        subject: `[Arkova Alert] ${totalStuck} stuck anchors detected`,
        html: `
          <h2>Pipeline Health Alert</h2>
          <p>${totalStuck} anchor(s) are stuck beyond expected thresholds:</p>
          <ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
          <p>Checked at: ${checkedAt}</p>
          <p><a href="${config.frontendUrl}/admin/pipeline">View Pipeline Dashboard</a></p>
        `,
        emailType: 'notification',
      });
      alertSent = true;
    } catch (emailErr) {
      logger.error({ error: emailErr }, 'Pipeline health: failed to send alert email');
    }
  } else {
    logger.info('Pipeline health: all clear');
  }

  return { healthy, stuckGroups, totalStuck, checkedAt, alertSent };
}
