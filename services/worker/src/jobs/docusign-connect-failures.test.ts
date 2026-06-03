import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: {},
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
}));

import {
  pollDocusignConnectFailures,
  type ConnectFailuresDeps,
  type ActiveIntegration,
  type ConnectFailureGap,
} from './docusign-connect-failures.js';

const MOCK_INTEGRATION: ActiveIntegration = {
  id: 'int-1',
  org_id: 'org-1',
  account_id: 'acct-1',
  base_uri: 'https://demo.docusign.net',
  token_secret_name: 'projects/p/secrets/s',
};

const MOCK_FAILURE: ConnectFailureGap = {
  envelope_id: 'env-100',
  envelope_status: 'completed',
  completed_at: '2026-05-27T10:00:00Z',
};

function makeMockDeps(overrides: Partial<ConnectFailuresDeps> = {}): ConnectFailuresDeps {
  return {
    listActiveIntegrations: vi.fn().mockResolvedValue([MOCK_INTEGRATION]),
    getAccessToken: vi.fn().mockResolvedValue('access-token-123'),
    listConnectFailures: vi.fn().mockResolvedValue([MOCK_FAILURE]),
    insertGap: vi.fn().mockResolvedValue({ inserted: true, duplicate: false, error: null }),
    ...overrides,
  };
}

