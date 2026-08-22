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

/**
 * Column-role classification.
 *
 * `deriveRecipientNames` hands the *value* of every name-role column to `stripPII`
 * as a literal to redact, and `stripPII` removes that literal from the ENTIRE row
 * text. So a header misclassified as a person-name column does not merely
 * over-redact its own cell — it scrubs that string everywhere it appears in the row.
 *
 * That makes classification bidirectionally load-bearing:
 *   - miss a real person column  -> PII leaves the browser (§1.6 breach)
 *   - hit a non-person column    -> the credential title / issuer the extractor
 *                                   exists to read is destroyed before it is sent
 *
 * Most real-world credential CSVs label the credential `course_name`,
 * `credential_name` or `certificate_name`, so the second failure mode is not
 * theoretical: it silently breaks bulk extraction for the common case.
 */
describe('buildStrippedRowText — name-column classification', () => {
  const PERSON_VALUE = 'Rutherford Vance';

  /** Headers that name a PERSON. Their values must never survive stripping. */
  const PERSON_NAME_HEADERS = [
    'full_name',
    'first_name',
    'last_name',
    'recipient_name',
    'recipient',
    'holder',
    'student',
    'student_name',
    'employee_name',
    'attendee',
    'participant',
    'learner',
    'candidate',
    'surname',
    'given_name',
    'name',
  ];

  it.each(PERSON_NAME_HEADERS)('redacts the value of person column %s', (header) => {
    const cols = [
      { name: header, index: 0 },
      { name: 'course', index: 1 },
    ] as unknown as CsvColumn[];
    const r = {
      data: { [header]: PERSON_VALUE, course: 'Ethics 101' },
    } as unknown as CsvRow;

    const text = buildStrippedRowText(r, cols);
    expect(text).not.toContain(PERSON_VALUE);
    expect(text).toContain('[NAME_REDACTED]');
  });

  /**
   * Headers that name a THING, not a person. Their values are credential metadata —
   * exactly what the extractor is being asked to read — and must survive intact.
   */
  const NON_PERSON_HEADERS: Array<[string, string]> = [
    ['course_name', 'Advanced Cardiac Life Support'],
    ['program_name', 'Nurse Residency Program'],
    ['school_name', 'Metro Community College'],
    ['credential_name', 'Certified Medication Aide'],
    ['certificate_name', 'Fire Safety Certificate'],
    ['Course Name', 'Pediatric Advanced Life Support'],
    ['issuer_name', 'Metro General Hospital'],
    ['organization_name', 'Metro Health Network'],
    ['company_name', 'Northwind Logistics'],
    ['employer_name', 'Blue Ridge Freight'],
    ['institution_name', 'Riverside Institute of Technology'],
    ['department_name', 'Emergency Medicine'],
    ['file_name', 'roster-q1.csv'],
    ['event_name', 'Annual Safety Summit'],
    ['product_name', 'Compliance Suite Pro'],
    ['member_id', 'MBR-000418'],
    ['employee_id', 'EMP-000418'],
    ['participant_count', '128'],
  ];

  it.each(NON_PERSON_HEADERS)(
    'preserves the value of non-person column %s',
    (header, value) => {
      const cols = [
        { name: header, index: 0 },
        { name: 'recipient', index: 1 },
      ] as unknown as CsvColumn[];
      const r = {
        data: { [header]: value, recipient: 'Jane Q. Doe' },
      } as unknown as CsvRow;

      const text = buildStrippedRowText(r, cols);
      // The metadata survives...
      expect(text).toContain(value);
      // ...and the person in the same row is still redacted, so this is a
      // precision fix, not a weakening of the boundary.
      expect(text).not.toContain('Jane Q. Doe');
    },
  );

  // Fail-safe direction: when a header is ambiguous, redact. `nominee` is not a
  // known person role and not a known non-person qualifier, so it is treated as a
  // person column — privacy over extraction quality.
  it('redacts an unrecognised qualifier on a name column', () => {
    const cols = [
      { name: 'nominee_name', index: 0 },
      { name: 'course', index: 1 },
    ] as unknown as CsvColumn[];
    const r = {
      data: { nominee_name: PERSON_VALUE, course: 'Ethics 101' },
    } as unknown as CsvRow;

    expect(buildStrippedRowText(r, cols)).not.toContain(PERSON_VALUE);
  });

  // Same direction: a header carrying BOTH a person token and a non-person
  // qualifier still redacts, because the person token is unqualified.
  it('redacts when a person token appears outside the qualified pair', () => {
    const cols = [
      { name: 'student_course_name', index: 0 },
      { name: 'course', index: 1 },
    ] as unknown as CsvColumn[];
    const r = {
      data: { student_course_name: PERSON_VALUE, course: 'Ethics 101' },
    } as unknown as CsvRow;

    expect(buildStrippedRowText(r, cols)).not.toContain(PERSON_VALUE);
  });
});

/**
 * End-to-end regression for the shape of row a real credential CSV produces:
 * the person disappears, the credential does not.
 */
describe('buildStrippedRowText — realistic credential row', () => {
  const realColumns = [
    { name: 'recipient_name', index: 0 },
    { name: 'course_name', index: 1 },
    { name: 'issuer_name', index: 2 },
    { name: 'completed_on', index: 3 },
    { name: 'ssn', index: 4 },
    { name: 'email', index: 5 },
    { name: 'phone', index: 6 },
  ] as unknown as CsvColumn[];

  const realRow = {
    data: {
      recipient_name: 'Jane Q. Doe',
      course_name: 'Advanced Cardiac Life Support',
      issuer_name: 'Metro General Hospital',
      completed_on: '2026-03-14',
      ssn: '123-45-6789',
      email: 'jane.doe@example.com',
      phone: '555-867-5309',
    },
  } as unknown as CsvRow;

  it('keeps the credential title and issuer', () => {
    const text = buildStrippedRowText(realRow, realColumns);
    expect(text).toContain('Advanced Cardiac Life Support');
    expect(text).toContain('Metro General Hospital');
    expect(text).toContain('2026-03-14');
  });

  it('loses the person name, SSN, email and phone', () => {
    const text = buildStrippedRowText(realRow, realColumns);
    expect(text).not.toContain('Jane Q. Doe');
    expect(text).not.toContain('123-45-6789');
    expect(text).not.toContain('jane.doe@example.com');
    expect(text).not.toContain('555-867-5309');
    expect(text).toContain('[NAME_REDACTED]');
    expect(text).toContain('[SSN_REDACTED]');
  });

  it('still emits one "<column>: <value>" line per non-empty column', () => {
    const text = buildStrippedRowText(realRow, realColumns);
    expect(text.split('\n')).toHaveLength(realColumns.length);
    expect(text).toContain('course_name: Advanced Cardiac Life Support');
  });
});
