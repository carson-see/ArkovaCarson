/**
 * CsvUploader Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CsvUploader } from './CsvUploader';

describe('CsvUploader', () => {
  const mockOnParsed = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render upload area', () => {
    render(<CsvUploader onParsed={mockOnParsed} />);

    expect(screen.getByText(/drop your csv or excel file here/i)).toBeInTheDocument();
    expect(screen.getByText(/select file/i)).toBeInTheDocument();
  });

  it('should show upload instructions', () => {
    render(<CsvUploader onParsed={mockOnParsed} />);

    expect(screen.getByText(/upload any spreadsheet/i)).toBeInTheDocument();
    expect(screen.getByText(/auto-detected columns/i)).toBeInTheDocument();
  });

  it('should accept valid CSV file', async () => {
    render(<CsvUploader onParsed={mockOnParsed} />);

    const fingerprint = 'a'.repeat(64);
    const csvContent = `fingerprint,filename,email
${fingerprint},test.pdf,user@example.com`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockOnParsed).toHaveBeenCalled();
    });

    const [parsedCsv, mapping, validation] = mockOnParsed.mock.calls[0];
    expect(parsedCsv.rows).toHaveLength(1);
    expect(mapping.fingerprint).toBe(0);
    expect(mapping.filename).toBe(1);
    expect(validation.valid).toHaveLength(1);
  });

  it('should detect invalid emails during validation', async () => {
    render(<CsvUploader onParsed={mockOnParsed} />);

    const fingerprint = 'a'.repeat(64);
    const csvContent = `fingerprint,filename,email
${fingerprint},test.pdf,invalid-email`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockOnParsed).toHaveBeenCalled();
    });

    const [, , validation] = mockOnParsed.mock.calls[0];
    expect(validation.invalid).toHaveLength(1);
    expect(validation.errors[0].message).toContain('Invalid email');
  });

  it('should show error for non-CSV file', async () => {
    render(<CsvUploader onParsed={mockOnParsed} />);

    const file = new File(['not csv'], 'test.txt', { type: 'text/plain' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/please upload a csv or excel/i)).toBeInTheDocument();
    });

    expect(mockOnParsed).not.toHaveBeenCalled();
  });

  it('should show error for empty CSV', async () => {
    render(<CsvUploader onParsed={mockOnParsed} />);

    const csvContent = `fingerprint,filename`;
    const file = new File([csvContent], 'empty.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/file is empty/i)).toBeInTheDocument();
    });

    expect(mockOnParsed).not.toHaveBeenCalled();
  });

  it('should accept CSV without fingerprint column (auto-generated)', async () => {
    render(<CsvUploader onParsed={mockOnParsed} />);

    const csvContent = `name,value
test.pdf,100`;

    const file = new File([csvContent], 'test.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockOnParsed).toHaveBeenCalled();
    });

    const [parsedCsv] = mockOnParsed.mock.calls[0];
    expect(parsedCsv.rows).toHaveLength(1);
  });

  it('should handle 500 rows', async () => {
    render(<CsvUploader onParsed={mockOnParsed} />);

    const header = 'fingerprint,filename';
    const rows = Array.from({ length: 500 }, (_, i) => {
      const fingerprint = 'a'.repeat(64);
      return `${fingerprint},file${i}.pdf`;
    });

    const csvContent = [header, ...rows].join('\n');
    const file = new File([csvContent], 'bulk.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockOnParsed).toHaveBeenCalled();
    }, { timeout: 5000 });

    const [parsedCsv] = mockOnParsed.mock.calls[0];
    expect(parsedCsv.rows).toHaveLength(500);
  });

  it('should show error when exceeding max rows', async () => {
    render(<CsvUploader onParsed={mockOnParsed} maxRows={10} />);

    const header = 'fingerprint,filename';
    const rows = Array.from({ length: 20 }, (_, i) => {
      const fingerprint = 'a'.repeat(64);
      return `${fingerprint},file${i}.pdf`;
    });

    const csvContent = [header, ...rows].join('\n');
    const file = new File([csvContent], 'too-many.csv', { type: 'text/csv' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText(/too many rows/i)).toBeInTheDocument();
    });

    expect(mockOnParsed).not.toHaveBeenCalled();
  });
});
