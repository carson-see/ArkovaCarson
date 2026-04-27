/**
 * HIPAA Session Timeout — REG-06 (SCRUM-565)
 *
 * Client-side idle detection that terminates session after inactivity.
 * Section 164.312(a)(2)(iii): Automatic logoff.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { logAuditEvent } from '@/lib/auditLog';

interface UseIdleTimeoutOptions {
  /** Timeout in minutes. 0 = disabled. */
  timeoutMinutes: number;
  /** Callback when session times out (before sign-out) */
  onTimeout?: () => void;
  /** Minutes before timeout to show warning (default: 2) */
  warningMinutes?: number;
}

interface UseIdleTimeoutResult {
  isActive: boolean;
  isWarning: boolean;
  minutesRemaining: number;
  reset: () => void;
}

const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll'] as const;

export function useIdleTimeout({
  timeoutMinutes,
  onTimeout,
  warningMinutes = 2,
}: UseIdleTimeoutOptions): UseIdleTimeoutResult {
  const lastActivityRef = useRef<number>(0);
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

  // Activity event listeners
  useEffect(() => {
    if (!isActive) return;

    // Initialize on mount (avoids calling Date.now() during render)
    lastActivityRef.current = Date.now();

    function onActivity() {
      lastActivityRef.current = Date.now();
      setIsWarning(false);
      setMinutesRemaining(timeoutMinutes);
    }

    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, onActivity, { passive: true });
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') {
        const elapsed = Date.now() - lastActivityRef.current;
        if (elapsed >= timeoutMs) {
          void supabase.auth.signOut();
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
  }, [isActive, timeoutMs, timeoutMinutes]);

  // Interval check for timeout + warning
  useEffect(() => {
    if (!isActive) return;

    async function handleTimeout() {
      onTimeout?.();
      // SCRUM-1270: write through worker (service_role) — direct browser inserts
      // into audit_events have been disabled in migration 0276.
      await logAuditEvent({
        eventType: 'SESSION_TIMEOUT',
        eventCategory: 'AUTH',
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
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        void handleTimeout();
        return;
      } else if (elapsed >= timeoutMs - warningMs) {
        setIsWarning(true);
      } else {
        setIsWarning(false);
      }
    }, 10_000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isActive, timeoutMs, warningMs, timeoutMinutes, onTimeout]);

  return { isActive, isWarning, minutesRemaining, reset };
}
