/**
 * useAcceptInvite Hook (SCRUM-3012)
 *
 * Drives the /accept-invite page against the worker's invitation endpoints:
 *   - GET  /api/invitations/:token  — public preview (no auth; the token
 *     itself is the proof of access)
 *   - POST /api/invitations/accept  — provisions the membership. Sent WITH
 *     the caller's session when one exists (join path), or without one when
 *     creating a brand-new account (the worker distinguishes the two).
 *
 * Talks to the worker directly rather than Supabase/RLS — invitations are
 * looked up by their (secret, single-use) token, not by the caller's
 * identity, so there is no meaningful RLS-scoped client read here.
 */

import { useCallback, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { resolveSafeWorkerEndpoint } from '@/lib/workerUrlSafety';
import { ACCEPT_INVITE_LABELS } from '@/lib/copy';

const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'http://localhost:3001';

export interface InvitationPreview {
  orgName: string;
  email: string;
  role: 'INDIVIDUAL' | 'ORG_ADMIN' | 'ORG_MEMBER';
  expired: boolean;
  alreadyUsed: boolean;
}

export interface AcceptInvitationResponse {
  success: true;
  orgId: string;
  orgName: string;
  verificationRequired: boolean;
  verificationEmailSent: boolean;
}

interface WorkerErrorBody {
  error?: { code?: string; message?: string };
}

/** Error marked with the worker's error `code` so the page can branch on it
 *  (expired / already_used / account_exists / email_mismatch / ...). The
 *  message is always the worker's own curated, user-safe string. */
export class InviteAcceptError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'InviteAcceptError';
  }
}

async function toAcceptError(response: Response): Promise<InviteAcceptError> {
  try {
    const body = (await response.json()) as WorkerErrorBody;
    return new InviteAcceptError(
      body.error?.message ?? ACCEPT_INVITE_LABELS.ERROR_GENERIC,
      body.error?.code,
    );
  } catch {
    return new InviteAcceptError(ACCEPT_INVITE_LABELS.ERROR_GENERIC);
  }
}

interface UseAcceptInviteReturn {
  preview: InvitationPreview | null;
  previewLoading: boolean;
  previewError: InviteAcceptError | null;
  loadPreview: (inviteToken: string) => Promise<InvitationPreview>;
  accepting: boolean;
  acceptError: InviteAcceptError | null;
  acceptInvitation: (params: {
    token: string;
    password?: string;
    fullName?: string;
  }) => Promise<AcceptInvitationResponse>;
}

export function useAcceptInvite(): UseAcceptInviteReturn {
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<InviteAcceptError | null>(null);

  const loadPreview = useCallback(async (inviteToken: string): Promise<InvitationPreview> => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const endpoint = resolveSafeWorkerEndpoint(
        WORKER_URL,
        `/api/invitations/${encodeURIComponent(inviteToken)}`,
      );
      const response = await fetch(endpoint.toString());
      if (!response.ok) {
        throw await toAcceptError(response);
      }
      const data = (await response.json()) as InvitationPreview;
      setPreview(data);
      return data;
    } catch (err) {
      const wrapped =
        err instanceof InviteAcceptError ? err : new InviteAcceptError(ACCEPT_INVITE_LABELS.ERROR_GENERIC);
      setPreviewError(wrapped);
      throw wrapped;
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<InviteAcceptError | null>(null);

  const acceptInvitation = useCallback(
    async (params: { token: string; password?: string; fullName?: string }): Promise<AcceptInvitationResponse> => {
      setAccepting(true);
      setAcceptError(null);
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const endpoint = resolveSafeWorkerEndpoint(WORKER_URL, '/api/invitations/accept');
        const response = await fetch(endpoint.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify(params),
        });
        if (!response.ok) {
          throw await toAcceptError(response);
        }
        return (await response.json()) as AcceptInvitationResponse;
      } catch (err) {
        const wrapped =
          err instanceof InviteAcceptError ? err : new InviteAcceptError(ACCEPT_INVITE_LABELS.ERROR_GENERIC);
        setAcceptError(wrapped);
        throw wrapped;
      } finally {
        setAccepting(false);
      }
    },
    [],
  );

  return { preview, previewLoading, previewError, loadPreview, accepting, acceptError, acceptInvitation };
}
