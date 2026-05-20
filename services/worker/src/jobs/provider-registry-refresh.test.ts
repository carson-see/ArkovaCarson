import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({ db: {} }));

import {
  checkProviderRegistryRefreshStatus,
  formatProviderRegistryRefreshSlackMessage,
  parseProviderRefreshOverdueDays,
  postProviderRegistryRefreshSlackAlert,
  type ProviderRegistryRefreshRow,
} from './provider-registry-refresh.js';

const NOW = new Date('2026-05-20T12:00:00.000Z');

function row(overrides: Partial<ProviderRegistryRefreshRow>): ProviderRegistryRefreshRow {
  return {
    kind: 'CPE',
    providerName: 'Udemy',
    providerDomain: 'udemy.com',
    status: 'confirmed',
    lastVerifiedDate: '2026-05-01',
    ...overrides,
  };
}

describe('provider registry refresh overdue checks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses 95 days by default and ignores invalid override values', () => {
    expect(parseProviderRefreshOverdueDays(undefined)).toBe(95);
    expect(parseProviderRefreshOverdueDays('120')).toBe(120);
    expect(parseProviderRefreshOverdueDays('0')).toBe(95);
    expect(parseProviderRefreshOverdueDays('not-a-number')).toBe(95);
  });

  it('flags stale and never-verified active providers', () => {
    const result = checkProviderRegistryRefreshStatus([
      row({ providerName: 'Fresh Provider', lastVerifiedDate: '2026-05-10' }),
      row({ providerName: 'Stale Provider', lastVerifiedDate: '2026-01-01' }),
      row({ providerName: 'Never Verified', lastVerifiedDate: null }),
      row({ providerName: 'Credential Host', status: 'not_found', lastVerifiedDate: '2025-01-01' }),
      row({ kind: 'CLE', providerName: 'Retired CLE', status: 'not_approved', lastVerifiedDate: null }),
    ], NOW, 95);

    expect(result.checked).toBe(5);
    expect(result.overdue).toHaveLength(2);
    expect(result.overdue.map((item) => item.providerName)).toEqual([
      'Stale Provider',
      'Never Verified',
    ]);
    expect(result.healthy).toBe(1);
    expect(result.inactive).toBe(2);
  });

  it('formats one actionable Slack line per overdue provider', () => {
    const result = checkProviderRegistryRefreshStatus([
      row({ providerName: 'Stale Provider', lastVerifiedDate: '2026-01-01' }),
      row({ kind: 'CLE', providerName: 'Never Verified', lastVerifiedDate: null }),
    ], NOW, 95);

    const message = formatProviderRegistryRefreshSlackMessage(result);

    expect(message).toContain('Provider registry refresh overdue for Stale Provider - last verified 2026-01-01.');
    expect(message).toContain('Provider registry refresh overdue for Never Verified - last verified not recorded.');
    expect(message).toContain('Checked 2 provider registry rows');
  });

  it('skips Slack when every active provider is fresh', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = checkProviderRegistryRefreshStatus([
      row({ providerName: 'Fresh Provider', lastVerifiedDate: '2026-05-10' }),
    ], NOW, 95);

    await expect(postProviderRegistryRefreshSlackAlert('https://hooks.slack.test/ok', result)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts an ops Slack alert when at least one provider is overdue', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const result = checkProviderRegistryRefreshStatus([
      row({ providerName: 'Stale Provider', lastVerifiedDate: '2026-01-01' }),
    ], NOW, 95);

    await expect(postProviderRegistryRefreshSlackAlert('https://hooks.slack.test/ok', result)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.slack.test/ok',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'manual',
      }),
    );
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init.body)).text).toContain('Provider registry refresh overdue for Stale Provider');
  });
});
