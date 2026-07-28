/**
 * Invitation accept/preview API (SCRUM-3012).
 *
 * Root cause fixed here: `routes/anchor.ts`'s `/send-invitation-email` built
 * the invite link as `/login?invite=true&org=...`, dropping the
 * `invitations.token` uuid entirely — nothing in the app ever consumed a
 * token because the link never carried one, so "accept" could never exist.
 * This module is the missing accept step: a public preview (org name, valid?)
 * and the actual provisioning (token+expiry validation, account creation for
 * a brand-new invitee, org_members insert, invitation status transition).
 *
 * Account creation happens WORKER-SIDE via the Supabase admin API
 * (`db.auth.admin.createUser`) — never exposed to the browser (Constitution
 * §1.4: `supabase.auth.admin` must never reach the client). The browser only
 * ever POSTs an email-address-scoped invitation token + a chosen password.
 *
 * Email verification interplay (founder ruling): prod runs with
 * `mailer_autoconfirm=false`, so a brand-new account still needs its email
 * confirmed before it can sign in — the invite token proved control of the
 * mailbox ONCE, but login continues to require the normal confirmed-email
 * gate. The worker creates the auth user with `email_confirm:false`, mints a
 * Supabase signup-confirmation link via `admin.generateLink`, and sends it
 * through the existing Resend pipeline (its own template + audit trail)
 * rather than relying on Supabase's separate built-in mailer, so every
 * outbound email in this flow stays on one audited path.
 *
 * Transaction safety for a brand-new account: `createUser` succeeds first
 * (nothing to roll back before that), then profile + org_members + invitation
 * status update run; ANY failure in that inner block deletes the just-created
 * auth user (best-effort) so a partial failure never leaves a dangling
 * account that blocks re-inviting the same address. An EXISTING account never
 * risks this — it only ever inserts an `org_members` row.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../utils/logger.js';
import { sendEmail } from '../email/sender.js';
import { buildAccountVerificationEmail } from '../email/templates.js';
import { buildLoginUrl } from '../lib/urls.js';

export interface InvitationDeps {
  db: SupabaseClient;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export type InvitationErrorCode =
  | 'not_found'
  | 'expired'
  | 'already_used'
  | 'email_mismatch'
  | 'account_exists'
  | 'invalid_input'
  | 'internal_error';

/** Maps 1:1 to an HTTP status in the route layer — see anchor.ts. */
export class InvitationError extends Error {
  constructor(message: string, readonly code: InvitationErrorCode) {
    super(message);
    this.name = 'InvitationError';
  }
}

type MemberProfileRole = 'INDIVIDUAL' | 'ORG_ADMIN' | 'ORG_MEMBER';

/** Mirrors admin-org-members.ts's PROFILE_ROLE_TO_MEMBER_ROLE (kept local —
 *  small, single-use map; not worth coupling two unrelated route modules). */
const PROFILE_ROLE_TO_MEMBER_ROLE: Record<MemberProfileRole, 'owner' | 'admin' | 'member'> = {
  ORG_ADMIN: 'admin',
  INDIVIDUAL: 'member',
  ORG_MEMBER: 'member',
};

interface InvitationRow {
  id: string;
  email: string;
  role: MemberProfileRole;
  org_id: string;
  invited_by: string;
  status: string;
  expires_at: string;
}

async function loadInvitationByToken(
  deps: InvitationDeps,
  token: string,
): Promise<InvitationRow | null> {
  const { data, error } = await deps.db
    .from('invitations')
    .select('id, email, role, org_id, invited_by, status, expires_at')
    .eq('token', token)
    .maybeSingle();
  if (error) {
    deps.logger.error({ error }, 'Invitation lookup failed');
    throw new InvitationError('Failed to look up this invitation.', 'internal_error');
  }
  return (data as InvitationRow | null) ?? null;
}

async function loadOrgName(deps: InvitationDeps, orgId: string): Promise<string> {
  const { data, error } = await deps.db
    .from('organizations')
    .select('display_name')
    .eq('id', orgId)
    .maybeSingle();
  if (error) {
    deps.logger.warn({ error, orgId }, 'Invitation: organization name lookup failed');
  }
  return (data as { display_name?: string | null } | null)?.display_name ?? 'the organization';
}

function isExpired(invitation: InvitationRow): boolean {
  return new Date(invitation.expires_at).getTime() < Date.now();
}

// ─── GET /api/invitations/:token — public preview ─────────────────────────

export interface InvitationPreview {
  orgName: string;
  email: string;
  role: MemberProfileRole;
  expired: boolean;
  alreadyUsed: boolean;
}

