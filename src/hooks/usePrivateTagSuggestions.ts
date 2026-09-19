import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from './useAuth';

export interface PrivateTagSuggestions {
  user: string[];
  organization: string[];
}

type PrivateTagRow = { tag: string; scope: 'user' | 'organization'; org_id: string | null };

function uniqueTags(rows: PrivateTagRow[], scope: PrivateTagRow['scope'], orgId: string | null): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const row of rows) {
    if (row.scope !== scope || (scope === 'organization' && row.org_id !== orgId)) continue;
    const normalized = row.tag.trim().toLocaleLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(row.tag.trim());
  }
  return tags;
}

export async function fetchPrivateTagSuggestions(orgId: string | null): Promise<PrivateTagSuggestions> {
  // RLS is the tenant boundary. Exact server-side scope predicates prevent
  // unrelated recent tags from consuming the selected scope's result limit;
  // local partitioning remains a defense-in-depth response check.
  const personalQuery = supabase
    .from('anchor_private_tags')
    .select('tag, scope, org_id')
    .eq('scope', 'user')
    .is('org_id', null)
    .order('created_at', { ascending: false })
    .limit(100);
  const organizationQuery = orgId
    ? supabase.from('anchor_private_tags').select('tag, scope, org_id')
      .eq('scope', 'organization').eq('org_id', orgId)
      .order('created_at', { ascending: false }).limit(100)
    : Promise.resolve({ data: [], error: null });
  const [personal, organization] = await Promise.all([personalQuery, organizationQuery]);
  if (personal.error) throw personal.error;
  if (organization.error) throw organization.error;
  return {
    user: uniqueTags((personal.data ?? []) as PrivateTagRow[], 'user', null),
    organization: uniqueTags((organization.data ?? []) as PrivateTagRow[], 'organization', orgId),
  };
}

export function commaAwareTagOptions(value: string, suggestions: string[]): string[] {
  const parts = value.split(',');
  const completed = parts.slice(0, -1).map((tag) => tag.trim()).filter(Boolean);
  const prefix = completed.length ? `${completed.join(', ')}, ` : '';
  const needle = (parts[parts.length - 1] ?? '').trim().toLocaleLowerCase();
  const chosen = new Set(completed.map((tag) => tag.toLocaleLowerCase()));
  return suggestions
    .filter((tag) => !chosen.has(tag.toLocaleLowerCase()) && tag.toLocaleLowerCase().startsWith(needle))
    .map((tag) => `${prefix}${tag}`);
}

export type ParsedPrivateTags =
  | { ok: true; tags: string[] }
  | { ok: false; reason: 'too_long' | 'too_many' };

export function parsePrivateTags(value: string): ParsedPrivateTags {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const rawTag of value.split(',')) {
    const tag = rawTag.trim();
    if (!tag) continue;
    if (tag.length > 64) return { ok: false, reason: 'too_long' };
    const normalized = tag.toLocaleLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      tags.push(tag);
    }
  }
  return tags.length > 10 ? { ok: false, reason: 'too_many' } : { ok: true, tags };
}

const EMPTY: PrivateTagSuggestions = { user: [], organization: [] };

export function usePrivateTagSuggestions(orgId: string | null) {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ['private-tag-suggestions', user?.id ?? 'none', orgId ?? 'personal'],
    queryFn: () => fetchPrivateTagSuggestions(orgId),
    enabled: Boolean(user),
    staleTime: 30_000,
  });
  return {
    suggestions: query.data ?? EMPTY,
    loading: Boolean(user) && query.isLoading,
    error: query.error ? 'Could not load tag suggestions' : null,
  };
}
