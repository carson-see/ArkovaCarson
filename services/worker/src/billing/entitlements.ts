/**
 * Verified-Identity Entitlement Service (PAY-01 / SCRUM-2384)
 *
 * Server-side (worker-only, service_role) management of the verified-identity
 * entitlement that gates verified-only features.
 *
 *   - Stripe Identity `identity.verification_session.verified` → grant.
 *   - A declined / canceled / requires_input session does NOT grant (those
 *     handlers never call grant — only `verified` does).
 *   - A lapsed paid subscription (`customer.subscription.deleted`) → revoke.
 *
 * The entitlement lives in the existing `entitlements` table (the canonical
 * entitlement mechanism: `entitlement_type` + `valid_from`/`valid_until`,
 * scoped per user and/or org). No schema change — RLS + FORCE already exist on
 * that table (SELECT-only policy for `authenticated`; writes are worker
 * service_role, which bypasses RLS).
 *
 * READ PATH (current-period correctness, SCRUM-1791): a verified entitlement is
 * gated by an active paid subscription, so `resolveVerifiedEntitlement` requires
 * BOTH (a) an open entitlement window covering `now`, AND (b) an `active`
 * subscription whose CURRENT period covers `now`. Reading the live
 * `subscriptions.current_period_*` (which SCRUM-1791 rolls forward on every
 * renewal invoice) prevents gating on a stale row.
 *
 * Constitution refs:
 *   - §1.2 / §1.4: every write path is Zod-validated; service_role never leaves
 *     the worker; no PII / secrets logged.
 *   - §1.5: timestamps are timestamptz UTC ISO strings.
 *   - §1.7: no real Stripe / DB in tests — the db client is mocked.
 */

import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import type { TypeSafeTablesInsert } from '../types/database-overrides.js';

/** Entitlement key for the Stripe-Identity verified capability. */
export const VERIFIED_IDENTITY_ENTITLEMENT = 'identity_verified' as const;

/**
 * Target of a grant/revoke. At least one of userId / orgId must be present.
 * UUIDs are validated to fail closed against malformed webhook metadata and to
 * keep RLS-scoping keys well-formed.
 */
const entitlementTargetSchema = z
  .object({
    userId: z.string().uuid().nullable().optional(),
    orgId: z.string().uuid().nullable().optional(),
  })
  .refine((t) => !!t.userId || !!t.orgId, {
    message: 'entitlement target requires a userId or an orgId',
  });

export type EntitlementTarget = z.infer<typeof entitlementTargetSchema>;

/** Minimal projection of an `entitlements` row used by the read gate. */
export interface VerifiedEntitlementRow {
  entitlement_type: string;
  valid_from: string;
  valid_until: string | null;
}

/** Minimal projection of the `subscriptions` row used by the read gate. */
export interface SubscriptionPeriodRow {
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
}

// ─── write: close any open window for (target, type) ─────────────────────

/**
 * Close every OPEN window (`valid_until IS NULL`) of the verified-identity
 * entitlement for the given target by stamping `valid_until = at`. Shared by
 * grant (idempotency) and revoke (lapse). Throws on a DB error so the caller
 * (a webhook handler) surfaces it and Stripe retries.
 */
async function closeOpenWindows(target: EntitlementTarget, at: Date): Promise<void> {
  const ts = at.toISOString();
  // Build a single UPDATE that targets the open window for the type, scoped to
  // whichever owner key(s) we hold. `service_role` bypasses RLS.
  let q = db
    .from('entitlements')
    .update({ valid_until: ts })
    .eq('entitlement_type', VERIFIED_IDENTITY_ENTITLEMENT)
    .is('valid_until', null);

  if (target.userId) {
    q = q.eq('user_id', target.userId);
  } else if (target.orgId) {
    q = q.eq('org_id', target.orgId);
  }

  const { error } = await q;
  if (error) {
    logger.error(
      { error, hasUser: !!target.userId, hasOrg: !!target.orgId },
      'Failed to close verified-identity entitlement window',
    );
    throw error;
  }
}

// ─── grant (verified → granted) ──────────────────────────────────────────

/**
 * Grant the verified-identity entitlement to a user/org. Idempotent: closes any
 * already-open window first, then inserts a single fresh open row
 * (`valid_until = null`). This avoids leaving two open windows on a re-verify
 * without needing a DB unique constraint (no migration).
 */
export async function grantVerifiedIdentityEntitlement(
  target: EntitlementTarget,
  at: Date = new Date(),
): Promise<void> {
  const parsed = entitlementTargetSchema.parse(target);

  // Idempotency: collapse any prior open window before inserting the new one.
  await closeOpenWindows(parsed, at);

  const row: TypeSafeTablesInsert<'entitlements'> = {
    user_id: parsed.userId ?? null,
    org_id: parsed.orgId ?? null,
    entitlement_type: VERIFIED_IDENTITY_ENTITLEMENT,
    source: 'subscription',
    valid_from: at.toISOString(),
    valid_until: null,
  };

  const { error } = await db.from('entitlements').insert(row);
  if (error) {
    logger.error(
      { error, hasUser: !!parsed.userId, hasOrg: !!parsed.orgId },
      'Failed to grant verified-identity entitlement',
    );
    throw error;
  }

  logger.info(
    { hasUser: !!parsed.userId, hasOrg: !!parsed.orgId },
    'Verified-identity entitlement granted',
  );
}

