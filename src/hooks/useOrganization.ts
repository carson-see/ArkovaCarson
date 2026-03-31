/**
 * Organization Hook
 *
 * Fetches and manages the current user's organization from the database.
 *
 * @see P2-TS-06
 */

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { logAuditEvent } from '@/lib/auditLog';
import { TOAST } from '@/lib/copy';
import type { Database } from '@/types/database.types';

type Organization = Database['public']['Tables']['organizations']['Row'];

/** All editable org profile fields */
type EditableOrgFields = Partial<Pick<Organization,
  'display_name' | 'domain' | 'description' | 'website_url' |
  'logo_url' | 'founded_date' | 'org_type' | 'linkedin_url' |
  'twitter_url' | 'industry_tag' | 'location'
>>;

interface UseOrganizationResult {
  organization: Organization | null;
  loading: boolean;
  updating: boolean;
  error: string | null;
  updateOrganization: (updates: EditableOrgFields) => Promise<boolean>;
  refreshOrganization: () => Promise<void>;
}

export function useOrganization(orgId: string | null | undefined): UseOrganizationResult {
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOrganization = useCallback(async () => {
    if (!orgId) {
      setOrganization(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from('organizations')
      .select('*')
      .eq('id', orgId)
      .single();

    if (fetchError) {
      setError(fetchError.message);
    } else {
      setOrganization(data);
    }

    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    fetchOrganization();
  }, [fetchOrganization]);

  const refreshOrganization = useCallback(async () => {
    await fetchOrganization();
  }, [fetchOrganization]);

  const updateOrganization = useCallback(
    async (updates: EditableOrgFields): Promise<boolean> => {
      if (!orgId) {
        setError('No organization');
        return false;
      }

      setUpdating(true);
      setError(null);

      // Use .select() to detect silent RLS failures — if RLS blocks the UPDATE,
      // Supabase returns { data: [], error: null } instead of an error.
      const { data: updatedRows, error: updateError } = await supabase
        .from('organizations')
        .update(updates)
        .eq('id', orgId)
        .select();

      if (updateError) {
        setError(updateError.message);
        toast.error(TOAST.ORG_UPDATE_FAILED);
        setUpdating(false);
        return false;
      }

      // Detect silent RLS rejection: query succeeded but no rows updated
      if (!updatedRows || updatedRows.length === 0) {
        setError('Update blocked — you may not have admin permissions for this organization');
        toast.error('Update failed — admin permissions required');
        setUpdating(false);
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

      // Use the returned data directly instead of re-fetching
      setOrganization(updatedRows[0] as Organization);

      toast.success(TOAST.ORG_UPDATED);
      setUpdating(false);
      return true;
    },
    [orgId]
  );

  return {
    organization,
    loading,
    updating,
    error,
    updateOrganization,
    refreshOrganization,
  };
}
