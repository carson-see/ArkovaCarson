/**
 * Credential Template Lookup Hook
 *
 * Fetches a credential template by credential_type + org_id for rendering.
 * Used by CredentialRenderer to look up the field schema.
 *
 * For public verification (no auth), uses get_public_template RPC.
 * For authenticated views, queries credential_templates directly.
 *
 * @see UF-01
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Json } from '@/types/database.types';

/** Schema for a single field in a template's default_metadata.fields array */
export interface TemplateField {
  key: string;
  label: string;
  type: 'text' | 'date' | 'number' | 'select';
  options?: string[];
  required?: boolean;
}

/** Parsed template data for rendering */
export interface TemplateDisplayData {
  name: string;
  fields: TemplateField[];
}

/** Parse default_metadata JSON into typed TemplateField array */
export function parseTemplateFields(defaultMetadata: Json | null | undefined): TemplateField[] {
  if (!defaultMetadata || typeof defaultMetadata !== 'object') return [];

  const meta = defaultMetadata as Record<string, Json>;
  const fields = meta.fields;

  if (!Array.isArray(fields)) return [];

  const result: TemplateField[] = [];
  for (const f of fields) {
    if (
      typeof f === 'object' &&
      f !== null &&
      typeof (f as Record<string, unknown>).key === 'string' &&
      typeof (f as Record<string, unknown>).label === 'string'
    ) {
      const obj = f as Record<string, unknown>;
      result.push({
        key: obj.key as string,
        label: obj.label as string,
        type: (obj.type as TemplateField['type']) ?? 'text',
        options: Array.isArray(obj.options) ? obj.options as string[] : undefined,
        required: typeof obj.required === 'boolean' ? obj.required : undefined,
      });
    }
  }
  return result;
}

interface UseCredentialTemplateResult {
  template: TemplateDisplayData | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetch a credential template for display purposes.
 * Works for both authenticated (direct query) and public (RPC) contexts.
 */
export function useCredentialTemplate(
  credentialType: string | null | undefined,
  orgId: string | null | undefined,
  options?: { public?: boolean }
): UseCredentialTemplateResult {
  const [template, setTemplate] = useState<TemplateDisplayData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!credentialType || !orgId) {
      setTemplate(null);
      return;
    }

    let cancelled = false;
    // Capture narrowed values for the async function
    const ct = credentialType;
    const oid = orgId;

    async function fetchTemplate() {
      setLoading(true);
      setError(null);

      try {
        if (options?.public) {
          // Public context: use RPC that exposes only display fields
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data, error: rpcError } = await (supabase.rpc as any)(
            'get_public_template',
            { p_credential_type: ct, p_org_id: oid }
          );

          if (rpcError) {
            // RPC may not exist yet — graceful fallback
            if (!cancelled) {
              setTemplate(null);
              setLoading(false);
            }
            return;
          }

          if (data && !cancelled) {
            setTemplate({
              name: data.name ?? ct,
              fields: parseTemplateFields(data.default_metadata),
            });
          } else if (!cancelled) {
            setTemplate(null);
          }
        } else {
          // Authenticated context: direct query
          const { data, error: queryError } = await supabase
            .from('credential_templates')
            .select('name, default_metadata')
            .eq('org_id', oid)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .eq('credential_type', ct as any)
            .eq('is_active', true)
            .limit(1)
            .maybeSingle();

          if (queryError) {
            if (!cancelled) setError(queryError.message);
          } else if (data && !cancelled) {
            setTemplate({
              name: data.name,
              fields: parseTemplateFields(data.default_metadata),
            });
          } else if (!cancelled) {
            setTemplate(null);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load template');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchTemplate();

    return () => {
      cancelled = true;
    };
  }, [credentialType, orgId, options?.public]);

  return { template, loading, error };
}
