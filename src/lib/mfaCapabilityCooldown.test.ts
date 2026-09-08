/**
 * mfaCapabilityCooldown tests — SCRUM-3167 (PR #2637 review; round 2 R17).
 *
 * R17 (CONFIRMED bypass): the cooldown used to be a single GLOBAL
 * sessionStorage key that survived `useAuth.signOut()`'s hard redirect —
 * on a shared browser, the NEXT user to sign in inherited the cooldown and
 * was seeded fail-open at `AuthGuard` mount. It is now keyed by userId
 * (both the module-level in-memory value and the sessionStorage mirror),
 * and this file pins the cross-user isolation directly. The companion
 * "never applies to the challenge path" half of R17 is enforced in
 * `AuthGuard.tsx` (this module has no concept of "path" — it is a pure
 * per-user timestamp store) and pinned in `AuthGuard.mfaGate.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armMfaCapabilityCooldown,
  isMfaCapabilityCooldownActive,
  clearMfaCapabilityCooldown,
  __resetMfaCapabilityCooldownForTests,
} from './mfaCapabilityCooldown';

const USER_A = 'user-a';
const USER_B = 'user-b';

describe('mfaCapabilityCooldown', () => {
  beforeEach(() => {
    __resetMfaCapabilityCooldownForTests();
  });

  afterEach(() => {
    __resetMfaCapabilityCooldownForTests();
    vi.useRealTimers();
  });

  it('is inactive before anything arms it', () => {
    expect(isMfaCapabilityCooldownActive(USER_A)).toBe(false);
  });

  it('becomes active for that user immediately after arming', () => {
    armMfaCapabilityCooldown(USER_A);
    expect(isMfaCapabilityCooldownActive(USER_A)).toBe(true);
  });

  it('R17: is CROSS-USER ISOLATED — arming for user A never activates the cooldown for user B', () => {
    armMfaCapabilityCooldown(USER_A);
    expect(isMfaCapabilityCooldownActive(USER_A)).toBe(true);
    expect(isMfaCapabilityCooldownActive(USER_B)).toBe(false);
  });

  it('reports alreadyArmed=false on the FIRST arm and true on subsequent arms for the SAME user within the window', () => {
    const first = armMfaCapabilityCooldown(USER_A);
    expect(first.alreadyArmed).toBe(false);

    const second = armMfaCapabilityCooldown(USER_A);
    expect(second.alreadyArmed).toBe(true);
  });

  it('arming for a different user does not count as "already armed" for the first user', () => {
    armMfaCapabilityCooldown(USER_A);
    const forB = armMfaCapabilityCooldown(USER_B);
    expect(forB.alreadyArmed).toBe(false);
  });

  it('expires after the 5-minute window and re-arms cleanly', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    armMfaCapabilityCooldown(USER_A, t0);

    expect(isMfaCapabilityCooldownActive(USER_A, t0 + 4 * 60_000)).toBe(true);
    expect(isMfaCapabilityCooldownActive(USER_A, t0 + 5 * 60_000 + 1)).toBe(false);

    const rearm = armMfaCapabilityCooldown(USER_A, t0 + 5 * 60_000 + 1);
    expect(rearm.alreadyArmed).toBe(false);
  });

  it('persists across a fresh in-memory state (simulated reload) via the per-user sessionStorage mirror', () => {
    const t0 = Date.now();
    armMfaCapabilityCooldown(USER_A, t0);

    __resetMfaCapabilityCooldownForTests({ keepSessionStorage: true });

    expect(isMfaCapabilityCooldownActive(USER_A, t0 + 60_000)).toBe(true);
  });

  it('R17(c): clearMfaCapabilityCooldown removes ONLY the named user\'s entry (module + sessionStorage)', () => {
    armMfaCapabilityCooldown(USER_A);
    armMfaCapabilityCooldown(USER_B);

    clearMfaCapabilityCooldown(USER_A);

    expect(isMfaCapabilityCooldownActive(USER_A)).toBe(false);
    expect(isMfaCapabilityCooldownActive(USER_B)).toBe(true);
  });

  it('R17: clearing survives a simulated reload too (sessionStorage entry actually removed, not just the in-memory value)', () => {
    armMfaCapabilityCooldown(USER_A);
    clearMfaCapabilityCooldown(USER_A);

    // Simulate a reload: in-memory state resets regardless, so this proves
    // the sessionStorage-backed entry was really deleted, not just shadowed.
    __resetMfaCapabilityCooldownForTests({ keepSessionStorage: true });
    expect(isMfaCapabilityCooldownActive(USER_A)).toBe(false);
  });

  it('treats an empty/falsy userId as never active (no global fallback)', () => {
    expect(isMfaCapabilityCooldownActive('')).toBe(false);
    expect(() => armMfaCapabilityCooldown('')).not.toThrow();
  });

  it('sessionStorage access is wrapped in try/catch — a throwing getItem/setItem never crashes', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    expect(() => isMfaCapabilityCooldownActive(USER_A)).not.toThrow();
    expect(() => armMfaCapabilityCooldown(USER_A)).not.toThrow();
    expect(() => clearMfaCapabilityCooldown(USER_A)).not.toThrow();

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
    removeItemSpy.mockRestore();
  });
});
