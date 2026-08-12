/**
 * keys.ts response-sanitizer contract.
 *
 * SCRUM-1271-D established this file to pin that internal-actor UUIDs and the
 * secret hash never reach customer-facing payloads.
 *
 * FD-P7 / BUG-2026-08-12 amends the contract in two ways:
 *
 *  1. `id` is KEPT. The PATCH/DELETE routes address a key by `:keyId`
 *     (= `api_keys.id`), so a response without `id` leaves an org admin with no
 *     way to name the key they want revoked. Stripping it made the CC6.8
 *     key-lifecycle control unreachable by customers. `org_id` (tenant id) and
 *     `key_hash` (the secret) remain stripped — those were the real leaks.
 *
 *  2. The tests now exercise the REAL `toPublicKey` exported from keys.ts.
 *     The previous version re-implemented the sanitizer locally and asserted
 *     against its own copy, so it could not fail when keys.ts drifted — which
 *     is precisely how the id-stripping regression reached production
 *     unnoticed. A verification has to outrank the claim it is verifying.
 */

import { describe, it, expect, vi } from 'vitest';

// keys.ts -> utils/db.js -> config.ts, which throws without worker env vars.
// Importing the real sanitizer is the point of this file, so stub the chain
// the same way keys.test.ts does rather than re-implementing the function.
vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { toPublicKey } from './keys.js';

describe('keys.ts public shape (SCRUM-1271-D, amended by FD-P7)', () => {
  const fullRow = {
    id: 'api-key-uuid-1',
    org_id: 'org-uuid-internal',
    key_hash: 'TEST_HASH_NOT_REAL_REDACTED',
    key_prefix: 'TEST_PREFIX_FAKE',
    name: 'Production API key',
    scopes: ['verify', 'verify:batch'],
    rate_limit_tier: 'paid',
    is_active: true,
    created_at: '2026-04-27T00:00:00Z',
    expires_at: null,
    last_used_at: '2026-04-27T09:00:00Z',
    revoked_at: null,
  };

  it('strips org_id and key_hash from outbound responses', () => {
    const out = toPublicKey(fullRow);
    expect(out).not.toHaveProperty('org_id');
    expect(out).not.toHaveProperty('key_hash');
  });

  it('FD-P7: keeps id — it is the handle the revoke route addresses', () => {
    const out = toPublicKey(fullRow);
    expect(out.id).toBe('api-key-uuid-1');
  });

  it('preserves key_prefix as the human-readable identifier', () => {
    const out = toPublicKey(fullRow);
    expect(out.key_prefix).toBe('TEST_PREFIX_FAKE');
  });

  it('preserves all non-secret fields (scopes, name, dates, status)', () => {
    const out = toPublicKey(fullRow);
    expect(out.name).toBe('Production API key');
    expect(out.scopes).toEqual(['verify', 'verify:batch']);
    expect(out.rate_limit_tier).toBe('paid');
    expect(out.is_active).toBe(true);
    expect(out.created_at).toBe('2026-04-27T00:00:00Z');
    expect(out.last_used_at).toBe('2026-04-27T09:00:00Z');
    expect(out.revoked_at).toBeNull();
  });

  it('does not mutate the input row', () => {
    const before = { ...fullRow };
    toPublicKey(fullRow);
    expect(fullRow).toEqual(before);
  });

  it('JSON.stringify never contains the tenant id or the secret hash', () => {
    const serialized = JSON.stringify(toPublicKey(fullRow));
    expect(serialized).not.toContain('org-uuid-internal');
    expect(serialized).not.toContain('TEST_HASH_NOT_REAL_REDACTED');
  });

  it('returns an empty object for a null/undefined row', () => {
    expect(toPublicKey(null)).toEqual({});
    expect(toPublicKey(undefined)).toEqual({});
  });
});
