/**
 * Public Search Hook
 *
 * Provides search functionality for public credential discovery.
 * Uses search_public_issuers and get_public_issuer_registry RPCs.
 *
 * @see UF-02
 */

import { useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { SEARCH_LABELS } from '@/lib/copy';

export interface IssuerResult {
  org_id: string;
  org_name: string;
  org_domain: string | null;
  credential_count: number;
}

export interface IssuerRegistryAnchor {
  public_id: string;
  credential_type: string | null;
  filename: string;
  issued_at: string | null;
  created_at: string;
  label: string | null;
}

export interface IssuerRegistry {
  org_id: string;
  org_name: string;
  org_domain: string | null;
  total: number;
  anchors: IssuerRegistryAnchor[];
}

interface UsePublicSearchReturn {
  /** Search results for issuer search */
  issuerResults: IssuerResult[];
  /** Whether a search is in progress */
  searching: boolean;
  /** Search error message */
  error: string | null;
  /** Search for public issuers by name */
  searchIssuers: (query: string) => Promise<void>;
  /** Clear search results */
  clearResults: () => void;
}

export function usePublicSearch(): UsePublicSearchReturn {
  const [issuerResults, setIssuerResults] = useState<IssuerResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchIssuers = useCallback(async (query: string) => {
    if (!query.trim()) {
      setIssuerResults([]);
      return;
    }

    setSearching(true);
    setError(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase as any).rpc(
        'search_public_issuers',
        { p_query: query.trim(), p_limit: 20 }
      );

      if (rpcError) {
        // PGRST203 (schema cache stale after migration) — show empty, not error
        if (rpcError.code === 'PGRST203') {
          console.warn('search_public_issuers RPC stale cache:', rpcError.message);
          setIssuerResults([]);
        } else {
          setError(SEARCH_LABELS.SEARCH_ERROR);
        }
        return;
      }

      // RPC returns { id, legal_name, display_name, public_id, verified, credential_count }
      // Map to IssuerResult { org_id, org_name, org_domain, credential_count }
      // Note: get_public_issuer_registry expects the UUID (id), not public_id
      const mapped = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        org_id: (row.id as string) ?? '',
        org_name: (row.display_name as string) ?? (row.legal_name as string) ?? '',
        org_domain: null,
        credential_count: (row.credential_count as number) ?? 0,
      }));
      setIssuerResults(mapped);
    } catch (err) {
      // BUG-UAT5-01: silent catch masked a TypeError from the generated
      // RPC type bindings. Log so prod triage doesn't have to reproduce.
      console.error('[usePublicSearch] issuer search threw:', err);
      setError(SEARCH_LABELS.SEARCH_ERROR);
    } finally {
      setSearching(false);
    }
  }, []);

  const clearResults = useCallback(() => {
    setIssuerResults([]);
    setError(null);
  }, []);

  return { issuerResults, searching, error, searchIssuers, clearResults };
}

interface UseIssuerRegistryReturn {
  registry: IssuerRegistry | null;
  loading: boolean;
  error: string | null;
  fetchRegistry: (orgId: string, page?: number) => Promise<void>;
}

export function useIssuerRegistry(): UseIssuerRegistryReturn {
  const [registry, setRegistry] = useState<IssuerRegistry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRegistry = useCallback(async (orgId: string, page = 0) => {
    setLoading(true);
    setError(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase as any).rpc(
        'get_public_issuer_registry',
        { p_org_id: orgId, p_limit: 20, p_offset: page * 20 }
      );

      if (rpcError) {
        setError(rpcError.message);
        return;
      }

      if (data?.error) {
        setError(data.error as string);
        return;
      }

      setRegistry(data as IssuerRegistry);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load registry');
    } finally {
      setLoading(false);
    }
  }, []);

  return { registry, loading, error, fetchRegistry };
}

// ── Public Org Profile ──────────────────────────────────────────────────────

export interface CredentialBreakdown {
  type: string | null;
  count: number;
}

export interface PublicOrgMember {
  member_key?: string | null;
  profile_public_id: string | null;
  display_name: string;
  avatar_url: string | null;
  role: string;
  is_public_profile: boolean;
}

export interface PublicSubOrganization {
  org_id: string;
  public_id: string | null;
  display_name: string;
  domain: string | null;
  description: string | null;
  logo_url: string | null;
  org_type: string | null;
  website_url: string | null;
  verification_status: string | null;
}

export interface OrgProfile {
  org_id: string;
  public_id: string | null;
  display_name: string;
  domain: string | null;
  description: string | null;
  org_type: string | null;
  website_url: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  logo_url: string | null;
  location: string | null;
  founded_date: string | null;
  industry_tag: string | null;
  verification_status: string | null;
  created_at: string;
  total_credentials: number;
  secured_credentials: number;
  credential_breakdown: CredentialBreakdown[];
  public_members: PublicOrgMember[];
  sub_organizations: PublicSubOrganization[];
}

interface UseOrgProfileReturn {
  profile: OrgProfile | null;
  loading: boolean;
  error: string | null;
  fetchProfile: (orgId: string) => Promise<void>;
}

export function useOrgProfile(): UseOrgProfileReturn {
  const [profile, setProfile] = useState<OrgProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async (orgId: string) => {
    setLoading(true);
    setError(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase as any).rpc(
        'get_public_org_profile',
        { p_org_id: orgId }
      );

      if (rpcError) {
        setError(rpcError.message);
        return;
      }

      // RPC returns SETOF jsonb — unwrap from function name key
      const result = Array.isArray(data) ? data[0]?.get_public_org_profile ?? data[0] : data;

      if (result?.error) {
        setError(result.error as string);
        return;
      }

      setProfile(result as OrgProfile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  }, []);

  return { profile, loading, error, fetchProfile };
}

// ── Public Member Profile ────────────────────────────────────────────────────

export interface PublicMemberOrganization {
  org_id: string;
  public_id: string | null;
  display_name: string;
  domain: string | null;
  logo_url: string | null;
  verification_status: string | null;
  role: string;
}

export interface PublicMemberProfile {
  public_id: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  social_links: Record<string, string> | null;
  created_at: string;
  organizations: PublicMemberOrganization[];
}

interface UsePublicMemberProfileReturn {
  profile: PublicMemberProfile | null;
  loading: boolean;
  error: string | null;
  fetchProfile: (publicId: string) => Promise<void>;
}

export function usePublicMemberProfile(): UsePublicMemberProfileReturn {
  const [profile, setProfile] = useState<PublicMemberProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProfile = useCallback(async (publicId: string) => {
    setLoading(true);
    setError(null);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: rpcError } = await (supabase as any).rpc(
        'get_public_member_profile',
        { p_public_id: publicId },
      );

      if (rpcError) {
        setError(rpcError.message);
        return;
      }

      const result = Array.isArray(data) ? data[0]?.get_public_member_profile ?? data[0] : data;

      if (result?.error) {
        setError(result.error as string);
        return;
      }

      setProfile(result as PublicMemberProfile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  }, []);

  return { profile, loading, error, fetchProfile };
}
