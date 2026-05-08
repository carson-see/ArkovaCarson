/**
 * Pure-function tests for snapshot sync.
 *
 * SCRUM-1724. The load-bearing test here is `assertNoApiKeysPiiLeak` —
 * defense-in-depth runtime check that the api_keys allowlist hasn't been
 * tampered with after build (e.g. someone runtime-monkeypatched or
 * passed a malicious config in).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../utils/gcp-auth.js', () => ({ getGcpAccessToken: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { __testing } from './bq-export-snapshot.js';
import {
  API_KEYS_COLUMN_ALLOWLIST,
  API_KEYS_FORBIDDEN_COLUMNS,
} from './bq-export-schemas.js';

const { assertNoApiKeysPiiLeak, utcDateToday, ORGANIZATIONS_SELECT, SNAPSHOT_TABLES } = __testing;

describe('bq-export-snapshot: SNAPSHOT_TABLES', () => {
  it('handles exactly the two snapshot tables (organizations, api_keys)', () => {
    expect([...SNAPSHOT_TABLES].sort((a, b) => a.localeCompare(b))).toEqual([
      'api_keys',
      'organizations',
    ]);
  });
});

describe('bq-export-snapshot: api_keys PII guard (assertNoApiKeysPiiLeak)', () => {
  it('passes for the canonical allowlist', () => {
    expect(() => assertNoApiKeysPiiLeak(API_KEYS_COLUMN_ALLOWLIST)).not.toThrow();
  });

  it.each([...API_KEYS_FORBIDDEN_COLUMNS])(
    'throws when forbidden column "%s" is in the select list',
    (forbidden) => {
      const tampered = [...API_KEYS_COLUMN_ALLOWLIST, forbidden];
      expect(() => assertNoApiKeysPiiLeak(tampered)).toThrow(/forbidden PII column|forbidden/i);
    },
  );

  it('rejects an empty/garbage list with raw `key`', () => {
    expect(() => assertNoApiKeysPiiLeak(['key'])).toThrow();
  });

  it('canonical allowlist contains key_hash (NOT hashed_key)', () => {
    expect(API_KEYS_COLUMN_ALLOWLIST).toContain('key_hash');
    expect(API_KEYS_COLUMN_ALLOWLIST).not.toContain('hashed_key');
  });
});

describe('bq-export-snapshot: utcDateToday', () => {
  it('returns a YYYY-MM-DD string', () => {
    const d = utcDateToday();
    expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches the UTC date of "now" within a 1-day window', () => {
    const d = utcDateToday();
    const today = new Date().toISOString().slice(0, 10);
    expect(d).toBe(today);
  });
});

describe('bq-export-snapshot: organizations select shape', () => {
  it('does NOT include obvious PII columns', () => {
    expect(ORGANIZATIONS_SELECT).not.toContain('owner_email');
    expect(ORGANIZATIONS_SELECT).not.toContain('phone');
  });

  it('includes id (snapshot key)', () => {
    expect(ORGANIZATIONS_SELECT).toContain('id');
  });
});
