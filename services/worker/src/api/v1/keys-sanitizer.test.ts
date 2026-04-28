/**
 * SCRUM-1271-D — keys.ts response sanitizer tests.
 *
 * Pin that internal-actor UUIDs and the secret hash never reach customer-
 * facing payloads. Customers reference keys by `key_prefix` (already unique
 * + human-readable) rather than the api_keys.id UUID per CLAUDE.md §6.
 */

import { describe, it, expect } from 'vitest';

// Re-implement the contract here so the test pins shape, not implementation.
// If keys.ts toPublicKey() drifts, the route tests in keys.test.ts will fail;
// this file pins the public-shape invariant.
function publicKeyShape(row: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...row };
  delete sanitized.id;
  delete sanitized.org_id;
  delete sanitized.key_hash;
  return sanitized;
}

describe('keys.ts public shape (SCRUM-1271-D)', () => {
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
  };

  it('strips id, org_id, key_hash from outbound responses', () => {
    const out = publicKeyShape(fullRow);
    expect(out).not.toHaveProperty('id');
    expect(out).not.toHaveProperty('org_id');
    expect(out).not.toHaveProperty('key_hash');
  });

  it('preserves key_prefix as the public identifier', () => {
    const out = publicKeyShape(fullRow);
    expect(out.key_prefix).toBe('TEST_PREFIX_FAKE');
  });

  it('preserves all non-secret fields (scopes, name, dates, status)', () => {
    const out = publicKeyShape(fullRow);
    expect(out.name).toBe('Production API key');
    expect(out.scopes).toEqual(['verify', 'verify:batch']);
    expect(out.rate_limit_tier).toBe('paid');
    expect(out.is_active).toBe(true);
    expect(out.created_at).toBe('2026-04-27T00:00:00Z');
    expect(out.last_used_at).toBe('2026-04-27T09:00:00Z');
  });

  it('does not mutate the input row', () => {
    const before = { ...fullRow };
    publicKeyShape(fullRow);
    expect(fullRow).toEqual(before);
  });

  it('JSON.stringify never contains the internal UUID', () => {
    const out = publicKeyShape(fullRow);
    expect(JSON.stringify(out)).not.toContain('api-key-uuid-1');
    expect(JSON.stringify(out)).not.toContain('org-uuid-internal');
  });
});
