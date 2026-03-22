/**
 * Unit tests for Training Data Exporter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatJsonlLine } from '../trainingExporter.js';

// ---- Hoisted mocks ----
const { mockSelect, mockUpdate, mockAppendFileSync, mockMkdirSync, mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockAppendFileSync = vi.fn();
  const mockMkdirSync = vi.fn();
  const mockSelect = vi.fn();
  const mockUpdate = vi.fn();

  return { mockSelect, mockUpdate, mockAppendFileSync, mockMkdirSync, mockLogger };
});

// Mock config
vi.mock('../../config.js', () => ({
  config: {
    trainingDataOutputPath: './test-output',
    logLevel: 'info',
    nodeEnv: 'test',
  },
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));

// Mock fs
vi.mock('node:fs', () => ({
  appendFileSync: mockAppendFileSync,
  mkdirSync: mockMkdirSync,
}));

// Build mock supabase client
function createMockSupabase(records: Array<Record<string, unknown>> = []) {
  const limitFn = vi.fn().mockResolvedValue({ data: records, error: null });
  const orderFn = vi.fn(() => ({ limit: limitFn }));
  const eqFn = vi.fn(() => ({ order: orderFn }));
  const selectFn = vi.fn(() => ({ eq: eqFn }));

  const inFn = vi.fn().mockResolvedValue({ error: null });
  const updateFn = vi.fn(() => ({ in: inFn }));

  mockSelect.mockImplementation(selectFn);
  mockUpdate.mockImplementation(updateFn);

  return {
    from: vi.fn(() => ({
      select: selectFn,
      update: updateFn,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('trainingExporter', () => {
  it('exports records as JSONL', async () => {
    const records = [
      {
        id: 'rec-1',
        source_url: 'https://example.com/filing1',
        record_type: '10-K',
        metadata: { entity_name: 'Test Corp' },
        content_hash: 'abc123',
        title: 'Test Filing',
      },
      {
        id: 'rec-2',
        source_url: 'https://example.com/filing2',
        record_type: '10-Q',
        metadata: { entity_name: 'Other Corp' },
        content_hash: 'def456',
        title: 'Quarterly Report',
      },
    ];

    const mockSupa = createMockSupabase(records);
    const { exportTrainingData } = await import('../trainingExporter.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await exportTrainingData(mockSupa as any);

    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const writtenContent = mockAppendFileSync.mock.calls[0][1] as string;
    const lines = writtenContent.trim().split('\n');
    expect(lines).toHaveLength(2);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.text).toBe('Test Filing');
    expect(parsed.source_url).toBe('https://example.com/filing1');
    expect(parsed.fingerprint).toBe('abc123');
  });

  it('marks records as exported', async () => {
    const records = [
      {
        id: 'rec-1',
        source_url: 'https://example.com',
        record_type: '10-K',
        metadata: {},
        content_hash: 'hash1',
        title: 'Filing',
      },
    ];

    const mockSupa = createMockSupabase(records);
    const { exportTrainingData } = await import('../trainingExporter.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await exportTrainingData(mockSupa as any);

    // Verify update was called on the from chain
    const fromCalls = mockSupa.from.mock.calls;
    expect(fromCalls.some((c: string[]) => c[0] === 'public_records')).toBe(true);
  });

  it('handles empty result set', async () => {
    const mockSupa = createMockSupabase([]);
    const { exportTrainingData } = await import('../trainingExporter.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await exportTrainingData(mockSupa as any);

    expect(mockAppendFileSync).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('No unexported')
    );
  });
});

describe('formatJsonlLine', () => {
  it('formats record as JSON string', () => {
    const record = {
      id: 'test-id',
      source_url: 'https://example.com',
      record_type: '10-K',
      metadata: { key: 'value' },
      content_hash: 'hash123',
      title: 'Test Title',
    };
    const line = formatJsonlLine(record);
    const parsed = JSON.parse(line);
    expect(parsed.text).toBe('Test Title');
    expect(parsed.fingerprint).toBe('hash123');
    expect(parsed.source_url).toBe('https://example.com');
  });
});
