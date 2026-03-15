/**
 * useCredentialLifecycle Hook Tests
 *
 * Tests lifecycle event computation, status derivation,
 * expiry warnings, and progress percentages.
 *
 * @see P6-TS-04
 */

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCredentialLifecycle } from './useCredentialLifecycle';

describe('useCredentialLifecycle', () => {
  it('returns empty defaults for null input', () => {
    const { result } = renderHook(() => useCredentialLifecycle(null));

    expect(result.current.events).toEqual([]);
    expect(result.current.currentStatus).toBe('PENDING');
    expect(result.current.isActive).toBe(false);
    expect(result.current.isTerminal).toBe(false);
    expect(result.current.progressPercent).toBe(0);
  });

  it('computes PENDING lifecycle with 25% progress', () => {
    const { result } = renderHook(() =>
      useCredentialLifecycle({
        status: 'PENDING',
        createdAt: '2026-03-01T00:00:00Z',
      }),
    );

    expect(result.current.currentStatus).toBe('PENDING');
    expect(result.current.progressPercent).toBe(25);
    expect(result.current.isActive).toBe(false);
    expect(result.current.isTerminal).toBe(false);

    const types = result.current.events.map(e => e.type);
    expect(types).toContain('CREATED');
    expect(types).toContain('SECURED');

    const securingEvent = result.current.events.find(e => e.type === 'SECURED');
    expect(securingEvent?.completed).toBe(false);
    expect(securingEvent?.current).toBe(true);
    expect(securingEvent?.label).toBe('Securing...');
  });

  it('computes SECURED lifecycle with 75% progress', () => {
    const { result } = renderHook(() =>
      useCredentialLifecycle({
        status: 'SECURED',
        createdAt: '2026-03-01T00:00:00Z',
        securedAt: '2026-03-01T01:00:00Z',
      }),
    );

    expect(result.current.currentStatus).toBe('SECURED');
    expect(result.current.progressPercent).toBe(75);
    expect(result.current.isActive).toBe(true);
    expect(result.current.isTerminal).toBe(false);

    const securedEvent = result.current.events.find(e => e.type === 'SECURED');
    expect(securedEvent?.completed).toBe(true);
    expect(securedEvent?.current).toBe(true);
  });

  it('computes REVOKED lifecycle with 100% progress and terminal flag', () => {
    const { result } = renderHook(() =>
      useCredentialLifecycle({
        status: 'REVOKED',
        createdAt: '2026-03-01T00:00:00Z',
        securedAt: '2026-03-01T01:00:00Z',
        revokedAt: '2026-03-02T00:00:00Z',
        revocationReason: 'Superseded by new version',
      }),
    );

    expect(result.current.currentStatus).toBe('REVOKED');
    expect(result.current.progressPercent).toBe(100);
    expect(result.current.isTerminal).toBe(true);
    expect(result.current.isActive).toBe(false);

    const revokedEvent = result.current.events.find(e => e.type === 'REVOKED');
    expect(revokedEvent?.terminal).toBe(true);
    expect(revokedEvent?.detail).toBe('Superseded by new version');
  });

  it('computes EXPIRED lifecycle with terminal flag', () => {
    const { result } = renderHook(() =>
      useCredentialLifecycle({
        status: 'EXPIRED',
        createdAt: '2026-03-01T00:00:00Z',
        securedAt: '2026-03-01T01:00:00Z',
        expiresAt: '2026-03-10T00:00:00Z',
      }),
    );

    expect(result.current.isTerminal).toBe(true);
    expect(result.current.progressPercent).toBe(100);

    const types = result.current.events.map(e => e.type);
    expect(types).toContain('EXPIRED');
    // Should NOT have an EXPIRES future event since status is already EXPIRED
    expect(types).not.toContain('EXPIRES');
  });

  it('includes ISSUED event when issuedAt is provided', () => {
    const { result } = renderHook(() =>
      useCredentialLifecycle({
        status: 'SECURED',
        createdAt: '2026-03-01T00:00:00Z',
        issuedAt: '2026-03-01T00:30:00Z',
        securedAt: '2026-03-01T01:00:00Z',
      }),
    );

    const issuedEvent = result.current.events.find(e => e.type === 'ISSUED');
    expect(issuedEvent).toBeDefined();
    expect(issuedEvent?.completed).toBe(true);
  });

  it('adds EXPIRES future event for SECURED records with expiresAt', () => {
    const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const { result } = renderHook(() =>
      useCredentialLifecycle({
        status: 'SECURED',
        createdAt: '2026-03-01T00:00:00Z',
        securedAt: '2026-03-01T01:00:00Z',
        expiresAt: futureDate,
      }),
    );

    const expiresEvent = result.current.events.find(e => e.type === 'EXPIRES');
    expect(expiresEvent).toBeDefined();
    expect(expiresEvent?.completed).toBe(false);
    expect(result.current.daysUntilExpiry).toBeGreaterThan(0);
    expect(result.current.isExpiringSoon).toBe(false);
  });

  it('flags isExpiringSoon when within 30 days of expiry', () => {
    const soonDate = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
    const { result } = renderHook(() =>
      useCredentialLifecycle({
        status: 'SECURED',
        createdAt: '2026-03-01T00:00:00Z',
        securedAt: '2026-03-01T01:00:00Z',
        expiresAt: soonDate,
      }),
    );

    expect(result.current.isExpiringSoon).toBe(true);
    expect(result.current.daysUntilExpiry).toBeLessThanOrEqual(30);
    expect(result.current.daysUntilExpiry).toBeGreaterThan(0);
  });
});
