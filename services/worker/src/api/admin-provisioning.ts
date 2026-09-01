/**
 * Platform-admin provisioning (SCRUM-3061).
 *
 * Creates a net-new organization and a net-new user account. The admin console
 * could already SET an existing org's quota (`handleSetOrgQuota`) and credits
 * (`handleAdjustOrgCredit`); it could not bring either subject into existence,
 * so every partner org to date was stood up by hand against prod.
 *
 * Design constraints are derived from
 * `docs/staging/premortem-platform-admin-provisioning-2026-09-01.md`. Three of
 * them are load-bearing and non-obvious:
 *
 * 1. **The auth user is ALWAYS created with `email_confirm: false`.**
 *    `zz_auth_user_auto_associate_org` fires on email confirmation and calls
 *    `auto_associate_profile_to_org_by_email_domain`, which joins the user to
 *    whatever org claims their email domain and sets
 *    `role = COALESCE(role,'ORG_MEMBER')`. Because `enforce_role_immutability`
 *    is a BEFORE UPDATE trigger, a role set that way can never be corrected
 *    without DDL. Deferring confirmation until AFTER role + org are written
 *    means the race cannot happen — this is correctness by construction, not a
 *    guard. The `role_conflict` check below is a belt-and-braces assertion for
 *    the case where the address already had a profile.
 *
 * 2. **No DDL, ever.** The neighbouring `admin_change_user_role` /
 *    `admin_set_platform_admin` RPCs run `ALTER TABLE profiles DISABLE TRIGGER`
 *    to write protected columns. That takes an ACCESS EXCLUSIVE lock on a hot
 *    table with no `lock_timeout` — the mechanism CLAUDE.md §1.2 attributes to
 *    the 2026-08-11 P0. We do not need it: `protect_privileged_profile_fields`
 *    grants `service_role` an explicit bypass, and `enforce_role_immutability`
 *    permits NULL -> value. Do not "simplify" this module by reusing those RPCs.
 *
 * 3. **`is_platform_admin` is not an input.** Minting a platform admin stays a
 *    separate, deliberate call to the existing promote-admin endpoint, which
 *    carries its own self-demotion guard.
 *
 * Email/URL modules are imported lazily inside the two helpers at the bottom:
 * `email/sender.ts` pulls the Resend SDK and `lib/urls.ts` evaluates the Zod
 * config at module scope, and neither belongs in the import graph of every
 * caller of admin-actions.ts (nor on the cold-start path when no mail is sent).
 *
 * PII: never log the email address or full name — user id and org id only (§1.4).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../utils/logger.js';

export interface AdminProvisioningDeps {
  db: SupabaseClient;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export type ProvisioningErrorCode =
  | 'invalid_input'
  | 'org_exists'
  | 'account_exists'
  | 'role_conflict'
  | 'internal_error';

/** Maps 1:1 to an HTTP status in the route layer. */
export class ProvisioningError extends Error {
  constructor(
    message: string,
    readonly code: ProvisioningErrorCode,
    readonly existingOrgId?: string,
  ) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

export const PROVISIONING_ERROR_STATUS: Record<ProvisioningErrorCode, number> = {
  invalid_input: 400,
  org_exists: 409,
  account_exists: 409,
  role_conflict: 409,
  internal_error: 500,
};

const PROFILE_ROLES = ['INDIVIDUAL', 'ORG_ADMIN', 'ORG_MEMBER'] as const;
const ORG_MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];
export type OrgMemberRole = (typeof ORG_MEMBER_ROLES)[number];

/** Deliberately permissive: real addresses only need to round-trip Supabase. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LEN = 200;

export interface CreateOrganizationInput {
  display_name: string;
  legal_name: string;
  /** null = uncapped. Always written explicitly (see F8). */
  anchor_quota: number | null;
  credits: number;
  is_test: boolean;
  allow_duplicate_name: boolean;
}