export async function getInvitationPreview(
  deps: InvitationDeps,
  token: string,
): Promise<InvitationPreview> {
  if (!token || typeof token !== 'string') {
    throw new InvitationError('A valid invitation link is required.', 'invalid_input');
  }

  const invitation = await loadInvitationByToken(deps, token);
  if (!invitation) {
    throw new InvitationError('This invitation link is invalid.', 'not_found');
  }

  const orgName = await loadOrgName(deps, invitation.org_id);

  return {
    orgName,
    email: invitation.email,
    role: invitation.role,
    expired: invitation.status === 'pending' && isExpired(invitation),
    alreadyUsed: invitation.status !== 'pending',
  };
}

// ─── POST /api/invitations/accept ──────────────────────────────────────────

export interface AcceptInvitationParams {
  token: string;
  /** Required only when provisioning a brand-new account (no session). */
  password?: string;
  fullName?: string;
  /** Authenticated caller id (from Authorization bearer), if any. */
  callerId: string | null;
}

export interface AcceptInvitationResult {
  orgId: string;
  orgName: string;
  /** True when a brand-new account was created and still needs email confirmation. */
  verificationRequired: boolean;
  verificationEmailSent: boolean;
}

async function provisionMembership(
  deps: InvitationDeps,
  userId: string,
  invitation: InvitationRow,
): Promise<void> {
  const { db, logger } = deps;

  // Idempotent: org_members has UNIQUE(user_id, org_id) — check first so a
  // race (double-submit / retry) is a clean no-op, not a constraint 500.
  const { data: existingMembership, error: membershipLookupError } = await db
    .from('org_members')
    .select('id')
    .eq('user_id', userId)
    .eq('org_id', invitation.org_id)
    .maybeSingle();
  if (membershipLookupError) throw membershipLookupError;

  if (!existingMembership) {
    const { error: memberInsertError } = await db.from('org_members').insert({
      user_id: userId,
      org_id: invitation.org_id,
      role: PROFILE_ROLE_TO_MEMBER_ROLE[invitation.role],
      invited_by: invitation.invited_by,
    });
    if (memberInsertError) throw memberInsertError;
  }

  // Backfill profiles.org_id/role only when unset — never reassign someone
  // already elsewhere (mirrors admin-org-members.ts's add-member backfill).
  const { error: profileUpdateError } = await db
    .from('profiles')
    .update({ org_id: invitation.org_id, role: invitation.role })
    .eq('id', userId)
    .is('org_id', null);
  if (profileUpdateError) {
    logger.warn(
      { error: profileUpdateError, userId, orgId: invitation.org_id },
      'Invitation accept: profile org backfill failed (non-fatal — membership already recorded)',
    );
  }

  const { error: statusError } = await db
    .from('invitations')
    .update({ status: 'accepted', accepted_at: new Date().toISOString() })
    .eq('id', invitation.id)
    .eq('status', 'pending');
  if (statusError) throw statusError;

  const { error: auditError } = await db.from('audit_events').insert({
    event_type: 'MEMBER_JOINED',
    event_category: 'ORGANIZATION',
    actor_id: userId,
    org_id: invitation.org_id,
    target_type: 'invitation',
    target_id: invitation.id,
    details: JSON.stringify({ invited_by: invitation.invited_by }),
  });
  if (auditError) {
    logger.warn({ error: auditError, userId, orgId: invitation.org_id }, 'Invitation accept: audit emit failed');
  }
}

/** Best-effort: mint + send the post-signup email confirmation link. Never
 *  throws — a failure here does not undo the account/membership that already
 *  succeeded; it is surfaced to the caller via `verificationEmailSent`. */
async function sendVerificationEmail(
  deps: InvitationDeps,
  args: { email: string; password: string; orgName: string },
): Promise<boolean> {
  const { db, logger } = deps;
  try {
    const { data: linkData, error: linkError } = await db.auth.admin.generateLink({
      type: 'signup',
      email: args.email,
      password: args.password,
      options: { redirectTo: buildLoginUrl() },
    });

    const actionLink = (
      linkData as { properties?: { action_link?: string } } | null
    )?.properties?.action_link;

    if (linkError || !actionLink) {
      logger.error({ error: linkError, email: args.email }, 'Invitation accept: verification link generation failed');
      return false;
    }

    const result = await sendEmail({
      to: args.email,
      ...buildAccountVerificationEmail({
        recipientEmail: args.email,
        organizationName: args.orgName,
        verificationUrl: actionLink,
      }),
      emailType: 'account_verification',
    });
    return result.success;
  } catch (err) {
    logger.error({ error: err, email: args.email }, 'Invitation accept: verification email send threw');
    return false;
  }
}

