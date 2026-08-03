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

// =============================================================================
// SILENT-FAILURE GUARD: a discarded Supabase `error` must not produce a
// COMPLETE report with fabricated-empty data (same defect class as the
// `.in()`-filter / chunkedRead silent-success bugs documented in
// src/jobs/agents.md and src/utils/jobPostcondition.ts).
// =============================================================================
describe('generateReport — Supabase read error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Returns the mock chain shape for a given table's terminal call, per the
   * exact call sites in report-generator.ts:
   *  - integrity_scores : .select(...).eq(...)                       [terminal at .eq]
   *  - anchors          : .select(...).eq(...).gte(...)              [terminal at .gte]
   *  - audit_events     : .select(...).eq(...).order(...).limit(...) [terminal at .limit]
   */
  function tableChain(table: string, result: { data: unknown; error: unknown }) {
    switch (table) {
      case 'anchors':
        return { select: () => ({ eq: () => ({ gte: () => Promise.resolve(result) }) }) };
      case 'audit_events':
        return {
          select: () => ({
            eq: () => ({ order: () => ({ limit: () => Promise.resolve(result) }) }),
          }),
        };
      default: // integrity_scores
        return { select: () => ({ eq: () => Promise.resolve(result) }) };
    }
  }

  /**
   * Drives generateReport() end-to-end with a real DB error surfaced on
   * `erroringTable`, and captures every `ai_reports` update payload so the
   * test can assert on the FINAL status write (what actually gets persisted).
   */
  async function runWithTableError(reportType: string, erroringTable: string) {
    const { db } = await import('../utils/db.js');
    const updateCalls: Array<Record<string, unknown>> = [];

    const reportRow = {
      id: 'report-err',
      org_id: 'org-1',
      report_type: reportType,
      parameters: {},
    };

    const dbError = { message: 'connection terminated unexpectedly', code: '57P01' };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db.from as any).mockImplementation((table: string) => {
      if (table === 'ai_reports') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: reportRow, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => {
            updateCalls.push(payload);
            return { eq: () => Promise.resolve({ data: null, error: null }) };
          },
        };
      }

      if (table === erroringTable) {
        return tableChain(table, { data: null, error: dbError });
      }

      return tableChain(table, { data: [], error: null });
    });

    const { generateReport } = await import('./report-generator.js');
    const ok = await generateReport('report-err');
    return { ok, updateCalls };
  }

  it('does not mark integrity_summary COMPLETE when integrity_scores read errors', async () => {
    const { ok, updateCalls } = await runWithTableError('integrity_summary', 'integrity_scores');

    const finalUpdate = updateCalls[updateCalls.length - 1];
    expect(finalUpdate.status).not.toBe('COMPLETE');
    expect(ok).toBe(false);
  });

  it('does not mark credential_analytics COMPLETE when anchors read errors', async () => {
    const { ok, updateCalls } = await runWithTableError('credential_analytics', 'anchors');

    const finalUpdate = updateCalls[updateCalls.length - 1];
    expect(finalUpdate.status).not.toBe('COMPLETE');
    expect(ok).toBe(false);
  });

  it('does not mark compliance_overview COMPLETE when audit_events read errors', async () => {
    const { ok, updateCalls } = await runWithTableError('compliance_overview', 'audit_events');

    const finalUpdate = updateCalls[updateCalls.length - 1];
    expect(finalUpdate.status).not.toBe('COMPLETE');
    expect(ok).toBe(false);
  });
});