export interface CreateUserAccountInput {
  email: string;
  full_name: string | null;
  role: ProfileRole;
  org_id: string | null;
  org_role: OrgMemberRole;
  send_invite_email: boolean;
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateCreateOrganizationInput(body: unknown): Validated<CreateOrganizationInput> {
  const b = (body ?? {}) as Record<string, unknown>;

  const displayName = typeof b.display_name === 'string' ? b.display_name.trim() : '';
  if (displayName.length === 0) return { ok: false, error: 'display_name is required' };
  if (displayName.length > MAX_NAME_LEN) {
    return { ok: false, error: `display_name must be ${MAX_NAME_LEN} characters or fewer` };
  }

  const legalNameRaw = typeof b.legal_name === 'string' ? b.legal_name.trim() : '';
  if (legalNameRaw.length > MAX_NAME_LEN) {
    return { ok: false, error: `legal_name must be ${MAX_NAME_LEN} characters or fewer` };
  }

  // undefined => keep the seed trigger's default cap of 10; null => uncapped.
  let anchorQuota: number | null = 10;
  if (b.anchor_quota === null) {
    anchorQuota = null;
  } else if (b.anchor_quota !== undefined) {
    if (typeof b.anchor_quota !== 'number' || !Number.isInteger(b.anchor_quota) || b.anchor_quota < 0) {
      return { ok: false, error: 'anchor_quota must be a non-negative integer, or null for uncapped' };
    }
    anchorQuota = b.anchor_quota;
  }

  const credits = b.credits === undefined ? 0 : b.credits;
  if (typeof credits !== 'number' || !Number.isInteger(credits) || credits < 0) {
    return { ok: false, error: 'credits must be a non-negative integer' };
  }

  const isTest = b.is_test === undefined ? true : b.is_test;
  if (typeof isTest !== 'boolean') return { ok: false, error: 'is_test must be a boolean' };

  const allowDuplicateName = b.allow_duplicate_name === undefined ? false : b.allow_duplicate_name;
  if (typeof allowDuplicateName !== 'boolean') {
    return { ok: false, error: 'allow_duplicate_name must be a boolean' };
  }

  return {
    ok: true,
    value: {
      display_name: displayName,
      legal_name: legalNameRaw.length > 0 ? legalNameRaw : displayName,
      anchor_quota: anchorQuota,
      credits,
      is_test: isTest,
      allow_duplicate_name: allowDuplicateName,
    },
  };
}

export function validateCreateUserAccountInput(body: unknown): Validated<CreateUserAccountInput> {
  const b = (body ?? {}) as Record<string, unknown>;

  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'a valid email is required' };

  const role = b.role as ProfileRole;
  if (!PROFILE_ROLES.includes(role)) {
    return { ok: false, error: `role must be one of ${PROFILE_ROLES.join(', ')}` };
  }

  const orgId = b.org_id === undefined || b.org_id === null ? null : b.org_id;
  if (orgId !== null && typeof orgId !== 'string') {
    return { ok: false, error: 'org_id must be a UUID string or null' };
  }
  if (role === 'INDIVIDUAL' && orgId !== null) {
    return { ok: false, error: 'org_id must be null for an INDIVIDUAL account' };
  }
  if (role !== 'INDIVIDUAL' && orgId === null) {
    return { ok: false, error: `org_id is required for role ${role}` };
  }

  const orgRole = (b.org_role === undefined ? 'member' : b.org_role) as OrgMemberRole;
  if (!ORG_MEMBER_ROLES.includes(orgRole)) {
    return { ok: false, error: `org_role must be one of ${ORG_MEMBER_ROLES.join(', ')}` };
  }

  const fullNameRaw = typeof b.full_name === 'string' ? b.full_name.trim() : '';
  if (fullNameRaw.length > MAX_NAME_LEN) {
    return { ok: false, error: `full_name must be ${MAX_NAME_LEN} characters or fewer` };
  }

