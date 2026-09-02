/**
 * Platform-admin provisioning (SCRUM-3873).
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
 *    means that race cannot happen — correctness by construction for the
 *    PROFILE half of that trigger.
 *
 *    It does NOT close the trigger's other half: its
 *    `INSERT INTO org_members (…, 'member') ON CONFLICT DO NOTHING` is
 *    UNCONDITIONAL and still fires whenever the address is eventually
 *    confirmed. An account provisioned into org A whose email domain is
 *    claimed by org B will additionally acquire an org_members row in B, and
 *    `get_user_org_ids()` feeds RLS off that table. That is pre-existing
 *    platform behaviour for every signup, not something this module
 *    introduces, and changing it belongs with the trigger — but do not read
 *    the paragraph above as covering it.
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

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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

/**
 * Postgres surfaces the offending value in `details` — a unique violation on
 * `profiles.email` reads `Key (email)=(person@example.com) already exists`.
 * Handing the raw error to pino would put that address in Cloud Run logs and
 * Sentry, against §1.4. Keep the code and message; drop everything else.
 */
function sanitizeError(err: unknown): { code?: string; message?: string } | undefined {
  if (err === null || err === undefined) return undefined;
  const e = err as { code?: unknown; message?: unknown };
  return {
    code: typeof e.code === 'string' ? e.code : undefined,
    message: typeof e.message === 'string' ? e.message.slice(0, 200) : undefined,
  };
}

/** Supabase reports an already-registered address without a stable code. */
function isDuplicateAuthUserError(err: unknown): boolean {
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return false;
  return /already (been )?registered|already exists/i.test(message);
}

const PROFILE_ROLES = ['INDIVIDUAL', 'ORG_ADMIN', 'ORG_MEMBER'] as const;
const ORG_MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];
export type OrgMemberRole = (typeof ORG_MEMBER_ROLES)[number];

const MAX_NAME_LEN = 200;

/**
 * `anchor_quota` is tri-state and the distinction matters (F8):
 *   omitted -> keep the seed trigger's default cap of 10
 *   null    -> uncapped, explicitly written over the trigger's default
 *   number  -> that cap
 */
const CreateOrganizationSchema = z
  .object({
    display_name: z.string().trim().min(1).max(MAX_NAME_LEN),
    legal_name: z.string().trim().max(MAX_NAME_LEN).optional(),
    anchor_quota: z.number().int().min(0).nullable().default(10),
    credits: z.number().int().min(0).default(0),
    is_test: z.boolean().default(true),
    allow_duplicate_name: z.boolean().default(false),
    // REQUIRED. The display_name pre-check below is SELECT-then-INSERT and so
    // cannot be atomic; this key is what actually makes creation idempotent
    // (migration 0422). The endpoint is new and has no other consumers, so it
    // is required rather than optional — an optional guarantee is not one.
    idempotency_key: z.string().uuid(),
  })
  .transform((v) => ({ ...v, legal_name: v.legal_name || v.display_name }));

const CreateUserAccountSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    full_name: z.string().trim().max(MAX_NAME_LEN).optional(),
    role: z.enum(PROFILE_ROLES),
    org_id: z.string().uuid().nullable().default(null),
    org_role: z.enum(ORG_MEMBER_ROLES).default('member'),
    send_invite_email: z.boolean().default(true),
    // NOTE: `is_platform_admin` is deliberately absent (F1). Zod strips
    // unknown keys, so passing it is silently ignored rather than honoured.
  })
  .transform((v) => ({ ...v, full_name: v.full_name || null }))
  .superRefine((v, ctx) => {
    if (v.role === 'INDIVIDUAL' && v.org_id !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'org_id must be null for an INDIVIDUAL account' });
    }
    if (v.role !== 'INDIVIDUAL' && v.org_id === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `org_id is required for role ${v.role}` });
    }
  });

export type CreateOrganizationInput = z.infer<typeof CreateOrganizationSchema>;
export type CreateUserAccountInput = z.infer<typeof CreateUserAccountSchema>;

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function toValidated<T>(
  result: { success: true; data: T } | { success: false; error: z.ZodError },
): Validated<T> {
  if (result.success) return { ok: true, value: result.data };
  const first = result.error.issues[0];
  const path = first.path.join('.');
  return { ok: false, error: path ? `${path}: ${first.message}` : first.message };
}

