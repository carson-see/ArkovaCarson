/**
 * Credential Templates CRUD Hook
 *
 * Manages credential templates for an organization.
 * ORG_ADMIN users can create, read, update, and deactivate templates.
 * Uses React Query for caching and deduplication.
 *
 * @see P5-TS-07
 */

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { logAuditEvent } from '@/lib/auditLog';
import { TOAST } from '@/lib/copy';
import { queryKeys } from '@/lib/queryClient';
import type { Database, Json } from '@/types/database.types';

type CredentialTemplate = Database['public']['Tables']['credential_templates']['Row'];

interface CreateTemplateParams {
  name: string;
  description?: string | null;
  credential_type: Database['public']['Enums']['credential_type'];
  default_metadata?: Record<string, Json | undefined> | null;
}

interface UpdateTemplateParams {
  name?: string;
  description?: string | null;
  credential_type?: Database['public']['Enums']['credential_type'];
  default_metadata?: Record<string, Json | undefined> | null;
  is_active?: boolean;
}

interface UseCredentialTemplatesResult {
  templates: CredentialTemplate[];
  loading: boolean;
  error: string | null;
  createTemplate: (params: CreateTemplateParams) => Promise<CredentialTemplate | null>;
  updateTemplate: (id: string, params: UpdateTemplateParams) => Promise<boolean>;
  deleteTemplate: (id: string) => Promise<boolean>;
  refreshTemplates: () => Promise<void>;
}

async function fetchTemplatesData(orgId: string): Promise<CredentialTemplate[]> {
  const { data, error } = await supabase
    .from('credential_templates')
    .select('id, org_id, name, description, credential_type, default_metadata, is_active, is_system, created_by, created_at, updated_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export function useCredentialTemplates(orgId: string | null | undefined): UseCredentialTemplatesResult {
  const qc = useQueryClient();

  const {
    data: templates = [],
    isLoading: loading,
    error: queryError,
  } = useQuery({
    queryKey: queryKeys.credentialTemplates(orgId ?? ''),
    queryFn: () => fetchTemplatesData(orgId!),
    enabled: !!orgId,
    staleTime: 60_000,
  });

  const refreshTemplates = useCallback(async () => {
    if (orgId) {
      await qc.invalidateQueries({ queryKey: queryKeys.credentialTemplates(orgId) });
    }
  }, [orgId, qc]);

  const createTemplate = useCallback(
    async (params: CreateTemplateParams): Promise<CredentialTemplate | null> => {
      if (!orgId) return null;

      const { data: user } = await supabase.auth.getUser();

      const { data, error: insertError } = await supabase
        .from('credential_templates')
        .insert({
          org_id: orgId,
          name: params.name,
          description: params.description ?? null,
          credential_type: params.credential_type,
          default_metadata: (params.default_metadata as Json) ?? {},
          created_by: user.user?.id ?? null,
        })
        .select()
        .single();

      if (insertError) {
        toast.error(TOAST.TEMPLATE_CREATE_FAILED);
        return null;
      }

      logAuditEvent({
        eventType: 'TEMPLATE_CREATED',
        eventCategory: 'ORG',
        targetType: 'credential_template',
        targetId: data.id,
        orgId,
        details: `Created template "${params.name}" (${params.credential_type})`,
      });

      toast.success(TOAST.TEMPLATE_CREATED);
      // Optimistic: prepend new template to cache
      qc.setQueryData<CredentialTemplate[]>(
        queryKeys.credentialTemplates(orgId),
        (prev) => [data, ...(prev ?? [])],
      );
      return data;
    },
    [orgId, qc]
  );

  const updateTemplate = useCallback(
    async (id: string, params: UpdateTemplateParams): Promise<boolean> => {
      if (!orgId) return false;

      const { error: updateError } = await supabase
        .from('credential_templates')
        .update({
          ...params,
          default_metadata: params.default_metadata === undefined
            ? undefined
            : (params.default_metadata as Json) ?? {},
        })
        .eq('id', id)
        .eq('org_id', orgId);

      if (updateError) {
        toast.error(TOAST.TEMPLATE_UPDATE_FAILED);
        return false;
      }

      logAuditEvent({
        eventType: 'TEMPLATE_UPDATED',
        eventCategory: 'ORG',
        targetType: 'credential_template',
        targetId: id,
        orgId,
        details: `Updated fields: ${Object.keys(params).join(', ')}`,
      });

      toast.success(TOAST.TEMPLATE_UPDATED);
      // Optimistic: update in cache
      qc.setQueryData<CredentialTemplate[]>(
        queryKeys.credentialTemplates(orgId),
        (prev) => (prev ?? []).map(t =>
          t.id === id
            ? { ...t, ...params, default_metadata: params.default_metadata === undefined ? t.default_metadata : (params.default_metadata ?? {}) } as CredentialTemplate
            : t
        ),
      );
      return true;
    },
    [orgId, qc]
  );

  const deleteTemplate = useCallback(
    async (id: string): Promise<boolean> => {
      if (!orgId) return false;

      const { error: deleteError } = await supabase
        .from('credential_templates')
        .delete()
        .eq('id', id)
        .eq('org_id', orgId);

      if (deleteError) {
        toast.error(TOAST.TEMPLATE_DELETE_FAILED);
        return false;
      }

      logAuditEvent({
        eventType: 'TEMPLATE_DELETED',
        eventCategory: 'ORG',
        targetType: 'credential_template',
        targetId: id,
        orgId,
      });

      toast.success(TOAST.TEMPLATE_DELETED);
      // Optimistic: remove from cache
      qc.setQueryData<CredentialTemplate[]>(
        queryKeys.credentialTemplates(orgId),
        (prev) => (prev ?? []).filter(t => t.id !== id),
      );
      return true;
    },
    [orgId, qc]
  );

  return {
    templates,
    loading: !orgId ? false : loading,
    error: queryError ? (queryError as Error).message : null,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    refreshTemplates,
  };
}
