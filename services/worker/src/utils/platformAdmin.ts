/**
 * Platform Admin Utility
 *
 * Shared helper to check if a user is an Arkova platform admin.
 * Used by treasury, admin-stats, and admin-health endpoints.
 *
 * SEC-3: Uses is_platform_admin DB flag instead of hardcoded email list.
 * Admin promotion/demotion is now a DB update, not a code deploy.
 *
 * @see feedback_treasury_access — Treasury is Arkova-internal ONLY
 */

import { db } from './db.js';

/**
 * Verify the requesting user is a platform admin (Arkova internal).
 * Checks is_platform_admin flag in profiles table (SEC-3).
 *
 * ARK-SEC-ADMIN: Removed hardcoded email fallback — admin status is DB-only.
 * If is_platform_admin column is null, fail secure (return false).
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data: profile } = await db
    .from('profiles')
    .select('is_platform_admin')
    .eq('id', userId)
    .single();

  // ARK-SEC-ADMIN: Fail secure — no fallback to hardcoded emails
  return profile?.is_platform_admin === true;
}
