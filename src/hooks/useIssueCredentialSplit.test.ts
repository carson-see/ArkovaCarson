/**
 * useIssueCredentialSplit (SCRUM-1755) — flag wrapper with `loading` state.
 *
 * Pins the fail-closed semantics that fixed the Codex P1 race:
 *   - initial state is `{ enabled: false, loading: true }`
 *   - on resolve, `enabled` reflects the fetched value
 *   - on RPC error, `enabled` is forced to `true` (split enforced) so an
 *     unauthorized org admin cannot bypass the gate by tripping the fetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mockGetFlag = vi.fn<() => Promise<boolean>>();

vi.mock('@/lib/switchboard', () => ({
  isIssueCredentialSplitEnabled: () => mockGetFlag(),
}));

import { useIssueCredentialSplit } from './useIssueCredentialSplit';

describe('useIssueCredentialSplit (SCRUM-1755)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with { enabled:false, loading:true } so callers fail-closed', () => {
    mockGetFlag.mockReturnValue(new Promise<boolean>(() => {}));
    const { result } = renderHook(() => useIssueCredentialSplit());
    expect(result.current).toEqual({ enabled: false, loading: true });
  });

  it('resolves to the fetched value once the flag returns', async () => {
    mockGetFlag.mockResolvedValue(true);
    const { result } = renderHook(() => useIssueCredentialSplit());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ enabled: true, loading: false });
  });

  it('falls back to enabled=true on fetch error so the gate stays enforced', async () => {
    mockGetFlag.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useIssueCredentialSplit());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ enabled: true, loading: false });
  });

  it('does not update state after unmount', async () => {
    let resolve!: (v: boolean) => void;
    mockGetFlag.mockReturnValue(new Promise<boolean>((r) => { resolve = r; }));
    const { result, unmount } = renderHook(() => useIssueCredentialSplit());
    unmount();
    await act(async () => {
      resolve(true);
      await Promise.resolve();
    });
    // Hook is unmounted; the result reference stays at its last value.
    expect(result.current).toEqual({ enabled: false, loading: true });
  });
});
