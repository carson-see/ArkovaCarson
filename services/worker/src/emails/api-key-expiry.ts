/**
 * SCRUM-5023 — API-key expiry notice email.
 *
 * Uses the existing Resend-backed sendEmail helper so delivery, dev-mode
 * skips, Sentry capture, and audit logging stay centralized.
 *
 * CONSTITUTION 1.4: this template receives the key PREFIX and NAME and nothing
 * else. The raw key is unrecoverable by construction (only the HMAC is
 * stored), and the hash must never leave the worker — an email is a plaintext
 * artifact that lands in a partner's inbox, a mail archive, and a support
 * thread. The prefix is 12 characters of a 76-character credential and exists
 * precisely to be quoted in situations like this one.
 *
 * §1.3 does not apply to email bodies (the CI copy lint covers `src/lib/copy.ts`
 * user-facing strings), but nothing here needs a banned term anyway: this is
 * about an API key, not the chain.
 */
import { sendEmail, type SendResult } from '../email/sender.js';
import { esc, SHARED_STYLES, wrapTemplate, formatUtc } from './_template.js';

export type ApiKeyExpiryKind = 'expiring' | 'expired';

export interface ApiKeyExpiryEmailData {
  recipientEmail: string;
  /** Display name the owner gave the key. */
  keyName: string;
  /** First 12 characters of the key — safe to show, useless to an attacker. */
  keyPrefix: string;
  kind: ApiKeyExpiryKind;
  expiresAt: string | Date;
  /** Whole days remaining; negative once past. */
  daysRemaining: number | null;
  manageKeysUrl: string;
  orgId?: string;
}

const STYLES = {
  ...SHARED_STYLES,
  warn: 'padding: 16px; background-color: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; color: #9a3412;',
  alert: 'padding: 16px; background-color: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; color: #991b1b;',
} as const;

function remainingLabel(daysRemaining: number | null): string {
  if (daysRemaining === null) return 'soon';
  if (daysRemaining <= 0) return 'today';
  if (daysRemaining === 1) return 'in 1 day';
  return `in ${daysRemaining} days`;
}

export function buildApiKeyExpiryEmail(
  data: ApiKeyExpiryEmailData,
): { subject: string; html: string } {
  const name = esc(data.keyName);
  const prefix = esc(data.keyPrefix);
  const when = esc(formatUtc(data.expiresAt, 'its scheduled expiry date'));
  const manageUrl = esc(data.manageKeysUrl);
  const expired = data.kind === 'expired';

  const subject = expired
    ? `Your Arkova API key "${data.keyName}" has expired`
    : `Your Arkova API key "${data.keyName}" expires ${remainingLabel(data.daysRemaining)}`;

  // The two kinds carry different asks. "Expiring" is a reminder with time to
  // act; "expired" reports that requests are ALREADY being refused — the state
  // a partner spent months in without being told.
  const callout = expired
    ? `<div style="${STYLES.alert}">
         <strong>This key stopped working on ${when}.</strong><br/>
         Requests using it are being refused until you extend the expiry or create a replacement.
       </div>`
    : `<div style="${STYLES.warn}">
         <strong>This key expires ${esc(remainingLabel(data.daysRemaining))}.</strong><br/>
         It stops working after ${when} unless you extend it.
       </div>`;

  const html = wrapTemplate(`
    <h2 style="color: #0f172a; margin-bottom: 16px;">${expired ? 'An API key has expired' : 'An API key is about to expire'}</h2>
    <p>This notice is about one API key in your organisation:</p>
    <p style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px;">
      <strong>${name}</strong><br/>
      ${prefix}&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;
    </p>
    ${callout}
    <p>An organisation admin can extend the expiry, or remove it entirely, from the API keys page. Extending keeps the same key &mdash; there is nothing to redistribute.</p>
    <div style="text-align: center; margin: 32px 0;">
      <a href="${manageUrl}" style="${STYLES.button}">Manage API Keys</a>
    </div>
    <p style="${STYLES.muted}">For security, Arkova never sends the key itself. Only the first characters are shown above, which is enough to identify it on the keys page.</p>
    <p style="${STYLES.muted}">Link not working? Copy and paste this URL into your browser:<br/>
    <span style="word-break: break-all; font-size: 12px;">${manageUrl}</span></p>
  `);

  return { subject, html };
}

export async function sendApiKeyExpiryEmail(
  data: ApiKeyExpiryEmailData,
): Promise<SendResult> {
  const { subject, html } = buildApiKeyExpiryEmail(data);
  return sendEmail({
    to: data.recipientEmail,
    subject,
    html,
    emailType: 'notification',
    orgId: data.orgId,
  });
}
