/**
 * BulkUploadWizard E2E Tests
 *
 * Tests the complete flow including success and failure rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BulkUploadWizard } from './BulkUploadWizard';

// Hoist mock function
const mockRpc = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mockRpc,
  },
}));

vi.mock('@/hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    canCreateCount: () => true,
    remaining: 1000,
    refresh: vi.fn().mockResolvedValue(undefined),
    canCreateAnchor: true,
    recordsUsed: 0,
    recordsLimit: 1000,
    percentUsed: 0,
    isNearLimit: false,
    planName: 'Professional',
    loading: false,
    error: null,
  }),
}));

describe('BulkUploadWizard', () => {
  const mockOnComplete = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render upload step initially', () => {
    render(<BulkUploadWizard onComplete={mockOnComplete} onCancel={mockOnCancel} />);

    expect(screen.getByText('Bulk Upload Records')).toBeInTheDocument();
    expect(screen.getByText(/drop your csv or excel file here/i)).toBeInTheDocument();
  });

  it('should show progress steps', () => {
    render(<BulkUploadWizard />);

    expect(screen.getByText('Upload')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
    expect(screen.getByText('Process')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });

  it('should process CSV and move to review step', async () => {
    render(<BulkUploadWizard />);

    const fingerprint = 'a'.repeat(64);
    const csvContent = `fingerprint,filename,email
${fingerprint},test.pdf,user@example.com`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Valid records')).toBeInTheDocument();
    });

    // Should show 1 valid record
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('should auto-detect and show credential_type and metadata mapping', async () => {
    render(<BulkUploadWizard />);

    const fingerprint = 'a'.repeat(64);
    const csvContent = `fingerprint,filename,credential_type,metadata
${fingerprint},degree.pdf,DEGREE,"{""issuer"": ""MIT""}"`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Valid records')).toBeInTheDocument();
    });

    // The review step should show credential type and metadata mapping selects
    expect(screen.getByText('Credential Type')).toBeInTheDocument();
    expect(screen.getByText('Metadata (JSON)')).toBeInTheDocument();
  });

  it('should show validation errors for invalid rows', async () => {
    render(<BulkUploadWizard />);

    const validFingerprint = 'a'.repeat(64);
    const csvContent = `fingerprint,filename,email
${validFingerprint},valid.pdf,valid@example.com
invalid-fp,invalid.pdf,bad-email`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Validation Errors')).toBeInTheDocument();
    });

    // Should show error for invalid fingerprint
    expect(screen.getByText(/invalid fingerprint/i)).toBeInTheDocument();
  });

  it('should process valid records and show completion', async () => {
    mockRpc.mockResolvedValue({
      data: {
        total: 2,
        created: 2,
        skipped: 0,
        failed: 0,
        results: [
          { fingerprint: 'a'.repeat(64), status: 'created', id: 'uuid-1' },
          { fingerprint: 'b'.repeat(64), status: 'created', id: 'uuid-2' },
        ],
      },
      error: null,
    });

    render(<BulkUploadWizard onComplete={mockOnComplete} />);

    // Upload CSV
    const fp1 = 'a'.repeat(64);
    const fp2 = 'b'.repeat(64);
    const csvContent = `fingerprint,filename
${fp1},file1.pdf
${fp2},file2.pdf`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    // Wait for review step
    await waitFor(() => {
      expect(screen.getByText('Process 2 Records')).toBeInTheDocument();
    });

    // Click process
    const processButton = screen.getByText('Process 2 Records');
    fireEvent.click(processButton);

    // Wait for completion
    await waitFor(() => {
      expect(screen.getByText('Upload Complete')).toBeInTheDocument();
    });

    expect(screen.getByText('2 Created')).toBeInTheDocument();
    expect(mockOnComplete).toHaveBeenCalledWith({
      total: 2,
      created: 2,
      skipped: 0,
      failed: 0,
    });
  });

  it('should handle mixed success and failure results', async () => {
    mockRpc.mockResolvedValue({
      data: {
        total: 3,
        created: 1,
        skipped: 1,
        failed: 1,
        results: [
          { fingerprint: 'a'.repeat(64), status: 'created', id: 'uuid-1' },
          { fingerprint: 'b'.repeat(64), status: 'skipped', reason: 'duplicate' },
          { fingerprint: 'c'.repeat(64), status: 'failed', reason: 'error' },
        ],
      },
      error: null,
    });

    render(<BulkUploadWizard onComplete={mockOnComplete} />);

    // Upload CSV with 3 valid records
    const fp1 = 'a'.repeat(64);
    const fp2 = 'b'.repeat(64);
    const fp3 = 'c'.repeat(64);
    const csvContent = `fingerprint,filename
${fp1},file1.pdf
${fp2},file2.pdf
${fp3},file3.pdf`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    // Wait for review step
    await waitFor(() => {
      expect(screen.getByText('Process 3 Records')).toBeInTheDocument();
    });

    // Click process
    fireEvent.click(screen.getByText('Process 3 Records'));

    // Wait for completion with issues
    await waitFor(() => {
      expect(screen.getByText('Upload Completed with Issues')).toBeInTheDocument();
    });

    expect(screen.getByText('1 Created')).toBeInTheDocument();
    expect(screen.getByText('1 Skipped')).toBeInTheDocument();
    expect(screen.getByText('1 Failed')).toBeInTheDocument();
  });

  it('should allow uploading another file after completion', async () => {
    mockRpc.mockResolvedValue({
      data: {
        total: 1,
        created: 1,
        skipped: 0,
        failed: 0,
        results: [{ fingerprint: 'a'.repeat(64), status: 'created', id: 'uuid-1' }],
      },
      error: null,
    });

    render(<BulkUploadWizard />);

    // First upload
    const csvContent = `fingerprint,filename
${'a'.repeat(64)},file.pdf`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Process 1 Records')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Process 1 Records'));

    await waitFor(() => {
      expect(screen.getByText('Upload Complete')).toBeInTheDocument();
    });

    // Click "Upload Another File"
    fireEvent.click(screen.getByText('Upload Another File'));

    // Should be back to upload step
    await waitFor(() => {
      expect(screen.getByText(/drop your csv or excel file here/i)).toBeInTheDocument();
    });
  });

  it('should handle 500 rows end-to-end', async () => {
    // Mock returns total across all batches
    mockRpc.mockResolvedValue({
      data: {
        total: 50, // Each batch of 50
        created: 50,
        skipped: 0,
        failed: 0,
        results: [],
      },
      error: null,
    });

    render(<BulkUploadWizard onComplete={mockOnComplete} />);

    // Generate 500 rows
    const header = 'fingerprint,filename';
    const rows = Array.from({ length: 500 }, (_, i) => {
      const fp = (('a'.codePointAt(0) ?? 97) + (i % 26)).toString(16).padStart(2, '0').repeat(32);
      return `${fp},file${i}.pdf`;
    });

    const csvContent = [header, ...rows].join('\n');
    const file = new File([csvContent], 'bulk.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(
      () => {
        expect(screen.getByText('Process 500 Records')).toBeInTheDocument();
      },
      { timeout: 5000 }
    );

    fireEvent.click(screen.getByText('Process 500 Records'));

    await waitFor(
      () => {
        expect(screen.getByText('Upload Complete')).toBeInTheDocument();
      },
      { timeout: 10000 }
    );

    // Check that created count is shown (sum of batches)
    expect(screen.getByText(/Created/)).toBeInTheDocument();
    // onComplete should be called with totals
    expect(mockOnComplete).toHaveBeenCalled();
  });

  it('should show progress bar during processing', async () => {
    // Slow mock to observe progress
    let resolveRpc: (value: unknown) => void;
    mockRpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRpc = resolve;
        })
    );

    render(<BulkUploadWizard />);

    const csvContent = `fingerprint,filename
${'a'.repeat(64)},file.pdf`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Process 1 Records')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Process 1 Records'));

    // Should show processing state
    await waitFor(() => {
      expect(screen.getByText('Processing records...')).toBeInTheDocument();
    });

    // Should show progress indicator (X of Y)
    expect(screen.getByText(/of 1 records/)).toBeInTheDocument();

    // Resolve the mock
    resolveRpc!({
      data: { total: 1, created: 1, skipped: 0, failed: 0, results: [] },
      error: null,
    });

    await waitFor(() => {
      expect(screen.getByText('Upload Complete')).toBeInTheDocument();
    });
  });
});
