/**
 * Referral capture (SCRUM-5024).
 *
 * A partner shares `https://app.arkova.ai/signup?ref=ABCD2345`. The visitor may
 * not sign up in that page load at all — the common path is that they request a
 * magic link or confirm an email, and the browser comes back to a URL with no
 * `?ref` on it. So the code is captured ONCE, at module scope, before any router
 * or telemetry runs (same placement as `oauthConfirmation.ts`), and parked in
 * `localStorage` until an organization actually exists to attribute.
 *
 * ACCEPTED LOSS, stated rather than hidden: `localStorage` is per-origin AND
 * per-device. If the visitor opens the emailed confirmation on their phone after
 * clicking the partner link on a laptop, the code is not there and the signup is
 * recorded as unreferred. `sessionStorage` would lose it far more often (a new
 * tab is enough), and a server-side cookie is a bigger privacy surface than a
 * referral code justifies. There is no recovery path for a device change; the
 * partner re-sends the link or the attribution is added by hand.
 *
 * The captured value is a public, shareable string — not a credential. It is
 * still scrubbed from the address bar (`history.replaceState`) so it does not
 * ride along into bookmarks, shared URLs, or the Referer header of the next
 * navigation.
 */

import { readItem, writeItem, removeItem } from './safeStorage';

export const REFERRAL_STORAGE_KEY = 'arkova.referral';

/** 30 days. Long enough for a partner conference and a delayed signup; short
 *  enough that a code parked a year ago does not silently attribute an
 *  unrelated organization. */
export const REFERRAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The format authority is the database: `referral_codes_code_format`
 *
 *   CHECK (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$')
 *
 * This regex is the same class. It is deliberately the explicit alphabet and
 * not `[A-Z2-9]` — `[A-Z2-9]` would admit I, L and O, which the constraint
 * rejects, so a captured code could pass here and then be a guaranteed
 * `unknown_code` at the RPC.
 */
export const REFERRAL_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

interface StoredReferral {
  code: string;
  capturedAt: number;
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Normalises then validates. Returns null for anything the DB CHECK would
 *  reject, so an invalid code is never parked and never reaches the RPC. */
export function normalizeReferralCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toUpperCase();
  return REFERRAL_CODE_RE.test(normalized) ? normalized : null;
}

/**
 * Reads `?ref=` from the current URL, parks a valid code, and strips the
 * parameter from the address bar. Returns the captured code, or null when
 * there was nothing valid to capture.
 *
 * Idempotent-by-overwrite: a second partner link replaces the first. Last link
 * clicked wins, which matches what the visitor just did. The DB still enforces
 * first-attribution-wins once an organization exists.
 */
export function captureReferralCodeFromUrl(): string | null {
  if (typeof window === 'undefined') return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
  if (!params.has('ref')) return null;

  const code = normalizeReferralCode(params.get('ref'));

  // Strip the parameter whether or not it was valid — a malformed `?ref` is
  // still noise we do not want propagating into bookmarks or Referer.
  params.delete('ref');
  const query = params.toString();
  try {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (query ? `?${query}` : '') + window.location.hash,
    );
  } catch {
    // A sandboxed frame can refuse replaceState. The capture below is still
    // correct; only the address-bar cleanup is lost.
  }

  if (!code) return null;

  const store = storage();
  if (store) {
    writeItem(store, REFERRAL_STORAGE_KEY, JSON.stringify({ code, capturedAt: Date.now() }));
  }
  return code;
}

/**
 * Returns the parked code when one is present and unexpired, else null.
 * A malformed or expired entry is removed on read rather than left to be
 * re-parsed on every page load.
 *
 * `now` is a parameter so the caller samples the clock at the decision point
 * (one clock per decision) instead of this module capturing a module-scope
 * timestamp that would be wrong for the whole session.
 */
export function readReferralCode(now: number = Date.now()): string | null {
  const store = storage();
  if (!store) return null;

  const raw = readItem(store, REFERRAL_STORAGE_KEY);
  if (raw === null) return null;

  let parsed: StoredReferral;
  try {
    parsed = JSON.parse(raw) as StoredReferral;
  } catch {
    removeItem(store, REFERRAL_STORAGE_KEY);
    return null;
  }

  const code = normalizeReferralCode(parsed?.code);
  const capturedAt = typeof parsed?.capturedAt === 'number' ? parsed.capturedAt : null;
  if (!code || capturedAt === null || !Number.isFinite(capturedAt)) {
    removeItem(store, REFERRAL_STORAGE_KEY);
    return null;
  }

  if (now - capturedAt > REFERRAL_TTL_MS) {
    removeItem(store, REFERRAL_STORAGE_KEY);
    return null;
  }

  return code;
}

/** Clears the parked code. Called after an attribution attempt has reached the
 *  database and produced a verdict — including a rejected one, because
 *  retrying a code the database has already refused cannot start succeeding. */
export function clearReferralCode(): void {
  const store = storage();
  if (store) removeItem(store, REFERRAL_STORAGE_KEY);
}

// Module-scope capture. Importing this module from `main.tsx` is what runs it,
// before React renders and before the router reads the URL.
captureReferralCodeFromUrl();
