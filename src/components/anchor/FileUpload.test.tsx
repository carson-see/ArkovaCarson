/**
 * FileUpload Component Tests (SCRUM-1789)
 *
 * Verifies upload routing: single file → onFileSelect, multi-file → onBulkDetected,
 * CSV/XLSX → onBulkDetected, disabled state blocks processing.
 * Also tests exported helper functions: isBulkUploadFile, isJsonFile.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileUpload, isBulkUploadFile, isJsonFile } from './FileUpload';

vi.mock('@/lib/fileHasher', () => ({
  generateFingerprint: vi.fn().mockResolvedValue('a'.repeat(64)),
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

  it('routes CSV file to bulk mode', () => {
    const { input, onFileSelect, onBulkDetected } = renderUpload();
    const csvFile = new File(['col1,col2\nval1,val2'], 'records.csv', { type: 'text/csv' });
    changeFiles(input, csvFile);
    expect(onBulkDetected).toHaveBeenCalledWith([csvFile]);
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('routes XLSX file to bulk mode', () => {
    const { input, onFileSelect, onBulkDetected } = renderUpload();
    const xlsxFile = new File(['xlsx-data'], 'records.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    changeFiles(input, xlsxFile);
    expect(onBulkDetected).toHaveBeenCalledWith([xlsxFile]);
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it('renders upload affordance text', () => {
    render(<FileUpload onFileSelect={vi.fn()} />);
    expect(screen.getByText(/drag and drop your document/i)).toBeInTheDocument();
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
