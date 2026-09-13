/**
 * SCRUM-5023 — who receives an org-scoped administrative notice.
 *
 * WHY THIS IS NOT ONE QUERY. Arkova records org administration in TWO places
 * and they do not agree:
 *
 *   - `profiles.role = 'ORG_ADMIN'` — the single-org column the API-key routes
 *     authorize against.
 *   - `org_members.role IN ('owner','admin')` — the junction table that exists
 *     precisely because a user can administer more than one org.
 *
 * Verified against prod 2026-09-12 (read-only): the org "Fragile Rocks" holds
 * ONE active key with an expiry ahead of it, ZERO `profiles` rows with
 * `role = 'ORG_ADMIN'`, and ONE `org_members` row with `role = 'admin'` whose
 * profile carries a live email address. A recipient lookup that reads
 * `profiles` alone returns nothing for that org, the notice job counts a
 * `noRecipients`, and the key lapses in exactly the silence this story exists
 * to end. Seven `org_members` owner/admin rows repo-wide have no matching
 * `profiles.role = 'ORG_ADMIN'`.
 *
 * So the recipient set is the UNION, resolved back through `profiles` for the
 * address. Org creators are usually in both, hence the case-insensitive
 * de-duplication — an admin must not receive the same notice twice because two
 * tables both remember them.
 *
 * IT THROWS. A recipient lookup that swallows its error returns `[]`, which is
 * indistinguishable from "this org has no admins" — the caller then records a
 * notice as handled and the warning is lost for good. The caller counts the
 * throw as a per-key failure and tries again on the next run.
 *
 * DELETED PROFILES ARE EXCLUDED. `profiles.deleted_at` is a soft delete; a row
 * carrying one is a departed user whose address must not be mailed. Zero rows
 * satisfy that today, which is exactly why it is worth pinning now.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Roles in `org_members` that count as org administration. */
export const ORG_MEMBER_ADMIN_ROLES = ['owner', 'admin'] as const;

interface EmailRow {
  email?: string | null;
}

interface MemberRow {
  user_id?: string | null;
}

function collectEmails(rows: EmailRow[] | null | undefined, into: Map<string, string>): void {
  for (const row of rows ?? []) {
    const email = typeof row.email === 'string' ? row.email.trim() : '';
    if (!email) continue;
    // Keyed case-insensitively, value kept in its stored casing: the local
    // part of an address is technically case-sensitive, so the ORIGINAL is
    // what gets mailed; only the duplicate test is folded.
    const key = email.toLowerCase();
    if (!into.has(key)) into.set(key, email);
  }
}

/**
 * Every address that should receive an administrative notice for `orgId`.
 *
 * @throws when either lookup fails — see the header.
 */
export async function listOrgAdminRecipients(
  client: SupabaseClient,
  orgId: string,
): Promise<string[]> {
  const recipients = new Map<string, string>();

  const { data: profileAdmins, error: profileError } = await client
    .from('profiles')
    .select('email')
    .eq('org_id', orgId)
    .eq('role', 'ORG_ADMIN')
    .is('deleted_at', null);

  if (profileError) {
    throw new Error(`ORG_ADMIN profile lookup failed: ${profileError.message}`);
  }
  collectEmails(profileAdmins as EmailRow[] | null, recipients);

  const { data: members, error: memberError } = await client
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .in('role', ORG_MEMBER_ADMIN_ROLES as unknown as string[]);

  if (memberError) {
    throw new Error(`org_members admin lookup failed: ${memberError.message}`);
  }

  const memberIds = (members as MemberRow[] | null ?? [])
    .map((row) => row.user_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (memberIds.length > 0) {
    // Resolved through `profiles` because `org_members` stores no address.
    // Keyed by the user ids the org-scoped query above returned, which is
    // strictly narrower than an org filter.
    const { data: memberProfiles, error: memberProfileError } = await client
      .from('profiles')
      .select('email')
      .in('id', memberIds)
      .is('deleted_at', null);

    if (memberProfileError) {
      throw new Error(`org_members profile resolution failed: ${memberProfileError.message}`);
    }
    collectEmails(memberProfiles as EmailRow[] | null, recipients);
  }

  return [...recipients.values()];
}
