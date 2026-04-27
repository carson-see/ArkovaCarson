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
import { PIPELINE_DASHBOARD_URL } from '../lib/urls.js';

interface StuckAnchorGroup {
  status: string;
  count: number;
  thresholdMinutes: number;
  oldestUpdatedAt: string | null;
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

  // SCRUM-1259 (R1-5): the previous exact-count on the bloated `anchors`
  // table 60s-timed-out per status (3 statuses × 60s = the cron ran past
  // its budget every tick). Replaced with a LIMIT-bounded id-only fetch
  // (cap CAP_ROWS) — turns "count" into "≤ CAP exact, else ≥ CAP". For
  // a stuck-anchor monitor this is the right tradeoff: we care that ANY
  // are stuck and roughly how many; precision past the cap doesn't change
  // the page severity.
  const STUCK_CAP = 500;

  for (const [status, thresholdMinutes] of Object.entries(THRESHOLDS)) {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000).toISOString();
    const anchorStatus = status as 'PENDING' | 'SUBMITTED' | 'BROADCASTING';

    // Fetch up to CAP rows ordered by updated_at ASC — the oldest fall in
    // first, so [0] is the oldest stuck anchor and length is the bounded
    // count. Hits idx_anchors_pending_claim / idx_anchors_broadcasting_status
    // / idx_anchors_submitted_status (all (status, updated_at)-shaped) for
    // efficient index scan even under bloat.
    const { data, error } = await db
      .from('anchors')
      .select('updated_at')
      .eq('status', anchorStatus)
      .lt('updated_at', cutoff)
      .is('deleted_at', null)
      .order('updated_at', { ascending: true })
      .limit(STUCK_CAP);

    if (error) {
      logger.error({ error, status }, 'Pipeline health: failed to check stuck anchors');
      continue;
    }

    if (data && data.length > 0) {
      stuckGroups.push({
        status,
        // When we hit the cap, the true count is ≥ STUCK_CAP — caller
        // can render "500+" or similar. The alert email below shows the
        // capped number with a "(at least)" suffix when capped.
        count: data.length,
        thresholdMinutes,
        oldestUpdatedAt: (data[0] as { updated_at: string }).updated_at ?? null,
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
        (g) => `• ${g.count} anchors stuck in ${g.status} (>${g.thresholdMinutes}min, oldest: ${g.oldestUpdatedAt ?? 'unknown'})`
      );

      const result = await sendEmail({
        to: 'carson@arkova.ai',
        subject: `[Arkova Alert] ${totalStuck} stuck anchors detected`,
        html: `
          <h2>Pipeline Health Alert</h2>
          <p>${totalStuck} anchor(s) are stuck beyond expected thresholds:</p>
          <ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>
          <p>Checked at: ${checkedAt}</p>
          <p><a href="${PIPELINE_DASHBOARD_URL}">View Pipeline Dashboard</a></p>
        `,
        emailType: 'notification',
      });
      alertSent = result.success;
      if (!result.success) {
        logger.warn({ error: result.error }, 'Pipeline health: alert email delivery failed');
      }
    } catch (emailErr) {
      logger.error({ error: emailErr }, 'Pipeline health: failed to send alert email');
    }
  } else {
    logger.info('Pipeline health: all clear');
  }

  return { healthy, stuckGroups, totalStuck, checkedAt, alertSent };
}
