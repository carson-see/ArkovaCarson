/**
 * Constitution §1.6 regression tests for the CSV bulk-upload AI extraction path.
 *
 * Before this module existed, `AIExtractionStep.tsx` built the text it POSTs to
 * `/api/v1/ai/extract-batch` by serialising EVERY column verbatim:
 *
 *     columns.map((col) => `${col.name}: ${row.data[col.name] ?? ''}`)
 *
 * with no PII stripping anywhere in the CSV path — no import of `stripPII` or
 * `stripPIIEnhanced` in AIExtractionStep.tsx, BulkUploadWizard.tsx or csvParser.ts.
 * §1.6 requires that PII be removed *before anything leaves the browser*, so raw
 * SSNs, emails, phone numbers and dates of birth were shipped to the server for
 * every CSV bulk upload.
 *
 * These tests pin the invariant so it cannot silently regress again.
 */
import { describe, it, expect } from 'vitest';
import { buildStrippedRowText } from './csvRowText';
import type { CsvColumn, CsvRow } from './csvParser';

const columns: CsvColumn[] = [
  { name: 'recipient', index: 0 },
  { name: 'email', index: 1 },
  { name: 'ssn', index: 2 },
  { name: 'phone', index: 3 },
  { name: 'course', index: 4 },
  { name: 'empty_col', index: 5 },
] as unknown as CsvColumn[];

const row: CsvRow = {
  data: {
    recipient: 'Jane Q. Doe',
    email: 'jane.doe@example.com',
    ssn: '123-45-6789',
    phone: '555-867-5309',
    course: 'Advanced Ethics 101',
    empty_col: '',
  },
} as unknown as CsvRow;

describe('buildStrippedRowText — §1.6 client-side PII boundary', () => {
  it('redacts SSNs before the text can leave the browser', () => {
    const text = buildStrippedRowText(row, columns);
    expect(text).not.toContain('123-45-6789');
    expect(text).toContain('[SSN_REDACTED]');
  });

  it('redacts email addresses', () => {
    const text = buildStrippedRowText(row, columns);
    expect(text).not.toContain('jane.doe@example.com');
  });

  it('redacts phone numbers', () => {
    const text = buildStrippedRowText(row, columns);
    expect(text).not.toContain('555-867-5309');
  });

  it('redacts recipient names when they are supplied', () => {
    const text = buildStrippedRowText(row, columns, { recipientNames: ['Jane Q. Doe'] });
    expect(text).not.toContain('Jane Q. Doe');
    expect(text).toContain('[NAME_REDACTED]');
  });

  // The real-world case: the caller does NOT know the names. Redaction must come
  // from the column role alone, because a CSV is structured and we already know
  // which column holds the person.
  it('redacts names derived from the column role with no options passed', () => {
    const text = buildStrippedRowText(row, columns);
    expect(text).not.toContain('Jane Q. Doe');
    expect(text).toContain('[NAME_REDACTED]');
  });

  it.each([
    'full_name', 'Student Name', 'employee', 'attendee', 'Participant', 'holder',
  ])('treats %s as a name column', (header) => {
    const cols = [{ name: header, index: 0 }, { name: 'course', index: 1 }] as unknown as CsvColumn[];
    const r = { data: { [header]: 'Rutherford Vance', course: 'Ethics' } } as unknown as CsvRow;
    const text = buildStrippedRowText(r, cols);
    expect(text).not.toContain('Rutherford Vance');
  });

  it('does not redact a single-character value that would match everywhere', () => {
    const cols = [{ name: 'name', index: 0 }, { name: 'course', index: 1 }] as unknown as CsvColumn[];
    const r = { data: { name: 'A', course: 'Anatomy' } } as unknown as CsvRow;
    // 'A' as a redaction target would destroy every A in the row.
    expect(buildStrippedRowText(r, cols)).toContain('Anatomy');
  });

  it('preserves the non-PII content the extractor actually needs', () => {
    const text = buildStrippedRowText(row, columns);
    expect(text).toContain('Advanced Ethics 101');
    expect(text).toContain('course:');
  });

  it('still omits empty columns, matching the prior formatting contract', () => {
    const text = buildStrippedRowText(row, columns);
    expect(text).not.toContain('empty_col:');
  });

  it('never emits a bare unredacted digit run that looks like an SSN', () => {
    const text = buildStrippedRowText(row, columns);
    expect(text).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
  });
});
