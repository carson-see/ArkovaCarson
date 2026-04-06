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
    const { error: rpcError } = await (supabase as any).rpc('revoke_anchor', {
      anchor_id: anchorId,
      reason: reason || null,
    });

    if (rpcError) {
      // Handle specific error codes — Supabase returns ERRCODE in .code, message text in .message
      const errMsg = (rpcError.message ?? '').toLowerCase();
      const errCode = (rpcError.code ?? '').toLowerCase();
      if (errCode === 'insufficient_privilege' || errCode === '42501' || errMsg.includes('insufficient_privilege') || errMsg.includes('permission')) {
        throw new Error('You do not have permission to revoke this record.');
      } else if (errMsg.includes('already revoked') || errMsg.includes('revoked')) {
        throw new Error('This record has already been revoked.');
      } else if (errMsg.includes('legal hold')) {
        throw new Error('Cannot revoke a record under legal hold.');
      } else {
        throw new Error(rpcError.message || 'Failed to revoke record.');
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
