/**
 * FileUpload Component Tests (SCRUM-1789; W2 / F1 dual-mode 2026-07-28)
 *
 * Verifies upload routing: single file → onFileSelect, multi-file → onBulkDetected,
 * single CSV/XLSX/XLS/TSV → explicit mode-choice step (W2), disabled state blocks
 * processing. Also tests exported helper functions: isBulkUploadFile, isJsonFile.
 *
 * W2 / F1 (founder ruling 2026-07-28): FOUND BUG — a dropped spreadsheet used to
 * be intercepted by isBulkUploadFile() and routed to onBulkDetected() BEFORE
 * generateFingerprint was ever called, so a spreadsheet could never reach the
 * single-document anchoring path. The "does not reach generateFingerprint before
 * a mode is chosen" tests below pin the pre-choice half of that behavior (still
 * correct — routing must not happen automatically); the "record mode" describe
 * block pins that row-mode/bulk import is UNCHANGED; the "document mode" describe
 * block is the actual regression test proving the bug is fixed — choosing
 * "Secure this file as a document" now reaches generateFingerprint / onFileSelect
 * for a real spreadsheet file, which was previously impossible for ANY choice.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileUpload, isBulkUploadFile, isJsonFile } from './FileUpload';

const mockGenerateFingerprint = vi.fn().mockResolvedValue('a'.repeat(64));
vi.mock('@/lib/fileHasher', () => ({
  generateFingerprint: (...args: unknown[]) => mockGenerateFingerprint(...args),
}));

vi.mock('@/components/layout/ArkovaLogo', () => ({
  ArkovaIcon: ({ className }: { className?: string }) => (
    <svg data-testid="arkova-icon" className={className} />
  ),
}));

function renderUpload(props: Partial<Parameters<typeof FileUpload>[0]> = {}) {
  const onFileSelect = vi.fn();
  const onBulkDetected = vi.fn();
  const result = render(
    <FileUpload onFileSelect={onFileSelect} onBulkDetected={onBulkDetected} {...props} />
  );
  const input = result.container.querySelector('input[type="file"]') as HTMLInputElement;
  return { input, onFileSelect, onBulkDetected };
}

function changeFiles(input: HTMLInputElement, files: File | File[]) {
  fireEvent.change(input, { target: { files: Array.isArray(files) ? files : [files] } });
}

describe('FileUpload', () => {
  it('does not process files when disabled', () => {
    const { input, onFileSelect, onBulkDetected } = renderUpload({ disabled: true });
    changeFiles(input, new File(['x'], 'document.pdf', { type: 'application/pdf' }));
    expect(onFileSelect).not.toHaveBeenCalled();
    expect(onBulkDetected).not.toHaveBeenCalled();
  });

  it('routes multiple files to bulk mode via onBulkDetected', () => {
    const { input, onFileSelect, onBulkDetected } = renderUpload();
    expect(input.multiple).toBe(true);
    const files = [
      new File(['one'], 'bulk-one.pdf', { type: 'application/pdf' }),
      new File(['two'], 'bulk-two.pdf', { type: 'application/pdf' }),
    ];
    changeFiles(input, files);
    expect(onBulkDetected).toHaveBeenCalledWith(files);
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('routes single file to onFileSelect with fingerprint', async () => {
    const { input, onFileSelect, onBulkDetected } = renderUpload();
    const file = new File(['single doc'], 'document.pdf', { type: 'application/pdf' });
    changeFiles(input, file);
    await vi.waitFor(() => {
      expect(onFileSelect).toHaveBeenCalledWith(file, 'a'.repeat(64));
    });
    expect(onBulkDetected).not.toHaveBeenCalled();
  });

  it('renders upload affordance text', () => {
    render(<FileUpload onFileSelect={vi.fn()} />);
    expect(screen.getByText(/drag and drop your document/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// W2 / F1 — spreadsheet dual-mode (founder ruling 2026-07-28)
//
// A single dropped/selected spreadsheet no longer routes straight to
// onBulkDetected (row/records mode) OR straight to onFileSelect (document
// mode) — it pauses on an explicit mode-choice step and neither callback
// fires until the user picks. A multi-file drop is untouched (still routes
// straight to onBulkDetected, tested above).
// ---------------------------------------------------------------------------
describe('FileUpload — spreadsheet dual-mode (W2 / F1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['records.csv', 'text/csv'],
    ['records.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['records.xls', 'application/vnd.ms-excel'],
    ['records.tsv', ''],
  ])('a single %s file pauses on the mode-choice step (neither callback fires yet)', (name, type) => {
    const { input, onFileSelect, onBulkDetected } = renderUpload();
    const file = new File(['a,b\n1,2'], name, { type });
    changeFiles(input, file);

    expect(screen.getByTestId('spreadsheet-mode-choice')).toBeInTheDocument();
    expect(screen.getByText(name)).toBeInTheDocument();
    expect(onBulkDetected).not.toHaveBeenCalled();
    expect(onFileSelect).not.toHaveBeenCalled();
    expect(mockGenerateFingerprint).not.toHaveBeenCalled();
  });

  it('a mixed multi-file drop (one of which is a spreadsheet) still routes straight to bulk mode — W1 surface untouched', () => {
    const { input, onFileSelect, onBulkDetected } = renderUpload();
    const files = [
      new File(['pdf-bytes'], 'cert.pdf', { type: 'application/pdf' }),
      new File(['csv-bytes'], 'roster.csv', { type: 'text/csv' }),
    ];
    changeFiles(input, files);

    expect(onBulkDetected).toHaveBeenCalledWith(files);
    expect(onFileSelect).not.toHaveBeenCalled();
    expect(screen.queryByTestId('spreadsheet-mode-choice')).not.toBeInTheDocument();
  });

  describe('record mode (row-mode / bulk-import path — UNCHANGED, this is the original intent)', () => {
    it('choosing "Import as a list of records" calls onBulkDetected with exactly the one file, and never calls onFileSelect/generateFingerprint', () => {
      const { input, onFileSelect, onBulkDetected } = renderUpload();
      const file = new File(['a,b\n1,2'], 'roster.csv', { type: 'text/csv' });
      changeFiles(input, file);

      fireEvent.click(screen.getByTestId('spreadsheet-mode-records'));

      expect(onBulkDetected).toHaveBeenCalledTimes(1);
      expect(onBulkDetected).toHaveBeenCalledWith([file]);
      expect(onFileSelect).not.toHaveBeenCalled();
      expect(mockGenerateFingerprint).not.toHaveBeenCalled();
      expect(screen.queryByTestId('spreadsheet-mode-choice')).not.toBeInTheDocument();
    });
  });

  describe('document mode (regression test — this is the bug fix)', () => {
    it('choosing "Secure this file as a document" reaches generateFingerprint and calls onFileSelect — previously IMPOSSIBLE for any spreadsheet', async () => {
      const { input, onFileSelect, onBulkDetected } = renderUpload();
      const file = new File(['a,b\n1,2'], 'quarterly-report.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      changeFiles(input, file);

      fireEvent.click(screen.getByTestId('spreadsheet-mode-document'));

      await vi.waitFor(() => {
        expect(mockGenerateFingerprint).toHaveBeenCalledWith(file);
        expect(onFileSelect).toHaveBeenCalledWith(file, 'a'.repeat(64));
      });
      expect(onBulkDetected).not.toHaveBeenCalled();
      expect(screen.queryByTestId('spreadsheet-mode-choice')).not.toBeInTheDocument();
    });
  });

  it('"Choose a different file" clears the pending spreadsheet and returns to the empty drop zone', () => {
    const { input, onFileSelect, onBulkDetected } = renderUpload();
    const file = new File(['a,b\n1,2'], 'roster.csv', { type: 'text/csv' });
    changeFiles(input, file);
    expect(screen.getByTestId('spreadsheet-mode-choice')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/choose a different file/i));

    expect(screen.queryByTestId('spreadsheet-mode-choice')).not.toBeInTheDocument();
    expect(screen.getByText(/drag and drop your document/i)).toBeInTheDocument();
    expect(onBulkDetected).not.toHaveBeenCalled();
    expect(onFileSelect).not.toHaveBeenCalled();
  });
});

describe('isBulkUploadFile', () => {
  it('returns true for .csv files', () => {
    expect(isBulkUploadFile(new File([], 'data.csv', { type: 'text/csv' }))).toBe(true);
  });

  it('returns true for .xlsx files', () => {
    expect(isBulkUploadFile(new File([], 'data.xlsx'))).toBe(true);
  });

  it('returns true for .xls files', () => {
    expect(isBulkUploadFile(new File([], 'data.xls'))).toBe(true);
  });

  it('returns true for .tsv files', () => {
    expect(isBulkUploadFile(new File([], 'data.tsv'))).toBe(true);
  });

  it('returns false for .pdf files', () => {
    expect(isBulkUploadFile(new File([], 'doc.pdf', { type: 'application/pdf' }))).toBe(false);
  });

  it('returns false for .docx files', () => {
    expect(isBulkUploadFile(new File([], 'doc.docx'))).toBe(false);
  });
});

describe('isJsonFile', () => {
  it('returns true for .json extension', () => {
    expect(isJsonFile(new File([], 'attestation.json'))).toBe(true);
  });

  it('returns true for application/json MIME type', () => {
    expect(isJsonFile(new File([], 'data', { type: 'application/json' }))).toBe(true);
  });

  it('returns false for .pdf files', () => {
    expect(isJsonFile(new File([], 'doc.pdf', { type: 'application/pdf' }))).toBe(false);
  });
});