export function validateCreateOrganizationInput(body: unknown): Validated<CreateOrganizationInput> {
  return toValidated(CreateOrganizationSchema.safeParse(body ?? {}));
}

export function validateCreateUserAccountInput(body: unknown): Validated<CreateUserAccountInput> {
  return toValidated(CreateUserAccountSchema.safeParse(body ?? {}));
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
    // limit(1), NOT maybeSingle(): once an admin has used
    // allow_duplicate_name, two rows share the name and maybeSingle() would
    // raise PGRST116 — turning the intended 409 into a 500 that the override
    // cannot get past.
    const { data: existingRows, error: lookupError } = await db
      .from('organizations')
      .select('id')
      .eq('display_name', input.display_name)
      .limit(1);
    if (lookupError) {
      logger.error({ error: sanitizeError(lookupError) }, 'Admin provisioning: duplicate-org lookup failed');
      throw new ProvisioningError('Failed to create the organization.', 'internal_error');
    }
    const existing = (existingRows as Array<{ id: string }> | null)?.[0];
    if (existing) {
      throw new ProvisioningError(
        'An organization with this name already exists. Re-submit with allow_duplicate_name to create it anyway.',
        'org_exists',
        existing.id,
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
      creation_idempotency_key: input.idempotency_key,
    })
    .select('id, public_id, org_prefix, display_name')
    .single();

  let orgRow = created as { id: string; public_id: string | null; org_prefix: string | null } | null;

  // 23505 on the partial unique index = this exact submission already created
  // an organization. That is a REPLAY, not a failure: return the organization
  // the first request made. This is the atomic half of the duplicate guard —
  // the display_name pre-check above only catches the slow, sequential case.
  if ((insertError as { code?: string } | null)?.code === '23505') {
    const { data: prior, error: priorError } = await db
      .from('organizations')
      .select('id, public_id, org_prefix, display_name')
      .eq('creation_idempotency_key', input.idempotency_key)
      .limit(1);
    const priorRow = (prior as Array<{ id: string; public_id: string | null; org_prefix: string | null }> | null)?.[0];
    if (priorError || !priorRow) {
      logger.error({ error: sanitizeError(priorError ?? insertError) }, 'Admin provisioning: idempotent replay lookup failed');
      throw new ProvisioningError('Failed to create the organization.', 'internal_error');
    }
    logger.info({ orgId: priorRow.id, actorId }, 'Admin provisioning: idempotent replay of organization creation');
    orgRow = priorRow;
  } else if (insertError || !orgRow) {
    logger.error({ error: sanitizeError(insertError) }, 'Admin provisioning: organization insert failed');
    throw new ProvisioningError('Failed to create the organization.', 'internal_error');
  }

  // F8: `trg_seed_free_tier_org_credits` has normally already inserted
  // (is_test=true, anchor_quota=10); always overwrite so "uncapped" is real
  // rather than silently defaulted.
  //
  // UPSERT, not UPDATE: PostgREST reports a zero-row UPDATE as success, and the
  // seed trigger skips orgs with a parent (`parent_org_id IS NOT NULL`). A bare
  // update would then return success for an org with NO org_credits row at all
  // and we would report a balance the org does not have — the same silent
  // default this write exists to prevent.
  const { error: creditsError } = await db
    .from('org_credits')
    .upsert({
      org_id: orgRow.id,
      is_test: input.is_test,
      anchor_quota: input.anchor_quota,
      balance: 0,
      purchased: 0,
      monthly_allocation: 0,
    }, { onConflict: 'org_id' });

  if (creditsError) {
    logger.error({ error: sanitizeError(creditsError), orgId: orgRow.id }, 'Admin provisioning: org_credits write failed');
    throw new ProvisioningError('Organization created but credit setup failed.', 'internal_error');
  }

  // Starting credits go through the existing audited ledger path
  // (`admin_adjust_org_credit`, migration 0375) rather than being written
  // straight onto the balance. Writing `purchased = credits` directly would
  // keep the conservation invariant balanced only by booking a founder grant
  // as revenue; the RPC books it as a GRANT row instead, which is what it is.
  if (input.credits > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: grantError } = await (db as any).rpc('admin_adjust_org_credit', {
      p_org_id: orgRow.id,
      p_amount: input.credits,
      p_reason: 'Starting credits at organization provisioning',
      p_idempotency_key: randomUUID(),
      p_actor: actorId,
    });
    if (grantError) {
      logger.error({ error: sanitizeError(grantError), orgId: orgRow.id }, 'Admin provisioning: starting-credit grant failed');
      throw new ProvisioningError('Organization created but the starting credit grant failed.', 'internal_error');
    }
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
    logger.warn({ error: sanitizeError(auditError), orgId: orgRow.id }, 'Admin provisioning: org audit emit failed');
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
    logger.error({ error: sanitizeError(existingError) }, 'Admin provisioning: existing-account lookup failed');
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
    // An auth user can exist with no profile row — the F4 orphan left behind
    // when a previous rollback's deleteUser also failed. The profiles lookup
    // above cannot see it, so map the duplicate here rather than reporting a
    // generic failure the operator cannot act on.
    if (isDuplicateAuthUserError(createError)) {
      throw new ProvisioningError(
        'An account with this email address already exists in the auth system but has no profile. '
          + 'It is orphaned from a failed provisioning attempt and needs manual cleanup.',
        'account_exists',
      );
    }
    logger.error({ error: sanitizeError(createError) }, 'Admin provisioning: auth user creation failed');
    throw new ProvisioningError('Failed to create the account.', 'internal_error');
  }
  const userId = newUser.id;

  let activationLink: string | null = null;
  let inviteEmailSent = false;

  try {
    // The `on_auth_user_created` trigger normally wins this race and has
    // already inserted the row; 23505 is therefore success, not a conflict.
    // Identity columns only. role / org_id / full_name are written by the
    // single UPDATE below, so there is exactly ONE writer for them whether the
    // row came from us or from `on_auth_user_created` — which in turn makes the
    // role guard meaningful on both paths instead of only one.
    const { error: profileInsertError } = await db.from('profiles').insert({
      id: userId,
      email: input.email,
      subscription_tier: 'free',
      status: 'ACTIVE',
    });
    if (profileInsertError && (profileInsertError as { code?: string }).code !== '23505') {
      throw profileInsertError;
    }

    // Assertion, not a second existence check: nothing should have set a role
    // by this point (the pre-check above already returned account_exists for a
    // known address, and email_confirm:false keeps the auto-association writer
    // dormant), so `currentRole` is expected to be null. If it is ever not,
    // `enforce_role_immutability` has frozen the wrong role onto this account
    // — fail loudly rather than ship a silently mis-roled admin. Do not delete
    // the pre-check above on the assumption that this replaces it.
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
      logger.warn({ error: sanitizeError(auditError), userId }, 'Admin provisioning: account audit emit failed');
    }

    const link = await generateSetPasswordLink(deps, input.email);

    if (input.send_invite_email) {
      inviteEmailSent = await sendProvisioningEmail(deps, {
        email: input.email,
        orgId: input.org_id,
        link,
      });
    }

    // F6, both branches: if no email actually went out — because the admin
    // opted out OR because the send failed — nobody has been told this account
    // exists. Hand the link back for out-of-band delivery and make the account
    // immediately usable. Reporting a send that did not happen is the silent
    // failure this whole flow exists to avoid, so this is keyed on the ACTUAL
    // send result, never on the caller's intent.
    if (!inviteEmailSent) {
      activationLink = link;
      // Confirming AFTER role and org are written makes the auto-association
      // profile update a no-op.
      const { error: confirmError } = await db.auth.admin.updateUserById(userId, {
        email_confirm: true,
      });
      if (confirmError) {
        logger.warn({ error: sanitizeError(confirmError), userId }, 'Admin provisioning: email auto-confirm failed');
      }
    }
  } catch (err) {
    logger.error(
      { error: err instanceof ProvisioningError ? err.code : sanitizeError(err), userId },
      'Admin provisioning: provisioning failed after account creation — rolling back the auth user',
    );
    const { error: deleteError } = await db.auth.admin.deleteUser(userId);
    if (deleteError) {
      logger.error(
        { error: sanitizeError(deleteError), userId },
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
      logger.error({ error: sanitizeError(error) }, 'Admin provisioning: set-password link generation failed');
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
