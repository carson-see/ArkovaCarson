/**
 * Unit tests for Training Data Exporter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----
const { mockLogger, mockAppendFileSync, mockMkdirSync } = vi.hoisted(() => {
  return {
    mockLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    mockAppendFileSync: vi.fn(),
    mockMkdirSync: vi.fn(),
  };
});

vi.mock('../../config.js', () => ({
  config: {
    logLevel: 'info',
    nodeEnv: 'test',
    trainingDataOutputPath: '/tmp/test-training-data/output.jsonl',
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('node:fs', () => ({
  appendFileSync: mockAppendFileSync,
  mkdirSync: mockMkdirSync,
}));

function createMockSupabase(selectData: unknown[] | null = [], selectError: unknown = null, updateError: unknown = null) {
  const mockUpdate = vi.fn(() => ({
    in: vi.fn().mockResolvedValue({ error: updateError }),
  }));

  return {
    from: vi.fn((_table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue({ data: selectData, error: selectError }),
          })),
        })),
      })),
      update: mockUpdate,
    })),
    _mockUpdate: mockUpdate,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('trainingExporter', () => {
  it('exports records as JSONL', async () => {
    const records = [
      {
        id: 'aaa-111',
        title: 'Apple — 10-K (2026-01-15)',
        source_url: 'https://sec.gov/test',
        record_type: 'sec_filing',
        metadata: { form_type: '10-K' },
        content_hash: 'a'.repeat(64),
      },
      {
        id: 'bbb-222',
        title: 'Microsoft — 10-Q (2026-02-01)',
        source_url: 'https://sec.gov/test2',
        record_type: 'sec_filing',
        metadata: { form_type: '10-Q' },
        content_hash: 'b'.repeat(64),
      },
    ];

    const mockSupa = createMockSupabase(records);
    const { exportTrainingData } = await import('../trainingExporter.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await exportTrainingData(mockSupa as any);

    expect(result.exported).toBe(2);
    expect(result.errors).toBe(0);

    // Verify JSONL lines written
    expect(mockAppendFileSync).toHaveBeenCalledTimes(2);
    const firstLine = JSON.parse(mockAppendFileSync.mock.calls[0][1].replace('\n', ''));
    expect(firstLine).toMatchObject({
      text: 'Apple — 10-K (2026-01-15)',
      source_url: 'https://sec.gov/test',
      record_type: 'sec_filing',
      fingerprint: 'a'.repeat(64),
    });

    // Verify directory creation
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.any(String),
      { recursive: true },
    );
  });

  it('marks records as exported after writing', async () => {
    const records = [
      {
        id: 'ccc-333',
        title: 'Test Record',
        source_url: null,
        record_type: 'test',
        metadata: {},
        content_hash: 'c'.repeat(64),
      },
    ];

    const mockSupa = createMockSupabase(records);
    const { exportTrainingData } = await import('../trainingExporter.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await exportTrainingData(mockSupa as any);

    // Verify update was called to mark as exported
    expect(mockSupa._mockUpdate).toHaveBeenCalledWith({ training_exported: true });
  });

  it('handles empty result set', async () => {
    const mockSupa = createMockSupabase([]);
    const { exportTrainingData } = await import('../trainingExporter.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await exportTrainingData(mockSupa as any);

    expect(result.exported).toBe(0);
    expect(result.errors).toBe(0);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('No unexported records found');
  });

  it('handles fetch error gracefully', async () => {
    const mockSupa = createMockSupabase(null, { message: 'DB error', code: 'PGRST301' });
    const { exportTrainingData } = await import('../trainingExporter.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await exportTrainingData(mockSupa as any);

    expect(result.exported).toBe(0);
    expect(result.errors).toBe(1);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('returns early when output path is not configured', async () => {
    // Override config for this test — must reset modules first
    vi.resetModules();

    vi.doMock('../../config.js', () => ({
      config: { logLevel: 'info', nodeEnv: 'test', trainingDataOutputPath: undefined },
    }));
    vi.doMock('../../utils/logger.js', () => ({ logger: mockLogger }));
    vi.doMock('node:fs', () => ({ appendFileSync: mockAppendFileSync, mkdirSync: mockMkdirSync }));

    const { exportTrainingData } = await import('../trainingExporter.js');
    const mockSupa = createMockSupabase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await exportTrainingData(mockSupa as any);

    expect(result.exported).toBe(0);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('TRAINING_DATA_OUTPUT_PATH not set'),
    );
  });
});
