/**
 * Organization Hook
 *
 * Fetches and manages the current user's organization from the database.
 * Uses React Query for caching — org data shared across all pages instantly.
 *
 * @see P2-TS-06
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { logAuditEvent } from '@/lib/auditLog';
import { TOAST } from '@/lib/copy';
import { queryKeys } from '@/lib/queryClient';
import { OrganizationUpdateSchema } from '@/lib/validators';
import type { Database } from '@/types/database.types';

type Organization = Database['public']['Tables']['organizations']['Row'];

/** All editable org profile fields */
type EditableOrgFields = Partial<Pick<Organization,
  'display_name' | 'domain' | 'description' | 'website_url' |
  'logo_url' | 'founded_date' | 'org_type' | 'linkedin_url' |
  'twitter_url' | 'industry_tag' | 'location'
>>;

/** Fetch organization from Supabase — extracted for React Query */
async function fetchOrganizationData(orgId: string): Promise<Organization> {
  const { data, error } = await supabase
    .from('organizations')
    .select('*')
    .eq('id', orgId)
    .single();

  if (error) throw error;
  return data;
}

interface UseOrganizationResult {
  organization: Organization | null;
  loading: boolean;
  updating: boolean;
  error: string | null;
  updateOrganization: (updates: EditableOrgFields) => Promise<boolean>;
  refreshOrganization: () => Promise<void>;
}

export function useOrganization(orgId: string | null | undefined): UseOrganizationResult {
  const qc = useQueryClient();

  const {
    data: organization = null,
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.organization(orgId ?? ''),
    queryFn: () => fetchOrganizationData(orgId!),
    enabled: !!orgId,
    staleTime: 60_000, // Org data rarely changes — 1 min stale
  });

  const error = queryError ? (queryError as Error).message : null;

  const refreshOrganization = useCallback(async () => {
    if (orgId) {
      await qc.invalidateQueries({ queryKey: queryKeys.organization(orgId) });
    }
  }, [orgId, qc]);

  const updateOrganization = useCallback(
    async (updates: EditableOrgFields): Promise<boolean> => {
      if (!orgId) return false;

      // Validate before DB call (CLAUDE.md §1.2 / §6)
      const parsed = OrganizationUpdateSchema.safeParse(updates);
      if (!parsed.success) {
        const msg = parsed.error.issues.map(i => i.message).join(', ');
        toast.error(msg);
        return false;
      }

      // Use .select() to detect silent RLS failures — if RLS blocks the UPDATE,
      // Supabase returns { data: [], error: null } instead of an error.
      const { data: updatedRows, error: updateError } = await supabase
        .from('organizations')
        .update(parsed.data)
        .eq('id', orgId)
        .select();

      if (updateError) {
        toast.error(TOAST.ORG_UPDATE_FAILED);
        return false;
      }

      // Detect silent RLS rejection: query succeeded but no rows updated
      if (!updatedRows || updatedRows.length === 0) {
        toast.error('Update failed — admin permissions required');
        return false;
      }

      logAuditEvent({
        eventType: 'ORG_UPDATED',
        eventCategory: 'ORG',
        targetType: 'organization',
        targetId: orgId,
        orgId,
        details: `Updated fields: ${Object.keys(updates).join(', ')}`,
      });

      // Update cache directly with returned data — no extra round-trip
      qc.setQueryData(queryKeys.organization(orgId), updatedRows[0]);

      toast.success(TOAST.ORG_UPDATED);
      return true;
    },
    [orgId, qc]
  );

  return {
    organization,
    loading,
    updating: false,
    error,
    updateOrganization,
    refreshOrganization,
  };
}
