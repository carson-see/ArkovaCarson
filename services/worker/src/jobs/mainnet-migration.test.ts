/**
 * getMigrationStatus — verifies the get_anchor_status_counts_fast RPC
 * plus the bounded migrated-flag scan return expected counts on the fast
 * path AND degrade gracefully on RPC error (never throws, returns 0
 * placeholders rather than crashing the cron).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpc, mockMigratedScan, mockLogger } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockMigratedScan = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockRpc, mockMigratedScan, mockLogger };
});

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../utils/db.js', () => {
  const migratedChain: Record<string, unknown> = {};
  migratedChain.not = vi.fn(() => migratedChain);
  migratedChain.limit = vi.fn(() => mockMigratedScan());

  return {
    db: {
      rpc: mockRpc,
      from: vi.fn((table: string) => {
        if (table !== 'anchors') return {};
        return {
          select: vi.fn(() => migratedChain),
        };
      }),
    },
  };
});

import { getMigrationStatus } from './mainnet-migration.js';

describe('getMigrationStatus — fast RPC path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMigratedScan.mockResolvedValue({ data: [], error: null });
  });

  it('fast path: returns counts from RPC + migrated-flag scan length', async () => {
    mockRpc.mockResolvedValue({
      data: { PENDING: 250, SUBMITTED: 12, BROADCASTING: 0, SECURED: 1_400_000, REVOKED: 5, total: 1_400_267 },
      error: null,
    });
    mockMigratedScan.mockResolvedValue({
      data: Array.from({ length: 7777 }, (_, i) => ({ id: `m${i}` })),
      error: null,
    });

    const status = await getMigrationStatus();

    expect(status.total).toBe(1_400_267);
    expect(status.pending).toBe(250);
    expect(status.secured).toBe(1_400_000);
    expect(status.submitted).toBe(12);
    expect(status.migrated).toBe(7777);
    expect(status.migratedCapped).toBe(false);
    expect(status.remaining).toBe(267);
  });

  it('error path: RPC error → counts default to 0; remaining sentinel -1', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'statement timeout' } });

    const status = await getMigrationStatus();

    expect(status.total).toBe(0);
    expect(status.pending).toBe(0);
    expect(status.secured).toBe(0);
    expect(status.remaining).toBe(-1);
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('migratedCapped flips true when scan hits LIMIT 100k', async () => {
    mockRpc.mockResolvedValue({
      data: { PENDING: 0, SUBMITTED: 0, BROADCASTING: 0, SECURED: 200_000, REVOKED: 0, total: 200_000 },
      error: null,
    });
    mockMigratedScan.mockResolvedValue({
      data: Array.from({ length: 100_000 }, (_, i) => ({ id: `m${i}` })),
      error: null,
    });

    const status = await getMigrationStatus();

    expect(status.migrated).toBe(100_000);
    expect(status.migratedCapped).toBe(true);
  });

  it('migrated-flag scan error does not throw; reports 0', async () => {
    mockRpc.mockResolvedValue({
      data: { PENDING: 0, SUBMITTED: 0, BROADCASTING: 0, SECURED: 100, REVOKED: 0, total: 100 },
      error: null,
    });
    mockMigratedScan.mockResolvedValue({ data: null, error: { message: 'index missing' } });

    const status = await getMigrationStatus();

    expect(status.migrated).toBe(0);
    expect(status.migratedCapped).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});
