/**
 * MFA capability-unavailable cooldown — SCRUM-3167 review batch (items
 * 5/D1, 24).
 *
 * ROOT CAUSE (D1, confirmed by the verifier): `AuthGuard`'s one-shot toast +
 * Sentry emission guard was a `useRef` — PER `AuthGuard` INSTANCE. Every one
 * of the ~52 routes in `App.tsx` mounts its own `AuthGuard`, so during an
 * MFA-platform outage a required-role admin who keeps navigating gets a
 * FRESH `enroll()`/`challenge()` attempt, plus a toast, plus a Sentry event,
 * on EVERY route change — the exact opposite of "one-shot."
 *
 * FIX: a cooldown that lives ABOVE any single `AuthGuard` instance — a
 * module-level in-memory timestamp (covers the common case: an SPA
 * navigation does not reload the JS module) mirrored into `sessionStorage`
 * (covers a full page reload, which resets module state but not
 * `sessionStorage`). While the cooldown is active, `AuthGuard` renders
 * `children` directly WITHOUT ever mounting `MfaChallenge`/
 * `MfaEnrollmentRequired` — so `enroll()`/`challenge()` are not re-attempted
 * within the window, not just "the toast is suppressed." The window expires
 * on its own; the next `AuthGuard` mount (or the periodic live-re-evaluation
 * re-render every existing MFA hook already does) naturally re-arms once it
 * passes, per `isMfaCapabilityCooldownActive`'s live time check.
 */

const COOLDOWN_MS = 5 * 60 * 1000;
const STORAGE_KEY = 'arkova_mfa_capability_unavailable_until';

/** In-memory primary — survives SPA navigation (no module reload), lost on a full page reload. */
let moduleUntil = 0;

function readStoredUntil(): number {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeStoredUntil(until: number): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, String(until));
  } catch {
    // Storage unavailable — the in-memory value still gates THIS module's
    // lifetime (i.e. until the next full reload), which is the common case.
  }
}

/** Is the cooldown currently active? Reads the later of the in-memory and sessionStorage-persisted deadlines. */
export function isMfaCapabilityCooldownActive(now: number = Date.now()): boolean {
  const until = Math.max(moduleUntil, readStoredUntil());
  return now < until;
}

/**
 * Arm (or extend) the cooldown for `COOLDOWN_MS` from `now`. Returns whether
 * the cooldown was ALREADY active before this call — the caller uses this to
 * decide whether to fire the one-shot toast/Sentry emission (only on the
 * transition into the cooldown, never on a repeat trip while it's already
 * active).
 */
export function armMfaCapabilityCooldown(now: number = Date.now()): { alreadyArmed: boolean } {
  const alreadyArmed = isMfaCapabilityCooldownActive(now);
  const until = now + COOLDOWN_MS;
  moduleUntil = Math.max(moduleUntil, until);
  writeStoredUntil(moduleUntil);
  return { alreadyArmed };
}

/**
 * Test-only reset. `keepSessionStorage` simulates a full page reload
 * (module state resets, `sessionStorage` does not) instead of a clean slate.
 */
export function __resetMfaCapabilityCooldownForTests(options: { keepSessionStorage?: boolean } = {}): void {
  moduleUntil = 0;
  if (!options.keepSessionStorage) {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
