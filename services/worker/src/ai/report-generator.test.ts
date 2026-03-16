/**
 * AI Report Generator Tests (P8-S16)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreateReportSchema } from './report-generator.js';

// Mock db and logger
vi.mock('../utils/db.js', () => ({
  db: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
          gte: vi.fn().mockResolvedValue({ data: [], error: null }),
          order: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            range: vi.fn().mockResolvedValue({ data: [], error: null }),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: { id: 'report-1' }, error: null }),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
      upsert: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock dependencies
vi.mock('./feedback.js', () => ({
  getExtractionAccuracy: vi.fn().mockResolvedValue([]),
}));

vi.mock('./review-queue.js', () => ({
  getReviewQueueStats: vi.fn().mockResolvedValue({
    total: 0, pending: 0, investigating: 0, escalated: 0, approved: 0, dismissed: 0,
  }),
}));

describe('CreateReportSchema', () => {
  it('validates integrity_summary', () => {
    const result = CreateReportSchema.safeParse({
      reportType: 'integrity_summary',
      title: 'Monthly Summary',
    });
    expect(result.success).toBe(true);
  });

  it('validates extraction_accuracy', () => {
    const result = CreateReportSchema.safeParse({
      reportType: 'extraction_accuracy',
      title: 'Accuracy Report',
      parameters: { dateRange: 30 },
    });
    expect(result.success).toBe(true);
  });

  it('validates credential_analytics', () => {
    const result = CreateReportSchema.safeParse({
      reportType: 'credential_analytics',
      title: 'Analytics',
    });
    expect(result.success).toBe(true);
  });

  it('validates compliance_overview', () => {
    const result = CreateReportSchema.safeParse({
      reportType: 'compliance_overview',
      title: 'Compliance Report',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown report type', () => {
    const result = CreateReportSchema.safeParse({
      reportType: 'unknown',
      title: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty title', () => {
    const result = CreateReportSchema.safeParse({
      reportType: 'integrity_summary',
      title: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects title exceeding 200 chars', () => {
    const result = CreateReportSchema.safeParse({
      reportType: 'integrity_summary',
      title: 'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('validates dateRange in parameters', () => {
    const result = CreateReportSchema.safeParse({
      reportType: 'integrity_summary',
      title: 'Test',
      parameters: { dateRange: 365 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects dateRange exceeding 365', () => {
    const result = CreateReportSchema.safeParse({
      reportType: 'integrity_summary',
      title: 'Test',
      parameters: { dateRange: 400 },
    });
    expect(result.success).toBe(false);
  });
});

describe('createReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a report and returns ID', async () => {
    const { createReport } = await import('./report-generator.js');
    const id = await createReport('org-1', 'user-1', 'integrity_summary', 'Test Report');
    expect(id).toBe('report-1');
  });
});

describe('listReports', () => {
  it('returns empty array when no reports', async () => {
    const { listReports } = await import('./report-generator.js');
    const reports = await listReports('org-1');
    expect(reports).toEqual([]);
  });
});

describe('getReport', () => {
  it('returns null when report not found', async () => {
    const { getReport } = await import('./report-generator.js');
    const report = await getReport('nonexistent');
    expect(report).toBeNull();
  });
});
