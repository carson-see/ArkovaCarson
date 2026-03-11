/**
 * Unit tests for report generation job
 *
 * HARDENING-5: processReport state machine, all 4 report types,
 * error handling, processPendingReports batch flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Hoisted mocks ----

const {
  mockFrom,
  mockLogger,
  setThenable,
  reportsTable,
  reportArtifactsTable,
  anchorsTable,
  auditEventsTable,
  billingEventsTable,
} = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  /** Assigns a `.then` property — intentional thenable mock matching Supabase's PostgREST builder. */
  function setThenable(obj: any, handler: (onFulfilled: any, onRejected?: any) => any) {
    Object.defineProperty(obj, 'then', { // NOSONAR — intentional thenable for Supabase mock
      value: vi.fn(handler),
      configurable: true,
      writable: true,
    });
  }

  // Build chainable query mocks per table
  function createChainableMock() {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.insert = vi.fn(() => chain);
    chain.update = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.is = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    // Terminal: resolve to { data, error }
    chain._resolve = { data: null, error: null };
    // Make the chain thenable
    setThenable(chain, (onFulfilled: any) => Promise.resolve(onFulfilled(chain._resolve)));
    return chain;
  }

  const reportsTable = createChainableMock();
  const reportArtifactsTable = createChainableMock();
  const anchorsTable = createChainableMock();
  const auditEventsTable = createChainableMock();
  const billingEventsTable = createChainableMock();

  const mockFrom = vi.fn((table: string) => {
    switch (table) {
      case 'reports':
        return reportsTable;
      case 'report_artifacts':
        return reportArtifactsTable;
      case 'anchors':
        return anchorsTable;
      case 'audit_events':
        return auditEventsTable;
      case 'billing_events':
        return billingEventsTable;
      default:
        return createChainableMock();
    }
  });

  return {
    mockFrom,
    mockLogger,
    setThenable,
    reportsTable,
    reportArtifactsTable,
    anchorsTable,
    auditEventsTable,
    billingEventsTable,
  };
});

vi.mock('../utils/db.js', () => ({
  db: { from: mockFrom },
}));

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

import { processReport, processPendingReports } from './report.js';

function makeReport(overrides: Partial<{
  id: string;
  user_id: string;
  org_id: string | null;
  report_type: 'anchor_summary' | 'compliance_audit' | 'activity_log' | 'billing_history';
  parameters: Record<string, unknown>;
}> = {}) {
  return {
    id: 'report-001',
    user_id: 'user-001',
    org_id: 'org-001',
    report_type: 'anchor_summary' as const,
    parameters: {},
    ...overrides,
  };
}