  const sendInviteEmail = b.send_invite_email === undefined ? true : b.send_invite_email;
  if (typeof sendInviteEmail !== 'boolean') {
    return { ok: false, error: 'send_invite_email must be a boolean' };
  }

  // NOTE: `is_platform_admin` is intentionally NOT read from the body (F1).
  return {
    ok: true,
    value: {
      email,
      full_name: fullNameRaw.length > 0 ? fullNameRaw : null,
      role,
      org_id: orgId,
      org_role: orgRole,
      send_invite_email: sendInviteEmail,
    },
  };
}

export interface CreateOrganizationResult {
  org_id: string;
  public_id: string | null;
  org_prefix: string | null;
  display_name: string;
  anchor_quota: number | null;
  credits_balance: number;
  is_test: boolean;
}

export async function createOrganization(
  deps: AdminProvisioningDeps,
  actorId: string,
  input: CreateOrganizationInput,
): Promise<CreateOrganizationResult> {
  const { db, logger } = deps;

  // F3: `organizations.display_name` carries no unique constraint, and a DB
  // constraint would be wrong — two unrelated legal entities can share a name.
  // So this is an explicit, overridable guard against the double-submit case.
  if (!input.allow_duplicate_name) {
    const { data: existing, error: lookupError } = await db
      .from('organizations')
      .select('id')
      .eq('display_name', input.display_name)
      .maybeSingle();
    if (lookupError) {
      logger.error({ error: lookupError }, 'Admin provisioning: duplicate-org lookup failed');
      throw new ProvisioningError('Failed to create the organization.', 'internal_error');
    }
    if (existing) {
      throw new ProvisioningError(
        'An organization with this name already exists. Re-submit with allow_duplicate_name to create it anyway.',
        'org_exists',
        (existing as { id: string }).id,
      );
    }
  }

  const { data: created, error: insertError } = await db
    .from('organizations')
    .insert({
      display_name: input.display_name,
      legal_name: input.legal_name,
      verification_status: 'UNVERIFIED',
      tier: 'FREE',
    })
    .select('id, public_id, org_prefix, display_name')
    .single();

  const orgRow = created as { id: string; public_id: string | null; org_prefix: string | null } | null;
  if (insertError || !orgRow) {
    logger.error({ error: insertError }, 'Admin provisioning: organization insert failed');
    throw new ProvisioningError('Failed to create the organization.', 'internal_error');
  }

  // F8: `trg_seed_free_tier_org_credits` has already inserted
  // (is_test=true, anchor_quota=10). Always overwrite with the resolved state
  // so "uncapped" and "no credits" are real rather than silently defaulted.
  const { error: creditsError } = await db
    .from('org_credits')
    .update({
      is_test: input.is_test,
      anchor_quota: input.anchor_quota,
      balance: input.credits,
      purchased: input.credits,
      monthly_allocation: 0,
    })
    .eq('org_id', orgRow.id);

  if (creditsError) {
    logger.error({ error: creditsError, orgId: orgRow.id }, 'Admin provisioning: org_credits write failed');
    throw new ProvisioningError('Organization created but credit setup failed.', 'internal_error');
  }

  const { error: auditError } = await db.from('audit_events').insert({
    event_type: 'ORGANIZATION_PROVISIONED',
    event_category: 'ORGANIZATION',
    actor_id: actorId,
    target_type: 'organization',
    target_id: orgRow.id,
    org_id: orgRow.id,
    details: JSON.stringify({
      anchor_quota: input.anchor_quota,
      credits: input.credits,
      is_test: input.is_test,
    }),
  });
  if (auditError) {
    logger.warn({ error: auditError, orgId: orgRow.id }, 'Admin provisioning: org audit emit failed');
  }

  logger.info(
    { orgId: orgRow.id, actorId, anchorQuota: input.anchor_quota, credits: input.credits },
    'Admin provisioning: organization created',
  );

  return {
    org_id: orgRow.id,
    public_id: orgRow.public_id,
    org_prefix: orgRow.org_prefix,
    display_name: input.display_name,
    anchor_quota: input.anchor_quota,
    credits_balance: input.credits,
    is_test: input.is_test,
  };
}

