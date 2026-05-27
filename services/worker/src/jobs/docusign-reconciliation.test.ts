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
  reconcileDocusignGaps,
  type ReconciliationDeps,
  type ActiveIntegration,
  type EnvelopeSummary,
} from './docusign-reconciliation.js';

const MOCK_INTEGRATION: ActiveIntegration = {
  id: 'int-1',
  org_id: 'org-1',
  account_id: 'acct-1',
  base_uri: 'https://demo.docusign.net',
  token_secret_name: 'projects/p/secrets/s',
};

const MOCK_ENVELOPE: EnvelopeSummary = {
  envelopeId: 'env-100',
  status: 'completed',
  completedDateTime: '2026-05-27T10:00:00Z',
};

function makeMockDeps(overrides: Partial<ReconciliationDeps> = {}): ReconciliationDeps {
  return {
    listActiveIntegrations: vi.fn().mockResolvedValue([MOCK_INTEGRATION]),
    getAccessToken: vi.fn().mockResolvedValue('access-token-123'),
    listCompletedEnvelopes: vi.fn().mockResolvedValue([MOCK_ENVELOPE]),
    getReceivedEnvelopeIds: vi.fn().mockResolvedValue(new Set<string>()),
    insertGap: vi.fn().mockResolvedValue({ inserted: true, duplicate: false, error: null }),
    ...overrides,
  };
}

describe('reconcileDocusignGaps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects a gap when envelope is not in nonces', async () => {
    const deps = makeMockDeps();
    const result = await reconcileDocusignGaps(deps);

    expect(result.ok).toBe(true);
    expect(result.integrations_checked).toBe(1);
    expect(result.envelopes_polled).toBe(1);
    expect(result.gaps_detected).toBe(1);
    expect(result.gaps_inserted).toBe(1);
    expect(result.duplicates_skipped).toBe(0);
    expect(result.token_refreshes).toBe(1);

    expect(deps.insertGap).toHaveBeenCalledWith({
      org_id: 'org-1',
      integration_id: 'int-1',
      account_id: 'acct-1',
      envelope_id: 'env-100',
      envelope_status: 'completed',
      completed_at: '2026-05-27T10:00:00Z',
    });
  });

  it('skips envelope that was already received via webhook', async () => {
    const deps = makeMockDeps({
      getReceivedEnvelopeIds: vi.fn().mockResolvedValue(new Set(['env-100'])),
    });
    const result = await reconcileDocusignGaps(deps);

    expect(result.gaps_detected).toBe(0);
    expect(result.gaps_inserted).toBe(0);
    expect(deps.insertGap).not.toHaveBeenCalled();
  });

  it('handles duplicate gap insertion gracefully', async () => {
    const deps = makeMockDeps({
      insertGap: vi.fn().mockResolvedValue({ inserted: false, duplicate: true, error: null }),
    });
    const result = await reconcileDocusignGaps(deps);

    expect(result.gaps_detected).toBe(1);
    expect(result.gaps_inserted).toBe(0);
    expect(result.duplicates_skipped).toBe(1);
    expect(result.ok).toBe(true);
  });

  it('fires Sentry alert for each new gap', async () => {
    const Sentry = await import('@sentry/node');
    const deps = makeMockDeps();
    await reconcileDocusignGaps(deps);

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
    await reconcileDocusignGaps(deps);

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('refreshes tokens even when no envelopes exist (keep-alive)', async () => {
    const deps = makeMockDeps({
      listCompletedEnvelopes: vi.fn().mockResolvedValue([]),
    });
    const result = await reconcileDocusignGaps(deps);

    expect(result.token_refreshes).toBe(1);
    expect(deps.getAccessToken).toHaveBeenCalledWith(MOCK_INTEGRATION);
    expect(result.gaps_detected).toBe(0);
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
    const result = await reconcileDocusignGaps(deps);

    expect(result.ok).toBe(false);
    expect(result.integrations_checked).toBe(2);
    expect(result.token_refreshes).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].integration_id).toBe('int-1');
  });

  it('continues to next integration on Envelopes API failure', async () => {
    const int2: ActiveIntegration = { ...MOCK_INTEGRATION, id: 'int-2', org_id: 'org-2' };
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([MOCK_INTEGRATION, int2]),
      listCompletedEnvelopes: vi
        .fn()
        .mockRejectedValueOnce(new Error('envelopes_api_500'))
        .mockResolvedValueOnce([MOCK_ENVELOPE]),
    });
    const result = await reconcileDocusignGaps(deps);

    expect(result.ok).toBe(false);
    expect(result.integrations_checked).toBe(2);
    expect(result.envelopes_polled).toBe(1);
    expect(result.errors[0].error).toContain('envelopes_api');
  });

  it('returns early with error if integration listing fails', async () => {
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockRejectedValue(new Error('db_down')),
    });
    const result = await reconcileDocusignGaps(deps);

    expect(result.ok).toBe(false);
    expect(result.integrations_checked).toBe(0);
    expect(result.errors[0].integration_id).toBe('*');
  });

  it('reports gap insert error without crashing', async () => {
    const deps = makeMockDeps({
      insertGap: vi.fn().mockResolvedValue({ inserted: false, duplicate: false, error: 'rls_denied' }),
    });
    const result = await reconcileDocusignGaps(deps);

    expect(result.ok).toBe(false);
    expect(result.gaps_detected).toBe(1);
    expect(result.gaps_inserted).toBe(0);
    expect(result.errors[0].error).toContain('rls_denied');
  });

  it('handles multiple envelopes with mixed gap/received status', async () => {
    const env2: EnvelopeSummary = {
      envelopeId: 'env-200',
      status: 'completed',
      completedDateTime: '2026-05-27T11:00:00Z',
    };
    const env3: EnvelopeSummary = {
      envelopeId: 'env-300',
      status: 'completed',
      completedDateTime: '2026-05-27T12:00:00Z',
    };
    const deps = makeMockDeps({
      listCompletedEnvelopes: vi.fn().mockResolvedValue([MOCK_ENVELOPE, env2, env3]),
      getReceivedEnvelopeIds: vi.fn().mockResolvedValue(new Set(['env-200'])),
    });
    const result = await reconcileDocusignGaps(deps);

    expect(result.envelopes_polled).toBe(3);
    expect(result.gaps_detected).toBe(2);
    expect(result.gaps_inserted).toBe(2);
    expect(deps.insertGap).toHaveBeenCalledTimes(2);
  });

  it('uses the provided lookback window', async () => {
    const deps = makeMockDeps({
      listCompletedEnvelopes: vi.fn().mockResolvedValue([]),
    });
    await reconcileDocusignGaps(deps, 48);

    const call = (deps.listCompletedEnvelopes as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const fromDate = new Date(call.fromDate);
    const hoursAgo = (Date.now() - fromDate.getTime()) / (1000 * 60 * 60);
    expect(hoursAgo).toBeGreaterThan(47);
    expect(hoursAgo).toBeLessThan(49);
  });

  it('returns clean result when no integrations exist', async () => {
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([]),
    });
    const result = await reconcileDocusignGaps(deps);

    expect(result.ok).toBe(true);
    expect(result.integrations_checked).toBe(0);
    expect(result.gaps_detected).toBe(0);
  });
});
