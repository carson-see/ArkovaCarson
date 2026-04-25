/**
 * Shared org-auth helpers for service_role API handlers.
 *
 * The worker uses a service_role Supabase client which bypasses RLS — every
 * cross-tenant write must explicitly scope by `org_id = caller's org`. These
 * helpers are the single source of truth for that lookup so handlers don't
 * each re-implement (and drift on) the auth fallback rules.
 */
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';

interface CallerProfile {
  org_id: string | null;
  role: string | null;
  is_platform_admin: boolean | null;
}

/**
 * Single profile fetch covering the columns every callsite needs (org id,
 * role, platform-admin flag). Returns null if profile is missing or the
 * lookup errors — callers MUST treat null as fail-closed (403) to avoid
 * leaking the no-org case as success.
 */
export async function getCallerProfile(userId: string): Promise<CallerProfile | null> {
  const { data, error } = await db
    .from('profiles')
    .select('org_id, role, is_platform_admin')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    logger.warn({ error, userId }, 'org-auth: profile lookup failed');
    return null;
  }
  return (data as CallerProfile | null) ?? null;
}

export async function getCallerOrgId(userId: string): Promise<string | null> {
  const profile = await getCallerProfile(userId);
  return profile?.org_id ?? null;
}

/**
 * Org-admin check with the same precedence used across the worker:
 *   1. `org_members.role` is owner/admin → admin.
 *   2. Profile role = 'ORG_ADMIN' or `is_platform_admin = true` → admin.
 *
 * Pass an already-loaded profile to avoid a redundant `profiles` query when
 * the caller has just resolved the org id via `getCallerProfile`.
 */
export async function isCallerOrgAdmin(
  userId: string,
  orgId: string,
  preloadedProfile?: CallerProfile | null,
): Promise<boolean> {
  const { data: membership } = await db
    .from('org_members')
    .select('role')
    .eq('user_id', userId)
    .eq('org_id', orgId)
    .maybeSingle();
  const role = (membership as { role?: string } | null)?.role;
  if (role === 'owner' || role === 'admin') return true;

  const profile = preloadedProfile ?? (await getCallerProfile(userId));
  return profile?.role === 'ORG_ADMIN' || profile?.is_platform_admin === true;
}
