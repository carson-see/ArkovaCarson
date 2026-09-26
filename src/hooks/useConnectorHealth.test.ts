/**
 * useConnectorHealth Hook Tests (surface the SCRUM-1146 health dashboard —
 * see this folder's agents.md).
 *
 * The Drive `changes.list` 400-on-every-call incident (2026-05-04 to
 * 2026-09-25, fixed by PR #3054) went unnoticed for five months because
 * `services/worker/src/api/connector-health.ts` computed a rich
 * `HealthReason` (`cursor_stale`, `changes_list_never_succeeded`,
 * `grant_exceeds_requested`, ...) that no UI ever read. This hook is the
 * read-side client for `GET /api/connectors/health`.
 *
 * Fail-closed is the load-bearing behavior under test: a non-OK response, a
 * malformed body, or a thrown network error must all resolve every
 * `getHealth()` lookup to `state: 'unknown'` — never `'connected'`. A health
 * check that cannot prove a connector is fine must not imply it is fine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useConnectorHealth, describeConnectorHealthReason } from './useConnectorHealth';

const workerFetch = vi.fn();
vi.mock('@/lib/workerClient', () => ({
  workerFetch: (...args: unknown[]) => workerFetch(...args),
}));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) };
}

describe('useConnectorHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts in a loading, unknown-for-everything state', () => {
    workerFetch.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useConnectorHealth());

    expect(result.current.loading).toBe(true);
    expect(result.current.getHealth('google_drive')).toEqual({
      id: 'google_drive',
      state: 'unknown',
      health_reason: null,
      last_error: null,
    });
  });

  it('fetches GET /api/connectors/health and reports a healthy connector unchanged', async () => {
    workerFetch.mockResolvedValue(jsonResponse({
      connectors: [
        { id: 'google_drive', label: 'Google Drive', kind: 'live', state: 'connected', health_reason: 'none', account_label: null, last_event_at: null, last_renewal_at: null, next_expires_at: null, last_error: null },
      ],
      generated_at: '2026-09-25T00:00:00Z',
    }));

    const { result } = renderHook(() => useConnectorHealth());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(workerFetch).toHaveBeenCalledWith('/api/connectors/health', { method: 'GET' });
    expect(result.current.getHealth('google_drive')).toEqual({
      id: 'google_drive',
      state: 'connected',
      health_reason: 'none',
      last_error: null,
    });
    expect(result.current.error).toBeNull();
  });

  it('surfaces cursor_stale as degraded with its reason', async () => {
    workerFetch.mockResolvedValue(jsonResponse({
      connectors: [
        { id: 'google_drive', label: 'Google Drive', kind: 'live', state: 'degraded', health_reason: 'cursor_stale', account_label: null, last_event_at: null, last_renewal_at: null, next_expires_at: null, last_error: 'Drive changes cursor has not advanced in over 6h' },
      ],
    }));

    const { result } = renderHook(() => useConnectorHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const health = result.current.getHealth('google_drive');
    expect(health.state).toBe('degraded');
    expect(health.health_reason).toBe('cursor_stale');
  });

  it('surfaces changes_list_never_succeeded as degraded', async () => {
    workerFetch.mockResolvedValue(jsonResponse({
      connectors: [
        { id: 'google_drive', state: 'degraded', health_reason: 'changes_list_never_succeeded', last_error: 'never succeeded' },
      ],
    }));

    const { result } = renderHook(() => useConnectorHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.getHealth('google_drive')).toMatchObject({
      state: 'degraded',
      health_reason: 'changes_list_never_succeeded',
    });
  });

  // This is the TRUE-in-prod case per the incident audit: the one connected
  // org's Drive account carries ~32 granted scopes, exceeding what Arkova
  // requested. It must render, not crash.
  it('surfaces grant_exceeds_requested as degraded without throwing', async () => {
    workerFetch.mockResolvedValue(jsonResponse({
      connectors: [
        { id: 'google_drive', state: 'degraded', health_reason: 'grant_exceeds_requested', last_error: 'Granted OAuth scope exceeds what this connection requested: drive, drive.readonly' },
      ],
    }));

    const { result } = renderHook(() => useConnectorHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.getHealth('google_drive')).toMatchObject({
      state: 'degraded',
      health_reason: 'grant_exceeds_requested',
    });
  });

  it('fails closed to unknown on a non-OK response — never connected', async () => {
    workerFetch.mockResolvedValue(jsonResponse({ error: { code: 'connector_health_unavailable' } }, false, 503));

    const { result } = renderHook(() => useConnectorHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.getHealth('google_drive').state).toBe('unknown');
    expect(result.current.error).toBe('HTTP 503');
  });

  it('fails closed to unknown when the request throws (network error)', async () => {
    workerFetch.mockRejectedValue(new Error('Unable to connect to the server.'));

    const { result } = renderHook(() => useConnectorHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.getHealth('google_drive').state).toBe('unknown');
    expect(result.current.error).toBe('Unable to connect to the server.');
  });

  it('fails closed to unknown on a malformed body (no connectors array)', async () => {
    workerFetch.mockResolvedValue(jsonResponse({ oops: true }));

    const { result } = renderHook(() => useConnectorHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.getHealth('google_drive').state).toBe('unknown');
    expect(result.current.error).toBe('Malformed connector health response');
  });

  it('never reports unknown as connected for a connector id absent from the response', async () => {
    workerFetch.mockResolvedValue(jsonResponse({ connectors: [] }));

    const { result } = renderHook(() => useConnectorHealth());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.getHealth('docusign')).toEqual({
      id: 'docusign',
      state: 'unknown',
      health_reason: null,
      last_error: null,
    });
  });
});

describe('describeConnectorHealthReason', () => {
  it('has plain-language copy for every documented HealthReason', () => {
    const reasons = [
      'vendor_auth_revoked',
      'grant_exceeds_requested',
      'subscription_expiry',
      'cursor_stale',
      'changes_list_never_succeeded',
      'file_access_not_granted',
      'changes_gap',
      'fetch_job_failures',
      'processing_failure',
    ] as const;
    for (const reason of reasons) {
      expect(describeConnectorHealthReason(reason)).toEqual(expect.any(String));
      expect(describeConnectorHealthReason(reason).length).toBeGreaterThan(0);
    }
  });

  it('never renders the raw cursor_stale/changes_list_never_succeeded machine token to a user', () => {
    expect(describeConnectorHealthReason('cursor_stale')).not.toMatch(/cursor stale/i);
    expect(describeConnectorHealthReason('changes_list_never_succeeded')).not.toMatch(/changes_list/i);
  });

  it('falls back to a generic message for null/none/unrecognized reasons', () => {
    expect(describeConnectorHealthReason(null)).toEqual(expect.any(String));
    expect(describeConnectorHealthReason('none')).toEqual(expect.any(String));
  });
});
