/**
 * useAsyncAction Hook
 *
 * Generic hook that provides loading/error state management for async operations.
 * Eliminates boilerplate across hooks like useRevokeAnchor, useInviteMember, useExportAnchors.
 */

import { useState, useCallback } from 'react';

interface UseAsyncActionReturn<TArgs extends unknown[], TResult> {
  execute: (...args: TArgs) => Promise<TResult>;
  loading: boolean;
  error: string | null;
  clearError: () => void;
}

/**
 * Wraps an async function with loading/error state management.
 *
 * @param fn - The async function to wrap. Should throw on error (message will be captured).
 * @param fallbackError - Default error message when a thrown error isn't
 *   deemed safe to show verbatim (see `isSafeError`).
 * @param isSafeError - Predicate deciding whether a thrown error's `.message`
 *   is safe to surface verbatim in `error` state. Defaults to "never safe" —
 *   every thrown error falls back to `fallbackError` unless a consumer
 *   explicitly opts a specific error shape in via this predicate.
 *
 *   Why the default is "never safe" (previously: `err instanceof Error ?
 *   err.message : fallbackError`, i.e. every `Error`'s message was trusted):
 *   `useInviteMember` wraps a function that calls `resolveWorkerBaseUrl`,
 *   which throws a plain `Error` carrying internal, engineer-facing config
 *   detail (naming `VITE_WORKER_URL` / Vercel project settings) when a
 *   production build has no worker URL configured. The old default meant that
 *   text would land in this hook's `error` state verbatim — latent only
 *   because no caller destructured `error` from `useInviteMember()` at the
 *   time this was found, one `const { error } = useInviteMember()` away from
 *   becoming a real leak (see `src/lib/workerResponseError.ts` for the
 *   sibling fix to this exact class of bug in 4 component-level catch
 *   blocks touched by the same incident).
 *
 *   Pass a type guard for your hook's own curated error class(es) — e.g.
 *   `isActionableInviteError` in `useInviteMember.ts` — to restore verbatim
 *   messages for errors YOU authored and know are safe. Pass
 *   `(err): err is Error => err instanceof Error` to restore the OLD
 *   blanket-trust behavior for a consumer whose thrown `Error`s are ALL
 *   already curated, user-safe text with no internal-detail throws mixed in
 *   (`useRevokeAnchor` and `useExportAnchors` both do this — checked at the
 *   same time as this change: every throw site in both is an authored string
 *   or a Supabase/PostgREST `error.message` passthrough, never a config/
 *   infrastructure detail like `resolveWorkerBaseUrl`'s, and `useRevokeAnchor`
 *   specifically has its `error` state actively rendered in 4 pages today —
 *   regressing it to a generic label would be a real UX loss, not just a
 *   theoretical one).
 */
export function useAsyncAction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  fallbackError = 'An unexpected error occurred',
  isSafeError?: (err: unknown) => boolean,
): UseAsyncActionReturn<TArgs, TResult> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const execute = useCallback(
    async (...args: TArgs): Promise<TResult> => {
      setLoading(true);
      setError(null);

      try {
        return await fn(...args);
      } catch (err) {
        const isSafe = err instanceof Error && (isSafeError?.(err) ?? false);
        setError(isSafe ? (err as Error).message : fallbackError);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [fn, fallbackError, isSafeError],
  );

  return { execute, loading, error, clearError };
}
