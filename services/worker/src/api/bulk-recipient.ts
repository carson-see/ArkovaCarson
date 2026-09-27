import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { buildActivationEmail, sendEmail } from '../email/index.js';
import { hashRecipientEmail } from '../lib/recipient-identity.js';
import { buildActivateUrl } from '../lib/urls.js';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

interface BulkRecipientInput {
  anchorPublicId: string;
  actorUserId: string;
  orgId: string | null;
  email: string;
  fullName?: string;
  /** Explicitly enabled by the authorized bulk-import orchestration. */
  deliverActivationEmail?: boolean;
}

interface RecipientProfileResult {
  profileId: string;
  created: boolean;
  activationToken?: string;
}

export async function deliverBulkActivationOnce(input: {
  profileId: string;
  activationToken: string;
  email: string;
  fullName?: string;
  actorUserId: string;
  orgId: string | null;
}): Promise<void> {
  const tokenHash = createHash('sha256').update(input.activationToken, 'utf8').digest('hex');
  const { error: claimError } = await db.from('recipient_activation_deliveries').insert({
    profile_id: input.profileId,
    token_hash: tokenHash,
    status: 'sending',
  });
  if (claimError) {
    if ((claimError as { code?: string }).code === '23505') {
      const { data: prior, error: priorError } = await db.from('recipient_activation_deliveries')
        .select('status').eq('profile_id', input.profileId).eq('token_hash', tokenHash).maybeSingle();
      if (priorError || !prior) throw new Error('recipient_activation_claim_failed');
      if (prior.status === 'sent') return;
      throw new Error(prior.status === 'failed'
        ? 'recipient_activation_email_failed'
        : 'recipient_activation_delivery_pending');
    }
    throw new Error('recipient_activation_claim_failed');
  }

  let orgName = 'Arkova';
  if (input.orgId) {
    const { data: org } = await db.from('organizations').select('display_name').eq('id', input.orgId).maybeSingle();
    orgName = org?.display_name ?? orgName;
  }
  const delivery = await sendEmail({
    to: input.email.trim().toLowerCase(),
    ...buildActivationEmail({
      recipientEmail: input.email.trim().toLowerCase(),
      organizationName: orgName,
      activationUrl: buildActivateUrl(input.activationToken),
    }),
    emailType: 'activation',
    actorId: input.actorUserId,
    orgId: input.orgId ?? undefined,
    idempotencyKey: `bulk-activation/${input.profileId}/${tokenHash}`,
  });
  const completion = delivery.success
    ? { status: 'sent', completed_at: new Date().toISOString(), failure_code: null }
    : { status: 'failed', completed_at: new Date().toISOString(), failure_code: 'provider_rejected' };
  const { error: completionError } = await db.from('recipient_activation_deliveries').update(completion)
    .eq('profile_id', input.profileId).eq('token_hash', tokenHash).eq('status', 'sending');
  if (completionError) {
    logger.error({ profileId: input.profileId, delivered: delivery.success }, 'Bulk activation delivery receipt update failed');
  }
  if (!delivery.success) throw new Error('recipient_activation_email_failed');
}

interface RecipientProfileRow {
  id: string;
  status: string | null;
  activation_token: string | null;
}

async function findProfileByEmail(email: string): Promise<RecipientProfileRow | null> {
  const { data, error } = await db.from('profiles').select('id, status, activation_token').eq('email', email).maybeSingle();
  if (error) throw new Error('recipient_profile_lookup_failed');
  return data as RecipientProfileRow | null;
}

async function ensurePendingProfile(
  profileId: string,
  email: string,
  fullName?: string,
): Promise<string> {
  const recovered = await recoverMarkerOwnedProfile(email, fullName, profileId);
  if (!recovered.activationToken) throw new Error('recipient_profile_create_failed');
  return recovered.activationToken;
}

async function recoverMarkerOwnedProfile(
  email: string,
  fullName: string | undefined,
  expectedUserId?: string,
): Promise<RecipientProfileResult> {
  const proposedToken = randomBytes(32).toString('hex');
  const { data, error } = await db.rpc('recover_bulk_recipient_profile', {
    p_email: email,
    p_full_name: fullName ?? '',
    p_activation_token: proposedToken,
    p_activation_token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...(expectedUserId ? { p_expected_user_id: expectedUserId } : {}),
  });
  const row = (data as Array<{ profile_id: string; activation_token: string }> | null)?.[0];
  if (error || !row?.profile_id || !row.activation_token) {
    throw new Error('recipient_profile_create_failed');
  }
  logger.warn({ profileId: row.profile_id, expectedUserId: expectedUserId ?? null },
    'Recovered marker-owned bulk recipient profile');
  return { profileId: row.profile_id, created: false, activationToken: row.activation_token };
}

/**
 * Resolve or create an unconfirmed, non-member recipient identity.
 * No org_id/role/membership is assigned and no address is auto-confirmed.
 */