describe('pollDocusignConnectFailures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts a gap for each Connect failure (happy path)', async () => {
    const deps = makeMockDeps();
    const result = await pollDocusignConnectFailures(deps);

    expect(result.ok).toBe(true);
    expect(result.integrations_checked).toBe(1);
    expect(result.failures_polled).toBe(1);
    expect(result.gaps_inserted).toBe(1);
    expect(result.duplicates_skipped).toBe(0);
    expect(result.token_refreshes).toBe(1);
    expect(result.errors).toHaveLength(0);

    expect(deps.insertGap).toHaveBeenCalledWith({
      org_id: 'org-1',
      integration_id: 'int-1',
      account_id: 'acct-1',
      envelope_id: 'env-100',
      envelope_status: 'completed',
      completed_at: '2026-05-27T10:00:00Z',
    });
  });

  it('inserts a gap for each of N failures', async () => {
    const failures: ConnectFailureGap[] = [
      MOCK_FAILURE,
      { envelope_id: 'env-200', envelope_status: 'completed', completed_at: '2026-05-27T11:00:00Z' },
      { envelope_id: 'env-300', envelope_status: 'completed', completed_at: '2026-05-27T12:00:00Z' },
    ];
    const deps = makeMockDeps({
      listConnectFailures: vi.fn().mockResolvedValue(failures),
    });
    const result = await pollDocusignConnectFailures(deps);

    expect(result.failures_polled).toBe(3);
    expect(result.gaps_inserted).toBe(3);
    expect(deps.insertGap).toHaveBeenCalledTimes(3);
  });

  it('counts duplicate insert as duplicates_skipped, not gaps_inserted', async () => {
    const deps = makeMockDeps({
      insertGap: vi.fn().mockResolvedValue({ inserted: false, duplicate: true, error: null }),
    });
    const result = await pollDocusignConnectFailures(deps);

    expect(result.failures_polled).toBe(1);
    expect(result.gaps_inserted).toBe(0);
    expect(result.duplicates_skipped).toBe(1);
    expect(result.ok).toBe(true);
  });

  it('handles empty failures list cleanly (still refreshes token)', async () => {
    const deps = makeMockDeps({
      listConnectFailures: vi.fn().mockResolvedValue([]),
    });
    const result = await pollDocusignConnectFailures(deps);

    expect(result.ok).toBe(true);
    expect(result.failures_polled).toBe(0);
    expect(result.gaps_inserted).toBe(0);
    expect(result.token_refreshes).toBe(1);
    expect(deps.insertGap).not.toHaveBeenCalled();
  });

  it('fires a Sentry warning for each NEW gap (with integration_id tag)', async () => {
    const Sentry = await import('@sentry/node');
    const deps = makeMockDeps();
    await pollDocusignConnectFailures(deps);

    expect(Sentry.captureMessage).toHaveBeenCalledOnce();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('env-100'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ integration_id: 'int-1' }),
      }),
    );
  });

  it('does not fire Sentry for duplicate gaps', async () => {
    const Sentry = await import('@sentry/node');
    const deps = makeMockDeps({
      insertGap: vi.fn().mockResolvedValue({ inserted: false, duplicate: true, error: null }),
    });
    await pollDocusignConnectFailures(deps);

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('continues to next integration when listConnectFailures throws', async () => {
    const int2: ActiveIntegration = { ...MOCK_INTEGRATION, id: 'int-2', org_id: 'org-2' };
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([MOCK_INTEGRATION, int2]),
      listConnectFailures: vi
        .fn()
        .mockRejectedValueOnce(new Error('connect_failures_api_500'))
        .mockResolvedValueOnce([MOCK_FAILURE]),
    });
    const result = await pollDocusignConnectFailures(deps);

    expect(result.ok).toBe(false);
    expect(result.integrations_checked).toBe(2);
    expect(result.failures_polled).toBe(1);
    expect(result.gaps_inserted).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].integration_id).toBe('int-1');
    expect(result.errors[0].error).toContain('connect_failures_api');
  });

  it('continues to next integration on token refresh failure', async () => {
    const int2: ActiveIntegration = { ...MOCK_INTEGRATION, id: 'int-2', org_id: 'org-2' };
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([MOCK_INTEGRATION, int2]),
      getAccessToken: vi
        .fn()
        .mockRejectedValueOnce(new Error('token_expired'))
        .mockResolvedValueOnce('token-2'),
    });
    const result = await pollDocusignConnectFailures(deps);

    expect(result.ok).toBe(false);
    expect(result.integrations_checked).toBe(2);
    expect(result.token_refreshes).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].integration_id).toBe('int-1');
    expect(result.errors[0].error).toContain('token_refresh');
    // The second integration still gets polled.
    expect(deps.listConnectFailures).toHaveBeenCalledTimes(1);
  });

  it('returns early with error if integration listing fails', async () => {
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockRejectedValue(new Error('db_down')),
    });
    const result = await pollDocusignConnectFailures(deps);

    expect(result.ok).toBe(false);
    expect(result.integrations_checked).toBe(0);
    expect(result.errors[0].integration_id).toBe('*');
  });

  it('reports gap insert error without crashing or firing Sentry', async () => {
    const Sentry = await import('@sentry/node');
    const deps = makeMockDeps({
      insertGap: vi.fn().mockResolvedValue({ inserted: false, duplicate: false, error: 'rls_denied' }),
    });
    const result = await pollDocusignConnectFailures(deps);

    expect(result.ok).toBe(false);
    expect(result.failures_polled).toBe(1);
    expect(result.gaps_inserted).toBe(0);
    expect(result.errors[0].error).toContain('rls_denied');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('defaults the lookback window to 2 hours', async () => {
    const deps = makeMockDeps({
      listConnectFailures: vi.fn().mockResolvedValue([]),
    });
    await pollDocusignConnectFailures(deps);

    const call = (deps.listConnectFailures as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const fromDate = new Date(call.fromDate);
    const hoursAgo = (Date.now() - fromDate.getTime()) / (1000 * 60 * 60);
    expect(hoursAgo).toBeGreaterThan(1.9);
    expect(hoursAgo).toBeLessThan(2.1);
  });

  it('honours an explicit lookback window', async () => {
    const deps = makeMockDeps({
      listConnectFailures: vi.fn().mockResolvedValue([]),
    });
    await pollDocusignConnectFailures(deps, 6);

    const call = (deps.listConnectFailures as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const fromDate = new Date(call.fromDate);
    const hoursAgo = (Date.now() - fromDate.getTime()) / (1000 * 60 * 60);
    expect(hoursAgo).toBeGreaterThan(5.9);
    expect(hoursAgo).toBeLessThan(6.1);
  });

  it('passes baseUri / accountId / accessToken through to listConnectFailures', async () => {
    const deps = makeMockDeps({
      listConnectFailures: vi.fn().mockResolvedValue([]),
    });
    await pollDocusignConnectFailures(deps);

    expect(deps.listConnectFailures).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUri: 'https://demo.docusign.net',
        accountId: 'acct-1',
        accessToken: 'access-token-123',
        fromDate: expect.any(String),
      }),
    );
  });

  it('returns a clean result when no integrations exist', async () => {
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([]),
    });
    const result = await pollDocusignConnectFailures(deps);

    expect(result.ok).toBe(true);
    expect(result.integrations_checked).toBe(0);
    expect(result.failures_polled).toBe(0);
    expect(result.gaps_inserted).toBe(0);
  });

  it('handles a mix of new gaps and duplicates across one integration', async () => {
    const failures: ConnectFailureGap[] = [
      MOCK_FAILURE,
      { envelope_id: 'env-dup', envelope_status: 'completed', completed_at: '2026-05-27T11:00:00Z' },
      { envelope_id: 'env-300', envelope_status: 'completed', completed_at: '2026-05-27T12:00:00Z' },
    ];
    const insertGap = vi
      .fn()
      .mockResolvedValueOnce({ inserted: true, duplicate: false, error: null })
      .mockResolvedValueOnce({ inserted: false, duplicate: true, error: null })
      .mockResolvedValueOnce({ inserted: true, duplicate: false, error: null });
    const deps = makeMockDeps({
      listConnectFailures: vi.fn().mockResolvedValue(failures),
      insertGap,
    });
    const Sentry = await import('@sentry/node');
    const result = await pollDocusignConnectFailures(deps);

    expect(result.failures_polled).toBe(3);
    expect(result.gaps_inserted).toBe(2);
    expect(result.duplicates_skipped).toBe(1);
    // Sentry fires only for the 2 NEW gaps.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2);
  });
});
