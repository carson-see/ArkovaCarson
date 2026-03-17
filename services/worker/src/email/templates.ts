/**
 * Email Templates (BETA-03)
 *
 * HTML email templates for transactional emails.
 * Uses inline CSS for maximum email client compatibility.
 *
 * Constitution refs:
 *   - 1.3: No blockchain terminology in user-facing strings
 *   - 1.6: No document content in emails (privacy boundary)
 */

/** Shared email styles — inline CSS for email client compatibility */
const STYLES = {
  container: 'font-family: "Helvetica Neue", Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #ffffff;',
  header: 'text-align: center; margin-bottom: 32px;',
  logo: 'font-size: 24px; font-weight: 700; color: #0f172a; letter-spacing: -0.5px;',
  body: 'font-size: 16px; line-height: 1.6; color: #334155;',
  button: 'display: inline-block; padding: 12px 32px; background-color: #0f172a; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;',
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

// ─── Template Types ──────────────────────────────────────────────────────────

export interface ActivationEmailData {
  recipientEmail: string;
  organizationName: string;
  activationUrl: string;
  credentialLabel?: string;
}

export interface AnchorSecuredEmailData {
  recipientEmail: string;
  credentialLabel: string;
  verificationUrl: string;
  organizationName?: string;
}

export interface RevocationEmailData {
  recipientEmail: string;
  credentialLabel: string;
  revocationReason?: string | null;
  organizationName?: string;
}

// ─── Template Builders ───────────────────────────────────────────────────────

/**
 * Activation email — sent when an admin uploads a credential for a new user.
 * The recipient gets an activation link to set up their account and view credentials.
 */
export function buildActivationEmail(data: ActivationEmailData): { subject: string; html: string } {
  const subject = `${data.organizationName} has issued you a credential on Arkova`;

  const html = wrapTemplate(`
    <h2 style="color: #0f172a; margin-bottom: 16px;">You've been issued a credential</h2>
    <p><strong>${data.organizationName}</strong> has issued ${data.credentialLabel ? `a credential (<em>${data.credentialLabel}</em>)` : 'a credential'} to you on Arkova.</p>
    <p>To view and manage your credentials, activate your account:</p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${data.activationUrl}" style="${STYLES.button}">Activate Your Account</a>
    </div>
    <p style="${STYLES.muted}">This link expires in 7 days. If you didn't expect this email, you can safely ignore it.</p>
    <p style="${STYLES.muted}">Link not working? Copy and paste this URL into your browser:<br/>
    <span style="word-break: break-all; font-size: 12px;">${data.activationUrl}</span></p>
  `);

  return { subject, html };
}

/**
 * Anchor secured email — sent when a credential is confirmed on the network.
 */
export function buildAnchorSecuredEmail(data: AnchorSecuredEmailData): { subject: string; html: string } {
  const subject = `Your credential "${data.credentialLabel}" has been secured`;

  const html = wrapTemplate(`
    <h2 style="color: #0f172a; margin-bottom: 16px;">Credential Secured</h2>
    <p>Your credential <strong>${data.credentialLabel}</strong>${data.organizationName ? ` from ${data.organizationName}` : ''} has been permanently secured on the network.</p>
    <p>You can verify this credential at any time:</p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${data.verificationUrl}" style="${STYLES.button}">View Credential</a>
    </div>
    <p style="${STYLES.muted}">This credential's integrity is independently verifiable by anyone with the original document.</p>
  `);

  return { subject, html };
}

/**
 * Revocation email — sent when a credential has been revoked.
 */
export function buildRevocationEmail(data: RevocationEmailData): { subject: string; html: string } {
  const subject = `Credential "${data.credentialLabel}" has been revoked`;

  const html = wrapTemplate(`
    <h2 style="color: #dc2626; margin-bottom: 16px;">Credential Revoked</h2>
    <p>The credential <strong>${data.credentialLabel}</strong>${data.organizationName ? ` from ${data.organizationName}` : ''} has been revoked.</p>
    ${data.revocationReason ? `<p><strong>Reason:</strong> ${data.revocationReason}</p>` : ''}
    <p style="${STYLES.muted}">This credential will no longer pass verification checks. If you believe this was done in error, please contact the issuing organization.</p>
  `);

  return { subject, html };
}
