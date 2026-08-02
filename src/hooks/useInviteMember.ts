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

/**
 * Generic, user-safe fallback shown for any unrecognized failure.
 * Kept local (not in the locked `copy.ts`) and intentionally identical in spirit
 * to `TOAST.MEMBER_INVITE_FAILED` so the unknown-error path never differs.
 */
const GENERIC_INVITE_FAILURE = TOAST.MEMBER_INVITE_FAILED;

/**
 * Error marked safe to display to the user.
 *
 * SCRUM-1979 / §1.4: only messages we author (curated RPC-branch strings, the
 * email-send-failed message, and the curated Zod validation messages) are
 * user-safe. Raw RPC/DB error text is NEVER wrapped in this — it is replaced by
 * {@link GENERIC_INVITE_FAILURE} before it can reach the `error` state or a toast.
 * `inviteMember` surfaces `message` verbatim only when the thrown value is an
 * `ActionableInviteError`; anything else falls back to the generic message.
 */
class ActionableInviteError extends Error {
  readonly userSafe = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'ActionableInviteError';
  }
}

function isActionableInviteError(err: unknown): err is ActionableInviteError {
  return err instanceof ActionableInviteError;
}

export function useInviteMember(): UseInviteMemberReturn {
  const inviteImpl = useCallback(
    async (options: InviteMemberInput): Promise<boolean> => {
      const parsedOptions = InviteMemberSchema.safeParse(options);
      if (!parsedOptions.success) {
        // Zod messages here are author-curated + user-safe (validators.ts).
        throw new ActionableInviteError(
          parsedOptions.error.issues[0]?.message ?? GENERIC_INVITE_FAILURE,
        );
      }

      const { email, role, orgId, orgName, inviterName } = parsedOptions.data;
      const emailEndpoint = resolveSafeWorkerEndpoint(WORKER_URL, '/api/send-invitation-email');

      // Step 1: Create invitation record via RPC
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: invitationId, error: rpcError } = await (supabase as any).rpc('invite_member', {
        invitee_email: email,
        invitee_role: role,
        target_org_id: orgId,
      });

      if (rpcError) {
        const rpcMessage = typeof rpcError.message === 'string' ? rpcError.message : '';
        if (rpcMessage.includes('already a member')) {
          throw new ActionableInviteError('This person is already a member of the organization.');
        } else if (rpcMessage.includes('insufficient_privilege')) {
          throw new ActionableInviteError('You do not have permission to invite members.');
        } else if (rpcMessage.includes('invalid email')) {
          throw new ActionableInviteError('Please enter a valid email address.');
        } else {
          // §1.4: do NOT surface raw rpcError.message — it can carry DB internals,
          // constraint names, PG DETAIL, or org/user identifiers. Map to generic.
          throw new Error(GENERIC_INVITE_FAILURE);
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
          body: JSON.stringify({ email, orgId, orgName, role, inviterName, invitationId }),
        });

        if (!emailResponse.ok) {
          throw new Error(`Invitation email endpoint returned ${emailResponse.status}`);
        }
      } catch (emailErr) {
        console.warn('Invitation email send failed (invitation still created):', emailErr);
        throw new ActionableInviteError(
          'Invitation was created, but the email could not be sent. Please try again.',
        );
      }

      return true;
    },
    [],
  );

  const { execute, loading, error, clearError } = useAsyncAction(
    inviteImpl,
    GENERIC_INVITE_FAILURE,
  );

  const inviteMember = useCallback(
    async (options: InviteMemberInput): Promise<boolean> => {
      try {
        const result = await execute(options);
        toast.success(TOAST.MEMBER_INVITED);
        return result;
      } catch (err) {
        // Surface the specific, actionable message only when it was explicitly
        // marked user-safe; otherwise fall back to the generic message so no raw
        // DB/RPC text ever reaches the user (SCRUM-1979 / §1.4).
        const message = isActionableInviteError(err) ? err.message : GENERIC_INVITE_FAILURE;
        toast.error(message);
        return false;
      }
    },
    [execute],
  );

  return { inviteMember, loading, error, clearError };
}
