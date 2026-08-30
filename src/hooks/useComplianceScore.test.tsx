/* eslint-disable arkova/require-error-code-assertion -- Rule flags the success-path `error == null` assert; the failure-path tests pin the specific messages ('HTTP 500' / 'Failed to fetch') */
/**
 * useJurisdictionRules — error-surfacing contract (SCRUM-3670).
 *
 * The hook previously swallowed fetch errors with a bare `catch {}` and had
 * no else-branch on `!res.ok`, so an HTTP 500 from the public rules endpoint
 * was indistinguishable from an empty rule set — the compliance-score
 * jurisdiction/industry pickers silently rendered empty. These tests pin the
 * corrected contract: `error` is exposed (mirroring the sibling
 * `useComplianceScore()` shape) and `refetch` allows recovery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useJurisdictionRules } from './useComplianceScore';

const mockFetch = vi.fn();

const okResponse = (rules: unknown[]) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ rules }),
});

const ruleRow = (jurisdiction: string, industry: string) => ({
  id: `${jurisdiction}-${industry}`,
  jurisdiction_code: jurisdiction,
  industry_code: industry,
  rule_name: 'rule',
  required_credential_types: [],
  optional_credential_types: [],
  regulatory_reference: null,
  details: {},
});

describe('useJurisdictionRules', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('exposes rules with a null error on a successful fetch', async () => {
    mockFetch.mockResolvedValue(okResponse([ruleRow('US-CA', 'accounting')]));

    const { result } = renderHook(() => useJurisdictionRules());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.jurisdictions).toEqual(['US-CA']);
    expect(result.current.industries).toEqual(['accounting']);
    expect(result.current.error).toBeNull();
  });

  it('sets error on a non-ok response instead of silently presenting an empty rule set', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });

    const { result } = renderHook(() => useJurisdictionRules());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rules).toEqual([]);
    // An HTTP 500 must be distinguishable from a genuinely empty rule set,
    // and the message must carry the status for diagnostics.
    expect(result.current.error).toContain('HTTP 500');
  });

  it('sets error when the fetch itself rejects (network failure)', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    const { result } = renderHook(() => useJurisdictionRules());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Failed to fetch');
  });

  it('refetch() recovers: error clears and rules populate once the endpoint succeeds', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mockFetch.mockResolvedValue(okResponse([ruleRow('US-NY', 'legal')]));

    const { result } = renderHook(() => useJurisdictionRules());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Failed to fetch');

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.jurisdictions).toEqual(['US-NY']);
    expect(result.current.industries).toEqual(['legal']);
  });
});
