/**
 * keys.ts response sanitizer tests (SCRUM-1271-D, amended by FD-P7).
 *
 * Pin that the secret hash and the org UUID never reach customer-facing
 * payloads — and that the key's own `id` DOES.
 *
 * History: SCRUM-1271-D originally stripped `id` too, intending customers to
 * reference keys by `key_prefix` with by-prefix v2 routes to follow. Those
 * routes never shipped, `key_prefix` carries no unique constraint (only 4
 * visible hex chars of entropy), and the frozen v1 PATCH/DELETE routes are
 * addressed by `:keyId` — so stripping `id` made revocation and deletion
 * unreachable from every client (fullsoak 2026-08 finding FD-P7, a CC6.8
 * control failure). `id` is the row's only unambiguous address on this
 * ORG_ADMIN-scoped surface and is not a secret; it stays.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Pin the REAL exported sanitizer, not a local re-implementation. The
// pre-FD-P7 version of this file re-implemented toPublicKey and asserted
// against its own copy — it could not fail regardless of what keys.ts did,
// which is one of the reasons FD-P7 shipped unnoticed.
import { toPublicKey as publicKeyShape } from './keys.js';

describe('keys.ts public shape (SCRUM-1271-D + FD-P7)', () => {
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
    revocation_reason: null,
  };

  it('strips org_id and key_hash from outbound responses', () => {
    const out = publicKeyShape(fullRow);
    expect(out).not.toHaveProperty('org_id');
    expect(out).not.toHaveProperty('key_hash');
  });

  it('keeps id — the only address the frozen v1 revoke/delete routes accept (FD-P7)', () => {
    const out = publicKeyShape(fullRow);
    expect(out.id).toBe('api-key-uuid-1');
  });

  it('preserves key_prefix as the display identifier', () => {
    const out = publicKeyShape(fullRow);
    expect(out.key_prefix).toBe('TEST_PREFIX_FAKE');
  });

  it('preserves all non-secret fields (scopes, name, dates, status, revocation)', () => {
    const out = publicKeyShape(fullRow);
    expect(out.name).toBe('Production API key');
    expect(out.scopes).toEqual(['verify', 'verify:batch']);
    expect(out.rate_limit_tier).toBe('paid');
    expect(out.is_active).toBe(true);
    expect(out.created_at).toBe('2026-04-27T00:00:00Z');
    expect(out.last_used_at).toBe('2026-04-27T09:00:00Z');
    expect(out).toHaveProperty('revoked_at');
    expect(out).toHaveProperty('revocation_reason');
  });

  it('does not mutate the input row', () => {
    const before = { ...fullRow };
    publicKeyShape(fullRow);
    expect(fullRow).toEqual(before);
  });

  it('JSON.stringify never contains the org UUID or the hash', () => {
    const out = publicKeyShape(fullRow);
    expect(JSON.stringify(out)).not.toContain('org-uuid-internal');
    expect(JSON.stringify(out)).not.toContain('TEST_HASH_NOT_REAL_REDACTED');
  });
});
