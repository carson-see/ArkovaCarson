/**
 * BulkUploadWizard E2E Tests
 *
 * Tests the complete flow including success and failure rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BulkUploadWizard, mergeExtractionResults } from './BulkUploadWizard';
import { BULK_IMPORT_LABELS } from '@/lib/copy';

// Hoist mock function
const mockRpc = vi.hoisted(() => vi.fn());
const mockCapability = vi.hoisted(() => ({ current: { canSecureInstantly: true, creditBalance: 5, instantSecureCost: 1 } }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mockRpc,
  },
}));
vi.mock('@/hooks/useSecuringCapability', () => ({
  useSecuringCapability: () => ({ capability: mockCapability.current }),
}));
vi.mock('@/lib/workerClient', () => ({
  WORKER_URL: 'http://worker.test',
  workerFetch: vi.fn(async () => {
    const result = await mockRpc();
    return new Response(JSON.stringify(result.data), { status: result.error ? 500 : 200 });
  }),
}));

// Mock AIExtractionStep to auto-skip (avoids supabase.auth.getSession dependency)
vi.mock('./AIExtractionStep', () => ({
  AIExtractionStep: ({ onSkip }: { onSkip: () => void }) => (
    <div data-testid="ai-extraction-step">
      <button onClick={onSkip}>Skip Extraction</button>
    </div>
  ),
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
    mockCapability.current = { canSecureInstantly: true, creditBalance: 5, instantSecureCost: 1 };
  });

  it('merges successful AI fields into the matching row without discarding existing metadata', () => {
    const records = [
      { fingerprint: 'a'.repeat(64), filename: 'a.pdf', metadata: { source: 'sheet', issuerName: 'User issuer' } },
      { fingerprint: 'b'.repeat(64), filename: 'b.pdf', metadata: { keep: 'yes' } },
    ];
    expect(mergeExtractionResults(records, [
      { index: 0, success: true, fields: { issuerName: 'AI issuer', unexpected: 'discard me' } },
      { index: 1, success: false, fields: { ignored: 'value' } },
    ])).toEqual([
      expect.objectContaining({ metadata: { issuerName: 'User issuer', source: 'sheet' } }),
      expect.objectContaining({ metadata: { keep: 'yes' } }),
    ]);
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

  it('should auto-parse an initial spreadsheet from Secure Document detection', async () => {
    const fingerprint = 'c'.repeat(64);
    const file = new File(
      [`fingerprint,filename,email\n${fingerprint},initial.pdf,user@example.com`],
      'initial.csv',
      { type: 'text/csv' }
    );

    render(<BulkUploadWizard initialFiles={[file]} />);

    await waitFor(() => {
      expect(screen.getByText('Valid records')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /^Process 1 Records$/i })).toBeInTheDocument();
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
    expect(screen.getByText('Document Type')).toBeInTheDocument();
    expect(screen.getByText('Metadata (JSON)')).toBeInTheDocument();
  });

  it('offers import-wide description, private tags, and explicit queue or instant action', async () => {
    render(<BulkUploadWizard orgId="child-org" />);
    const file = new File(
      [`fingerprint,filename\n${'a'.repeat(64)},degree.pdf`],
      'records.csv',
      { type: 'text/csv' },
    );
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText('Valid records')).toBeInTheDocument());
    expect(screen.getByLabelText('Public description for every row')).toHaveAttribute('maxlength', '1000');
    expect(screen.getByLabelText('Private tags for every row')).toBeInTheDocument();
    expect(screen.getByLabelText('Organization tags for every row')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add all to queue' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Secure all instantly' })).toBeInTheDocument();
  });

  it('does not silently downgrade a selected instant import when capability becomes unavailable', async () => {
    const { rerender } = render(<BulkUploadWizard orgId="child-org" />);
    const file = new File([`fingerprint,filename\n${'a'.repeat(64)},degree.pdf`], 'records.csv', { type: 'text/csv' });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText('Valid records')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Secure all instantly' }));
    expect(screen.getByText(/one credit per row — up to 1 credit/)).toBeInTheDocument();
    mockCapability.current = { canSecureInstantly: false, creditBalance: 0, instantSecureCost: 1 };
    rerender(<BulkUploadWizard orgId="child-org" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Instant securing is no longer available');
    expect(screen.getByRole('button', { name: /Process 1 Records/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add all to queue' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  // R19 (CTO ruling 2026-07-28): issuer-attestation acknowledgement, required
  // when no fingerprint column is mapped (every row becomes record-derived).
  describe('R19: issuer-attestation acknowledgement', () => {
    it('shows the attestation notice and disables Process when no fingerprint column is mapped', async () => {
      render(<BulkUploadWizard />);

      const csvContent = `name,course\nJane Doe,CPR Certification`;
      const file = new File([csvContent], 'roster.csv', { type: 'text/csv' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(() => {
        expect(screen.getByTestId('record-attestation-notice')).toBeInTheDocument();
      });

      const processButton = screen.getByRole('button', { name: /^Process 1 Records$/i });
      expect(processButton).toBeDisabled();
    });

    it('enables Process once the attestation checkbox is checked', async () => {
      render(<BulkUploadWizard />);

      const csvContent = `name,course\nJane Doe,CPR Certification`;
      const file = new File([csvContent], 'roster.csv', { type: 'text/csv' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(() => {
        expect(screen.getByTestId('record-attestation-checkbox')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('record-attestation-checkbox'));

      const processButton = screen.getByRole('button', { name: /^Process 1 Records$/i });
      expect(processButton).not.toBeDisabled();
    });

    it('does NOT show the attestation notice when a fingerprint column is mapped', async () => {
      render(<BulkUploadWizard />);

      const fingerprint = 'a'.repeat(64);
      const csvContent = `fingerprint,filename\n${fingerprint},test.pdf`;
      const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(() => {
        expect(screen.getByText('Valid records')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('record-attestation-notice')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Process 1 Records$/i })).not.toBeDisabled();
    });
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

    // Click process -> goes to extraction step
    const processButton = screen.getByText('Process 2 Records');
    fireEvent.click(processButton);
    await waitFor(() => { expect(screen.getByText('Skip Extraction')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Skip Extraction'));

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
      needsCredit: 0,
      held: 0,
      instantFailed: 0,
      instantPending: 0,
      instantUnknown: 0,
      recipientLinkFailed: 0,
      recipientOutcomes: { notPermitted: 0, notLinked: 0, linkedNotSent: 0, linkedUnconfirmed: 0, unknown: 0 },
      partial: false,
      action: 'queue',
    });
  });

  // SHOULD-FIX from the #3020 review: the row is secured, so the summary must
  // say so and must NOT invite a re-upload of an anchor that already exists.
  it('reports a secured row whose recipient could not be linked', async () => {
    mockRpc.mockResolvedValue({
      data: {
        total: 1,
        created: 1,
        skipped: 0,
        failed: 0,
        recipient_link_failed: 1,
        results: [{
          fingerprint: 'a'.repeat(64), status: 'created_recipient_failed',
          public_id: 'ARK-1', reason: 'recipient_activation_email_failed',
        }],
      },
      error: null,
    });

    render(<BulkUploadWizard onComplete={mockOnComplete} />);

    const csvContent = `fingerprint,filename\n${'a'.repeat(64)},file1.pdf`;
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => { expect(screen.getByText('Process 1 Records')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Process 1 Records'));
    await waitFor(() => { expect(screen.getByText('Skip Extraction')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Skip Extraction'));

    // S3: `recipient_activation_email_failed` is thrown AFTER the
    // `anchor_recipients` insert commits, so the recipient IS linked and only
    // the invitation did not go. The old single string claimed the opposite.
    await waitFor(() => {
      expect(screen.getByText(BULK_IMPORT_LABELS.RECIPIENT_OUTCOME_LABEL.linkedNotSent(1))).toBeInTheDocument();
    });
    expect(screen.getByText(BULK_IMPORT_LABELS.RECIPIENT_OUTCOME_BODY.linkedNotSent)).toBeInTheDocument();
    expect(screen.queryByText(BULK_IMPORT_LABELS.RECIPIENT_OUTCOME_BODY.notLinked)).not.toBeInTheDocument();
    // The anchor exists: it is counted as created and never as failed.
    expect(screen.getByText('1 Created')).toBeInTheDocument();
    expect(screen.queryByText('1 Failed')).not.toBeInTheDocument();
    expect(mockOnComplete).toHaveBeenCalledWith(expect.objectContaining({
      created: 1, failed: 0, recipientLinkFailed: 1,
      recipientOutcomes: expect.objectContaining({ linkedNotSent: 1, notLinked: 0 }),
    }));
  });

  // B1(c): the forbidden case gets its OWN copy. Telling a personal-scope user
  // that the link "failed" points them at a retry that can never work; the
  // truthful statement is that recipients need organization authority.
  it('reports a recipient the caller is not permitted to add with its own copy', async () => {
    mockRpc.mockResolvedValue({
      data: {
        total: 1, created: 1, skipped: 0, failed: 0, recipient_link_failed: 1,
        results: [{
          fingerprint: 'a'.repeat(64), status: 'created_recipient_failed',
          public_id: 'ARK-1', reason: 'recipient_provisioning_forbidden',
        }],
      },
      error: null,
    });

    render(<BulkUploadWizard onComplete={mockOnComplete} />);
    const csvContent = `fingerprint,filename\n${'a'.repeat(64)},file1.pdf`;
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => { expect(screen.getByText('Process 1 Records')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Process 1 Records'));
    await waitFor(() => { expect(screen.getByText('Skip Extraction')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Skip Extraction'));

    await waitFor(() => {
      expect(screen.getByText(BULK_IMPORT_LABELS.RECIPIENT_OUTCOME_LABEL.notPermitted(1))).toBeInTheDocument();
    });
    expect(screen.getByText(BULK_IMPORT_LABELS.RECIPIENT_OUTCOME_BODY.notPermitted)).toBeInTheDocument();
    expect(screen.queryByText(BULK_IMPORT_LABELS.RECIPIENT_OUTCOME_BODY.notLinked)).not.toBeInTheDocument();
    expect(screen.getByText('1 Created')).toBeInTheDocument();
  });

  it('asserts nothing about a recipient reason it does not recognise', async () => {
    mockRpc.mockResolvedValue({
      data: {
        total: 1, created: 1, skipped: 0, failed: 0, recipient_link_failed: 1,
        results: [{
          fingerprint: 'a'.repeat(64), status: 'created_recipient_failed',
          public_id: 'ARK-1', reason: 'a_reason_from_a_newer_worker',
        }],
      },
      error: null,
    });

    render(<BulkUploadWizard onComplete={mockOnComplete} />);
    const csvContent = `fingerprint,filename\n${'a'.repeat(64)},file1.pdf`;
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => { expect(screen.getByText('Process 1 Records')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Process 1 Records'));
    await waitFor(() => { expect(screen.getByText('Skip Extraction')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Skip Extraction'));

    await waitFor(() => {
      expect(screen.getByText(BULK_IMPORT_LABELS.RECIPIENT_OUTCOME_LABEL.unknown(1))).toBeInTheDocument();
    });
    expect(screen.getByText(BULK_IMPORT_LABELS.RECIPIENT_OUTCOME_BODY.unknown)).toBeInTheDocument();
  });

  // NIT: a batch where EVERY recipient failed rendered the green all-clear
  // "Upload Complete" title, because hasFailures ignored recipientLinkFailed.
  it('does not render the all-clear title when every recipient failed', async () => {
    mockRpc.mockResolvedValue({
      data: {
        total: 1, created: 1, skipped: 0, failed: 0, recipient_link_failed: 1,
        results: [{
          fingerprint: 'a'.repeat(64), status: 'created_recipient_failed',
          public_id: 'ARK-1', reason: 'recipient_link_failed',
        }],
      },
      error: null,
    });

    render(<BulkUploadWizard onComplete={mockOnComplete} />);
    const csvContent = `fingerprint,filename\n${'a'.repeat(64)},file1.pdf`;
    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => { expect(screen.getByText('Process 1 Records')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Process 1 Records'));
    await waitFor(() => { expect(screen.getByText('Skip Extraction')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Skip Extraction'));

    await waitFor(() => {
      expect(screen.getByText(BULK_IMPORT_LABELS.COMPLETE_WITH_ISSUES)).toBeInTheDocument();
    });
    expect(screen.queryByText(BULK_IMPORT_LABELS.COMPLETE)).not.toBeInTheDocument();
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

    // Click process -> extraction step
    fireEvent.click(screen.getByText('Process 3 Records'));
    await waitFor(() => { expect(screen.getByText('Skip Extraction')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Skip Extraction'));

    // Wait for completion with issues
    await waitFor(() => {
      expect(screen.getByText('Upload Completed with Issues')).toBeInTheDocument();
    });

    expect(screen.getByText('1 Created')).toBeInTheDocument();
    expect(screen.getByText('1 Skipped')).toBeInTheDocument();
    expect(screen.getByText('1 Failed')).toBeInTheDocument();
  });

  it('reports instant held, failed, pending, and unavailable states truthfully', async () => {
    const fingerprints = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(64));
    mockRpc.mockResolvedValue({ data: {
      total: 4, created: 4, skipped: 0, failed: 0,
      results: [
        { fingerprint: fingerprints[0], status: 'created', instant_status: 'HELD' },
        { fingerprint: fingerprints[1], status: 'created', instant_status: 'FAILED' },
        { fingerprint: fingerprints[2], status: 'created', instant_status: 'PROCESSING' },
        { fingerprint: fingerprints[3], status: 'created', instant_status: null },
      ],
    }, error: null });
    render(<BulkUploadWizard />);
    const csv = `fingerprint,filename\n${fingerprints.map((fingerprint, index) => `${fingerprint},file${index}.pdf`).join('\n')}`;
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [new File([csv], 'records.csv', { type: 'text/csv' })] },
    });
    await waitFor(() => expect(screen.getByText('Process 4 Records')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Secure all instantly' }));
    fireEvent.click(screen.getByText('Process 4 Records'));
    await waitFor(() => expect(screen.getByText('Skip Extraction')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Skip Extraction'));

    await waitFor(() => expect(screen.getByText('Upload Completed with Issues')).toBeInTheDocument());
    expect(screen.getByText('1 Held for review')).toBeInTheDocument();
    expect(screen.getByText('1 Instant failed')).toBeInTheDocument();
    expect(screen.getByText('1 Instant pending')).toBeInTheDocument();
    expect(screen.getByText('1 Status unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Instant securing states are reported separately/)).toBeInTheDocument();
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
    await waitFor(() => { expect(screen.getByText('Skip Extraction')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Skip Extraction'));

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
    await waitFor(() => { expect(screen.getByText('Skip Extraction')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Skip Extraction'));

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
    await waitFor(() => { expect(screen.getByText('Skip Extraction')).toBeInTheDocument(); });
    fireEvent.click(screen.getByText('Skip Extraction'));

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
