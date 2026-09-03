/**
 * MFA Session Assurance Gate — pre-pentest hardening.
 *
 * Root cause: `supabase.auth.signInWithPassword()` returns a session at
 * Authenticator Assurance Level `aal1` even when the signing-in user has a
 * verified TOTP factor enrolled. Supabase requires an explicit
 * `mfa.challenge()` + `mfa.verify()` round trip to raise the session to
 * `aal2`. Before this hook, nothing in the app ever called
 * `getAuthenticatorAssuranceLevel()`, so a password alone granted full
 * access to any route — an enrolled user's MFA factor was decorative.
 *
 * This hook is consumed by `AuthGuard` (the single choke point every
 * authenticated route renders through) to decide whether the current
 * session still needs a challenge before rendering protected content.
 *
 * EVERY-LOGIN ENFORCEMENT (verified against @supabase/auth-js source,
 * GoTrueClient.js `_getAuthenticatorAssuranceLevel`): `currentLevel` is
 * decoded from the `aal` claim of WHATEVER JWT the current session holds —
 * a stateless, per-session read. Supabase has no "remember this device" or
 * "skip MFA if recently verified" mechanism; a brand new
 * `signInWithPassword()` call always yields a brand new session whose JWT
 * carries `aal1` (password alone cannot mint `aal2` — that would defeat the
 * concept). This hook holds NO persisted "already verified" flag anywhere
 * (no localStorage/sessionStorage/module-level cache) — `markVerified()`
 * only ever sets local `useState` for THIS mounted instance, which is
 * destroyed and recreated on every route navigation (each `<Route>` in
 * App.tsx wraps its own `<AuthGuard>`) and on every full page reload. The
 * practical effect: a second, independent login by an already-enrolled
 * user is challenged again, every time, by construction — there is no
 * shortcut path to bypass. Session restore (refresh token / page reload)
 * is equally safe in EITHER direction: if Supabase's refresh preserves the
 * session's `aal2` (the documented, intended MFA behavior — elevation
 * persists for the life of the session so users aren't re-prompted every
 * ~1h token refresh), the fresh check on remount correctly reports
 * 'satisfied' with no re-prompt; if it did not, the fresh check would
 * correctly report 'challenge_required' again. Either way this hook never
 * grants 'satisfied' from a stale assumption — only from a live read of
 * the CURRENT session's JWT. See `useMfaAssurance.test.ts` for the tests
 * that pin this (second-login re-challenge, session-restore variants).
 *
 * LIVE RE-EVALUATION (SCRUM-3167, CTO ruling A4-11): beyond the initial
 * per-mount/per-userId check above, this hook also re-runs the SAME check
 * on `visibilitychange` (when the tab returns to foreground) and on a 60s
 * interval while mounted (via the shared `useVisibilityPolling`, with
 * `immediate: false` since the initial-mount effect above already ran the
 * first check — R7, PR #2637 review round 2: this used to be a bespoke
 * `useForegroundInterval` hook, now deleted in favour of reusing the
 * pre-existing, more heavily reviewed polling hook). This catches a
 * session whose factor state changes server-side mid-session
 * (e.g. the user unenrolled their only TOTP factor from another device, or
 * an operator revoked a factor via the break-glass runbook) without
 * requiring a full page reload. Re-checks reuse the exact same fail-open
 * logic as the initial check — they can only ever ADD a challenge for a
 * session that newly needs one, never remove access outside of that same
 * fail-open contract.
 *
 * SAFETY CONTRACT — read before changing this file:
 * Every ambiguous/error/timeout outcome below resolves to `'satisfied'`
 * (i.e. do NOT show a challenge). This hook can therefore only ever ADD
 * friction for users who have a verified MFA factor; it can never be the
 * reason a user with no MFA factor is blocked from signing in. That
 * asymmetry is deliberate: an availability incident that locks out every
 * user (including the ~100% of users who have never enrolled MFA) is a far
 * worse outcome than a rare missed MFA challenge.
 *
 * markVerified() vs markBypassed() (PR #2637 review, item 32): `MfaChallenge`
 * calls `markVerified()` ONLY after a real, successful `challenge()`+
 * `verify()` round trip — it is the one place this hook is told
 * `hasVerifiedFactor` is now truthfully `true`. `markBypassed()` is
 * ENROLLMENT-PATH ONLY as of the R17-R21 CTO ruling (PR #2637 review round
 * 2) — `MfaChallenge` has no fail-open branch left at all (it fails CLOSED
 * on every error; see its own doc comment). The only remaining caller is
 * `AuthGuard`'s enrollment-branch `handleCapabilityUnavailable`, for a user
 * who was already known to have NO verified factor — it clears the
 * challenge (`status` -> `'satisfied'`) WITHOUT asserting anything new
 * about `hasVerifiedFactor`, preserving whatever this hook already knew.
 *
 * MODULE-SCOPE CACHE (R11, PR #2637 review round 2, efficiency): AuthGuard
 * mounts a fresh `useMfaAssurance` instance per `<Route>` (App.tsx), so
 * every in-app navigation previously re-awaited
 * `getAuthenticatorAssuranceLevel()` and flashed the loading spinner even
 * though the underlying session had not changed. The optional second
 * argument, `sessionKey` (the caller's session `access_token` or
 * `expires_at` — anything that changes on every genuinely new sign-in),
 * lets a remount for the SAME `(userId, sessionKey)` pair render
 * synchronously from the last known result instead of re-fetching. Caching
 * is deliberately INERT whenever `sessionKey` is `null`/omitted — every
 * pre-existing call site (all of `useMfaAssurance.test.ts`, which has no
 * concept of a session key) keeps its exact prior behavior, most
 * importantly the EVERY-LOGIN ENFORCEMENT guarantee: two independent
 * `renderHook(() => useMfaAssurance('user-1'))` calls with no session key
 * must never share a cache entry, or a completed challenge from the FIRST
 * login would leak into the second. The 60s/visibility re-check (`check()`
 * below) still runs and refreshes the cache regardless of whether this
 * mount was seeded from it. `markVerified`/`markBypassed` write through to
 * the cache too — otherwise a remount immediately after either would read
 * the STALE pre-change cached value instead of the fresh one. `useAuth.ts`'s
 * `signOut()` also clears the cache outright via
 * `clearMfaAssuranceCache()`, as an explicit belt-and-suspenders measure
 * even though a genuinely new sign-in already mints a new session key on
 * its own.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/async';
import { useVisibilityPolling } from './useVisibilityPolling';

export type MfaAssuranceStatus = 'loading' | 'satisfied' | 'challenge_required';

interface UseMfaAssuranceResult {
  /** Whether the CURRENT session still needs an MFA challenge. */
  status: MfaAssuranceStatus;
  /**
   * Whether the user has a verified MFA factor enrolled at all, independent
   * of whether THIS session has completed the challenge yet. Derived from
   * the same fetch as `status`; does not change when `markVerified()` is
   * called except to confirm `true` (see markVerified below).
   */
  hasVerifiedFactor: boolean;
  /** Call after a successful mfa.challenge()+mfa.verify() round trip. */
  markVerified: () => void;
  /** Call to clear the challenge on the ENROLLMENT path only, WITHOUT asserting a real verify happened — see module doc comment. */
  markBypassed: () => void;
}

