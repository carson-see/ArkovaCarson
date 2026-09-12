/**
 * SCRUM-5023 — the ONE authoritative derivation of an API key's usability.
 *
 * `api_keys` stores three independent columns (`is_active`, `revoked_at`,
 * `expires_at`) and every consumer used to combine them itself. They combined
 * them differently: `middleware/apiKeyAuth.ts` has refused expired keys since
 * it was written (`api_key_expired`), while GET /api/v1/keys handed back the
 * raw columns and left the caller to guess. A partner reading `is_active` —
 * the obvious field, and `true` on 13 of the 19 prod rows whose `expires_at`
 * had already passed — concluded their key was fine right up until it 401'd.
 *
 * So the server answers the question now, in one place, and both the list
 * route and the expiry-notice cron read the answer from here. Add a caller
 * before you add a second derivation.
 *
 * §1.8: `status` and `expires_in_days` are ADDITIVE nullable fields on the
 * frozen v1 contract. The raw columns stay, byte-unchanged — a client that
 * reads `is_active` keeps seeing exactly what it saw.
 */

/** Days out at which an active key starts warning. */
export const EXPIRING_SOON_WINDOW_DAYS = 14;

/**
 * Upper bound on a requested expiry (10 years). Not a security boundary —
 * a bound that keeps a fat-fingered `expires_in_days: 36500000` from writing
 * a timestamp Postgres cannot represent, and keeps "expires" meaningful.
 */
export const MAX_EXPIRES_IN_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The subset of an `api_keys` row this derivation reads. */
export interface ApiKeyExpiryFields {
  is_active: boolean;
  revoked_at?: string | null;
  expires_at?: string | null;
}

/**
 * Server-derived key status.
 *
 * - `revoked`      — deliberately withdrawn (or a pre-FD-P7 row with only
 *                    `is_active = false`). Terminal.
 * - `expired`      — `expires_at` has passed. Auth refuses it.
 * - `expiring_soon`— live, but inside EXPIRING_SOON_WINDOW_DAYS.
 * - `active`       — live, with no expiry or one comfortably ahead.
 */
export type ApiKeyStatus = 'active' | 'expiring_soon' | 'expired' | 'revoked';

function msUntilExpiry(expiresAt: string | null | undefined, now: Date): number | null {
  if (!expiresAt) return null;
  const parsed = new Date(expiresAt).getTime();
  if (Number.isNaN(parsed)) return null;
  return parsed - now.getTime();
}

/**
 * Derive the status of a key row.
 *
 * REVOKED OUTRANKS EXPIRED when a row is both. The admin who revoked a key
 * needs to see that their action stuck; showing "expired" would read as if the
 * key had lapsed on its own, and would invite them to "just extend it" on a
 * key that revocation made permanently unusable (see the 409 in keys.ts).
 *
 * An UNPARSEABLE `expires_at` fails CLOSED to `expired`. A corrupt timestamp
 * is not evidence that a key is safe to keep using, and `new Date('x') < now`
 * is `false` — the naive comparison would report such a row `active`.
 */
export function deriveKeyStatus(row: ApiKeyExpiryFields, now: Date = new Date()): ApiKeyStatus {
  if (row.revoked_at || row.is_active === false) return 'revoked';

  if (row.expires_at) {
    const remaining = msUntilExpiry(row.expires_at, now);
    if (remaining === null) return 'expired'; // unparseable → fail closed
    if (remaining <= 0) return 'expired';
    if (remaining <= EXPIRING_SOON_WINDOW_DAYS * DAY_MS) return 'expiring_soon';
  }

  return 'active';
}

/**
 * Whole days until expiry: positive ahead, `0` on the final partial day,
 * negative once past. `null` when the key never expires or the stored
 * timestamp cannot be parsed (never `NaN` — that would serialize to `null`
 * in JSON anyway, but by accident rather than by contract).
 *
 * FLOOR, not ceil: six hours of life left is not "1 day", and a caller
 * rendering "expires in 1 day" for a key that dies this afternoon is exactly
 * the false reassurance this story exists to remove.
 */
export function expiresInDays(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): number | null {
  const remaining = msUntilExpiry(expiresAt, now);
  if (remaining === null) return null;
  return Math.floor(remaining / DAY_MS);
}

/**
 * The additive §1.8 fields for one key row, ready to spread onto a response.
 */
export function keyExpiryFields(
  row: ApiKeyExpiryFields,
  now: Date = new Date(),
): { status: ApiKeyStatus; expires_in_days: number | null } {
  return {
    status: deriveKeyStatus(row, now),
    expires_in_days: expiresInDays(row.expires_at, now),
  };
}
