/**
 * useActivateAccount Hook
 *
 * Drives the /activate page against the worker's activation endpoints:
 *   - GET  /api/activation/:token      — public preview (no auth; the
 *     single-use token itself is the proof of access)
 *   - POST /api/activation/complete    — consumes the token, sets the
 *     recipient's password and marks the profile ACTIVE.
 *
 * Deliberately talks to the WORKER, not Supabase. Activation must write the
 * `auth.users` password via the admin API, which needs the service_role key —
 * and that key must never reach the browser (Constitution §1.4). The previous
 * implementation called `supabase.rpc('activate_user', { p_token, p_claim_key })`
 * directly, which could not bind (no such overload in prod) and could not have
 * set a password even if it had. Same shape as `useAcceptInvite` (SCRUM-3012).
 *
 * No session is ever attached: the recipient has no account to sign into yet.
 */

import { useCallback, useState } from 'react';
import { resolveSafeWorkerEndpoint, resolveWorkerBaseUrl } from '@/lib/workerUrlSafety';
import { ACTIVATE_ACCOUNT_LABELS } from '@/lib/copy';

export interface ActivationPreview {
  email: string;
  fullName: string | null;
  orgName: string;
  expired: boolean;
}

export interface ActivateAccountResponse {
  success: true;
  email: string;
  orgId: string | null;
  orgName: string;
}

interface WorkerErrorBody {
  error?: { code?: string; message?: string };
}

/** Carries the worker's error `code` so the page can branch on
 *  expired / not_found / already_used. The message is always the worker's own
 *  curated, user-safe string — never a raw DB or network error. */
export class ActivateAccountError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'ActivateAccountError';
  }
}

async function toActivationError(response: Response): Promise<ActivateAccountError> {
  try {
    const body = (await response.json()) as WorkerErrorBody;
    return new ActivateAccountError(
      body.error?.message ?? ACTIVATE_ACCOUNT_LABELS.ERROR_GENERIC,
      body.error?.code,
    );
  } catch {
    return new ActivateAccountError(ACTIVATE_ACCOUNT_LABELS.ERROR_GENERIC);
  }
}

interface UseActivateAccountReturn {
  preview: ActivationPreview | null;
  previewLoading: boolean;
  previewError: ActivateAccountError | null;
  loadPreview: (activationToken: string) => Promise<ActivationPreview>;
  activating: boolean;
  activateError: ActivateAccountError | null;
  activateAccount: (params: {
    token: string;
    password: string;
    fullName?: string;
  }) => Promise<ActivateAccountResponse>;
}

export function useActivateAccount(): UseActivateAccountReturn {
  const [preview, setPreview] = useState<ActivationPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<ActivateAccountError | null>(null);

  const loadPreview = useCallback(async (activationToken: string): Promise<ActivationPreview> => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const workerUrl = resolveWorkerBaseUrl(import.meta.env.VITE_WORKER_URL);
      const endpoint = resolveSafeWorkerEndpoint(
        workerUrl,
        `/api/activation/${encodeURIComponent(activationToken)}`,
      );
      const response = await fetch(endpoint.toString());
      if (!response.ok) {
        throw await toActivationError(response);
      }
      const data = (await response.json()) as ActivationPreview;
      setPreview(data);
      return data;
    } catch (err) {
      const wrapped =
        err instanceof ActivateAccountError
          ? err
          : new ActivateAccountError(ACTIVATE_ACCOUNT_LABELS.ERROR_GENERIC);
      setPreviewError(wrapped);
      throw wrapped;
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<ActivateAccountError | null>(null);

  const activateAccount = useCallback(
    async (params: {
      token: string;
      password: string;
      fullName?: string;
    }): Promise<ActivateAccountResponse> => {
      setActivating(true);
      setActivateError(null);
      try {
        const workerUrl = resolveWorkerBaseUrl(import.meta.env.VITE_WORKER_URL);
        const endpoint = resolveSafeWorkerEndpoint(workerUrl, '/api/activation/complete');
        const response = await fetch(endpoint.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
        if (!response.ok) {
          throw await toActivationError(response);
        }
        return (await response.json()) as ActivateAccountResponse;
      } catch (err) {
        const wrapped =
          err instanceof ActivateAccountError
            ? err
            : new ActivateAccountError(ACTIVATE_ACCOUNT_LABELS.ERROR_GENERIC);
        setActivateError(wrapped);
        throw wrapped;
      } finally {
        setActivating(false);
      }
    },
    [],
  );

  return {
    preview,
    previewLoading,
    previewError,
    loadPreview,
    activating,
    activateError,
    activateAccount,
  };
}
