/**
 * Payment grace warning email.
 *
 * Uses the existing Resend-backed sendEmail helper so delivery, dev-mode
 * skips, Sentry capture, and audit logging stay centralized.
 */
import { sendEmail, type SendResult } from '../email/sender.js';
import { esc, SHARED_STYLES, wrapTemplate, formatUtc } from './_template.js';

export interface GraceWarningEmailData {
  recipientEmail: string;
  organizationName: string;
  manageBillingUrl: string;
  graceExpiresAt: string | Date;
  daysRemaining?: number;
  actorId?: string;
  orgId?: string;
}

const STYLES = {
  ...SHARED_STYLES,
  notice: 'padding: 16px; background-color: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; color: #9a3412;',
} as const;

function remainingLabel(daysRemaining?: number): string {
  if (daysRemaining === undefined) return 'soon';
  if (daysRemaining <= 0) return 'today';
  if (daysRemaining === 1) return 'in 1 day';
  return `in ${daysRemaining} days`;
}

export function buildGraceWarningEmail(
  data: GraceWarningEmailData,
): { subject: string; html: string } {
  const orgName = esc(data.organizationName);
  const deadline = esc(formatUtc(data.graceExpiresAt, 'the end of the grace period'));
  const remaining = esc(remainingLabel(data.daysRemaining));
  const billingUrl = esc(data.manageBillingUrl);
  const subject = `Action needed: update billing for ${orgName}`;

  const html = wrapTemplate(`
    <h2 style="color: #0f172a; margin-bottom: 16px;">Update billing to keep Arkova active</h2>
    <p>We could not process the latest payment for <strong>${orgName}</strong>.</p>
    <div style="${STYLES.notice}">
      <strong>Payment grace ends ${remaining}.</strong><br/>
      Your organization will be suspended after <strong>${deadline}</strong> if billing is not updated.
    </div>
    <p>Please update the payment method for your organization to keep verification and credential workflows available.</p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${billingUrl}" style="${STYLES.button}">Update Billing</a>
    </div>
    <p style="${STYLES.muted}">If payment has already been updated, no action is needed.</p>
    <p style="${STYLES.muted}">Link not working? Copy and paste this URL into your browser:<br/>
    <span style="word-break: break-all; font-size: 12px;">${billingUrl}</span></p>
  `);

  return { subject, html };
}

export async function sendGraceWarningEmail(
  data: GraceWarningEmailData,
): Promise<SendResult> {
  const { subject, html } = buildGraceWarningEmail(data);
  return sendEmail({
    to: data.recipientEmail,
    subject,
    html,
    emailType: 'notification',
    actorId: data.actorId,
    orgId: data.orgId,
  });
}
