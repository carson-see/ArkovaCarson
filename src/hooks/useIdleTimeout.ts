/**
 * HIPAA Session Timeout — REG-06 (SCRUM-565)
 *
 * Client-side idle detection that terminates session after inactivity.
 * Section 164.312(a)(2)(iii): Automatic logoff.
 *
 * Tracks mouse, keyboard, touch, and visibility events.
 * When the configured timeout is reached, signs the user out.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface UseIdleTimeoutOptions {
  /** Timeout in minutes. 0 = disabled. Default: 0. */
  timeoutMinutes: number;
  /** Callback when session times out (before sign-out) */
  onTimeout?: () => void;
  /** Whether to show a warning before timeout */
  warningMinutes?: number;
}

interface UseIdleTimeoutResult {
  /** Whether the timeout is active */
  isActive: boolean;
  /** Whether the warning period is active */
  isWarning: boolean;
  /** Minutes remaining before timeout */
  minutesRemaining: number;
  /** Reset the idle timer (e.g., after user interaction) */
  reset: () => void;
}

const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll'] as const;

export function useIdleTimeout({
  timeoutMinutes,
  onTimeout,
  warningMinutes = 2,
}: UseIdleTimeoutOptions): UseIdleTimeoutResult {
  const lastActivityRef = useRef<number>(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isWarning, setIsWarning] = useState(false);
  const [minutesRemaining, setMinutesRemaining] = useState(timeoutMinutes);

  const isActive = timeoutMinutes > 0;
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const warningMs = warningMinutes * 60 * 1000;

  const reset = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIsWarning(false);
    setMinutesRemaining(timeoutMinutes);
  }, [timeoutMinutes]);

  // Handle activity events
  useEffect(() => {
    if (!isActive) return;

    function onActivity() {
      lastActivityRef.current = Date.now();
      setIsWarning(false);
    }

    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, onActivity, { passive: true });
    }

    // Visibility change — reset on return from background
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        // Don't reset — check if timed out while hidden
        const elapsed = Date.now() - lastActivityRef.current;
        if (elapsed >= timeoutMs) {
          void handleTimeout();
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        document.removeEventListener(event, onActivity);
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, timeoutMs]);

  // Check idle state on interval
  useEffect(() => {
    if (!isActive) return;

    async function handleTimeout() {
      onTimeout?.();
      // Log audit event (fire-and-forget via worker)
      await supabase.from('audit_events').insert({
        event_type: 'SESSION_TIMEOUT',
        event_category: 'SECURITY',
        details: JSON.stringify({ timeout_minutes: timeoutMinutes }),
      });
      await supabase.auth.signOut();
    }

    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      const remaining = Math.max(0, timeoutMs - elapsed);
      const remainingMinutes = Math.ceil(remaining / 60_000);

      setMinutesRemaining(remainingMinutes);

      if (elapsed >= timeoutMs) {
        void handleTimeout();
      } else if (elapsed >= timeoutMs - warningMs) {
        setIsWarning(true);
      } else {
        setIsWarning(false);
      }
    }, 10_000); // Check every 10 seconds

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isActive, timeoutMs, warningMs, timeoutMinutes, onTimeout]);

  return {
    isActive,
    isWarning,
    minutesRemaining,
    reset,
  };
}
