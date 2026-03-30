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

/** Escape HTML special characters to prevent injection in email templates. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

export interface InvitationEmailData {
  recipientEmail: string;
  organizationName: string;
  inviterName?: string;
  role: string;
  inviteUrl: string;
}

export interface DomainVerificationEmailData {
  domain: string;
  verificationCode: string;
  organizationName?: string;
}

// ─── Template Builders ───────────────────────────────────────────────────────

/**
 * Activation email — sent when an admin uploads a credential for a new user.
 * The recipient gets an activation link to set up their account and view credentials.
 */
export function buildActivationEmail(data: ActivationEmailData): { subject: string; html: string } {
  const subject = `${esc(data.organizationName)} has issued you a credential on Arkova`;

  const html = wrapTemplate(`
    <h2 style="color: #0f172a; margin-bottom: 16px;">You've been issued a credential</h2>
    <p><strong>${esc(data.organizationName)}</strong> has issued ${data.credentialLabel ? `a credential (<em>${esc(data.credentialLabel)}</em>)` : 'a credential'} to you on Arkova.</p>
    <p>To view and manage your credentials, activate your account:</p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${esc(data.activationUrl)}" style="${STYLES.button}">Activate Your Account</a>
    </div>
    <p style="${STYLES.muted}">This link expires in 7 days. If you didn't expect this email, you can safely ignore it.</p>
    <p style="${STYLES.muted}">Link not working? Copy and paste this URL into your browser:<br/>
    <span style="word-break: break-all; font-size: 12px;">${esc(data.activationUrl)}</span></p>
  `);

  return { subject, html };
}

/**
 * Anchor secured email — sent when a credential is confirmed on the network.
 */
export function buildAnchorSecuredEmail(data: AnchorSecuredEmailData): { subject: string; html: string } {
  const subject = `Your credential "${esc(data.credentialLabel)}" has been secured`;

  const html = wrapTemplate(`
    <h2 style="color: #0f172a; margin-bottom: 16px;">Credential Secured</h2>
    <p>Your credential <strong>${esc(data.credentialLabel)}</strong>${data.organizationName ? ` from ${esc(data.organizationName)}` : ''} has been permanently secured on the network.</p>
    <p>You can verify this credential at any time:</p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${esc(data.verificationUrl)}" style="${STYLES.button}">View Credential</a>
    </div>
    <p style="${STYLES.muted}">This credential's integrity is independently verifiable by anyone with the original document.</p>
  `);

  return { subject, html };
}

/**
 * Revocation email — sent when a credential has been revoked.
 */
export function buildRevocationEmail(data: RevocationEmailData): { subject: string; html: string } {
  const subject = `Credential "${esc(data.credentialLabel)}" has been revoked`;

  const html = wrapTemplate(`
    <h2 style="color: #dc2626; margin-bottom: 16px;">Credential Revoked</h2>
    <p>The credential <strong>${esc(data.credentialLabel)}</strong>${data.organizationName ? ` from ${esc(data.organizationName)}` : ''} has been revoked.</p>
    ${data.revocationReason ? `<p><strong>Reason:</strong> ${esc(data.revocationReason)}</p>` : ''}
    <p style="${STYLES.muted}">This credential will no longer pass verification checks. If you believe this was done in error, please contact the issuing organization.</p>
  `);

  return { subject, html };
}

/**
 * Invitation email — sent when an org admin invites someone to join.
 */
export function buildInvitationEmail(data: InvitationEmailData): { subject: string; html: string } {
  const subject = `You've been invited to join ${esc(data.organizationName)} on Arkova`;

  const roleLabel = data.role === 'ORG_ADMIN' ? 'an administrator' : 'a member';
  const inviterLine = data.inviterName
    ? `<strong>${esc(data.inviterName)}</strong> has invited you`
    : 'You have been invited';

  const html = wrapTemplate(`
    <h2 style="color: #0f172a; margin-bottom: 16px;">Organization Invitation</h2>
    <p>${inviterLine} to join <strong>${esc(data.organizationName)}</strong> as ${roleLabel} on Arkova.</p>
    <p>Arkova is a trusted credential infrastructure platform for securing and verifying important documents.</p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${esc(data.inviteUrl)}" style="${STYLES.button}">Accept Invitation</a>
    </div>
    <p style="${STYLES.muted}">This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.</p>
    <p style="${STYLES.muted}">Link not working? Copy and paste this URL into your browser:<br/>
    <span style="word-break: break-all; font-size: 12px;">${esc(data.inviteUrl)}</span></p>
  `);

  return { subject, html };
}

/**
 * Domain verification email — sent when an org starts domain verification.
 * Contains a 6-digit code to confirm domain ownership.
 */
export function buildDomainVerificationEmail(data: DomainVerificationEmailData): { subject: string; html: string } {
  const orgLabel = data.organizationName ? esc(data.organizationName) : esc(data.domain);
  const subject = `Verify domain ownership for ${orgLabel}`;

  const html = wrapTemplate(`
    <h2 style="color: #0f172a; margin-bottom: 16px;">Verify Your Domain</h2>
    <p>Your organization is verifying ownership of <strong>${esc(data.domain)}</strong> on Arkova.</p>
    <p>Use this verification code to confirm:</p>
    <div style="text-align: center; margin: 32px 0;">
      <div style="display: inline-block; padding: 16px 40px; background-color: #f1f5f9; border-radius: 12px; font-size: 36px; font-weight: 700; letter-spacing: 8px; font-family: 'Courier New', monospace; color: #0f172a;">
        ${esc(data.verificationCode)}
      </div>
    </div>
    <p style="${STYLES.muted}">Enter this code on the domain verification page in Arkova.</p>
    <p style="${STYLES.muted}">This code expires in 24 hours. If you didn't request this, you can safely ignore this email.</p>
  `);

  return { subject, html };
}