interface AssuranceState {
  userId: string | null;
  sessionKey: string | null;
  status: MfaAssuranceStatus;
  hasVerifiedFactor: boolean;
}

const SATISFIED_NO_FACTOR: Omit<AssuranceState, 'userId' | 'sessionKey'> = {
  status: 'satisfied',
  hasVerifiedFactor: false,
};

interface CachedAssurance {
  userId: string;
  sessionKey: string;
  status: MfaAssuranceStatus;
  hasVerifiedFactor: boolean;
}

// R11: a single most-recent-result slot is enough — AuthGuard only ever
// cares about the CURRENT user's CURRENT session, never a history of past
// ones. See the module doc comment above for the "inert when sessionKey is
// null" safety property this relies on.
let moduleCache: CachedAssurance | null = null;

function readModuleCache(userId: string, sessionKey: string | null): CachedAssurance | null {
  if (!sessionKey || !moduleCache) return null;
  if (moduleCache.userId !== userId || moduleCache.sessionKey !== sessionKey) return null;
  return moduleCache;
}

function writeModuleCache(
  userId: string,
  sessionKey: string | null,
  status: MfaAssuranceStatus,
  hasVerifiedFactor: boolean,
): void {
  if (!sessionKey) return;
  moduleCache = { userId, sessionKey, status, hasVerifiedFactor };
}

