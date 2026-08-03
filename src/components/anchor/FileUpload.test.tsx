/**
 * FileUpload Component Tests (SCRUM-1789; W2/F1 dual-mode + SCRUM-2911 W1 mixed-batch)
 *
 * Verifies upload routing: single file → onFileSelect, all-spreadsheet
 * multi-file → onBulkDetected, mixed-format multi-file → onMixedBatchDetected,
 * single CSV/XLSX/XLS/TSV → explicit mode-choice step (W2), disabled state
 * blocks processing. Also tests exported helper functions: isBulkUploadFile,
 * isJsonFile.
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
 *
 * SCRUM-2911 W1 (founder P0, 2026-07-28): a founder-reported bug had ANY
 * multi-file drop (`files.length > 1`) route unconditionally to
 * `onBulkDetected` → `BulkUploadWizard`, which only understands CSV/XLSX
 * rows and picks the first spreadsheet out of the dropped files — if none of
 * the files were spreadsheets, ALL of them were silently discarded with no
 * error (e.g. dropping 2 PDFs + a DOCX lost all three, and — the fix this
 * revision also pins — a mixed spreadsheet + non-spreadsheet drop dropped the
 * non-spreadsheet files). A multi-file drop now only takes the bulk-import
 * path when EVERY file is a spreadsheet; otherwise it routes to the new
 * `onMixedBatchDetected` callback instead.
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
  const onMixedBatchDetected = vi.fn();
  const result = render(
    <FileUpload
      onFileSelect={onFileSelect}
      onBulkDetected={onBulkDetected}
      onMixedBatchDetected={onMixedBatchDetected}
      {...props}
    />
  );
  const input = result.container.querySelector('input[type="file"]') as HTMLInputElement;
  return { input, onFileSelect, onBulkDetected, onMixedBatchDetected };
}

function changeFiles(input: HTMLInputElement, files: File | File[]) {
  fireEvent.change(input, { target: { files: Array.isArray(files) ? files : [files] } });
}

describe('FileUpload', () => {
  it('does not process files when disabled', () => {
    const { input, onFileSelect, onBulkDetected, onMixedBatchDetected } = renderUpload({ disabled: true });
    changeFiles(input, new File(['x'], 'document.pdf', { type: 'application/pdf' }));
    expect(onFileSelect).not.toHaveBeenCalled();
    expect(onBulkDetected).not.toHaveBeenCalled();
    expect(onMixedBatchDetected).not.toHaveBeenCalled();
  });

  // Regression test — pins the founder-reported bug fix. Pre-fix this exact
  // call went to onBulkDetected (which discards non-spreadsheet files); the
  // fix routes it to onMixedBatchDetected instead so nothing is lost.
  it('routes a mixed-format multi-file drop (2 PDFs) to onMixedBatchDetected, NOT onBulkDetected', () => {
    const { input, onFileSelect, onBulkDetected, onMixedBatchDetected } = renderUpload();
    expect(input.multiple).toBe(true);
    const files = [
      new File(['one'], 'bulk-one.pdf', { type: 'application/pdf' }),
      new File(['two'], 'bulk-two.pdf', { type: 'application/pdf' }),
    ];
    changeFiles(input, files);
    expect(onMixedBatchDetected).toHaveBeenCalledWith(files);
    expect(onBulkDetected).not.toHaveBeenCalled();
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('routes a genuinely mixed batch (pdf + docx + png + xml) to onMixedBatchDetected', () => {
    const { input, onBulkDetected, onMixedBatchDetected } = renderUpload();
    const files = [
      new File(['a'], 'contract.pdf', { type: 'application/pdf' }),
      new File(['b'], 'notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      new File(['c'], 'photo.png', { type: 'image/png' }),
      new File(['d'], 'data.xml', { type: 'application/xml' }),
    ];
    changeFiles(input, files);
    expect(onMixedBatchDetected).toHaveBeenCalledWith(files);
    expect(onBulkDetected).not.toHaveBeenCalled();
  });

  it('still routes an all-spreadsheet multi-file drop to onBulkDetected (unchanged)', () => {
    const { input, onBulkDetected, onMixedBatchDetected } = renderUpload();
    const files = [
      new File(['a,b'], 'sheet-one.csv', { type: 'text/csv' }),
      new File(['c,d'], 'sheet-two.csv', { type: 'text/csv' }),
    ];
    changeFiles(input, files);
    expect(onBulkDetected).toHaveBeenCalledWith(files);
    expect(onMixedBatchDetected).not.toHaveBeenCalled();
  });

  it('routes single file to onFileSelect with fingerprint', async () => {
    const { input, onFileSelect, onBulkDetected, onMixedBatchDetected } = renderUpload();
    const file = new File(['single doc'], 'document.pdf', { type: 'application/pdf' });
    changeFiles(input, file);
    await vi.waitFor(() => {
      expect(onFileSelect).toHaveBeenCalledWith(file, 'a'.repeat(64));
    });
    expect(onBulkDetected).not.toHaveBeenCalled();
    expect(onMixedBatchDetected).not.toHaveBeenCalled();
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

  it('a mixed multi-file drop (one of which is a spreadsheet) routes to onMixedBatchDetected, not onBulkDetected (SCRUM-2911 W1)', () => {
    const { input, onFileSelect, onBulkDetected, onMixedBatchDetected } = renderUpload();
    const files = [
      new File(['pdf-bytes'], 'cert.pdf', { type: 'application/pdf' }),
      new File(['csv-bytes'], 'roster.csv', { type: 'text/csv' }),
    ];
    changeFiles(input, files);

    expect(onMixedBatchDetected).toHaveBeenCalledWith(files);
    expect(onBulkDetected).not.toHaveBeenCalled();
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
