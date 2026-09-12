/**
 * useInviteMember Hook
 *
 * Hook for inviting members to an organization via RPC function.
 * After the invitation record is created, triggers an invitation
 * email via the worker API.
 */

import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { useAsyncAction } from './useAsyncAction';
import { TOAST } from '@/lib/copy';
import { InviteMemberSchema, type InviteMemberInput } from '@/lib/validators';
import { resolveSafeWorkerEndpoint, resolveWorkerBaseUrl } from '@/lib/workerUrlSafety';

interface UseInviteMemberReturn {
  inviteMember: (options: InviteMemberInput) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  clearError: () => void;
}

interface UseInviteMemberOptions {
  platformAdmin?: boolean;
}

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

export function useInviteMember({ platformAdmin = false }: UseInviteMemberOptions = {}): UseInviteMemberReturn {
  const adminRetryRef = useRef<{ intent: string; key: string } | null>(null);
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
      const workerUrl = resolveWorkerBaseUrl(import.meta.env.VITE_WORKER_URL);
      const emailEndpoint = resolveSafeWorkerEndpoint(
        workerUrl,
        platformAdmin
          ? `/api/admin/organizations/${encodeURIComponent(orgId)}/invitations`
          : '/api/send-invitation-email',
      );

      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new ActionableInviteError('Your session has expired. Please sign in and try again.');
      }

      if (platformAdmin) {
        const intent = `${orgId}\n${email}\n${role}`;
        if (adminRetryRef.current?.intent !== intent) {
          adminRetryRef.current = { intent, key: crypto.randomUUID() };
        }

        let response: Response;
        let body: { sent?: unknown; created?: unknown; code?: unknown };
        try {
          response = await fetch(emailEndpoint.toString(), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              email,
              role,
              idempotency_key: adminRetryRef.current.key,
            }),
          });
          body = await response.json() as { sent?: unknown; created?: unknown; code?: unknown };
        } catch (requestError) {
          console.warn('Platform invitation request could not be confirmed (submission key retained for retry):', requestError);
          throw new ActionableInviteError(
            'The invitation could not be confirmed or sent. Please try again.',
          );
        }

        if (response.ok && body.sent === true) {
          adminRetryRef.current = null;
          return true;
        }
        if (response.status === 409 && body.code === 'already_member') {
          throw new ActionableInviteError('This person is already a member of the organization.');
        }
        if (response.status === 403) {
          throw new ActionableInviteError('You do not have permission to invite members.');
        }
        if (response.status === 404) {
          throw new ActionableInviteError('This organization is no longer available.');
        }
        if (response.status === 502 && body.created === true && body.code === 'email_delivery_failed') {
          throw new ActionableInviteError(
            'Invitation was created, but email delivery could not be confirmed. Please try again.',
          );
        }
        throw new ActionableInviteError(
          'The invitation could not be completed. Review the details and try again.',
        );
      }

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
        const emailResponse = await fetch(emailEndpoint.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ email, orgId, orgName, role, inviterName, invitationId }),
        });

        const responseBody = await emailResponse.json() as { sent?: unknown };
        if (!emailResponse.ok || responseBody.sent !== true) {
          throw new Error(`Invitation email endpoint returned ${emailResponse.status}`);
        }
      } catch (emailErr) {
        console.warn('Invitation email send failed (invitation still created):', emailErr);
        throw new ActionableInviteError(
          'Invitation was created, but email delivery could not be confirmed. Please try again.',
        );
      }

      return true;
    },
    [platformAdmin],
  );

  const { execute, loading, error, clearError } = useAsyncAction(
    inviteImpl,
    GENERIC_INVITE_FAILURE,
    // Only an ActionableInviteError (curated, user-safe messages we authored
    // — "already a member", "email could not be sent", etc.) surfaces
    // verbatim in `error` state, mirroring the toast-safety check in
    // `inviteMember` below. Everything else — including resolveWorkerBaseUrl's
    // internal VITE_WORKER_URL config text — falls back to
    // GENERIC_INVITE_FAILURE. See useAsyncAction.ts's isSafeError doc.
    isActionableInviteError,
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
