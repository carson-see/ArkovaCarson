/**
 * useRevokeAnchor Hook
 *
 * Hook for revoking anchors via the revoke_anchor RPC function.
 * Supports an optional reason parameter (persisted to DB).
 */

import { useCallback } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { useAsyncAction } from './useAsyncAction';
import { TOAST } from '@/lib/copy';

interface UseRevokeAnchorReturn {
  revokeAnchor: (anchorId: string, reason?: string) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  clearError: () => void;
}

export function useRevokeAnchor(): UseRevokeAnchorReturn {
  const revokeImpl = useCallback(async (anchorId: string, reason?: string): Promise<boolean> => {
    // Type assertion needed until types are regenerated
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: rpcError } = await (supabase.rpc as any)('revoke_anchor', {
      anchor_id: anchorId,
      reason: reason || null,
    });

    if (rpcError) {
      // Handle specific error codes
      if (rpcError.message.includes('insufficient_privilege')) {
        throw new Error('You do not have permission to revoke this anchor.');
      } else if (rpcError.message.includes('already revoked')) {
        throw new Error('This anchor has already been revoked.');
      } else if (rpcError.message.includes('legal hold')) {
        throw new Error('Cannot revoke an anchor under legal hold.');
      } else {
        throw new Error(rpcError.message || 'Failed to revoke anchor.');
      }
    }

    return true;
  }, []);

  const { execute, loading, error, clearError } = useAsyncAction(revokeImpl);

  const revokeAnchor = useCallback(
    async (anchorId: string, reason?: string): Promise<boolean> => {
      try {
        const result = await execute(anchorId, reason);
        toast.success(TOAST.ANCHOR_REVOKED);
        return result;
      } catch {
        toast.error(TOAST.ANCHOR_REVOKE_FAILED);
        return false;
      }
    },
    [execute],
  );

  return { revokeAnchor, loading, error, clearError };
}
