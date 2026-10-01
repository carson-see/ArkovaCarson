import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { mapAnchorToRecord } from './useAnchors';
import type { Record } from '@/components/records';

export type PrivateTagScope = 'user' | 'organization';
export interface PrivateAnchorListPage { records: Record[]; hasMore: boolean }

const PAGE_SIZE = 25;
const ANCHOR_COLUMNS = 'id, filename, fingerprint, status, created_at, chain_timestamp, file_size, credential_type, chain_tx_id, chain_block_height, public_id, metadata, folder_id, version_number, parent_anchor_id, anchor_private_tags!inner(tag, normalized_tag, scope, owner_user_id, org_id)';

export async function fetchPrivateAnchorList(input: { userId: string; orgId: string | null; role: string | null | undefined; tag: string; scope: PrivateTagScope; page: number }): Promise<PrivateAnchorListPage> {
  const normalizedTag = input.tag.trim().toLocaleLowerCase();
  if (!normalizedTag || normalizedTag.length > 64 || input.page < 0) return { records: [], hasMore: false };
  if (input.scope === 'organization' && !input.orgId) return { records: [], hasMore: false };
  let query = supabase.from('anchors').select(ANCHOR_COLUMNS)
    .eq('anchor_private_tags.scope', input.scope).eq('anchor_private_tags.normalized_tag', normalizedTag)
    .is('deleted_at', null).is('metadata->>pipeline_source', null).not('public_id', 'is', null);
  query = input.scope === 'user'
    ? query.eq('anchor_private_tags.owner_user_id', input.userId).is('anchor_private_tags.org_id', null)
    : query.eq('anchor_private_tags.org_id', input.orgId!);
  if (input.orgId) {
    query = query.eq('org_id', input.orgId);
    if (input.role !== 'ORG_ADMIN') query = query.eq('user_id', input.userId);
  } else query = query.eq('user_id', input.userId).is('org_id', null);
  const start = input.page * PAGE_SIZE;
  const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, start + PAGE_SIZE);
  if (error) throw error;
  const rows = data ?? [];
  return { records: rows.slice(0, PAGE_SIZE).map((row) => mapAnchorToRecord(row)), hasMore: rows.length > PAGE_SIZE };
}

export function usePrivateAnchorList(input: { userId?: string; orgId: string | null; role?: string | null; tag: string; scope: PrivateTagScope; page: number }) {
  const normalized = input.tag.trim().toLocaleLowerCase();
  return useQuery({
    queryKey: ['private-anchor-list', input.userId, input.orgId, input.role, input.scope, normalized, input.page],
    queryFn: () => fetchPrivateAnchorList({ ...input, userId: input.userId!, role: input.role }),
    enabled: Boolean(input.userId && normalized && normalized.length <= 64 && (input.scope === 'user' || input.orgId)),
  });
}