export async function acceptInvitation(
  deps: InvitationDeps,
  params: AcceptInvitationParams,
): Promise<AcceptInvitationResult> {
  const { db, logger } = deps;
  const { token, password, fullName, callerId } = params;

  if (!token || typeof token !== 'string') {
    throw new InvitationError('A valid invitation link is required.', 'invalid_input');
  }

  const invitation = await loadInvitationByToken(deps, token);
  if (!invitation) {
    throw new InvitationError('This invitation link is invalid.', 'not_found');
  }

  const orgName = await loadOrgName(deps, invitation.org_id);
  const email = invitation.email.toLowerCase();

  // Idempotency: an already-accepted invitation is only a "success" replay
  // when the caller can PROVE they're the member who accepted it.
  if (invitation.status !== 'pending') {
    if (callerId) {
      const { data: membership } = await db
        .from('org_members')
        .select('id')
        .eq('user_id', callerId)
        .eq('org_id', invitation.org_id)
        .maybeSingle();
      if (membership) {
        return { orgId: invitation.org_id, orgName, verificationRequired: false, verificationEmailSent: false };
      }
    }
    throw new InvitationError(
      'This invitation has already been used. Ask your administrator to send a new one.',
      'already_used',
    );
  }

  if (isExpired(invitation)) {
    throw new InvitationError(
      'This invitation has expired. Ask your administrator to send a new one.',
      'expired',
    );
  }

  // ── Existing-user path: caller is authenticated and owns the invited address ──
  if (callerId) {
    const { data: callerProfile, error: profileError } = await db
      .from('profiles')
      .select('email')
      .eq('id', callerId)
      .maybeSingle();
    if (profileError) {
      logger.error({ error: profileError, callerId }, 'Invitation accept: caller profile lookup failed');
      throw new InvitationError('Failed to verify your account.', 'internal_error');
    }
    const callerEmail = (callerProfile as { email?: string } | null)?.email;
    if ((callerEmail ?? '').toLowerCase() !== email) {
      throw new InvitationError(
        'This invitation was sent to a different email address. Sign out and try again.',
        'email_mismatch',
      );
    }

    await provisionMembership(deps, callerId, invitation);
    return { orgId: invitation.org_id, orgName, verificationRequired: false, verificationEmailSent: false };
  }

  // ── No session: check whether an account already exists for this address
  //    before trying (and failing) to create a duplicate. ──
  const { data: existingProfile, error: existingProfileError } = await db
    .from('profiles')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (existingProfileError) {
    logger.error({ error: existingProfileError, email }, 'Invitation accept: existing-account lookup failed');
    throw new InvitationError('Failed to process this invitation.', 'internal_error');
  }
  if (existingProfile) {
    throw new InvitationError(
      'An account with this email already exists. Sign in to accept this invitation.',
      'account_exists',
    );
  }

  if (!password || password.length < 8) {
    throw new InvitationError(
      'A password of at least 8 characters is required to create your account.',
      'invalid_input',
    );
  }

  // ── New-account path: create the auth user worker-side (never in the browser). ──
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
    user_metadata: fullName ? { full_name: fullName } : undefined,
  });

  const newUser = (created as { user?: { id: string } } | null)?.user;
  if (createError || !newUser) {
    logger.error({ error: createError, email }, 'Invitation accept: auth user creation failed');
    throw new InvitationError('Failed to create your account. Please try again.', 'internal_error');
  }
  const newUserId = newUser.id;

  try {
    const { error: profileInsertError } = await db.from('profiles').insert({
      id: newUserId,
      email,
      full_name: fullName ?? null,
      subscription_tier: 'free',
      status: 'ACTIVE',
    });
    // 23505 = unique_violation. A DB trigger MAY already have created this row
    // for the new auth user — that's success, not a failure, to insert around.
    if (profileInsertError && (profileInsertError as { code?: string }).code !== '23505') {
      throw profileInsertError;
    }

    await provisionMembership(deps, newUserId, invitation);
  } catch (err) {
    logger.error(
      { error: err, newUserId, email },
      'Invitation accept: provisioning failed after account creation — rolling back the new auth user',
    );
    const { error: deleteError } = await db.auth.admin.deleteUser(newUserId);
    if (deleteError) {
      // Rollback itself failed — this IS a real orphaned account. Loud log,
      // no PII beyond the id (already logged above under the original error).
      logger.error({ error: deleteError, newUserId }, 'Invitation accept: rollback deleteUser failed — orphaned auth user, needs manual cleanup');
    }
    throw new InvitationError('Failed to complete your invitation. Please try again.', 'internal_error');
  }

  const verificationEmailSent = await sendVerificationEmail(deps, { email, password, orgName });

  return { orgId: invitation.org_id, orgName, verificationRequired: true, verificationEmailSent };
}
