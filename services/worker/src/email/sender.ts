/**
 * Email Sender Service (BETA-03)
 *
 * Wraps Resend SDK for transactional email delivery.
 * All email sends are audit-logged. No PII beyond email address
 * is included in audit logs (Constitution 1.6).
 *
 * Feature-gated: emails are silently skipped when RESEND_API_KEY is not set.
 * This allows development without a Resend account.
 *
 * Constitution refs:
 *   - 1.4: API keys loaded from env, never logged
 *   - 1.6: No document content in emails
 */

import { Resend } from 'resend';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';
import { config } from '../config.js';

/** Email send result */
export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/** Options for sending an email */
export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  /** Email type for audit logging */
  emailType: 'activation' | 'anchor_secured' | 'revocation' | 'notification';
  /** Related anchor ID for audit trail */
  anchorId?: string;
  /** Actor user ID (who triggered the send) */
  actorId?: string;
  /** Organization ID for audit trail */
  orgId?: string;
}

let resendClient: Resend | null = null;

/**
 * Get or create the Resend client singleton.
 * Returns null if RESEND_API_KEY is not configured.
 */
function getResendClient(): Resend | null {
  if (!config.resendApiKey) {
    return null;
  }

  if (!resendClient) {
    resendClient = new Resend(config.resendApiKey);
    logger.info('Resend email client initialized');
  }

  return resendClient;
}

/**
 * Send a transactional email via Resend.
 *
 * - Feature-gated: silently returns success when Resend is not configured (dev mode)
 * - All sends are audit-logged (event_type: 'EMAIL_SENT')
 * - No PII beyond recipient email in audit logs
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendResult> {
  const client = getResendClient();

  if (!client) {
    logger.debug(
      { to: options.to, type: options.emailType },
      'Email skipped — RESEND_API_KEY not configured',
    );
    return { success: true, messageId: 'dev-mode-skipped' };
  }

  try {
    const { data, error } = await client.emails.send({
      from: config.emailFrom,
      to: [options.to],
      subject: options.subject,
      html: options.html,
    });

    if (error) {
      logger.error(
        { to: options.to, type: options.emailType, error: error.message },
        'Email send failed',
      );

      // Audit log the failure — non-fatal
      await logEmailAudit(options, false, undefined, error.message);

      return { success: false, error: error.message };
    }

    const messageId = data?.id;
    logger.info(
      { to: options.to, type: options.emailType, messageId },
      'Email sent successfully',
    );

    // Audit log the success — non-fatal
    await logEmailAudit(options, true, messageId);

    return { success: true, messageId };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      { to: options.to, type: options.emailType, error: errorMessage },
      'Email send threw',
    );

    await logEmailAudit(options, false, undefined, errorMessage);

    return { success: false, error: errorMessage };
  }
}

/**
 * Log an email send event to audit_events.
 * Non-fatal — errors are logged but don't propagate.
 */
async function logEmailAudit(
  options: SendEmailOptions,
  success: boolean,
  messageId?: string,
  errorMessage?: string,
): Promise<void> {
  try {
    await db.from('audit_events').insert({
      event_type: 'EMAIL_SENT',
      event_category: 'NOTIFICATION',
      actor_id: options.actorId ?? null,
      org_id: options.orgId ?? null,
      target_type: options.anchorId ? 'anchor' : 'user',
      target_id: options.anchorId ?? options.to,
      details: JSON.stringify({
        email_type: options.emailType,
        recipient: options.to,
        success,
        message_id: messageId,
        error: errorMessage,
      }),
    });
  } catch (auditError) {
    logger.warn({ error: auditError }, 'Failed to log email audit event');
  }
}

/** Reset client for testing */
export function _resetClient(): void {
  resendClient = null;
}