export async function resolveBulkRecipientProfile(
  emailInput: string,
  fullName?: string,
): Promise<RecipientProfileResult> {
  const email = emailInput.trim().toLowerCase();
  const existing = await findProfileByEmail(email);
  if (existing) {
    const { data: authData, error: authError } = await db.auth.admin.getUserById(existing.id);
    if (authError) throw new Error('recipient_profile_lookup_failed');
    const provisionedByBulk = authData.user?.app_metadata?.arkova_bulk_recipient === true
      && authData.user?.app_metadata?.admin_provisioned === true;
    const mailboxConfirmed = Boolean(authData.user?.email_confirmed_at);
    if (!provisionedByBulk || mailboxConfirmed) {
      return { profileId: existing.id, created: false };
    }
    if (existing.status === 'PENDING_ACTIVATION' && existing.activation_token) {
      return recoverMarkerOwnedProfile(email, fullName, existing.id);
    }
    return {
      profileId: existing.id,
      created: false,
      activationToken: await ensurePendingProfile(existing.id, email, fullName),
    };
  }

  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    email_confirm: false,
    user_metadata: fullName ? { full_name: fullName } : undefined,
    // Both markers are server-authored. `admin_provisioned` makes the explicit
    // org-less placement authoritative to the email-domain association trigger.
    app_metadata: { arkova_bulk_recipient: true, admin_provisioned: true },
  });
  const newUser = (created as { user?: { id: string } } | null)?.user;
  if (createError || !newUser) {
    // Concurrent identical rows/imports may race on the unique auth email.
    // The loser links the winner's profile; it never deletes or rewrites it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const raced = await findProfileByEmail(email);
      if (raced) {
        const { data: authData, error: authError } = await db.auth.admin.getUserById(raced.id);
        if (authError) throw new Error('recipient_profile_lookup_failed');
        const bulkPending = authData.user?.app_metadata?.arkova_bulk_recipient === true
          && authData.user?.app_metadata?.admin_provisioned === true
          && !authData.user?.email_confirmed_at;
        if (!bulkPending) return { profileId: raced.id, created: false };
        if (raced.status === 'PENDING_ACTIVATION' && raced.activation_token) {
          return recoverMarkerOwnedProfile(email, fullName, raced.id);
        }
        return { profileId: raced.id, created: false,
          activationToken: await ensurePendingProfile(raced.id, email, fullName) };
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return recoverMarkerOwnedProfile(email, fullName);
  }

  const activationToken = randomBytes(32).toString('hex');
  const activationFields = { status: 'PENDING_ACTIVATION' as const, activation_token: activationToken,
    activation_token_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() };
  try {
    const { error: insertError } = await db.from('profiles').insert({
      id: newUser.id,
      email,
      full_name: fullName ?? null,
      org_id: null,
      role: null,
      ...activationFields,
    });
    if (insertError) {
      if ((insertError as { code?: string }).code !== '23505') throw insertError;
      return { profileId: newUser.id, created: true,
        activationToken: await ensurePendingProfile(newUser.id, email, fullName) };
    }
  } catch {
    // Do not delete: another concurrent request may already have linked the
    // trigger-created profile. The app_metadata marker makes a retry repairable.
    logger.error({ profileId: newUser.id }, 'Bulk recipient profile setup failed');
    try {
      return await recoverMarkerOwnedProfile(email, fullName, newUser.id);
    } catch (recoveryError) {
      throw new Error('recipient_profile_create_failed', { cause: recoveryError });
    }
  }
  return { profileId: newUser.id, created: true, activationToken };
}

export async function linkBulkRecipient(input: BulkRecipientInput): Promise<void> {
  if (!config.enableBulkRecipientProvisioning) throw new Error('recipient_provisioning_disabled');
  // Fail before creating any auth/profile state when the required secret is absent.
  const emailHash = hashRecipientEmail(input.email, config.recipientIdentifierPepper);
  if (!emailHash) throw new Error('recipient_email_invalid');
  let anchorQuery = db.from('anchors').select('id')
    .eq('public_id', input.anchorPublicId)
    .eq('user_id', input.actorUserId)
    .is('deleted_at', null);
  anchorQuery = input.orgId ? anchorQuery.eq('org_id', input.orgId) : anchorQuery.is('org_id', null);
  const { data: anchor, error: anchorError } = await anchorQuery.maybeSingle();
  if (anchorError || !anchor) throw new Error('recipient_anchor_unavailable');

  const recipient = await resolveBulkRecipientProfile(input.email, input.fullName);
  const { error } = await db.from('anchor_recipients').insert({
    anchor_id: anchor.id,
    recipient_email_hash: emailHash,
    recipient_user_id: recipient.profileId,
    claimed_at: null,
  });
  if (error && (error as { code?: string }).code === '23505') {
    const { data: existingLink, error: lookupError } = await db.from('anchor_recipients')
      .select('recipient_user_id').eq('anchor_id', anchor.id)
      .eq('recipient_email_hash', emailHash).maybeSingle();
    if (lookupError || existingLink?.recipient_user_id !== recipient.profileId) {
      throw new Error('recipient_link_conflict');
    }
  } else if (error) {
    throw new Error('recipient_link_failed');
  }

  if (recipient.activationToken && input.deliverActivationEmail === true) {
    await deliverBulkActivationOnce({
      profileId: recipient.profileId,
      activationToken: recipient.activationToken,
      email: input.email,
      fullName: input.fullName,
      actorUserId: input.actorUserId,
      orgId: input.orgId,
    });
  }
}
