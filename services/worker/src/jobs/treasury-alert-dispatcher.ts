/**
 * Treasury Alert Dispatcher (ARK-103 — SCRUM-1013)
 *
 * Slack + email wiring for `runTreasuryAlertCheck`. Kept separate from the
 * pure decision function (`treasury-alert.ts`) so the tests there stay
 * network-free.
 *
 * Slack delivery: Block Kit payload POSTed to `SLACK_TREASURY_WEBHOOK_URL`
 * (falls back to logging a warning when unset — dev-mode safety).
 *
 * Email delivery: Resend via the existing `sendEmail` helper, to the
 * `TREASURY_ALERT_EMAIL` recipient.
 */
import { sendEmail } from '../email/sender.js';
import { logger } from '../utils/logger.js';
import type { TreasuryAlertDispatcher } from './treasury-alert.js';

/**
 * Returns a dispatcher that POSTs to the configured Slack webhook + sends
 * via the transactional email provider. Missing env gates log a warning
 * rather than throwing — a partially-configured install still fires the
 * alerts it can.
 */
export function buildTreasuryAlertDispatcher(): TreasuryAlertDispatcher {
  const slackWebhook = process.env.SLACK_TREASURY_WEBHOOK_URL;
  const emailTo = process.env.TREASURY_ALERT_EMAIL;

  return {
    async sendSlack(payload) {
      if (!slackWebhook) {
        logger.warn('SLACK_TREASURY_WEBHOOK_URL not configured — skipping Slack alert');
        return;
      }
      try {
        // `redirect: 'manual'` + timeout is SSRF defense-in-depth — a compromised
        // webhook can't pivot us to an internal service.
        const res = await fetch(slackWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          logger.warn({ status: res.status }, 'Slack treasury alert non-2xx');
        }
      } catch (err) {
        logger.error({ error: err }, 'Slack treasury alert POST failed');
      }
    },
    async sendEmail(subject, body) {
      if (!emailTo) {
        logger.warn('TREASURY_ALERT_EMAIL not configured — skipping email alert');
        return;
      }
      try {
        await sendEmail({
          to: emailTo,
          subject,
          html: `<pre style="font-family: monospace">${escapeHtml(body)}</pre>`,
          emailType: 'treasury_alert',
        });
      } catch (err) {
        logger.error({ error: err }, 'Email treasury alert send failed');
      }
    },
  };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
