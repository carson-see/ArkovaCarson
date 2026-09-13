/**
 * Affiliate Listing Consent Hook (SCRUM-3864, epic SCRUM-3863)
 *
 * `organizations.sub_org_listing_parent_optin` lives on the CHILD org's row,
 * not the parent's own row — it records whether the PARENT has consented to
 * publishing this specific affiliation. `useOrganization().updateOrganization`
 * only ever writes the CURRENT org's own row, so it cannot express "the parent
 * admin updates a column on a different org's row" — this hook exists for
 * exactly that asymmetric write.
 *
 * Authorization is NOT re-implemented here. `organizations_update_admin`
 * (RLS) already lets the caller through because `buildAffiliateMembershipRows`
 * writes the creating parent admin into the child's `org_members` as `owner`
 * (`is_org_admin_of(child.id)` is true for them), and the
 * `protect_org_tenancy_fields()` BEFORE UPDATE trigger (migration 0429) is the
 * column-level authority that actually decides whether THIS caller may touch
 * THIS column: only an admin of `parent_org_id` may change
 * `sub_org_listing_parent_optin`. A caller who is not an admin of the parent
 * gets `42501 insufficient_privilege` from Postgres, surfaced here as a
 * failed update — this hook never tries to guess who is allowed, it just
 * reports what Postgres decided.
 *
 * @see supabase/migrations/0429_suborg_tenancy_foundations.sql
 * @see machines/subOrgListingConsent.machine.ts
 */

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { logAuditEvent } from '@/lib/auditLog';
import { TOAST } from '@/lib/copy';
import { OrganizationUpdateSchema } from '@/lib/validators';

interface UseAffiliateListingConsentResult {
  /** The `childOrgId` of the update currently in flight, or null. */
  busyChildOrgId: string | null;
  /**
   * Sets `sub_org_listing_parent_optin` on `childOrgId`'s row. Returns the
   * new value that actually landed, or `null` on failure (validation error,
   * RLS/trigger rejection, or network failure) — the caller should not apply
   * an optimistic update past this call.
   */
  setParentListingOptin: (childOrgId: string, next: boolean) => Promise<boolean | null>;
}

export function useAffiliateListingConsent(): UseAffiliateListingConsentResult {
  const [busyChildOrgId, setBusyChildOrgId] = useState<string | null>(null);

  const setParentListingOptin = useCallback(
    async (childOrgId: string, next: boolean): Promise<boolean | null> => {
      const parsed = OrganizationUpdateSchema
        .pick({ sub_org_listing_parent_optin: true })
        .safeParse({ sub_org_listing_parent_optin: next });
      if (!parsed.success) {
        toast.error(parsed.error.issues.map((i) => i.message).join(', '));
        return null;
      }

      setBusyChildOrgId(childOrgId);
      try {
        // `.select()` is load-bearing (mirrors useOrganization.updateOrganization):
        // when RLS or the 0429 trigger blocks the write, Supabase/PostgREST
        // returns `{ data: [], error: null }` rather than an error — checking
        // only `error` would silently report success on a no-op UPDATE.
        const { data: updatedRows, error } = await supabase
          .from('organizations')
          .update(parsed.data)
          .eq('id', childOrgId)
          .select('id, sub_org_listing_parent_optin');

        if (error) {
          toast.error(TOAST.LISTING_CONSENT_UPDATE_FAILED);
          return null;
        }
        if (!updatedRows || updatedRows.length === 0) {
          toast.error(TOAST.LISTING_CONSENT_NOT_AUTHORIZED);
          return null;
        }

        logAuditEvent({
          eventType: 'SUB_ORG_LISTING_CONSENT_CHANGED',
          eventCategory: 'ORG',
          targetType: 'organization',
          targetId: childOrgId,
          orgId: childOrgId,
          details: `sub_org_listing_parent_optin=${next}`,
        });

        return (updatedRows[0] as { sub_org_listing_parent_optin: boolean })
          .sub_org_listing_parent_optin;
      } catch {
        toast.error(TOAST.LISTING_CONSENT_UPDATE_FAILED);
        return null;
      } finally {
        setBusyChildOrgId(null);
      }
    },
    [],
  );

  return { busyChildOrgId, setParentListingOptin };
}
