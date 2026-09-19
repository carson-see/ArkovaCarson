/**
 * API-key notice recipients must be authorized to act on the linked keys.
 * GET/PATCH /api/v1/keys authorize profiles.role=ORG_ADMIN and profiles.org_id.
 * Membership-only admins and admins whose home org differs cannot manage this
 * org's keys through that API, so sending them its management link is misleading.
 * Supporting those recipients requires selected-org key management first.
 *
 * A missing eligible recipient stays visible as noRecipients; it is never marked
 * notified. Lookup errors throw so the job records a failure and retries later.
 * Soft-deleted profiles are excluded and addresses never enter logs.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { scanAllPages } from './postgrest-filter.js';

export async function listOrgAdminRecipients(client: SupabaseClient, orgId: string): Promise<string[]> {
  // Stable ordering and empty-page termination also cover a server row cap
  // below our requested page width. Never send or mark a partial scan complete.
  const scan = await scanAllPages<{ email: string | null }>(
    (offset, limit) => client.from('profiles')
      .select('email')
      .eq('org_id', orgId)
      .eq('role', 'ORG_ADMIN')
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(offset, offset + limit - 1),
    { maxRows: 25_000, maxPages: 64 },
  );
  if (scan.status !== 'complete') {
    throw new Error(`API-key recipient scan incomplete: ${scan.status}`);
  }

  const recipients = new Map<string, string>();
  for (const row of scan.rows) {
    const email = typeof row.email === 'string' ? row.email.trim() : '';
    if (email && !recipients.has(email.toLowerCase())) {
      recipients.set(email.toLowerCase(), email);
    }
  }
  return [...recipients.values()];
}
