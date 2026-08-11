/**
 * Recipient account activation (launch blocker).
 *
 * Root cause fixed here — TWO independent, unconditional failures that between
 * them made activation 100% broken in production:
 *
 *  A. `ActivateAccountPage.tsx` called `activate_user({ p_token, p_claim_key })`,
 *     but the only overload deployed to prod is
 *     `activate_user(p_token text, p_password text)`. PostgREST binds function
 *     overloads by argument NAME, so `p_claim_key` could never resolve and every
 *     call returned PGRST202. The `p_claim_key` variant exists ONLY in
 *     `docs/migrations-archive/0175_activate_user_function.sql` — archived,
 *     never deployed (there is no `activation_tokens` table and no `claim_key`
 *     column anywhere in the live schema).
 *
 *  B. The deployed `activate_user` ACCEPTS `p_password` and then ignores it
 *     entirely — it only flips `profiles.status` to ACTIVE and clears the
 *     token. So even with (A) fixed, no password was ever set on the
 *     `auth.users` row and the recipient still could not sign in.
 *
 * WHY THIS IS A WORKER ENDPOINT AND NOT AN RPC
 *
 * Setting a password means writing GoTrue's `auth.users` state, which requires
 * the Supabase admin API (`auth.admin.updateUserById`) and therefore the
 * service_role key. Per Constitution §1.4 that key must NEVER reach the
 * browser, so the work cannot happen client-side. A SECURITY DEFINER function
 * writing password hashes straight into `auth.users` is the same antipattern
 * that migration 0401 rejects for `create_pending_recipient` — GoTrue owns
 * password hashing, `auth.identities` and confirmation state, and hand-writing
 * those rows produces accounts that cannot authenticate. So the SQL function is
 * retired (migration 0402) and this module is the one path that works, exactly
 * mirroring `invitations.ts` (SCRUM-3012), which already solves the identical
 * "unauthenticated caller holding an emailed token needs an account
 * provisioned" problem.
 *
 * EMAIL CONFIRMATION (flagged for human confirmation — see agents.md)
 *
 * `createPendingRecipient` mints the auth user with `email_confirm: false`, and
 * prod runs `mailer_autoconfirm=false`. Activation therefore sets
 * `email_confirm: true`: the single-use activation token was delivered to that
 * mailbox and nowhere else, so clicking it is the same proof of mailbox control
 * that a confirmation link provides. Without this the recipient sets a password
 * and STILL cannot sign in — i.e. the blocker would not actually be fixed.
 *
 * TOKEN HANDLING
 *
 *  - Format-validated (64 hex chars, matching `randomBytes(32).toString('hex')`)
 *    before any query, so malformed input never reaches Postgres.
 *  - Compared with `timingSafeEqual` in addition to the indexed lookup.
 *  - Single-use via a compare-and-swap UPDATE: the claim is taken BEFORE the
 *    password is written, so a replay can never reset an existing password.
 *  - Expiry enforced from `profiles.activation_token_expires_at`.
 *  - Never logged, never placed in an error message, never returned.
 */

import { timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../utils/logger.js';

export interface ActivationDeps {
  db: SupabaseClient;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export type ActivationErrorCode =
  | 'not_found'
  | 'expired'
  | 'already_used'
  | 'invalid_input'
  | 'internal_error';

/** Maps 1:1 to an HTTP status in the route layer — see routes/anchor.ts. */
export class ActivationError extends Error {
  constructor(message: string, readonly code: ActivationErrorCode) {
    super(message);
    this.name = 'ActivationError';
  }
}

/** `profiles.activation_token` is `randomBytes(32).toString('hex')` — see
 *  `recipients.ts`. Anything else cannot be a token we ever issued, so it is
 *  rejected before it reaches the database. */
const ACTIVATION_TOKEN_RE = /^[0-9a-f]{64}$/;

/** Mirrors `AcceptInvitationSchema` / `ActivateAccountSchema` (src/lib/validators.ts). */
const MIN_PASSWORD_LENGTH = 8;

/** Deliberately identical for "never existed" and "already consumed": the
 *  token is cleared on activation, so a second click finds nothing, and we do
 *  not want an oracle that distinguishes the two. */
const INVALID_TOKEN_MESSAGE =
  'This activation link is invalid or has already been used. Ask your organization administrator to send a new one.';

interface PendingProfileRow {
  id: string;
  email: string;
  full_name: string | null;
  org_id: string | null;
  status: string;
  activation_token: string | null;
  activation_token_expires_at: string | null;
}

/** Constant-time equality over the raw token bytes. The DB lookup is already an
 *  indexed equality on a 256-bit random value, so this is defence in depth
 *  against a future refactor that loosens the query (e.g. to a prefix match),
 *  and it keeps the app-layer comparison non-short-circuiting. */
function tokensMatch(supplied: string, stored: string | null): boolean {
  if (!stored) return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isExpired(row: PendingProfileRow): boolean {
  if (!row.activation_token_expires_at) return false;
  return new Date(row.activation_token_expires_at).getTime() < Date.now();
}

async function loadPendingProfile(
  deps: ActivationDeps,
  token: string,
): Promise<PendingProfileRow> {
  if (!ACTIVATION_TOKEN_RE.test(token)) {
    throw new ActivationError(INVALID_TOKEN_MESSAGE, 'not_found');
  }

  const { data, error } = await deps.db
    .from('profiles')
    .select('id, email, full_name, org_id, status, activation_token, activation_token_expires_at')
    .eq('activation_token', token)
    .eq('status', 'PENDING_ACTIVATION')
    .maybeSingle();

  if (error) {
    // No token in the log line — only the DB error itself.
    deps.logger.error({ error }, 'Activation: pending profile lookup failed');
    throw new ActivationError('Failed to look up this activation link.', 'internal_error');
  }

  const row = data as PendingProfileRow | null;
  if (!row || !tokensMatch(token, row.activation_token)) {
    throw new ActivationError(INVALID_TOKEN_MESSAGE, 'not_found');
  }
  return row;
}

async function loadOrgName(deps: ActivationDeps, orgId: string | null): Promise<string> {
  if (!orgId) return 'your organization';
  const { data, error } = await deps.db
    .from('organizations')
    .select('display_name')
    .eq('id', orgId)
    .maybeSingle();
  if (error) {
    deps.logger.warn({ error, orgId }, 'Activation: organization name lookup failed');
  }
  return (data as { display_name?: string | null } | null)?.display_name ?? 'your organization';
}

// ─── GET /api/activation/:token — public preview ───────────────────────────

export interface ActivationPreview {
  email: string;
  fullName: string | null;
  orgName: string;
  expired: boolean;
}

export async function getActivationPreview(
  deps: ActivationDeps,
  token: string,
): Promise<ActivationPreview> {
  const row = await loadPendingProfile(deps, token);
  return {
    email: row.email,
    fullName: row.full_name,
    orgName: await loadOrgName(deps, row.org_id),
    expired: isExpired(row),
  };
}

// ─── POST /api/activation/complete ─────────────────────────────────────────

export interface CompleteActivationParams {
  token: string;
  password: string;
  fullName?: string;
}

export interface ActivationResult {
  email: string;
  orgId: string | null;
  orgName: string;
}

export async function completeActivation(
  deps: ActivationDeps,
  params: CompleteActivationParams,
): Promise<ActivationResult> {
  const { db, logger } = deps;
  const { token, password, fullName } = params;

  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new ActivationError(
      `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
      'invalid_input',
    );
  }

  const row = await loadPendingProfile(deps, token);

  if (isExpired(row)) {
    throw new ActivationError(
      'This activation link has expired. Ask your organization administrator to send a new one.',
      'expired',
    );
  }

  // ── Claim the single-use token FIRST (compare-and-swap). ──
  // Order matters: claiming before the password write means a replayed or
  // concurrently-consumed token is rejected without ever touching the
  // password. The reverse order would let anyone re-submitting an
  // already-consumed link overwrite the account's password.
  const { data: claimedRows, error: claimError } = await db
    .from('profiles')
    .update({
      status: 'ACTIVE',
      activation_token: null,
      activation_token_expires_at: null,
      ...(fullName ? { full_name: fullName } : {}),
    })
    .eq('id', row.id)
    .eq('activation_token', token)
    .eq('status', 'PENDING_ACTIVATION')
    .select('id');

  if (claimError) {
    logger.error({ error: claimError, profileId: row.id }, 'Activation: token claim failed');
    throw new ActivationError('Failed to activate your account. Please try again.', 'internal_error');
  }

  if (!Array.isArray(claimedRows) || claimedRows.length === 0) {
    // Someone else won the CAS between our read and our write.
    throw new ActivationError(INVALID_TOKEN_MESSAGE, 'already_used');
  }

  // ── Now set the password (Defect B) and confirm the mailbox. ──
  const { error: passwordError } = await db.auth.admin.updateUserById(row.id, {
    password,
    email_confirm: true,
    ...(fullName ? { user_metadata: { full_name: fullName } } : {}),
  });

  if (passwordError) {
    // Best-effort rollback: without it the recipient is left ACTIVE with no
    // password AND no token, i.e. permanently locked out of a live account.
    logger.error(
      { error: passwordError, profileId: row.id },
      'Activation: password write failed — restoring the pending activation state',
    );
    const { error: rollbackError } = await db
      .from('profiles')
      .update({
        status: 'PENDING_ACTIVATION',
        activation_token: row.activation_token,
        activation_token_expires_at: row.activation_token_expires_at,
      })
      .eq('id', row.id);
    if (rollbackError) {
      logger.error(
        { error: rollbackError, profileId: row.id },
        'Activation: rollback failed — profile is ACTIVE with no password, needs manual reset',
      );
    }
    throw new ActivationError('Failed to activate your account. Please try again.', 'internal_error');
  }

  const orgName = await loadOrgName(deps, row.org_id);

  const { error: auditError } = await db.from('audit_events').insert({
    event_type: 'USER_ACTIVATED',
    event_category: 'USER',
    actor_id: row.id,
    org_id: row.org_id,
    target_type: 'profile',
    target_id: row.id,
    details: JSON.stringify({ email: row.email }),
  });
  if (auditError) {
    logger.warn({ error: auditError, profileId: row.id }, 'Activation: audit emit failed');
  }

  logger.info({ profileId: row.id, orgId: row.org_id }, 'Recipient account activated');

  return { email: row.email, orgId: row.org_id, orgName };
}
