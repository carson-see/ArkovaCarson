/**
 * Credential Templates CRUD Hook
 *
 * Manages credential templates for an organization.
 * ORG_ADMIN users can create, read, update, and deactivate templates.
 *
 * @see P5-TS-07
 */

import { useEffect, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { logAuditEvent } from '@/lib/auditLog';
import { TOAST } from '@/lib/copy';
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

export function useCredentialTemplates(orgId: string | null | undefined): UseCredentialTemplatesResult {
  const [templates, setTemplates] = useState<CredentialTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTemplates = useCallback(async () => {
    if (!orgId) {
      setTemplates([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from('credential_templates')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });

    if (fetchError) {
      setError(fetchError.message);
    } else {
      setTemplates(data ?? []);
    }

    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const refreshTemplates = useCallback(async () => {
    await fetchTemplates();
  }, [fetchTemplates]);

  const createTemplate = useCallback(
    async (params: CreateTemplateParams): Promise<CredentialTemplate | null> => {
      if (!orgId) {
        setError('No organization');
        return null;
      }

      setError(null);

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
        setError(insertError.message);
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
      await fetchTemplates();
      return data;
    },
    [orgId, fetchTemplates]
  );

  const updateTemplate = useCallback(
    async (id: string, params: UpdateTemplateParams): Promise<boolean> => {
      if (!orgId) {
        setError('No organization');
        return false;
      }

      setError(null);

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
        setError(updateError.message);
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
      await fetchTemplates();
      return true;
    },
    [orgId, fetchTemplates]
  );

  const deleteTemplate = useCallback(
    async (id: string): Promise<boolean> => {
      if (!orgId) {
        setError('No organization');
        return false;
      }

      setError(null);

      const { error: deleteError } = await supabase
        .from('credential_templates')
        .delete()
        .eq('id', id)
        .eq('org_id', orgId);

      if (deleteError) {
        setError(deleteError.message);
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
      await fetchTemplates();
      return true;
    },
    [orgId, fetchTemplates]
  );

  return {
    templates,
    loading,
    error,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    refreshTemplates,
  };
}