/** Explicit invalidation hook for `useAuth.ts`'s `signOut()` (R11). */
export function clearMfaAssuranceCache(): void {
  moduleCache = null;
}

export function __resetMfaAssuranceCacheForTests(): void {
  moduleCache = null;
}

// getAuthenticatorAssuranceLevel() is documented as "fairly quick
// (microseconds) and rarely uses the network" when called without a JWT
// argument (the default — it reads the current session). A budget this
// generous is purely a last-resort circuit breaker for a stalled network
// call; it should never fire in normal operation.
const ASSURANCE_CHECK_TIMEOUT_MS = 8_000;

// LIVE RE-EVALUATION cadence (A4-11). Deliberately the same order of
// magnitude as `useVisibilityPolling`'s admin-dashboard polls — cheap
// enough to run continuously, frequent enough that a mid-session factor
// change is caught well within one work session.
const REASSURANCE_INTERVAL_MS = 60_000;

export function useMfaAssurance(
  userId: string | null,
  sessionKey: string | null = null,
): UseMfaAssuranceResult {
  // R11: seed synchronously from the module cache when this exact
  // (userId, sessionKey) pair was already resolved by a PRIOR instance
  // (e.g. the previous route's AuthGuard, just unmounted on navigation) —
  // a remount for the same session then renders immediately instead of
  // flashing the loading spinner while re-awaiting the same answer.
  const [state, setState] = useState<AssuranceState>(() => {
    if (userId) {
      const cached = readModuleCache(userId, sessionKey);
      if (cached) {
        return { userId, sessionKey, status: cached.status, hasVerifiedFactor: cached.hasVerifiedFactor };
      }
    }
    return { userId: null, sessionKey: null, ...SATISFIED_NO_FACTOR };
  });

  // `check()` is called from three places (initial mount / userId change,
  // the 60s interval, and the visibilitychange handler) and must always act
  // on the LATEST userId/sessionKey, not whatever it closed over when it
  // was created. Synced in an effect (never assigned during render —
  // react-hooks/refs) declared BEFORE the userId-change effect further
  // down, so by the time that effect's `check()` call reads the ref on a
  // userId change, it already holds the new value (React runs a
  // component's passive effects in declaration order on the same commit).
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  const sessionKeyRef = useRef(sessionKey);
  useEffect(() => {
    sessionKeyRef.current = sessionKey;
  }, [sessionKey]);

  // Guards against a setState commit after this hook instance has
  // unmounted (a check already in flight when navigation tears down this
  // AuthGuard) — the fetch itself keeps running (fire-and-forget is fine
  // here; there is nothing to cancel network-side), only the resulting
  // setState is suppressed.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const check = useCallback(async () => {
    const checkedUserId = userIdRef.current;
    const checkedSessionKey = sessionKeyRef.current;
    if (!checkedUserId) return;

    try {
      const { data, error } = await withTimeout(
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
        ASSURANCE_CHECK_TIMEOUT_MS,
        'mfa-assurance-check',
      );

      // Stale-response guard: userId/sessionKey moved on (user switch, new
      // sign-in) or this instance unmounted while the call was in flight —
      // never apply a result for a user/session/mount that is no longer
      // current.
      if (
        unmountedRef.current ||
        userIdRef.current !== checkedUserId ||
        sessionKeyRef.current !== checkedSessionKey
      ) {
        return;
      }

      if (error || !data) {
        // Fail OPEN — see module doc comment.
        setState({ userId: checkedUserId, sessionKey: checkedSessionKey, ...SATISFIED_NO_FACTOR });
        writeModuleCache(checkedUserId, checkedSessionKey, 'satisfied', false);
        return;
      }

      const hasVerifiedFactor = data.nextLevel === 'aal2';
      const status: MfaAssuranceStatus =
        data.currentLevel === data.nextLevel ? 'satisfied' : 'challenge_required';
      setState({ userId: checkedUserId, sessionKey: checkedSessionKey, status, hasVerifiedFactor });
      writeModuleCache(checkedUserId, checkedSessionKey, status, hasVerifiedFactor);
    } catch {
      if (
        unmountedRef.current ||
        userIdRef.current !== checkedUserId ||
        sessionKeyRef.current !== checkedSessionKey
      ) {
        return;
      }
      // Timeout or unexpected throw — fail OPEN. See module doc comment.
      setState({ userId: checkedUserId, sessionKey: checkedSessionKey, ...SATISFIED_NO_FACTOR });
      writeModuleCache(checkedUserId, checkedSessionKey, 'satisfied', false);
    }
  }, []);

  // Initial check on mount, and again whenever userId/sessionKey changes
  // (login/logout/user switch/token rotation) — UNLESS this exact mount was
  // already seeded synchronously from the module cache above (R11), in
  // which case a fresh fetch here would defeat the whole point of caching.
  // The 60s/visibility re-check below still runs regardless.
  useEffect(() => {
    if (!userId) {
      // No setState needed: the render-time derivation below already
      // returns 'satisfied' for a null userId regardless of stale `state`
      // (it only trusts `state` when `state.userId === userId`). Calling
      // setState synchronously here would only trigger an extra render for
      // no behavioral benefit (react-hooks/set-state-in-effect).
      return;
    }
    if (readModuleCache(userId, sessionKey)) {
      return;
    }
    void check();
  }, [userId, sessionKey, check]);

  // LIVE RE-EVALUATION (A4-11): re-run the same check on a 60s interval and
  // whenever the tab regains foreground, via the shared hook both MFA
  // policy consumers use. Inherits `check`'s fail-open contract and its
  // stale-response guard — there is no separate "polling" code path.
  useVisibilityPolling(check, REASSURANCE_INTERVAL_MS, { immediate: false, enabled: Boolean(userId) });

  const markVerified = useCallback(() => {
    setState({ userId, sessionKey, status: 'satisfied', hasVerifiedFactor: true });
    // R11: write through so an immediate remount (e.g. the next route)
    // sees the fresh, truthful result instead of the stale pre-verify
    // cache entry.
    if (userId) writeModuleCache(userId, sessionKey, 'satisfied', true);
  }, [userId, sessionKey]);

  const markBypassed = useCallback(() => {
    // Preserves whatever `hasVerifiedFactor` already reflected for THIS
    // userId — a bypass clears the challenge without rewriting the factor
    // truth either way. For a stale/never-resolved userId there is nothing
    // truthful to preserve, so it defaults to `false` (the same fail-open
    // default every other ambiguous outcome in this hook uses).
    setState((prev) => {
      const hasVerifiedFactor = prev.userId === userId ? prev.hasVerifiedFactor : false;
      if (userId) writeModuleCache(userId, sessionKey, 'satisfied', hasVerifiedFactor);
      return { userId, sessionKey, status: 'satisfied', hasVerifiedFactor };
    });
  }, [userId, sessionKey]);

  // `state` only reflects a completed check for `state.userId`/
  // `state.sessionKey`. If either has already moved on (new login / user
  // switch / token rotation) but the effect for the new identity hasn't
  // resolved yet, the committed `state` is stale — report 'loading' rather
  // than whatever the PREVIOUS user/session's result was. Without this, a
  // protected route could flash visible for one render before the real
  // check for the new identity completes.
  if (state.userId !== userId || state.sessionKey !== sessionKey) {
    return {
      status: userId ? 'loading' : 'satisfied',
      hasVerifiedFactor: false,
      markVerified,
      markBypassed,
    };
  }

  return {
    status: state.status,
    hasVerifiedFactor: state.hasVerifiedFactor,
    markVerified,
    markBypassed,
  };
}
