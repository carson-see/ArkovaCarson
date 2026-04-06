/**
 * Platform Admin Utility
 *
 * Shared helper to check if a user is an Arkova platform admin.
 * Used by treasury, admin-stats, and admin-health endpoints.
 *
 * SEC-3: Uses is_platform_admin DB flag. No hardcoded email fallback.
 * Admin promotion/demotion is now a DB update, not a code deploy.
 *
 * SEC-029: Removed hardcoded email fallback to prevent privilege escalation
 * if an attacker claims a listed email via misconfigured auth provider.
 *
 * @see feedback_treasury_access — Treasury is Arkova-internal ONLY
 */

import { db } from './db.js';

/**
 * Verify the requesting user is a platform admin (Arkova internal).
 * Checks is_platform_admin flag in profiles table (SEC-3).
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data: profile } = await db
    .from('profiles')
    .select('is_platform_admin')
    .eq('id', userId)
    .single();

  if (!profile) return false;

  return profile.is_platform_admin === true;
}
