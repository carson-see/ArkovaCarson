/**
 * useInviteMember Hook
 *
 * Hook for inviting members to an organization via RPC function.
 * After the invitation record is created, triggers an invitation
 * email via the worker API.
 */

import { useCallback } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { useAsyncAction } from './useAsyncAction';
import { TOAST } from '@/lib/copy';

type InviteRole = 'INDIVIDUAL' | 'ORG_ADMIN';

interface InviteOptions {
  email: string;
  role: InviteRole;
  orgId: string;
  orgName: string;
  inviterName?: string;
}

interface UseInviteMemberReturn {
  inviteMember: (options: InviteOptions) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  clearError: () => void;
}

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001';

export function useInviteMember(): UseInviteMemberReturn {
  const inviteImpl = useCallback(
    async (options: InviteOptions): Promise<boolean> => {
      const { email, role, orgId, orgName, inviterName } = options;

      // Step 1: Create invitation record via RPC
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: rpcError } = await (supabase.rpc as any)('invite_member', {
        invite_email: email,
        invite_role: role,
        org_id: orgId,
      });

      if (rpcError) {
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

      // Step 2: Send invitation email via worker API (non-blocking)
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (session?.access_token) {
          await fetch(`${WORKER_URL}/api/send-invitation-email`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ email, orgId, orgName, role, inviterName }),
          });
        }
      } catch (emailErr) {
        // Email failure is non-fatal — invitation record was created
        console.warn('Invitation email send failed (invitation still created):', emailErr);
      }

      return true;
    },
    [],
  );

  const { execute, loading, error, clearError } = useAsyncAction(inviteImpl);

  const inviteMember = useCallback(
    async (options: InviteOptions): Promise<boolean> => {
      try {
        const result = await execute(options);
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
