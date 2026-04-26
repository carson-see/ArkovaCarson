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
 *   1. Calls `cb()` once on mount.
 *   2. Sets a `setInterval(intervalMs)` tick that fires `cb()` only when
 *      `document.hidden === false`.
 *   3. Adds a `visibilitychange` listener that calls `cb()` immediately when
 *      the tab returns to foreground (so admins don't stare at stale data
 *      for up to a full poll interval after switching back).
 *   4. Clears the interval + removes the listener on unmount.
 *
 * Caller contract:
 *   - `cb` MUST handle its own errors. The hook swallows rejection here so
 *     a stale poll doesn't crash the React tree; if you need to surface
 *     errors, set component state inside `cb` and read it from the parent.
 *   - Wrap `cb` in `useCallback` so the effect doesn't re-arm every render.
 *
 * Server-side rendering: every `document` reference is guarded so the hook
 * is a no-op when `document` is undefined (Node SSR build).
 */

import { useEffect } from 'react';

export function useVisibilityPolling(
  cb: () => Promise<unknown> | void,
  intervalMs: number,
): void {
  useEffect(() => {
    // Swallow rejected promises so the hook never throws into React's
    // commit phase. Callers are responsible for surfacing errors via state.
    const swallow = (p: Promise<unknown> | void) => {
      if (p && typeof (p as Promise<unknown>).catch === 'function') {
        (p as Promise<unknown>).catch(() => undefined);
      }
    };

    swallow(cb());

    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      swallow(cb());
    }, intervalMs);

    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) swallow(cb());
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
  }, [cb, intervalMs]);
}
