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

/** Hardcoded fallback — only used if DB flag column doesn't exist yet */
const PLATFORM_ADMIN_EMAILS_FALLBACK = [
  'carson@arkova.ai',
  'sarah@arkova.ai',
];

/**
 * Verify the requesting user is a platform admin (Arkova internal).
 * Checks is_platform_admin flag in profiles table (SEC-3).
 * Falls back to email whitelist if flag column not available.
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const { data: profile } = await db
    .from('profiles')
    .select('email, is_platform_admin')
    .eq('id', userId)
    .single();

  if (!profile?.email) return false;

  // Prefer DB flag (SEC-3)
  if (profile.is_platform_admin !== undefined && profile.is_platform_admin !== null) {
    return profile.is_platform_admin === true;
  }

  // Fallback to hardcoded list if column not yet migrated
  return PLATFORM_ADMIN_EMAILS_FALLBACK.includes(profile.email);
}
