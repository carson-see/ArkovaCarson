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

import { esc, SHARED_STYLES, wrapTemplate, formatUtc } from './_template.js';

const STYLES = {
  ...SHARED_STYLES,
  panel: 'padding: 16px; background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; color: #1e3a8a;',
} as const;

export function buildParentDelinquentSplitEmail(
  data: ParentDelinquentSplitEmailData,
): { subject: string; html: string } {
  const subOrg = esc(data.subOrganizationName);
  const parentOrg = esc(data.parentOrganizationName);
  const splitUrl = esc(data.splitUrl);
  const expiresAt = esc(formatUtc(data.tokenExpiresAt, 'the link expiration time'));
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
