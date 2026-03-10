/**
 * Organization Hook
 *
 * Fetches and manages the current user's organization from the database.
 *
 * @see P2-TS-06
 */

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { logAuditEvent } from '@/lib/auditLog';
import type { Database } from '@/types/database.types';

type Organization = Database['public']['Tables']['organizations']['Row'];

interface UseOrganizationResult {
  organization: Organization | null;
  loading: boolean;
  updating: boolean;
  error: string | null;
  updateOrganization: (updates: Partial<Pick<Organization, 'display_name' | 'domain'>>) => Promise<boolean>;
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
    async (updates: Partial<Pick<Organization, 'display_name' | 'domain'>>): Promise<boolean> => {
      if (!orgId) {
        setError('No organization');
        return false;
      }

      setUpdating(true);
      setError(null);

      const { error: updateError } = await supabase
        .from('organizations')
        .update(updates)
        .eq('id', orgId);

      if (updateError) {
        setError(updateError.message);
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

      const { data } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', orgId)
        .single();
      if (data) setOrganization(data);

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
