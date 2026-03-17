/**
 * BETA-06: AIExtractionStep Component Tests
 *
 * Tests the per-row AI extraction step in the BulkUploadWizard.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AIExtractionStep } from './AIExtractionStep';
import type { CsvColumn, CsvRow, ColumnMapping } from '@/lib/csvParser';

// Mock the supabase module
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: 'test-token' } },
      }),
    },
  },
}));

// Mock fetch for the batch extraction API
const mockFetch = vi.fn();
global.fetch = mockFetch;

const mockColumns: CsvColumn[] = [
  { index: 0, name: 'name', sample: 'John Doe' },
  { index: 1, name: 'degree', sample: 'BS Computer Science' },
  { index: 2, name: 'institution', sample: 'MIT' },
];

const mockMapping: ColumnMapping = {
  fingerprint: null,
  filename: null,
  fileSize: null,
  email: null,
  credentialType: null,
  metadata: null,
};

const mockRows: CsvRow[] = [
  { rowNumber: 1, data: { name: 'John Doe', degree: 'BS Computer Science', institution: 'MIT' } },
  { rowNumber: 2, data: { name: 'Jane Smith', degree: 'MS Physics', institution: 'Stanford' } },
];

describe('AIExtractionStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders extraction step with row count', () => {
    render(
      <AIExtractionStep
        rows={mockRows}
        columns={mockColumns}
        mapping={mockMapping}
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />
    );

    expect(screen.getAllByText(/2 rows/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/AI Extraction/i)).toBeInTheDocument();
  });

  it('shows extract and skip buttons', () => {
    render(
      <AIExtractionStep
        rows={mockRows}
        columns={mockColumns}
        mapping={mockMapping}
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /extract/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /skip/i })).toBeInTheDocument();
  });

  it('calls onSkip when skip button clicked', () => {
    const onSkip = vi.fn();
    render(
      <AIExtractionStep
        rows={mockRows}
        columns={mockColumns}
        mapping={mockMapping}
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={onSkip}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(onSkip).toHaveBeenCalled();
  });

  it('calls onBack when back button clicked', () => {
    const onBack = vi.fn();
    render(
      <AIExtractionStep
        rows={mockRows}
        columns={mockColumns}
        mapping={mockMapping}
        onComplete={vi.fn()}
        onBack={onBack}
        onSkip={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows progress during extraction', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        results: [
          { index: 0, success: true, fields: { credentialType: 'DEGREE' }, confidence: 0.9 },
          { index: 1, success: true, fields: { credentialType: 'DEGREE' }, confidence: 0.8 },
        ],
        summary: { total: 2, succeeded: 2, failed: 0 },
        creditsRemaining: 488,
      }),
    });

    render(
      <AIExtractionStep
        rows={mockRows}
        columns={mockColumns}
        mapping={mockMapping}
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /extract/i }));

    await waitFor(() => {
      expect(screen.getByText(/Analyzing/i)).toBeInTheDocument();
    });
  });

  it('calls onComplete with results after successful extraction', async () => {
    const extractionResults = {
      results: [
        { index: 0, success: true, fields: { credentialType: 'DEGREE', issuerName: 'MIT' }, confidence: 0.9 },
        { index: 1, success: true, fields: { credentialType: 'DEGREE', issuerName: 'Stanford' }, confidence: 0.85 },
      ],
      summary: { total: 2, succeeded: 2, failed: 0 },
      creditsRemaining: 488,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(extractionResults),
    });

    const onComplete = vi.fn();
    render(
      <AIExtractionStep
        rows={mockRows}
        columns={mockColumns}
        mapping={mockMapping}
        onComplete={onComplete}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /extract/i }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith(extractionResults.results);
    });
  });

  it('handles API errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'batch_extraction_failed', message: 'Server error' }),
    });

    render(
      <AIExtractionStep
        rows={mockRows}
        columns={mockColumns}
        mapping={mockMapping}
        onComplete={vi.fn()}
        onBack={vi.fn()}
        onSkip={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /extract/i }));

    await waitFor(() => {
      expect(screen.getByText(/Server error/i)).toBeInTheDocument();
    });
  });
});
