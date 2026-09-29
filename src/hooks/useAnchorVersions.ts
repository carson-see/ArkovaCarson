/**
 * useAnchorVersions Hook
 *
 * Walks an anchor's version lineage (`anchors.parent_anchor_id` /
 * `anchors.version_number`) up to the root and down through every
 * descendant, returning the full chain newest-first.
 *
 * Extracted from an ad-hoc `useEffect` that used to live directly in
 * `RecordDetailPage.tsx`. That inline version gated the fetch on
 * `version_number > 1 || parent_anchor_id`, which MISSED the oldest/root
 * version of a chain once it had been superseded: a record with
 * `version_number === 1` and no parent that a newer child now supersedes has
 * neither condition true, so its own lineage was never fetched — the exact
 * founder-reported record (`ARK-DOC-7RFUVV`, version 1, superseded by
 * `ARK-DOC-DRN2J6` version 2) showed no version banner at all. This hook
 * always attempts the walk for any anchor with an id; an anchor with no
 * relations simply resolves to an empty/single-entry array.
 *
 * RLS-scoped: every query goes through the existing Supabase client, so a
 * caller only ever sees rows their own `anchors` RLS policies allow.
 *
 * @see src/pages/RecordDetailPage.tsx
 * @see src/components/anchor/AssetDetailView.tsx
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export interface AnchorVersionEntry {
  /** Internal anchor id. Selected because the chain walk needs it and the
   * rest of this authenticated app already links between records via
   * `recordDetailPath(id)` (DashboardPage, MyRecordsPage, MemberDetailPage,
   * useNotifications, ...) — this hook follows that existing, established
   * convention rather than inventing a second one. `publicId` is ALSO
   * returned below for any consumer (e.g. a future public-safe surface)
   * that should link by public id instead. */
  id: string;
  publicId: string | null;
  versionNumber: number;
  status: string;
  createdAt: string;
  filename: string;
  fingerprint: string;
}

interface AnchorVersionsInput {
  id: string;
  versionNumber?: number | null;
  parentAnchorId?: string | null;
  status?: string;
}

interface AnchorVersionRow {
  id: string;
  public_id: string | null;
  version_number: number;
  status: string;
  created_at: string;
  filename: string;
  fingerprint: string;
}

function toEntry(row: AnchorVersionRow): AnchorVersionEntry {
  return {
    id: row.id,
    publicId: row.public_id,
    versionNumber: row.version_number,
    status: row.status,
    createdAt: row.created_at,
    filename: row.filename,
    fingerprint: row.fingerprint,
  };
}

const VERSION_ROW_COLUMNS = 'id, public_id, version_number, status, created_at, filename, fingerprint';
// Safety cap mirroring the original inline implementation — bounds the
// descendant walk against a corrupted/cyclic parent_anchor_id chain.
const MAX_CHAIN_LENGTH = 50;

interface UseAnchorVersionsReturn {
  versions: AnchorVersionEntry[];
  loading: boolean;
}

export function useAnchorVersions(anchor: AnchorVersionsInput | null | undefined): UseAnchorVersionsReturn {
  const [versions, setVersions] = useState<AnchorVersionEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!anchor?.id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear versions when there is no anchor to walk
      setVersions([]);
      setLoading(false);
      return;
    }

    async function run() {
      setLoading(true);
      try {
        // Walk up through parent_anchor_id to find the root of the chain.
        let rootId = anchor!.id;
        let parentId = anchor!.parentAnchorId ?? null;
        const visited = new Set<string>([rootId]);

        while (parentId && !visited.has(parentId)) {
          visited.add(parentId);
          const { data: parent } = await supabase
            .from('anchors')
            .select('id, parent_anchor_id')
            .eq('id', parentId)
            .is('deleted_at', null)
            .single();
          if (!parent) break;
          rootId = parent.id;
          parentId = parent.parent_anchor_id;
        }

        const collected: AnchorVersionEntry[] = [];

        const { data: root } = await supabase
          .from('anchors')
          .select(VERSION_ROW_COLUMNS)
          .eq('id', rootId)
          .is('deleted_at', null)
          .single();
        if (root) collected.push(toEntry(root as AnchorVersionRow));

        let currentParent = rootId;
        for (let i = 0; i < MAX_CHAIN_LENGTH; i++) {
          const { data: children } = await supabase
            .from('anchors')
            .select(VERSION_ROW_COLUMNS)
            .eq('parent_anchor_id', currentParent)
            .is('deleted_at', null)
            .order('version_number', { ascending: true })
            .limit(1);
          if (!children || children.length === 0) break;
          const child = children[0] as AnchorVersionRow;
          collected.push(toEntry(child));
          currentParent = child.id;
        }

        if (!cancelled) {
          setVersions(collected.sort((a, b) => b.versionNumber - a.versionNumber));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- status is not read by the walk itself
  }, [anchor?.id, anchor?.parentAnchorId]);

  return { versions, loading };
}
