/**
 * AIReportsPanel Component Tests (P8-S16)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AIReportsPanel } from './AIReportsPanel';

const mockFetchReports = vi.fn();
const mockCreateReport = vi.fn();
const mockFetchReport = vi.fn();

vi.mock('@/hooks/useAIReports', () => ({
  useAIReports: () => ({
    reports: [],
    loading: false,
    creating: false,
    fetchReports: mockFetchReports,
    createReport: mockCreateReport,
    fetchReport: mockFetchReport,
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('AIReportsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the AI reports header', () => {
    render(<AIReportsPanel />);
    expect(screen.getByText('AI Reports')).toBeTruthy();
  });

  it('renders empty state when no reports', () => {
    render(<AIReportsPanel />);
    expect(screen.getByText('No reports yet')).toBeTruthy();
  });

  it('renders the generate button', () => {
    render(<AIReportsPanel />);
    expect(screen.getByText('Generate Report')).toBeTruthy();
  });

  it('calls fetchReports on mount', () => {
    render(<AIReportsPanel />);
    expect(mockFetchReports).toHaveBeenCalled();
  });

  it('shows report type selector when generate clicked', async () => {
    render(<AIReportsPanel />);
    const button = screen.getByText('Generate Report');
    fireEvent.click(button);

    expect(screen.getByText('Select Report Type')).toBeTruthy();
    expect(screen.getByText('Integrity Summary')).toBeTruthy();
    expect(screen.getByText('Extraction Accuracy')).toBeTruthy();
    expect(screen.getByText('Credential Analytics')).toBeTruthy();
    expect(screen.getByText('Compliance Overview')).toBeTruthy();
  });

  it('renders description text', () => {
    render(<AIReportsPanel />);
    expect(screen.getByText('Generate analytics and compliance reports')).toBeTruthy();
  });
});

describe('AIReportsPanel with reports', () => {
  it('renders report list', () => {
    vi.doMock('@/hooks/useAIReports', () => ({
      useAIReports: () => ({
        reports: [
          {
            id: 'report-1',
            orgId: 'org-1',
            requestedBy: 'user-1',
            reportType: 'integrity_summary',
            status: 'COMPLETE',
            title: 'Monthly Summary',
            parameters: {},
            result: { totalCredentials: 100, averageScore: 82 },
            errorMessage: null,
            startedAt: '2026-03-16T10:00:00Z',
            completedAt: '2026-03-16T10:01:00Z',
            createdAt: '2026-03-16T10:00:00Z',
          },
        ],
        loading: false,
        creating: false,
        fetchReports: mockFetchReports,
        createReport: mockCreateReport,
        fetchReport: mockFetchReport,
      }),
    }));
  });
});
