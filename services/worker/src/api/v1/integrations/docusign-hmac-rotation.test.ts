import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../config.js', () => ({
  config: {
    supabaseJwtSecret: 'test-jwt-secret',
    frontendUrl: 'http://localhost:3000',
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  rotateHmacKey,
  retireHmacKey,
  type RotationDeps,
  type HmacKeyEntry,
} from './docusign-hmac-rotation.js';

function makeMockDeps(overrides: Partial<RotationDeps> = {}): RotationDeps {
  return {
    getIntegration: vi.fn().mockResolvedValue({
      id: 'int-1',
      org_id: 'org-1',
      account_id: 'acct-1',
      hmac_keys: null,
    }),
    updateHmacKeys: vi.fn().mockResolvedValue({ error: null }),
    generateKey: () => 'generated-key-abc123',
    now: () => new Date('2026-05-27T12:00:00Z'),
    ...overrides,
  };
}

describe('rotateHmacKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates a new key and stores it when no keys exist', async () => {
    const deps = makeMockDeps();
    const result = await rotateHmacKey({ orgId: 'org-1', integrationId: 'int-1' }, deps);

    expect(result.ok).toBe(true);
    expect(result.new_key).toBe('generated-key-abc123');
    expect(result.total_keys).toBe(1);
    expect(deps.updateHmacKeys).toHaveBeenCalledWith('int-1', [
      { key: 'generated-key-abc123', created_at: '2026-05-27T12:00:00.000Z', label: 'rotated-2026-05-27' },
    ]);
  });

  it('appends new key alongside existing key', async () => {
    const existing: HmacKeyEntry[] = [
      { key: 'old-key-999', created_at: '2026-01-01T00:00:00Z' },
    ];
    const deps = makeMockDeps({
      getIntegration: vi.fn().mockResolvedValue({
        id: 'int-1',
        org_id: 'org-1',
        account_id: 'acct-1',
        hmac_keys: existing,
      }),
    });
    const result = await rotateHmacKey({ orgId: 'org-1', integrationId: 'int-1' }, deps);

    expect(result.ok).toBe(true);
    expect(result.total_keys).toBe(2);
    const updateCall = (deps.updateHmacKeys as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(updateCall).toHaveLength(2);
    expect(updateCall[0].key).toBe('old-key-999');
    expect(updateCall[1].key).toBe('generated-key-abc123');
  });

  it('rejects when integration not found', async () => {
    const deps = makeMockDeps({
      getIntegration: vi.fn().mockResolvedValue(null),
    });
    const result = await rotateHmacKey({ orgId: 'org-1', integrationId: 'int-1' }, deps);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('integration_not_found');
  });

  it('rejects when org_id mismatch', async () => {
    const deps = makeMockDeps({
      getIntegration: vi.fn().mockResolvedValue({
        id: 'int-1',
        org_id: 'org-DIFFERENT',
        account_id: 'acct-1',
        hmac_keys: null,
      }),
    });
    const result = await rotateHmacKey({ orgId: 'org-1', integrationId: 'int-1' }, deps);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('org_mismatch');
  });

  it('caps at 2 keys maximum', async () => {
    const existing: HmacKeyEntry[] = [
      { key: 'key-1', created_at: '2026-01-01T00:00:00Z' },
      { key: 'key-2', created_at: '2026-03-01T00:00:00Z' },
    ];
    const deps = makeMockDeps({
      getIntegration: vi.fn().mockResolvedValue({
        id: 'int-1',
        org_id: 'org-1',
        account_id: 'acct-1',
        hmac_keys: existing,
      }),
    });
    const result = await rotateHmacKey({ orgId: 'org-1', integrationId: 'int-1' }, deps);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('max_keys_reached');
  });

  it('propagates DB update error', async () => {
    const deps = makeMockDeps({
      updateHmacKeys: vi.fn().mockResolvedValue({ error: { message: 'db_down' } }),
    });
    const result = await rotateHmacKey({ orgId: 'org-1', integrationId: 'int-1' }, deps);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('update_failed');
  });
});

describe('retireHmacKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes the specified key by created_at', async () => {
    const existing: HmacKeyEntry[] = [
      { key: 'old-key', created_at: '2026-01-01T00:00:00Z' },
      { key: 'new-key', created_at: '2026-05-27T00:00:00Z' },
    ];
    const deps = makeMockDeps({
      getIntegration: vi.fn().mockResolvedValue({
        id: 'int-1',
        org_id: 'org-1',
        account_id: 'acct-1',
        hmac_keys: existing,
      }),
    });
    const result = await retireHmacKey(
      { orgId: 'org-1', integrationId: 'int-1', retireCreatedAt: '2026-01-01T00:00:00Z' },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.remaining_keys).toBe(1);
    const updateCall = (deps.updateHmacKeys as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(updateCall).toHaveLength(1);
    expect(updateCall[0].key).toBe('new-key');
  });

  it('rejects retiring the last key', async () => {
    const existing: HmacKeyEntry[] = [
      { key: 'only-key', created_at: '2026-01-01T00:00:00Z' },
    ];
    const deps = makeMockDeps({
      getIntegration: vi.fn().mockResolvedValue({
        id: 'int-1',
        org_id: 'org-1',
        account_id: 'acct-1',
        hmac_keys: existing,
      }),
    });
    const result = await retireHmacKey(
      { orgId: 'org-1', integrationId: 'int-1', retireCreatedAt: '2026-01-01T00:00:00Z' },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('cannot_retire_last_key');
  });

  it('rejects when key not found by created_at', async () => {
    const existing: HmacKeyEntry[] = [
      { key: 'key-1', created_at: '2026-01-01T00:00:00Z' },
      { key: 'key-2', created_at: '2026-05-27T00:00:00Z' },
    ];
    const deps = makeMockDeps({
      getIntegration: vi.fn().mockResolvedValue({
        id: 'int-1',
        org_id: 'org-1',
        account_id: 'acct-1',
        hmac_keys: existing,
      }),
    });
    const result = await retireHmacKey(
      { orgId: 'org-1', integrationId: 'int-1', retireCreatedAt: '2099-01-01T00:00:00Z' },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('key_not_found');
  });

  it('rejects when no hmac_keys exist', async () => {
    const deps = makeMockDeps();
    const result = await retireHmacKey(
      { orgId: 'org-1', integrationId: 'int-1', retireCreatedAt: '2026-01-01T00:00:00Z' },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_keys_configured');
  });
});
