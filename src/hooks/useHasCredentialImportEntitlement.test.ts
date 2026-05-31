/**
 * useHasCredentialImportEntitlement — resolver tests (SCRUM-1847 / CPE-R1)
 *
 * The pure `resolveImportEntitlement` function carries the gating logic and is
 * unit-tested directly here (the React hook is a thin React Query wrapper).
 *
 * @see SCRUM-1847, SCRUM-1857
 */

import { describe, it, expect } from 'vitest';
import {
  resolveImportEntitlement,
  CREDENTIAL_SOURCE_IMPORT_ENTITLEMENT,
  type EntitlementRow,
} from './useHasCredentialImportEntitlement';

const NOW = new Date('2026-05-31T12:00:00Z');

function row(overrides: Partial<EntitlementRow> = {}): EntitlementRow {
  return {
    entitlement_type: CREDENTIAL_SOURCE_IMPORT_ENTITLEMENT,
    valid_from: '2026-01-01T00:00:00Z',
    valid_until: null,
    ...overrides,
  };
}

describe('resolveImportEntitlement', () => {
  it('returns false while loading', () => {
    expect(resolveImportEntitlement({ loading: true, rows: undefined, now: NOW })).toBe(false);
  });

  it('returns false on query error (fail-closed)', () => {
    expect(
      resolveImportEntitlement({ loading: false, rows: undefined, error: true, now: NOW }),
    ).toBe(false);
  });

  it('returns false when there are no entitlement rows', () => {
    expect(resolveImportEntitlement({ loading: false, rows: [], now: NOW })).toBe(false);
  });

  it('returns true for an active, unbounded entitlement', () => {
    expect(resolveImportEntitlement({ loading: false, rows: [row()], now: NOW })).toBe(true);
  });

  it('returns true when within the valid window', () => {
    expect(
      resolveImportEntitlement({
        loading: false,
        rows: [row({ valid_until: '2026-12-31T00:00:00Z' })],
        now: NOW,
      }),
    ).toBe(true);
  });

  it('returns false when the entitlement has expired', () => {
    expect(
      resolveImportEntitlement({
        loading: false,
        rows: [row({ valid_until: '2026-03-01T00:00:00Z' })],
        now: NOW,
      }),
    ).toBe(false);
  });

  it('returns false when the entitlement has not started yet', () => {
    expect(
      resolveImportEntitlement({
        loading: false,
        rows: [row({ valid_from: '2026-09-01T00:00:00Z' })],
        now: NOW,
      }),
    ).toBe(false);
  });

  it('ignores rows of a different entitlement_type', () => {
    expect(
      resolveImportEntitlement({
        loading: false,
        rows: [row({ entitlement_type: 'some_other_feature' })],
        now: NOW,
      }),
    ).toBe(false);
  });

  it('returns true if any one of several rows is active', () => {
    expect(
      resolveImportEntitlement({
        loading: false,
        rows: [
          row({ valid_until: '2026-03-01T00:00:00Z' }), // expired
          row({ valid_until: '2027-01-01T00:00:00Z' }), // active
        ],
        now: NOW,
      }),
    ).toBe(true);
  });
});
