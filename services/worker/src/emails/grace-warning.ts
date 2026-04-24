/**
 * Payment grace warning email.
 *
 * Uses the existing Resend-backed sendEmail helper so delivery, dev-mode
 * skips, Sentry capture, and audit logging stay centralized.
 */
import { sendEmail, type SendResult } from '../email/sender.js';

export interface GraceWarningEmailData {
  recipientEmail: string;
  organizationName: string;
  manageBillingUrl: string;
  graceExpiresAt: string | Date;
  daysRemaining?: number;
  actorId?: string;
  orgId?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLES = {
  container: 'font-family: "Helvetica Neue", Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #ffffff;',
  header: 'text-align: center; margin-bottom: 32px;',
  logo: 'font-size: 24px; font-weight: 700; color: #0f172a;',
  body: 'font-size: 16px; line-height: 1.6; color: #334155;',
  button: 'display: inline-block; padding: 12px 32px; background-color: #0f172a; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;',
  notice: 'padding: 16px; background-color: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; color: #9a3412;',
  footer: 'margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8; text-align: center;',
  muted: 'color: #64748b; font-size: 14px;',
} as const;

function wrapTemplate(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f8fafc;">
  <div style="${STYLES.container}">
    <div style="${STYLES.header}">
      <span style="${STYLES.logo}">Arkova</span>
    </div>
    <div style="${STYLES.body}">
      ${content}
    </div>
    <div style="${STYLES.footer}">
      <p>Arkova &mdash; Trusted Credential Infrastructure</p>
      <p style="margin-top: 8px;">This is an automated message. Please do not reply directly.</p>
    </div>
  </div>
</body>
</html>`;
}

function formatUtc(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'the end of the grace period';
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

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
  const deadline = esc(formatUtc(data.graceExpiresAt));
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
