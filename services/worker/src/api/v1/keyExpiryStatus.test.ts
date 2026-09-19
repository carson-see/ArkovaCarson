/**
 * SCRUM-5023 — server-derived API-key expiry status.
 *
 * Prod facts this suite encodes (read-only query 2026-09-12): `api_keys` held
 * 19 rows, 13 of them `is_active = true` with `expires_at` already in the past.
 * The list route returned those raw columns and every consumer — dashboard,
 * partner, SDK — had to re-derive "is this key usable?" from them. Two partners
 * derived it differently from the worker middleware, which has rejected expired
 * keys all along (`api_key_expired`). One derivation has to be authoritative,
 * and it has to be the server's.
 *
 * The derivation lives here, alone and pure, because THREE callers need the
 * identical answer: GET /api/v1/keys, the daily expiry-notice cron, and the
 * dashboard badge (via the field the list route now returns). A second copy is
 * how the dashboard and the middleware disagreed in the first place.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveKeyStatus,
  expiresInDays,
  EXPIRING_SOON_WINDOW_DAYS,
  MAX_EXPIRES_IN_DAYS,
  type ApiKeyExpiryFields,
} from './keyExpiryStatus.js';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function at(offsetDays: number): string {
  return new Date(NOW.getTime() + offsetDays * DAY_MS).toISOString();
}

function key(fields: Partial<ApiKeyExpiryFields>): ApiKeyExpiryFields {
  return { is_active: true, revoked_at: null, expires_at: null, ...fields };
}

describe('deriveKeyStatus', () => {
  it('reports active for a live key with no expiry', () => {
    expect(deriveKeyStatus(key({ expires_at: null }), NOW)).toBe('active');
  });

  it('reports active for a key expiring beyond the expiring-soon window', () => {
    expect(deriveKeyStatus(key({ expires_at: at(EXPIRING_SOON_WINDOW_DAYS + 1) }), NOW)).toBe('active');
  });

  it('reports expiring_soon inside the window', () => {
    expect(deriveKeyStatus(key({ expires_at: at(3) }), NOW)).toBe('expiring_soon');
  });

  it('treats the window edge as expiring_soon (inclusive)', () => {
    expect(deriveKeyStatus(key({ expires_at: at(EXPIRING_SOON_WINDOW_DAYS) }), NOW)).toBe('expiring_soon');
  });

  it('reports expired once expires_at is in the past', () => {
    expect(deriveKeyStatus(key({ expires_at: at(-1) }), NOW)).toBe('expired');
  });

  it('reports expired for the HakiChain shape — is_active true, expiry long past', () => {
    // Created 2026-06-01 with a 30-day expiry; expired 2026-07-01; row still
    // carries is_active = true. The raw columns say "active"; the truth is not.
    const hakichain = key({ is_active: true, expires_at: '2026-07-01T00:00:00.000Z' });
    expect(hakichain.is_active).toBe(true);
    expect(deriveKeyStatus(hakichain, NOW)).toBe('expired');
  });

  it('reports revoked when revoked_at is stamped, even if the expiry is fine', () => {
    expect(deriveKeyStatus(key({ revoked_at: at(-2), expires_at: at(100) }), NOW)).toBe('revoked');
  });

  it('reports revoked when is_active is false and no stamp exists (pre-FD-P7 rows)', () => {
    expect(deriveKeyStatus(key({ is_active: false, revoked_at: null }), NOW)).toBe('revoked');
  });

  it('prefers revoked over expired — a revoke is a deliberate act, expiry is a lapse', () => {
    // Both are true of this row. The admin who revoked it needs to see that
    // their action stuck; "expired" would read as if it lapsed on its own.
    expect(deriveKeyStatus(key({ revoked_at: at(-5), expires_at: at(-1) }), NOW)).toBe('revoked');
  });

  it('treats a born-expired row (expiry before creation) as expired, not active', () => {
    // Prod holds one such row. Whatever wrote it, the read path must not
    // report it usable.
    expect(deriveKeyStatus(key({ expires_at: '2020-01-01T00:00:00.000Z' }), NOW)).toBe('expired');
  });

  it('is not fooled by an unparseable expires_at — fails closed to expired', () => {
    expect(deriveKeyStatus(key({ expires_at: 'not-a-date' }), NOW)).toBe('expired');
  });
});

describe('expiresInDays', () => {
  it('is null when the key never expires', () => {
    expect(expiresInDays(null, NOW)).toBeNull();
  });

  it('counts whole days remaining', () => {
    expect(expiresInDays(at(7), NOW)).toBe(7);
  });

  it('reports 0 on the last partial day rather than rounding up to 1', () => {
    expect(expiresInDays(new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toISOString(), NOW)).toBe(0);
  });

  it('goes negative once expired, counting days since', () => {
    expect(expiresInDays(at(-3), NOW)).toBe(-3);
  });

  it('is null for an unparseable timestamp rather than NaN', () => {
    expect(expiresInDays('not-a-date', NOW)).toBeNull();
  });
});

describe('expiry bounds', () => {
  it('caps requested expiry at 10 years', () => {
    expect(MAX_EXPIRES_IN_DAYS).toBe(3650);
  });

  it('warns two weeks ahead', () => {
    expect(EXPIRING_SOON_WINDOW_DAYS).toBe(14);
  });
});
