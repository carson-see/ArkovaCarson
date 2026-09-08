/**
 * useVisibilityPolling — page-visibility-aware polling hook.
 *
 * Extracted from AnchorQueuePage / PipelineAdminPage / useTreasuryBalance after
 * the SCRUM-1260 (R1-6) /simplify pass surfaced the same inline polling
 * pattern in three places. Backgrounded admin tabs were independently hammering
 * the worker on a 30–60s clock; centralising the pattern here makes the
 * "skip when hidden, refresh on visibilitychange, abort on unmount" contract
 * a single auditable spec.
 *
 * Behaviour:
 *   1. Calls `cb()` once on mount (`options.immediate`, default `true`).
 *   2. Sets a `setInterval(intervalMs)` tick that fires `cb()` only when
 *      `document.hidden === false`.
 *   3. Adds a `visibilitychange` listener that calls `cb()` immediately when
 *      the tab returns to foreground (so admins don't stare at stale data
 *      for up to a full poll interval after switching back).
 *   4. Clears the interval + removes the listener on unmount.
 *
 * `options.immediate` (SCRUM-3167 review, R7): defaults to `true`, so
 * every pre-existing caller (`AnchorQueuePage`, `PipelineAdminPage`,
 * `useTreasuryBalance`, `useOpsSloStats`) is UNCHANGED. Pass `false` for a
 * caller whose "first check" already happened via its own separate effect
 * and would otherwise double-fire on mount — this is what
 * `useMfaAssurance`/`useMfaEnrollmentRequirement` need (they migrated here
 * from the now-deleted `useForegroundInterval`, which never fired
 * immediately at all).
 *
 * `options.enabled` (R7): defaults to `true`. When `false`, this hook is a
 * complete no-op — no immediate fire, no interval, no listener — needed by
 * `useMfaAssurance` (`Boolean(userId)`) and `useMfaEnrollmentRequirement`
 * (`Boolean(profile)`).
 *
 * `cb` is read via a ref (R7's "ref-for-callback discipline", ported from
 * `useForegroundInterval`), so passing a new `cb` identity on every render
 * no longer restarts the effect (and therefore never re-fires `immediate`
 * or re-arms the interval/listener) — the LATEST `cb` is simply what runs
 * on the next tick. This is strictly safer than the pre-R7 contract, which
 * relied on the caller remembering to `useCallback` its `cb` — a caller
 * that already does is completely unaffected; one that didn't now gets the
 * intended behaviour instead of a silent effect-restart footgun.
 *
 * Caller contract:
 *   - `cb` MUST handle its own errors. The hook swallows rejection here so
 *     a stale poll doesn't crash the React tree; if you need to surface
 *     errors, set component state inside `cb` and read it from the parent.
 *
 * Server-side rendering: every `document` reference is guarded so the hook
 * is a no-op when `document` is undefined (Node SSR build).
 */

import { useEffect, useRef } from 'react';

export interface UseVisibilityPollingOptions {
  /** Fire `cb()` once immediately on mount (and whenever the hook transitions to enabled). Default `true`. */
  immediate?: boolean;
  /** When `false`, this hook is a complete no-op (no immediate fire, no interval, no listener). Default `true`. */
  enabled?: boolean;
}

export function useVisibilityPolling(
  cb: () => Promise<unknown> | void,
  intervalMs: number,
  options: UseVisibilityPollingOptions = {},
): void {
  const { immediate = true, enabled = true } = options;

  const cbRef = useRef(cb);
  useEffect(() => {
    cbRef.current = cb;
  }, [cb]);

  useEffect(() => {
    if (!enabled) return;

    // Swallow rejected promises so the hook never throws into React's
    // commit phase. Callers are responsible for surfacing errors via state.
    const swallow = (p: Promise<unknown> | void) => {
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        (p as Promise<unknown>).catch(() => undefined);
      }
    };

    if (immediate) swallow(cbRef.current());

    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      swallow(cbRef.current());
    }, intervalMs);

    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) swallow(cbRef.current());
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      clearInterval(id);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [intervalMs, immediate, enabled]);
}
