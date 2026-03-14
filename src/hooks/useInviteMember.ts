/**
 * useInviteMember Hook
 *
 * Hook for inviting members to an organization via RPC function.
 */

import { useCallback } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { useAsyncAction } from './useAsyncAction';
import { TOAST } from '@/lib/copy';

type InviteRole = 'INDIVIDUAL' | 'ORG_ADMIN';

interface UseInviteMemberReturn {
  inviteMember: (email: string, role: InviteRole, orgId: string) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  clearError: () => void;
}

export function useInviteMember(): UseInviteMemberReturn {
  const inviteImpl = useCallback(
    async (email: string, role: InviteRole, orgId: string): Promise<boolean> => {
      // Type assertion needed until types are regenerated
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: rpcError } = await (supabase.rpc as any)('invite_member', {
        invite_email: email,
        invite_role: role,
        org_id: orgId,
      });

      if (rpcError) {
        // Handle specific error codes
        if (rpcError.message.includes('already a member')) {
          throw new Error('This person is already a member of the organization.');
        } else if (rpcError.message.includes('insufficient_privilege')) {
          throw new Error('You do not have permission to invite members.');
        } else if (rpcError.message.includes('invalid email')) {
          throw new Error('Please enter a valid email address.');
        } else {
          throw new Error(rpcError.message || 'Failed to send invitation.');
        }
      }

      return true;
    },
    [],
  );

  const { execute, loading, error, clearError } = useAsyncAction(inviteImpl);

  const inviteMember = useCallback(
    async (email: string, role: InviteRole, orgId: string): Promise<boolean> => {
      try {
        const result = await execute(email, role, orgId);
        toast.success(TOAST.MEMBER_INVITED);
        return result;
      } catch {
        toast.error(TOAST.MEMBER_INVITE_FAILED);
        return false;
      }
    },
    [execute],
  );

  return { inviteMember, loading, error, clearError };
}
