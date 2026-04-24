/**
 * Parent-delinquent split-off email.
 *
 * Sent to sub-organization admins when a parent organization's payment state
 * could affect their account. Delivery goes through the shared Resend sender.
 */
import { sendEmail, type SendResult } from '../email/sender.js';

export interface ParentDelinquentSplitEmailData {
  recipientEmail: string;
  subOrganizationName: string;
  parentOrganizationName: string;
  splitUrl: string;
  tokenExpiresAt: string | Date;
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
  panel: 'padding: 16px; background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; color: #1e3a8a;',
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
  if (Number.isNaN(date.getTime())) return 'the link expiration time';
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

export function buildParentDelinquentSplitEmail(
  data: ParentDelinquentSplitEmailData,
): { subject: string; html: string } {
  const subOrg = esc(data.subOrganizationName);
  const parentOrg = esc(data.parentOrganizationName);
  const splitUrl = esc(data.splitUrl);
  const expiresAt = esc(formatUtc(data.tokenExpiresAt));
  const subject = `Keep ${subOrg} active on Arkova`;

  const html = wrapTemplate(`
    <h2 style="color: #0f172a; margin-bottom: 16px;">Keep your organization active</h2>
    <p><strong>${parentOrg}</strong>, the parent organization for <strong>${subOrg}</strong>, has a billing issue that may affect your access.</p>
    <div style="${STYLES.panel}">
      You can move <strong>${subOrg}</strong> to independent billing using a secure, single-use link.
    </div>
    <p>This link expires at <strong>${expiresAt}</strong>.</p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${splitUrl}" style="${STYLES.button}">Set Up Independent Billing</a>
    </div>
    <p style="${STYLES.muted}">If your parent organization resolves billing first, no action is needed.</p>
    <p style="${STYLES.muted}">Link not working? Copy and paste this URL into your browser:<br/>
    <span style="word-break: break-all; font-size: 12px;">${splitUrl}</span></p>
  `);

  return { subject, html };
}

export async function sendParentDelinquentSplitEmail(
  data: ParentDelinquentSplitEmailData,
): Promise<SendResult> {
  const { subject, html } = buildParentDelinquentSplitEmail(data);
  return sendEmail({
    to: data.recipientEmail,
    subject,
    html,
    emailType: 'notification',
    actorId: data.actorId,
    orgId: data.orgId,
  });
}
