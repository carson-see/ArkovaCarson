/**
 * Credential Lifecycle Hook
 *
 * Tracks and computes the lifecycle state of a credential anchor,
 * including timeline events and status transitions.
 *
 * @see P6-TS-04
 */

import { useMemo } from 'react';

export type LifecycleStatus = 'PENDING' | 'SECURED' | 'REVOKED' | 'EXPIRED';

export interface LifecycleEvent {
  type: 'CREATED' | 'ISSUED' | 'SECURED' | 'REVOKED' | 'EXPIRED' | 'EXPIRES';
  timestamp: string | null;
  label: string;
  completed: boolean;
  current: boolean;
  terminal: boolean;
  detail?: string;
}

interface LifecycleInput {
  status: LifecycleStatus;
  createdAt: string;
  issuedAt?: string | null;
  securedAt?: string | null;
  revokedAt?: string | null;
  revocationReason?: string | null;
  expiresAt?: string | null;
}

interface UseCredentialLifecycleResult {
  events: LifecycleEvent[];
  currentStatus: LifecycleStatus;
  isActive: boolean;
  isTerminal: boolean;
  isExpiringSoon: boolean;
  daysUntilExpiry: number | null;
  progressPercent: number;
}

const EXPIRY_WARNING_DAYS = 30;

export function useCredentialLifecycle(input: LifecycleInput | null): UseCredentialLifecycleResult {
  return useMemo(() => {
    if (!input) {
      return {
        events: [],
        currentStatus: 'PENDING' as LifecycleStatus,
        isActive: false,
        isTerminal: false,
        isExpiringSoon: false,
        daysUntilExpiry: null,
        progressPercent: 0,
      };
    }

    const events: LifecycleEvent[] = [];
    const { status, createdAt, issuedAt, securedAt, revokedAt, revocationReason, expiresAt } = input;

    // Created — always present
    events.push({
      type: 'CREATED',
      timestamp: createdAt,
      label: 'Created',
      completed: true,
      current: false,
      terminal: false,
    });

    // Issued — only if issued_at exists
    if (issuedAt) {
      events.push({
        type: 'ISSUED',
        timestamp: issuedAt,
        label: 'Issued',
        completed: true,
        current: false,
        terminal: false,
      });
    }

    // Secured
    if (status === 'PENDING') {
      events.push({
        type: 'SECURED',
        timestamp: null,
        label: 'Securing...',
        completed: false,
        current: true,
        terminal: false,
      });
    } else {
      events.push({
        type: 'SECURED',
        timestamp: securedAt ?? null,
        label: 'Secured',
        completed: true,
        current: status === 'SECURED',
        terminal: false,
      });
    }

    // Revoked
    if (status === 'REVOKED') {
      events.push({
        type: 'REVOKED',
        timestamp: revokedAt ?? null,
        label: 'Revoked',
        completed: true,
        current: false,
        terminal: true,
        detail: revocationReason ?? undefined,
      });
    }

    // Expired
    if (status === 'EXPIRED') {
      events.push({
        type: 'EXPIRED',
        timestamp: expiresAt ?? null,
        label: 'Expired',
        completed: true,
        current: false,
        terminal: true,
      });
    }

    // Upcoming expiry for active records
    if (expiresAt && status !== 'EXPIRED' && status !== 'REVOKED') {
      events.push({
        type: 'EXPIRES',
        timestamp: expiresAt,
        label: 'Expires',
        completed: false,
        current: false,
        terminal: false,
      });
    }

    // Compute derived state
    const isTerminal = status === 'REVOKED' || status === 'EXPIRED';
    const isActive = status === 'SECURED';

    let daysUntilExpiry: number | null = null;
    let isExpiringSoon = false;
    if (expiresAt && isActive) {
      const msUntilExpiry = new Date(expiresAt).getTime() - Date.now();
      daysUntilExpiry = Math.ceil(msUntilExpiry / (1000 * 60 * 60 * 24));
      isExpiringSoon = daysUntilExpiry > 0 && daysUntilExpiry <= EXPIRY_WARNING_DAYS;
    }

    // Progress: PENDING=25, SECURED=75, terminal=100
    let progressPercent = 0;
    if (status === 'PENDING') progressPercent = 25;
    else if (status === 'SECURED') progressPercent = 75;
    else progressPercent = 100;

    return {
      events,
      currentStatus: status,
      isActive,
      isTerminal,
      isExpiringSoon,
      daysUntilExpiry,
      progressPercent,
    };
  }, [input]);
}