describe('processReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all DB ops succeed
    reportsTable._resolve = { data: null, error: null };
    setThenable(reportsTable, (onFulfilled: any) =>
      Promise.resolve(onFulfilled(reportsTable._resolve))
    );
    reportArtifactsTable._resolve = { data: null, error: null };
    setThenable(reportArtifactsTable, (onFulfilled: any) =>
      Promise.resolve(onFulfilled(reportArtifactsTable._resolve))
    );
    anchorsTable._resolve = { data: [], error: null };
    setThenable(anchorsTable, (onFulfilled: any) =>
      Promise.resolve(onFulfilled(anchorsTable._resolve))
    );
    auditEventsTable._resolve = { data: [], error: null };
    setThenable(auditEventsTable, (onFulfilled: any) =>
      Promise.resolve(onFulfilled(auditEventsTable._resolve))
    );
    billingEventsTable._resolve = { data: [], error: null };
    setThenable(billingEventsTable, (onFulfilled: any) =>
      Promise.resolve(onFulfilled(billingEventsTable._resolve))
    );
  });

  it('sets status to "generating" before processing', async () => {
    await processReport(makeReport());

    expect(reportsTable.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generating' })
    );
  });

  it('returns false when initial status update fails', async () => {
    reportsTable._resolve = { data: null, error: { message: 'DB error' } };

    const result = await processReport(makeReport());

    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('returns true on successful anchor_summary report', async () => {
    anchorsTable._resolve = {
      data: [
        { id: '1', status: 'SECURED', created_at: '2026-01-01' },
        { id: '2', status: 'PENDING', created_at: '2026-01-02' },
      ],
      error: null,
    };

    const result = await processReport(makeReport({ report_type: 'anchor_summary' }));

    expect(result).toBe(true);
    expect(mockFrom).toHaveBeenCalledWith('anchors');
    expect(mockFrom).toHaveBeenCalledWith('report_artifacts');
  });

  it('returns true on successful compliance_audit report', async () => {
    auditEventsTable._resolve = { data: [{ id: 'evt1' }], error: null };

    const result = await processReport(makeReport({ report_type: 'compliance_audit' }));

    expect(result).toBe(true);
    expect(mockFrom).toHaveBeenCalledWith('audit_events');
  });

  it('returns true on successful activity_log report', async () => {
    auditEventsTable._resolve = { data: [], error: null };

    const result = await processReport(makeReport({ report_type: 'activity_log' }));

    expect(result).toBe(true);
    expect(mockFrom).toHaveBeenCalledWith('audit_events');
  });

  it('returns true on successful billing_history report', async () => {
    billingEventsTable._resolve = { data: [], error: null };

    const result = await processReport(makeReport({ report_type: 'billing_history' }));

    expect(result).toBe(true);
    expect(mockFrom).toHaveBeenCalledWith('billing_events');
  });

  it('queries anchors table for anchor_summary', async () => {
    await processReport(makeReport({ report_type: 'anchor_summary' }));

    expect(mockFrom).toHaveBeenCalledWith('anchors');
    expect(anchorsTable.select).toHaveBeenCalledWith('id, status, created_at');
    expect(anchorsTable.eq).toHaveBeenCalledWith('user_id', 'user-001');
    expect(anchorsTable.is).toHaveBeenCalledWith('deleted_at', null);
  });

  it('queries audit_events with limit 1000 for compliance_audit', async () => {
    await processReport(makeReport({ report_type: 'compliance_audit' }));

    expect(mockFrom).toHaveBeenCalledWith('audit_events');
    expect(auditEventsTable.select).toHaveBeenCalledWith('*');
    expect(auditEventsTable.limit).toHaveBeenCalledWith(1000);
  });

  it('queries audit_events with limit 500 for activity_log', async () => {
    await processReport(makeReport({ report_type: 'activity_log' }));

    expect(mockFrom).toHaveBeenCalledWith('audit_events');
    expect(auditEventsTable.limit).toHaveBeenCalledWith(500);
  });

  it('stores artifact with correct filename pattern', async () => {
    await processReport(makeReport({ id: 'report-xyz', report_type: 'anchor_summary' }));

    expect(reportArtifactsTable.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        report_id: 'report-xyz',
        filename: 'arkova-anchor_summary-report-xyz.json',
        mime_type: 'application/json',
      })
    );
  });

  it('sets completed status with 30-day expiry', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-10T12:00:00Z') });

    await processReport(makeReport());

    // Check the final update call sets completed status
    const updateCalls = reportsTable.update.mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1][0];
    expect(lastUpdate.status).toBe('completed');
    expect(lastUpdate.completed_at).toBeDefined();
    expect(lastUpdate.expires_at).toBeDefined();

    // Verify 30-day expiry
    const expiry = new Date(lastUpdate.expires_at);
    const expected = new Date('2026-04-09T12:00:00Z');
    expect(expiry.getTime()).toBe(expected.getTime());

    vi.useRealTimers();
  });

  it('marks report as failed on generation error', async () => {
    // Make anchors query throw by having .then() reject properly
    // We override .then so the thenable rejects when awaited
    const originalThen = anchorsTable.then;
    setThenable(anchorsTable, (onFulfilled: any, onRejected?: any) => {
      const rejection = Promise.reject(new Error('DB connection lost'));
      return rejection.then(onFulfilled, onRejected);
    });

    const result = await processReport(makeReport({ report_type: 'anchor_summary' }));

    expect(result).toBe(false);
    const updateCalls = reportsTable.update.mock.calls;
    const lastUpdate = updateCalls[updateCalls.length - 1][0];
    expect(lastUpdate.status).toBe('failed');
    expect(lastUpdate.error_message).toBe('DB connection lost');

    setThenable(anchorsTable, originalThen);
  });

  it('handles null org_id', async () => {
    const result = await processReport(makeReport({ org_id: null }));

    expect(result).toBe(true);
  });
});

