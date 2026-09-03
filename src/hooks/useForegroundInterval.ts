/**
 * useForegroundInterval — shared "live re-evaluation" cadence (SCRUM-3167
 * review batch, items 13/S2/EA3).
 *
 * `useMfaAssurance.ts` and `useMfaEnrollmentRequirement.ts` independently
 * implemented the identical CTO ruling A4-11 pattern: re-run something on a
 * fixed interval AND immediately when the tab regains foreground (so a
 * backgrounded tab doesn't wait up to a full interval after the user
 * switches back). This hook is the single shared implementation.
 *
 * `callback` is read via a ref so this hook never re-arms the interval or
 * listener just because the caller passed a new function identity on
 * re-render (mirrors `useVisibilityPolling`'s discipline, without that
 * hook's "fire once on mount" behavior — the MFA callers explicitly do NOT
 * want an immediate fire, since the thing they re-evaluate already ran once
 * via its own initial effect).
 */

import { useEffect, useRef } from 'react';

export function useForegroundInterval(
  callback: () => void,
  intervalMs: number,
  enabled: boolean = true,
): void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;

    const intervalId = setInterval(() => {
      callbackRef.current();
    }, intervalMs);

    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        callbackRef.current();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    return () => {
      clearInterval(intervalId);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [intervalMs, enabled]);
}
