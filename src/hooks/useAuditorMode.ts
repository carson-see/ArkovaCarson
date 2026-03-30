/**
 * Auditor Mode Hook (VAI-04)
 *
 * Provides a toggle for "Auditor Mode" — a compliance-focused read-only view.
 * When enabled, write actions (issue, revoke, edit) are hidden across the app.
 * State persisted in localStorage. Toggle logged as audit event.
 *
 * @see docs/stories/20_verifiable_ai.md — VAI-04
 */

import { useState, useCallback, createContext, useContext } from 'react';
import { logAuditEvent } from '@/lib/auditLog';

const STORAGE_KEY = 'arkova_auditor_mode';

export interface AuditorModeState {
  /** Whether auditor mode is currently active */
  isAuditorMode: boolean;
  /** Toggle auditor mode on/off */
  toggleAuditorMode: () => void;
  /** Explicitly set auditor mode */
  setAuditorMode: (enabled: boolean) => void;
}

export const AuditorModeContext = createContext<AuditorModeState>({
  isAuditorMode: false,
  toggleAuditorMode: () => {},
  setAuditorMode: () => {},
});

export function useAuditorMode(): AuditorModeState {
  return useContext(AuditorModeContext);
}

/**
 * Initialize auditor mode state. Use this in a provider component.
 */
export function useAuditorModeState(): AuditorModeState {
  const [isAuditorMode, setIsAuditorMode] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const setAuditorMode = useCallback((enabled: boolean) => {
    setIsAuditorMode(enabled);
    try {
      localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch {
      // localStorage unavailable
    }
    logAuditEvent({
      eventType: enabled ? 'auditor_mode_enabled' : 'auditor_mode_disabled',
      eventCategory: 'ADMIN',
      targetType: 'session',
      details: JSON.stringify({ auditor_mode: enabled }),
    });
  }, []);

  const toggleAuditorMode = useCallback(() => {
    setAuditorMode(!isAuditorMode);
  }, [isAuditorMode, setAuditorMode]);

  return { isAuditorMode, toggleAuditorMode, setAuditorMode };
}