// ─── revoke (lapsed → revoked) ───────────────────────────────────────────

/**
 * Revoke the verified-identity entitlement by closing every open window for the
 * target (`valid_until = at`). Used when a paid subscription lapses. No-op when
 * the target has neither a userId nor an orgId (nothing to scope to).
 */
export async function revokeVerifiedIdentityEntitlement(
  target: EntitlementTarget,
  at: Date = new Date(),
): Promise<void> {
  if (!target.userId && !target.orgId) {
    logger.warn('revokeVerifiedIdentityEntitlement called with no userId/orgId — no-op');
    return;
  }
  const parsed = entitlementTargetSchema.parse(target);
  await closeOpenWindows(parsed, at);
  logger.info(
    { hasUser: !!parsed.userId, hasOrg: !!parsed.orgId },
    'Verified-identity entitlement revoked',
  );
}

// ─── pure resolver (current-period window) ───────────────────────────────

export interface ResolveVerifiedEntitlementInput {
  rows: VerifiedEntitlementRow[] | null | undefined;
  subscription: SubscriptionPeriodRow | null | undefined;
  now?: Date;
}

/**
 * Pure gate: does the target currently hold the verified-identity entitlement?
 *
 * Requires BOTH:
 *   (a) an open entitlement window covering `now`
 *       (`valid_from <= now` and (`valid_until` null or `> now`)), AND
 *   (b) an `active` subscription whose CURRENT period covers `now`
 *       (`current_period_start <= now` and (`current_period_end` null or `> now`)).
 *
 * Fails closed (false) on missing rows / missing subscription. (b) is what makes
 * the gate read the CURRENT period rather than a stale row (SCRUM-1791).
 */
export function resolveVerifiedEntitlement({
  rows,
  subscription,
  now = new Date(),
}: ResolveVerifiedEntitlementInput): boolean {
  const ts = now.getTime();

  const hasOpenWindow = (rows ?? []).some((r) => {
    if (r.entitlement_type !== VERIFIED_IDENTITY_ENTITLEMENT) return false;
    const from = new Date(r.valid_from).getTime();
    if (Number.isFinite(from) && from > ts) return false;
    if (r.valid_until) {
      const until = new Date(r.valid_until).getTime();
      if (Number.isFinite(until) && until <= ts) return false;
    }
    return true;
  });
  if (!hasOpenWindow) return false;

  // (b) current, non-stale subscription period.
  if (!subscription) return false;
  if (subscription.status !== 'active' && subscription.status !== 'trialing') return false;

  if (subscription.current_period_start) {
    const start = new Date(subscription.current_period_start).getTime();
    if (Number.isFinite(start) && start > ts) return false;
  }
  if (subscription.current_period_end) {
    const end = new Date(subscription.current_period_end).getTime();
    // stale period (end already passed) → deny, do NOT gate on it.
    if (Number.isFinite(end) && end <= ts) return false;
  }

  return true;
}

// ─── db-backed read gate ─────────────────────────────────────────────────

/**
 * Read the verified-identity entitlement rows for the target + the latest
 * subscription, then resolve the gate. Fails closed (false) on any DB error.
 *
 * This is the worker-side gate for verified-only features; it reads the CURRENT
 * subscription period (SCRUM-1791) so it never grants on a stale row.
 */
export async function hasActiveVerifiedEntitlement(
  target: EntitlementTarget,
  now: Date = new Date(),
): Promise<boolean> {
  const parsed = entitlementTargetSchema.safeParse(target);
  if (!parsed.success) return false;
  const { userId, orgId } = parsed.data;

  // Entitlement rows for this owner key. service_role bypasses RLS; we still
  // scope to the owner column we hold.
  const entQuery = db
    .from('entitlements')
    .select('entitlement_type, valid_from, valid_until')
    .eq('entitlement_type', VERIFIED_IDENTITY_ENTITLEMENT);

  const { data: rows, error: entError } = userId
    ? await entQuery.eq('user_id', userId)
    : await entQuery.eq('org_id', orgId as string);

  if (entError) {
    logger.error({ error: entError }, 'Failed to read verified-identity entitlement rows — failing closed');
    return false;
  }

  // Latest subscription for the user (the period source of truth, SCRUM-1791).
  // Tenant-scoped: the .eq() filters to the CALLER's own user_id (or org_id) —
  // the gate only ever evaluates the authenticated caller's own subscription.
  // The dynamic column choice hides the scope from the static rule.
  // eslint-disable-next-line arkova/missing-org-filter -- scoped to caller's own user_id/org_id
  const { data: subscription, error: subError } = await db
    .from('subscriptions')
    .select('status, current_period_start, current_period_end')
    .eq(userId ? 'user_id' : 'org_id', (userId ?? orgId) as string)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (subError) {
    logger.error({ error: subError }, 'Failed to read subscription for verified entitlement — failing closed');
    return false;
  }

  return resolveVerifiedEntitlement({
    rows: (rows ?? []) as VerifiedEntitlementRow[],
    subscription: subscription as SubscriptionPeriodRow | null,
    now,
  });
}
