/**
 * mfaCapabilityCooldown tests — SCRUM-3167 review batch (items 5/D1, 24).
 *
 * D1 (CONFIRMED by the verifier): AuthGuard's one-shot toast/Sentry ref was
 * PER AuthGuard INSTANCE, and every one of the ~52 routes mounts its own
 * AuthGuard. During an MFA-platform outage, a required-role admin who keeps
 * navigating gets a fresh `enroll()`/`challenge()` attempt PLUS a toast PLUS
 * a Sentry event on EVERY route change — no session-level memo. This module
 * is the shared, cross-instance cooldown: once ANY AuthGuard instance
 * reports a capability failure, every instance (including ones that mount
 * AFTER the fact, e.g. on the next navigation) sees the cooldown as active
 * for a bounded window and skips re-attempting the failing operation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armMfaCapabilityCooldown,
  isMfaCapabilityCooldownActive,
  __resetMfaCapabilityCooldownForTests,
} from './mfaCapabilityCooldown';

// sessionStorage works natively in this test environment (unlike
// localStorage — see mfaPolicy.ts's module doc comment / agents.md).
describe('mfaCapabilityCooldown', () => {
  beforeEach(() => {
    __resetMfaCapabilityCooldownForTests();
  });

  afterEach(() => {
    __resetMfaCapabilityCooldownForTests();
    vi.useRealTimers();
  });

  it('is inactive before anything arms it', () => {
    expect(isMfaCapabilityCooldownActive()).toBe(false);
  });

  it('becomes active immediately after arming', () => {
    armMfaCapabilityCooldown();
    expect(isMfaCapabilityCooldownActive()).toBe(true);
  });

  it('reports alreadyArmed=false on the FIRST arm and true on subsequent arms within the window', () => {
    const first = armMfaCapabilityCooldown();
    expect(first.alreadyArmed).toBe(false);

    const second = armMfaCapabilityCooldown();
    expect(second.alreadyArmed).toBe(true);
  });

  it('expires after the 5-minute window and re-arms cleanly', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    armMfaCapabilityCooldown(t0);

    expect(isMfaCapabilityCooldownActive(t0 + 4 * 60_000)).toBe(true);
    expect(isMfaCapabilityCooldownActive(t0 + 5 * 60_000 + 1)).toBe(false);

    // Re-arming after expiry reports a fresh (not "already armed") window.
    const rearm = armMfaCapabilityCooldown(t0 + 5 * 60_000 + 1);
    expect(rearm.alreadyArmed).toBe(false);
  });

  it('persists across a fresh in-memory state (simulated reload) via the sessionStorage mirror', () => {
    const t0 = Date.now();
    armMfaCapabilityCooldown(t0);

    // Simulate a full page reload: module state resets, sessionStorage does not.
    __resetMfaCapabilityCooldownForTests({ keepSessionStorage: true });

    expect(isMfaCapabilityCooldownActive(t0 + 60_000)).toBe(true);
  });

  it('sessionStorage access is wrapped in try/catch — a throwing getItem/setItem never crashes', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(() => isMfaCapabilityCooldownActive()).not.toThrow();
    expect(() => armMfaCapabilityCooldown()).not.toThrow();

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
  });
});
