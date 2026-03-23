/**
 * Version Chain Hook
 *
 * Fetches the full lineage chain for an anchor by traversing
 * parent_anchor_id links. Returns ancestors (older versions)
 * and descendants (newer versions) in chronological order.
 */

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export interface ChainLink {
  id: string;
  publicId: string | null;
  filename: string;
  credentialType: string | null;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  versionNumber: number;
  isCurrent: boolean;
}

interface UseVersionChainResult {
  chain: ChainLink[];
  loading: boolean;
  hasChain: boolean;
}

export function useVersionChain(anchorId: string | undefined): UseVersionChainResult {
  const [chain, setChain] = useState<ChainLink[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!anchorId) return;

    let cancelled = false;

    const id = anchorId;
    async function fetchChain() {
      setLoading(true);

      // Fetch the current anchor to get parent_anchor_id
      const { data: current } = await supabase
        .from('anchors')
        .select('id, public_id, filename, credential_type, status, created_at, expires_at, revoked_at, version_number, parent_anchor_id, user_id')
        .eq('id', id)
        .single();

      if (!current || cancelled) {
        setLoading(false);
        return;
      }

      const links: ChainLink[] = [];

      // Walk up the chain (ancestors)
      let parentId = current.parent_anchor_id;
      const visited = new Set<string>([current.id]);
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const { data: parent } = await supabase
          .from('anchors')
          .select('id, public_id, filename, credential_type, status, created_at, expires_at, revoked_at, version_number, parent_anchor_id')
          .eq('id', parentId)
          .single();

        if (!parent || cancelled) break;
        links.unshift({
          id: parent.id,
          publicId: parent.public_id,
          filename: parent.filename,
          credentialType: parent.credential_type,
          status: parent.status,
          createdAt: parent.created_at,
          expiresAt: parent.expires_at,
          revokedAt: parent.revoked_at,
          versionNumber: parent.version_number,
          isCurrent: false,
        });
        parentId = parent.parent_anchor_id;
      }

      // Add current anchor
      links.push({
        id: current.id,
        publicId: current.public_id,
        filename: current.filename,
        credentialType: current.credential_type,
        status: current.status,
        createdAt: current.created_at,
        expiresAt: current.expires_at,
        revokedAt: current.revoked_at,
        versionNumber: current.version_number,
        isCurrent: true,
      });

      // Walk down the chain (descendants)
      let currentId = current.id;
      while (!cancelled) {
        const { data: children } = await supabase
          .from('anchors')
          .select('id, public_id, filename, credential_type, status, created_at, expires_at, revoked_at, version_number, parent_anchor_id')
          .eq('parent_anchor_id', currentId)
          .order('created_at', { ascending: true })
          .limit(1);

        if (!children?.length) break;
        const child = children[0];
        if (visited.has(child.id)) break;
        visited.add(child.id);

        links.push({
          id: child.id,
          publicId: child.public_id,
          filename: child.filename,
          credentialType: child.credential_type,
          status: child.status,
          createdAt: child.created_at,
          expiresAt: child.expires_at,
          revokedAt: child.revoked_at,
          versionNumber: child.version_number,
          isCurrent: false,
        });
        currentId = child.id;
      }

      if (!cancelled) {
        setChain(links);
        setLoading(false);
      }
    }

    fetchChain();
    return () => { cancelled = true; };
  }, [anchorId]);

  return {
    chain,
    loading,
    hasChain: chain.length > 1,
  };
}