export interface CreateUserAccountResult {
  user_id: string;
  email: string;
  role: ProfileRole;
  org_id: string | null;
  org_role: OrgMemberRole | null;
  invite_email_sent: boolean;
  /** Populated ONLY when the caller opted out of the email (F6). */
  activation_link: string | null;
}

export async function createUserAccount(
  deps: AdminProvisioningDeps,
  actorId: string,
  input: CreateUserAccountInput,
): Promise<CreateUserAccountResult> {
  const { db, logger } = deps;

  const { data: existingProfile, error: existingError } = await db
    .from('profiles')
    .select('id')
    .eq('email', input.email)
    .maybeSingle();
  if (existingError) {
    logger.error({ error: existingError }, 'Admin provisioning: existing-account lookup failed');
    throw new ProvisioningError('Failed to create the account.', 'internal_error');
  }
  if (existingProfile) {
    throw new ProvisioningError(
      'An account with this email address already exists.',
      'account_exists',
    );
  }

  // F2: email_confirm:false keeps `zz_auth_user_auto_associate_org` dormant
  // until role + org are written below.
  const { data: createdUser, error: createError } = await db.auth.admin.createUser({
    email: input.email,
    email_confirm: false,
    user_metadata: input.full_name ? { full_name: input.full_name } : undefined,
  });

  const newUser = (createdUser as { user?: { id: string } } | null)?.user;
  if (createError || !newUser) {
    logger.error({ error: createError }, 'Admin provisioning: auth user creation failed');
    throw new ProvisioningError('Failed to create the account.', 'internal_error');
  }
  const userId = newUser.id;

  let activationLink: string | null = null;
  let inviteEmailSent = false;

  try {
    // The `on_auth_user_created` trigger normally wins this race and has
    // already inserted the row; 23505 is therefore success, not a conflict.
    const { error: profileInsertError } = await db.from('profiles').insert({
      id: userId,
      email: input.email,
      full_name: input.full_name,
      role: input.role,
      org_id: input.org_id,
      subscription_tier: 'free',
      status: 'ACTIVE',
    });
    if (profileInsertError && (profileInsertError as { code?: string }).code !== '23505') {
      throw profileInsertError;
    }

    // Belt-and-braces (F2): if anything pre-set a different role, that role is
    // frozen by `enforce_role_immutability` and the account is unusable as
    // requested. Fail loudly rather than shipping a silently mis-roled admin.
    const { data: profileRow, error: readBackError } = await db
      .from('profiles')
      .select('id, role')
      .eq('id', userId)
      .maybeSingle();
    if (readBackError) throw readBackError;

    const currentRole = (profileRow as { role: ProfileRole | null } | null)?.role ?? null;
    if (currentRole !== null && currentRole !== input.role) {
      throw new ProvisioningError(
        `This account was auto-assigned the role ${currentRole}, which cannot be changed. `
          + 'Its email domain is claimed by an existing organization.',
        'role_conflict',
      );
    }

    // service_role bypasses protect_privileged_profile_fields; role is still
    // NULL here so enforce_role_immutability permits NULL -> value. No DDL.
    const { error: profileUpdateError } = await db
      .from('profiles')
      .update({ role: input.role, org_id: input.org_id, full_name: input.full_name })
      .eq('id', userId);
    if (profileUpdateError) throw profileUpdateError;

    if (input.org_id) {
      const { error: memberError } = await db.from('org_members').insert({
        user_id: userId,
        org_id: input.org_id,
        role: input.org_role,
        invited_by: actorId,
      });
      if (memberError) throw memberError;
    }

    const { error: auditError } = await db.from('audit_events').insert({
      event_type: 'ACCOUNT_PROVISIONED',
      event_category: 'PROFILE',
      actor_id: actorId,
      target_type: 'profile',
      target_id: userId,
      org_id: input.org_id,
      details: JSON.stringify({ role: input.role, org_role: input.org_id ? input.org_role : null }),
    });
    if (auditError) {
      logger.warn({ error: auditError, userId }, 'Admin provisioning: account audit emit failed');
    }

    const link = await generateSetPasswordLink(deps, input.email);

    if (input.send_invite_email) {
      inviteEmailSent = await sendProvisioningEmail(deps, {
        email: input.email,
        orgId: input.org_id,
        link,
      });
    } else {
      // F6: nobody is being told, so make the account immediately usable and
      // hand the link back for out-of-band delivery. Confirming AFTER role and
      // org are written makes the auto-association profile update a no-op.
      activationLink = link;
      const { error: confirmError } = await db.auth.admin.updateUserById(userId, {
        email_confirm: true,
      });
      if (confirmError) {
        logger.warn({ error: confirmError, userId }, 'Admin provisioning: email auto-confirm failed');
      }
    }
  } catch (err) {
    logger.error(
      { error: err instanceof ProvisioningError ? err.code : err, userId },
      'Admin provisioning: provisioning failed after account creation — rolling back the auth user',
    );
    const { error: deleteError } = await db.auth.admin.deleteUser(userId);
    if (deleteError) {
      logger.error(
        { error: deleteError, userId },
        'Admin provisioning: rollback deleteUser failed — orphaned auth user needs manual cleanup',
      );
    }
    if (err instanceof ProvisioningError) throw err;
    throw new ProvisioningError('Failed to create the account.', 'internal_error');
  }

  logger.info(
    { userId, actorId, orgId: input.org_id, role: input.role, inviteEmailSent },
    'Admin provisioning: account created',
  );

  return {
    user_id: userId,
    email: input.email,
    role: input.role,
    org_id: input.org_id,
    org_role: input.org_id ? input.org_role : null,
    invite_email_sent: inviteEmailSent,
    activation_link: activationLink,
  };
}

