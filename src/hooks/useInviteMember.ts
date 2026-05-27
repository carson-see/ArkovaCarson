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
import { InviteMemberSchema, type InviteMemberInput } from '@/lib/validators';
import { resolveSafeWorkerEndpoint } from '@/lib/workerUrlSafety';

interface UseInviteMemberReturn {
  inviteMember: (options: InviteMemberInput) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  clearError: () => void;
}

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001';

export function useInviteMember(): UseInviteMemberReturn {
  const inviteImpl = useCallback(
    async (options: InviteMemberInput): Promise<boolean> => {
      const parsedOptions = InviteMemberSchema.safeParse(options);
      if (!parsedOptions.success) {
        throw new Error(parsedOptions.error.issues[0]?.message ?? 'Failed to send invitation.');
      }

      const { email, role, orgId, orgName, inviterName } = parsedOptions.data;
      const emailEndpoint = resolveSafeWorkerEndpoint(WORKER_URL, '/api/send-invitation-email');

      // Step 1: Create invitation record via RPC
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: rpcError } = await (supabase as any).rpc('invite_member', {
        invitee_email: email,
        invitee_role: role,
        target_org_id: orgId,
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

      // Step 2: Send invitation email via worker API
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          throw new Error('No active session');
        }

        const emailResponse = await fetch(emailEndpoint.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ email, orgId, orgName, role, inviterName }),
        });

        if (!emailResponse.ok) {
          throw new Error(`Invitation email endpoint returned ${emailResponse.status}`);
        }
      } catch (emailErr) {
        console.warn('Invitation email send failed (invitation still created):', emailErr);
        throw new Error('Invitation was created, but the email could not be sent. Please try again.');
      }

      return true;
    },
    [],
  );

  const { execute, loading, error, clearError } = useAsyncAction(inviteImpl);

  const inviteMember = useCallback(
    async (options: InviteMemberInput): Promise<boolean> => {
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