describe('processPendingReports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults
    reportsTable._resolve = { data: null, error: null };
    setThenable(reportsTable, (onFulfilled: any) =>
      Promise.resolve(onFulfilled(reportsTable._resolve))
    );
    reportArtifactsTable._resolve = { data: null, error: null };
    setThenable(reportArtifactsTable, (onFulfilled: any) =>
      Promise.resolve(onFulfilled(reportArtifactsTable._resolve))
    );
    anchorsTable._resolve = { data: [], error: null };
    setThenable(anchorsTable, (onFulfilled: any) =>
      Promise.resolve(onFulfilled(anchorsTable._resolve))
    );
    auditEventsTable._resolve = { data: [], error: null };
    setThenable(auditEventsTable, (onFulfilled: any) =>
      Promise.resolve(onFulfilled(auditEventsTable._resolve))
    );
    billingEventsTable._resolve = { data: [], error: null };
    setThenable(billingEventsTable, (onFulfilled: any) =>
      Promise.resolve(onFulfilled(billingEventsTable._resolve))
    );
  });

  it('returns { processed: 0, failed: 0 } when query fails', async () => {
    // First call to reportsTable is the pending query
    reportsTable._resolve = { data: null, error: { message: 'connection refused' } };

    const result = await processPendingReports();

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('returns { processed: 0, failed: 0 } when no pending reports', async () => {
    reportsTable._resolve = { data: [], error: null };

    const result = await processPendingReports();

    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('returns { processed: 0, failed: 0 } when data is null', async () => {
    reportsTable._resolve = { data: null, error: null };

    const result = await processPendingReports();

    expect(result).toEqual({ processed: 0, failed: 0 });
  });

  it('queries reports table with correct filters', async () => {
    reportsTable._resolve = { data: [], error: null };

    await processPendingReports();

    expect(mockFrom).toHaveBeenCalledWith('reports');
    expect(reportsTable.select).toHaveBeenCalledWith('*');
    expect(reportsTable.eq).toHaveBeenCalledWith('status', 'pending');
    expect(reportsTable.order).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(reportsTable.limit).toHaveBeenCalledWith(10);
  });

  it('processes multiple reports and counts successes', async () => {
    // Return two pending reports on the first call, then succeed on subsequent calls
    let callCount = 0;
    setThenable(reportsTable, (onFulfilled: any) => {
      callCount++;
      if (callCount === 1) {
        // First call: the pending query
        return Promise.resolve(
          onFulfilled({
            data: [
              makeReport({ id: 'r1', report_type: 'anchor_summary' }),
              makeReport({ id: 'r2', report_type: 'activity_log' }),
            ],
            error: null,
          })
        );
      }
      // Subsequent calls: status updates succeed
      return Promise.resolve(onFulfilled({ data: null, error: null }));
    });

    const result = await processPendingReports();

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('counts failed reports separately', async () => {
    let callCount = 0;
    setThenable(reportsTable, (onFulfilled: any) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          onFulfilled({
            data: [makeReport({ id: 'r1' })],
            error: null,
          })
        );
      }
      // All subsequent update calls fail → processReport returns false
      return Promise.resolve(onFulfilled({ data: null, error: { message: 'fail' } }));
    });

    const result = await processPendingReports();

    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);
  });
});
