/**
 * MFA capability-unavailable cooldown — SCRUM-3167 (PR #2637 review; items
 * 5/D1, 24; round 2 R17).
 *
 * ROOT CAUSE (D1, confirmed by the verifier): `AuthGuard`'s one-shot toast +
 * Sentry emission guard was a `useRef` — PER `AuthGuard` INSTANCE. Every one
 * of the ~52 routes in `App.tsx` mounts its own `AuthGuard`, so during an
 * MFA-platform outage a required-role admin who keeps navigating gets a
 * FRESH `enroll()` attempt, plus a toast, plus a Sentry event, on EVERY
 * route change — the exact opposite of "one-shot."
 *
 * FIX: a cooldown that lives ABOVE any single `AuthGuard` instance — a
 * module-level in-memory timestamp (covers the common case: an SPA
 * navigation does not reload the JS module) mirrored into `sessionStorage`
 * (covers a full page reload, which resets module state but not
 * `sessionStorage`).
 *
 * R17 (CONFIRMED bypass, round 2): the cooldown used to be a single GLOBAL
 * key. On a shared browser, `useAuth.signOut()`'s hard redirect left the
 * cooldown standing, so the NEXT user to sign in inherited it and was
 * seeded fail-open at `AuthGuard` mount — before `MfaChallenge` (the
 * every-login challenge for a user WHO HAS a verified factor) ever
 * mounted. Two independent fixes close this:
 *   (a) every key here — in-memory and sessionStorage — is now keyed by
 *       `userId`, so arming it for one user can never activate it for a
 *       different user (see `clearMfaCapabilityCooldown` for explicit
 *       cleanup too, called from `useAuth.signOut()` and on a user
 *       change in `AuthGuard`).
 *   (b) — enforced in `AuthGuard.tsx`, not here — this cooldown is
 *       consulted ONLY on the ENROLLMENT branch (`!hasVerifiedFactor &&
 *       mfaRequired`). The CHALLENGE branch (`mfaStatus ===
 *       'challenge_required'`) is checked FIRST in the decision order and
 *       never looks at this module at all — a verified-factor user is
 *       ALWAYS challenged, cooldown or not. This module has no concept of
 *       "which path" — it is a pure per-user timestamp store — so that
 *       half of the fix is a property of the CALLER, verified in
 *       `AuthGuard.mfaGate.test.tsx`.
 *
 * While the cooldown is active for a user on the enrollment branch,
 * `AuthGuard` renders `children` directly WITHOUT ever mounting
 * `MfaEnrollmentRequired` — so `enroll()` is not re-attempted within the
 * window, not just "the toast is suppressed." The window expires on its
 * own; the next `AuthGuard` render (or the periodic live-re-evaluation
 * every existing MFA hook already does) naturally re-arms once it passes,
 * per `isMfaCapabilityCooldownActive`'s live time check.
 */

import { readItem, writeItem, removeItem } from './safeStorage';

const COOLDOWN_MS = 5 * 60 * 1000;
const STORAGE_KEY_PREFIX = 'arkova_mfa_capability_unavailable_until:';

/** In-memory primary for ONE user at a time — survives SPA navigation (no module reload), lost on a full page reload or a user switch. */
let moduleUserId: string | null = null;
let moduleUntil = 0;

function storageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

function readStoredUntil(userId: string): number {
  const raw = readItem(sessionStorage, storageKey(userId));
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Is the cooldown currently active FOR THIS USER? Reads the later of the in-memory (only if it belongs to this userId) and sessionStorage-persisted deadlines. */
export function isMfaCapabilityCooldownActive(userId: string, now: number = Date.now()): boolean {
  if (!userId) return false;
  const inMemory = moduleUserId === userId ? moduleUntil : 0;
  const until = Math.max(inMemory, readStoredUntil(userId));
  return now < until;
}

/**
 * Arm (or extend) the cooldown for `userId` for `COOLDOWN_MS` from `now`.
 * Returns whether the cooldown was ALREADY active for this user before this
 * call — the caller uses this to decide whether to fire the one-shot
 * toast/Sentry emission (only on the transition into the cooldown, never
 * on a repeat trip while it's already active).
 */
export function armMfaCapabilityCooldown(userId: string, now: number = Date.now()): { alreadyArmed: boolean } {
  if (!userId) return { alreadyArmed: false };

  const alreadyArmed = isMfaCapabilityCooldownActive(userId, now);
  const until = now + COOLDOWN_MS;
  const priorModuleUntil = moduleUserId === userId ? moduleUntil : 0;
  moduleUserId = userId;
  moduleUntil = Math.max(priorModuleUntil, until);
  writeItem(sessionStorage, storageKey(userId), String(moduleUntil));
  return { alreadyArmed };
}

/**
 * Clear the cooldown for `userId` — both the in-memory value (only if it
 * currently belongs to this user) and the sessionStorage mirror. Called
 * from `useAuth.signOut()` before its hard redirect (R17(c): a signed-out
 * user's cooldown must never seed the next login on a shared browser) and
 * from `AuthGuard` when the authenticated `userId` changes without a
 * formal sign-out.
 */
export function clearMfaCapabilityCooldown(userId: string | null | undefined): void {
  if (!userId) return;
  if (moduleUserId === userId) {
    moduleUserId = null;
    moduleUntil = 0;
  }
  removeItem(sessionStorage, storageKey(userId));
}

/**
 * Test-only reset. `keepSessionStorage` simulates a full page reload
 * (module state resets, `sessionStorage` does not) instead of a clean slate.
 * Only clears the in-memory value here — sessionStorage entries are
 * per-key already, so tests that need a truly clean slate across users
 * should call `clearMfaCapabilityCooldown` per user id instead.
 */
export function __resetMfaCapabilityCooldownForTests(options: { keepSessionStorage?: boolean } = {}): void {
  const priorUserId = moduleUserId;
  moduleUserId = null;
  moduleUntil = 0;
  if (!options.keepSessionStorage && priorUserId) {
    removeItem(sessionStorage, storageKey(priorUserId));
  }
  // Best-effort: also sweep any OTHER per-user keys a test may have armed
  // directly (e.g. a second user in the same test) so test files stay
  // isolated from each other without needing to track every userId used.
  if (!options.keepSessionStorage) {
    try {
      const staleKeys: string[] = [];
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(STORAGE_KEY_PREFIX)) staleKeys.push(key);
      }
      staleKeys.forEach((key) => removeItem(sessionStorage, key));
    } catch {
      // ignore — sessionStorage enumeration can throw in the same
      // restricted environments the try/catch guards elsewhere handle
    }
  }
}
