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
import { buildActivateUrl } from '../lib/urls.js';
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

  // ── Create the auth user FIRST. ──
  // `profiles.id` is FOREIGN KEY -> `auth.users(id)` ON DELETE CASCADE
  // (constraint `profiles_id_fkey`, convalidated in prod and never dropped).
  // Minting a standalone `crypto.randomUUID()` for `profiles.id` therefore
  // ALWAYS violated that FK — the insert could not succeed for any genuinely
  // new recipient, so bulk issuance created the anchors and then 500'd on
  // every recipient provisioning. Same worker-side account-creation pattern as
  // `invitations.ts` (Constitution §1.4: `supabase.auth.admin` never reaches
  // the browser).
  //
  // `email_confirm: false` deliberately: the activation link the recipient is
  // about to receive is what proves mailbox control, so we must not mark the
  // address confirmed before they have clicked it.
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    email_confirm: false,
    user_metadata: request.fullName ? { full_name: request.fullName } : undefined,
  });

  const newUser = (created as { user?: { id: string } } | null)?.user;
  if (createError || !newUser) {
    logger.error({ email, error: createError }, 'Failed to create recipient auth user');
    throw new Error(
      `Failed to create pending recipient: ${createError?.message ?? 'auth user creation returned no user'}`,
    );
  }

  // The profile row MUST be keyed by the auth user's id to satisfy the FK.
  const profileId = newUser.id;

  const activationFields = {
    org_id: request.orgId,
    role: 'ORG_MEMBER' as const,
    status: 'PENDING_ACTIVATION' as const,
    activation_token: activationToken,
    activation_token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };

  try {
    const { error: insertError } = await db.from('profiles').insert({
      id: profileId,
      email,
      full_name: request.fullName ?? null,
      ...activationFields,
    });

    if (insertError) {
      // 23505 = unique_violation. The `create_profile_for_new_user` trigger on
      // `auth.users` may already have inserted a bare profile row for the user
      // we just created. That row carries NO org, NO PENDING_ACTIVATION status
      // and NO activation token, so — unlike `invitations.ts`, where the
      // trigger's row is equivalent to the one being inserted — swallowing the
      // 23505 as success here would leave a recipient who can never be
      // activated. Apply the activation fields to the existing row instead.
      if ((insertError as { code?: string }).code !== '23505') {
        throw insertError;
      }

      const { error: updateError } = await db
        .from('profiles')
        .update({
          ...activationFields,
          ...(request.fullName ? { full_name: request.fullName } : {}),
        })
        .eq('id', profileId);

      if (updateError) {
        throw updateError;
      }
    }
  } catch (err) {
    logger.error(
      { email, profileId, error: err },
      'Failed to create pending profile — rolling back the new auth user',
    );
    const { error: deleteError } = await db.auth.admin.deleteUser(profileId);
    if (deleteError) {
      // Rollback itself failed — this IS a real orphaned auth user that will
      // block any future re-invite of this address. Loud log, no PII beyond
      // what is already logged above.
      logger.error(
        { error: deleteError, profileId },
        'Recipient rollback deleteUser failed — orphaned auth user, needs manual cleanup',
      );
    }
    const message = err instanceof Error ? err.message : ((err as { message?: string })?.message ?? String(err));
    throw new Error(`Failed to create pending recipient: ${message}`, { cause: err });
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

  // Build activation URL (hex token is URL-safe; buildActivateUrl also encodes defensively)
  const activationUrl = buildActivateUrl(activationToken);

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