/**
 * Recovery-type link: the admin never sets, sees, or transmits a password —
 * the recipient chooses their own. Prohibited alternative is minting a
 * password admin-side and emailing it.
 */
async function generateSetPasswordLink(
  deps: AdminProvisioningDeps,
  email: string,
): Promise<string | null> {
  const { db, logger } = deps;
  try {
    const { buildLoginUrl } = await import('../lib/urls.js');
    const { data, error } = await db.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: buildLoginUrl() },
    });
    const link = (data as { properties?: { action_link?: string } } | null)?.properties?.action_link;
    if (error || !link) {
      logger.error({ error }, 'Admin provisioning: set-password link generation failed');
      return null;
    }
    return link;
  } catch (err) {
    logger.error({ error: err }, 'Admin provisioning: set-password link generation threw');
    return null;
  }
}

async function sendProvisioningEmail(
  deps: AdminProvisioningDeps,
  args: { email: string; orgId: string | null; link: string | null },
): Promise<boolean> {
  const { db, logger } = deps;
  if (!args.link) return false;

  let orgName = 'Arkova';
  if (args.orgId) {
    const { data: org } = await db
      .from('organizations')
      .select('display_name')
      .eq('id', args.orgId)
      .maybeSingle();
    orgName = (org as { display_name?: string } | null)?.display_name ?? orgName;
  }

  try {
    // Lazy: keeps the Resend SDK out of the import graph of every module that
    // touches admin actions, and off the cold-start path when no email is sent.
    const [{ sendEmail }, { buildAccountVerificationEmail }] = await Promise.all([
      import('../email/sender.js'),
      import('../email/templates.js'),
    ]);
    const result = await sendEmail({
      to: args.email,
      ...buildAccountVerificationEmail({
        recipientEmail: args.email,
        organizationName: orgName,
        verificationUrl: args.link,
      }),
      emailType: 'account_verification',
    });
    return result.success;
  } catch (err) {
    logger.error({ error: err }, 'Admin provisioning: invite email send threw');
    return false;
  }
}
