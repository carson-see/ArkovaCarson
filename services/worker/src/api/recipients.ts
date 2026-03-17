/**
 * Recipient Management API (BETA-04)
 *
 * Worker endpoints for creating pending recipients and sending
 * activation emails when an admin uploads a credential for a
 * person who doesn't have an Arkova account.
 *
 * Constitution refs:
 *   - 1.4: No PII beyond email in audit logs
 *   - 1.6: No document content in emails
 */

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { sendEmail, buildActivationEmail } from '../email/index.js';

export interface CreateRecipientRequest {
  /** Recipient's email address */
  email: string;
  /** Organization ID */
  orgId: string;
  /** Recipient's full name (optional) */
  fullName?: string;
  /** Credential label for the activation email (optional) */
  credentialLabel?: string;
  /** Actor user ID (the admin creating the recipient) */
  actorId: string;
}

export interface CreateRecipientResult {
  profileId: string;
  isNew: boolean;
  activationEmailSent?: boolean;
}

/**
 * Create a pending recipient profile and send activation email.
 *
 * If the recipient already exists, returns their existing profile ID
 * without sending an activation email.
 */
export async function createPendingRecipient(
  request: CreateRecipientRequest,
): Promise<CreateRecipientResult> {
  const email = request.email.toLowerCase().trim();

  // Check if profile already exists
  const { data: existing } = await db
    .from('profiles')
    .select('id, status')
    .eq('email', email)
    .maybeSingle();

  if (existing) {
    logger.info({ email, profileId: existing.id }, 'Recipient already exists');
    return { profileId: existing.id, isNew: false };
  }

  // Generate activation token
  const { randomBytes } = await import('node:crypto');
  const activationToken = randomBytes(32).toString('hex');
  const profileId = crypto.randomUUID();

  // Create pending profile
  const { error: insertError } = await db.from('profiles').insert({
    id: profileId,
    email,
    full_name: request.fullName ?? null,
    org_id: request.orgId,
    role: 'MEMBER',
    status: 'PENDING_ACTIVATION',
    activation_token: activationToken,
    activation_token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });

  if (insertError) {
    logger.error({ email, error: insertError }, 'Failed to create pending profile');
    throw new Error(`Failed to create pending recipient: ${insertError.message}`);
  }

  // Log audit event
  await db.from('audit_events').insert({
    event_type: 'USER_INVITED',
    event_category: 'USER',
    actor_id: request.actorId,
    org_id: request.orgId,
    target_type: 'profile',
    target_id: profileId,
    details: JSON.stringify({
      recipient_email: email,
      invited_by: request.actorId,
    }),
  });

  // Get organization name for the email
  const { data: org } = await db
    .from('organizations')
    .select('display_name')
    .eq('id', request.orgId)
    .single();

  const orgName = org?.display_name ?? 'Your organization';

  // Build activation URL
  const activationUrl = `${config.frontendUrl}/activate?token=${activationToken}`;

  // Send activation email
  const emailResult = await sendEmail({
    to: email,
    ...buildActivationEmail({
      recipientEmail: email,
      organizationName: orgName,
      activationUrl,
      credentialLabel: request.credentialLabel,
    }),
    emailType: 'activation',
    actorId: request.actorId,
    orgId: request.orgId,
  });

  logger.info(
    { email, profileId, emailSent: emailResult.success },
    'Pending recipient created',
  );

  return {
    profileId,
    isNew: true,
    activationEmailSent: emailResult.success,
  };
}
