/**
 * Tests for PII Stripping Module (P8-S18)
 *
 * Constitution 4A: PII must be stripped client-side before any data leaves the browser.
 * This module is CLIENT-SIDE ONLY — never imported in services/worker/.
 */

import { describe, it, expect } from 'vitest';
import { stripPII, type StrippingReport } from './piiStripper';

describe('piiStripper', () => {
  describe('SSN patterns', () => {
    it('strips XXX-XX-XXXX format', () => {
      const result = stripPII('SSN: 123-45-6789');
      expect(result.strippedText).toBe('SSN: [SSN_REDACTED]');
      expect(result.piiFound).toContain('ssn');
      expect(result.redactionCount).toBeGreaterThanOrEqual(1);
    });

    it('strips XXXXXXXXX format (no dashes)', () => {
      const result = stripPII('SSN 123456789 on file');
      expect(result.strippedText).toBe('SSN [SSN_REDACTED] on file');
      expect(result.piiFound).toContain('ssn');
    });

    it('strips XXX XX XXXX format (spaces)', () => {
      const result = stripPII('Number: 123 45 6789');
      expect(result.strippedText).toBe('Number: [SSN_REDACTED]');
      expect(result.piiFound).toContain('ssn');
    });
  });

  describe('email patterns', () => {
    it('strips standard email addresses', () => {
      const result = stripPII('Contact: john.doe@university.edu');
      expect(result.strippedText).toBe('Contact: [EMAIL_REDACTED]');
      expect(result.piiFound).toContain('email');
    });

    it('strips multiple emails', () => {
      const result = stripPII('From: a@b.com To: c@d.org');
      expect(result.strippedText).toBe('From: [EMAIL_REDACTED] To: [EMAIL_REDACTED]');
      expect(result.redactionCount).toBe(2);
    });
  });

  describe('phone patterns', () => {
    it('strips (XXX) XXX-XXXX format', () => {
      const result = stripPII('Phone: (555) 123-4567');
      expect(result.strippedText).toBe('Phone: [PHONE_REDACTED]');
      expect(result.piiFound).toContain('phone');
    });

    it('strips XXX-XXX-XXXX format', () => {
      const result = stripPII('Call 555-123-4567 for info');
      expect(result.strippedText).toBe('Call [PHONE_REDACTED] for info');
    });

    it('strips +1XXXXXXXXXX format', () => {
      const result = stripPII('Tel: +15551234567');
      expect(result.strippedText).toBe('Tel: [PHONE_REDACTED]');
    });

    it('strips XXX.XXX.XXXX format', () => {
      const result = stripPII('Fax: 555.123.4567');
      expect(result.strippedText).toBe('Fax: [PHONE_REDACTED]');
    });
  });

  describe('date of birth patterns', () => {
    it('strips MM/DD/YYYY format', () => {
      const result = stripPII('DOB: 01/15/1990');
      expect(result.strippedText).toBe('DOB: [DOB_REDACTED]');
      expect(result.piiFound).toContain('dob');
    });

    it('strips MM-DD-YYYY format', () => {
      const result = stripPII('Born: 01-15-1990');
      expect(result.strippedText).toBe('Born: [DOB_REDACTED]');
    });

    it('strips YYYY-MM-DD format after DOB keyword', () => {
      const result = stripPII('Date of Birth: 1990-01-15');
      expect(result.strippedText).toBe('Date of Birth: [DOB_REDACTED]');
    });

    it('preserves non-DOB dates (issue dates, etc.)', () => {
      const result = stripPII('Issued: 2024-06-15');
      expect(result.strippedText).toBe('Issued: 2024-06-15');
    });
  });

  describe('student ID patterns', () => {
    it('strips Student ID: XXXXXXXX format', () => {
      const result = stripPII('Student ID: 12345678');
      expect(result.strippedText).toBe('Student ID: [STUDENT_ID_REDACTED]');
      expect(result.piiFound).toContain('studentId');
    });

    it('strips ID Number: XXXXXXXX format', () => {
      const result = stripPII('ID Number: A12345678');
      expect(result.strippedText).toBe('ID Number: [STUDENT_ID_REDACTED]');
    });

    it('strips Student No. format', () => {
      const result = stripPII('Student No. 987654');
      expect(result.strippedText).toBe('Student No. [STUDENT_ID_REDACTED]');
    });
  });

  describe('name matching against provided names', () => {
    it('strips names when recipient names are provided', () => {
      const result = stripPII('Awarded to John Michael Smith for excellence', {
        recipientNames: ['John Michael Smith'],
      });
      expect(result.strippedText).toBe('Awarded to [NAME_REDACTED] for excellence');
      expect(result.piiFound).toContain('name');
    });

    it('strips multiple names', () => {
      const result = stripPII('John Smith and Jane Doe received awards', {
        recipientNames: ['John Smith', 'Jane Doe'],
      });
      expect(result.strippedText).toBe('[NAME_REDACTED] and [NAME_REDACTED] received awards');
    });

    it('is case-insensitive for name matching', () => {
      const result = stripPII('JOHN SMITH graduated', {
        recipientNames: ['John Smith'],
      });
      expect(result.strippedText).toBe('[NAME_REDACTED] graduated');
    });

    it('does not strip if no names provided', () => {
      const result = stripPII('John Smith graduated');
      expect(result.strippedText).toBe('John Smith graduated');
      expect(result.piiFound).not.toContain('name');
    });
  });

  describe('combined PII in a single document', () => {
    it('strips all PII types from a credential document', () => {
      const text = `
        University of Michigan
        Diploma
        Awarded to John Doe
        SSN: 123-45-6789
        Student ID: A87654321
        DOB: 03/15/1995
        Email: john.doe@umich.edu
        Phone: (734) 555-1234
        Date of Issue: 2024-05-15
        Bachelor of Science in Computer Science
      `;

      const result = stripPII(text, { recipientNames: ['John Doe'] });

      expect(result.strippedText).not.toContain('123-45-6789');
      expect(result.strippedText).not.toContain('john.doe@umich.edu');
      expect(result.strippedText).not.toContain('(734) 555-1234');
      expect(result.strippedText).not.toContain('03/15/1995');
      expect(result.strippedText).not.toContain('A87654321');
      expect(result.strippedText).not.toContain('John Doe');

      // Preserve non-PII
      expect(result.strippedText).toContain('University of Michigan');
      expect(result.strippedText).toContain('Bachelor of Science');
      expect(result.strippedText).toContain('Computer Science');
      expect(result.strippedText).toContain('2024-05-15'); // issue date preserved

      expect(result.piiFound).toEqual(
        expect.arrayContaining(['ssn', 'email', 'phone', 'dob', 'studentId', 'name']),
      );
      expect(result.redactionCount).toBeGreaterThanOrEqual(6);
    });
  });

  // ─── Keyword word-separator coverage (snake_case / kebab-case) ────────
  //
  // Every context-aware keyword in this module joined its words with `\s+`, which
  // does not match `_` or `-`. That is fine for OCR prose but wrong for the CSV
  // bulk-upload path, which serialises each row as `"<column>: <value>"` lines
  // straight from CSV headers — and real CSV headers are overwhelmingly
  // snake_case. `Student ID: 88213` redacted; `student_id: 88213` shipped the raw
  // identifier to `/api/v1/ai/extract-batch`.
  describe('keyword separators — person ID keywords', () => {
    const REDACTED = '[STUDENT_ID_REDACTED]';

    it.each([
      ['space',      'Student ID: 88213'],
      ['lowercase',  'student id: 88213'],
      ['snake_case', 'student_id: 88213'],
      ['kebab-case', 'student-id: 88213'],
    ])('redacts the student ID in %s form', (_label, text) => {
      const result = stripPII(text);
      expect(result.strippedText).toContain(REDACTED);
      expect(result.strippedText).not.toContain('88213');
      expect(result.piiFound).toContain('studentId');
    });

    it.each([
      ['space',      'ID Number: 88213'],
      ['snake_case', 'id_number: 88213'],
      ['kebab-case', 'id-number: 88213'],
    ])('redacts the ID number in %s form', (_label, text) => {
      const result = stripPII(text);
      expect(result.strippedText).toContain(REDACTED);
      expect(result.strippedText).not.toContain('88213');
    });

    it.each([
      ['space + period', 'Student No. 987654'],
      ['snake_case',     'student_no: 987654'],
      ['space',          'student number: 987654'],
      ['snake_case',     'student_number: 987654'],
    ])('redacts the student number in %s form', (_label, text) => {
      const result = stripPII(text);
      expect(result.strippedText).toContain(REDACTED);
      expect(result.strippedText).not.toContain('987654');
    });

    it('preserves the keyword itself, redacting only the value', () => {
      const result = stripPII('student_id: 88213');
      expect(result.strippedText).toBe(`student_id: ${REDACTED}`);
    });
  });

  // Deliberate scope decision (see agents.md): person-role identifiers redact,
  // thing-role identifiers do not. The mechanism is this in-cell, keyword-anchored
  // stripper — NOT the CSV name-column classifier, whose literals are removed from
  // the WHOLE row text and would scrub credential metadata everywhere it appears.
  describe('keyword separators — non-student person ID roles', () => {
    it.each([
      ['employee_id',    'employee_id: EMP0004189'],
      ['member_id',      'member_id: MBR0004189'],
      ['learner_id',     'learner_id: LRN0004189'],
      ['participant_id', 'participant_id: PRT0004189'],
      ['attendee_id',    'attendee_id: ATT0004189'],
      ['candidate_id',   'candidate_id: CND0004189'],
      ['recipient_id',   'recipient_id: RCP0004189'],
      ['holder_id',      'holder_id: HLD0004189'],
    ])('redacts %s', (_label, text) => {
      const result = stripPII(text);
      expect(result.strippedText).toContain('[STUDENT_ID_REDACTED]');
      expect(result.strippedText).not.toContain('0004189');
      expect(result.piiFound).toContain('studentId');
    });

    it('redacts a hyphenated person ID value', () => {
      const result = stripPII('employee_id: EMP-000418');
      expect(result.strippedText).toBe('employee_id: [STUDENT_ID_REDACTED]');
    });

    it.each([
      ['course_id',       'course_id: CS10199'],
      ['credential_id',   'credential_id: CRED12345'],
      ['certificate_id',  'certificate_id: CERT12345'],
      ['badge_id',        'badge_id: BADGE1234'],
      ['issuer_id',       'issuer_id: ISS123456'],
      ['organization_id', 'organization_id: ORG123456'],
      ['batch_id',        'batch_id: BATCH12345'],
      ['transaction_id',  'transaction_id: TXN1234567'],
      ['document_id',     'document_id: DOC1234567'],
    ])('leaves the thing-role identifier %s intact', (_label, text) => {
      const result = stripPII(text);
      expect(result.strippedText).toBe(text);
      expect(result.piiFound).not.toContain('studentId');
    });
  });

  describe('keyword separators — DOB keywords', () => {
    it.each([
      ['space',      'Date of Birth: 01/15/1990'],
      ['snake_case', 'date_of_birth: 01/15/1990'],
      ['kebab-case', 'date-of-birth: 01/15/1990'],
      ['space',      'birth date: 01/15/1990'],
      ['snake_case', 'birth_date: 01/15/1990'],
    ])('redacts the DOB in %s form', (_label, text) => {
      const result = stripPII(text);
      expect(result.strippedText).toContain('[DOB_REDACTED]');
      expect(result.strippedText).not.toContain('01/15/1990');
      expect(result.piiFound).toContain('dob');
    });

    it('still preserves a non-DOB issue date', () => {
      const result = stripPII('issue_date: 2024-06-15');
      expect(result.strippedText).toBe('issue_date: 2024-06-15');
      expect(result.piiFound).not.toContain('dob');
    });
  });

  describe('keyword separators — address keywords', () => {
    it.each([
      ['space',      'Postal Code: SW1A 1AA'],
      ['snake_case', 'postal_code: SW1A 1AA'],
      ['kebab-case', 'postal-code: SW1A 1AA'],
    ])('redacts the postal code in %s form', (_label, text) => {
      const result = stripPII(text);
      expect(result.strippedText).toContain('[ADDRESS_REDACTED]');
      expect(result.strippedText).not.toContain('SW1A 1AA');
      expect(result.piiFound).toContain('address');
    });

    it('redacts zip_code without mangling the keyword', () => {
      // Previously `zip\s*(?:code)?` matched only `zip`, leaving the value regex to
      // swallow `_code: ` and emit `zip[ADDRESS_REDACTED]`.
      const result = stripPII('zip_code: 10001-4321');
      expect(result.strippedText).toBe('zip_code: [ADDRESS_REDACTED]');
    });

    it.each([
      ['street_address', 'street_address: 123 Main St'],
      ['home_address',   'home_address: 123 Main St'],
    ])('redacts the address in %s form', (_label, text) => {
      const result = stripPII(text);
      expect(result.strippedText).toContain('[ADDRESS_REDACTED]');
      expect(result.strippedText).not.toContain('123 Main St');
    });
  });

  describe('keyword separators — national ID keywords', () => {
    it.each([
      ['national_id',     'national_id: AB123456'],
      ['national-id',     'national-id: AB123456'],
      ['tax_id',          'tax_id: AB123456'],
      ['ni_number',       'ni_number: QQ123456C'],
      ['passport_number', 'passport_number: X1234567'],
      ['passport_no',     'passport_no: X1234567'],
      ['steuer_id',       'steuer_id: 12345678901'],
      ['pan_number',      'pan_number: ABCDE1234F'],
      ['pan_card',        'pan_card: ABCDE1234F'],
      ['sin_number',      'sin_number: AB123456'],
    ])('redacts %s', (_label, text) => {
      const result = stripPII(text);
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
      expect(result.piiFound).toContain('nationalId');
    });
  });

  describe('report structure', () => {
    it('returns proper StrippingReport shape', () => {
      const result = stripPII('Test SSN: 123-45-6789');
      expect(result).toMatchObject({
        strippedText: expect.any(String),
        piiFound: expect.any(Array),
        redactionCount: expect.any(Number),
        originalLength: expect.any(Number),
        strippedLength: expect.any(Number),
      } satisfies Record<keyof StrippingReport, unknown>);
    });

    it('reports zero redactions for clean text', () => {
      const result = stripPII('University of Michigan, Bachelor of Science, 2024');
      expect(result.redactionCount).toBe(0);
      expect(result.piiFound).toEqual([]);
      expect(result.strippedText).toBe('University of Michigan, Bachelor of Science, 2024');
    });
  });

  // ─── PII-06: International phone patterns ──────────────────────────────
  describe('international phone patterns (PII-06)', () => {
    it('strips UK phone numbers (+44)', () => {
      const result = stripPII('Contact: +447911123456');
      expect(result.strippedText).toBe('Contact: [PHONE_REDACTED]');
      expect(result.piiFound).toContain('phone');
    });

    it('strips German phone numbers (+49)', () => {
      const result = stripPII('Tel: +4915112345678');
      expect(result.strippedText).toBe('Tel: [PHONE_REDACTED]');
      expect(result.piiFound).toContain('phone');
    });

    it('strips French phone numbers (+33)', () => {
      const result = stripPII('Mobile: +33612345678');
      expect(result.strippedText).toBe('Mobile: [PHONE_REDACTED]');
    });

    it('strips Japanese phone numbers (+81)', () => {
      const result = stripPII('Phone: +819012345678');
      expect(result.strippedText).toBe('Phone: [PHONE_REDACTED]');
    });

    it('strips Australian phone numbers (+61)', () => {
      const result = stripPII('Call: +61412345678');
      expect(result.strippedText).toBe('Call: [PHONE_REDACTED]');
    });

    it('still strips US numbers', () => {
      const result = stripPII('Phone: (555) 123-4567');
      expect(result.strippedText).toBe('Phone: [PHONE_REDACTED]');
    });
  });

  // ─── PII-07: Address patterns ──────────────────────────────────────────
  describe('address patterns (PII-07)', () => {
    it('strips address values after "address:" keyword', () => {
      const result = stripPII('Address: 123 Main Street, Springfield, IL 62704');
      expect(result.strippedText).toContain('[ADDRESS_REDACTED]');
      expect(result.strippedText).not.toContain('123 Main Street');
      expect(result.piiFound).toContain('address');
    });

    it('strips address after "street:" keyword', () => {
      const result = stripPII('Street: 456 Elm Avenue, Apt 3B');
      expect(result.strippedText).toContain('[ADDRESS_REDACTED]');
      expect(result.strippedText).not.toContain('456 Elm Avenue');
    });

    it('strips postal code values after "postal code:" keyword', () => {
      const result = stripPII('Postal Code: SW1A 2AA');
      expect(result.strippedText).toContain('[ADDRESS_REDACTED]');
      expect(result.piiFound).toContain('address');
    });

    it('does not strip address-like text without keyword', () => {
      const result = stripPII('123 Main Street is a nice place');
      // Without keyword, should not be stripped
      expect(result.strippedText).toContain('123 Main Street');
    });
  });

  // ─── PII-07: National ID patterns ─────────────────────────────────────
  describe('national ID patterns (PII-07)', () => {
    it('strips national ID values after keyword', () => {
      const result = stripPII('National ID: AB123456C');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
      expect(result.strippedText).not.toContain('AB123456C');
      expect(result.piiFound).toContain('nationalId');
    });

    it('strips UK NI number after "NI Number:" keyword', () => {
      const result = stripPII('NI Number: QQ123456C');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
      expect(result.strippedText).not.toContain('QQ123456C');
    });

    it('strips German tax ID after "Steuer-ID:" keyword', () => {
      const result = stripPII('Steuer-ID: 12345678901');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
    });

    it('strips passport number after keyword', () => {
      const result = stripPII('Passport Number: C12345678');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
      expect(result.strippedText).not.toContain('C12345678');
    });
  });

  // ─── PII-06: EU date format DOB ───────────────────────────────────────
  describe('EU date format DOB (PII-06)', () => {
    it('strips DD/MM/YYYY format after DOB keyword', () => {
      const result = stripPII('Date of Birth: 25/12/1990');
      expect(result.strippedText).not.toContain('25/12/1990');
      expect(result.strippedText).toContain('[DOB_REDACTED]');
      expect(result.piiFound).toContain('dob');
    });

    it('strips DD.MM.YYYY format after DOB keyword', () => {
      const result = stripPII('DOB: 15.03.1985');
      expect(result.strippedText).not.toContain('15.03.1985');
      expect(result.strippedText).toContain('[DOB_REDACTED]');
    });
  });

  // ─── CRIT-4: Hardened PII patterns ──────────────────────────────────
  describe('CRIT-4: multi-line addresses', () => {
    it('strips multi-line addresses (up to 3 lines)', () => {
      const text = 'Address: 123 Main St\nApt 4B\nNew York, NY 10001';
      const result = stripPII(text);
      expect(result.strippedText).not.toContain('123 Main St');
      expect(result.strippedText).not.toContain('New York, NY 10001');
      expect(result.piiFound).toContain('address');
    });
  });

  describe('CRIT-4: expanded national ID patterns', () => {
    it('strips Aadhaar numbers (12 digits with spaces)', () => {
      const result = stripPII('Aadhaar: 1234 5678 9012');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
      expect(result.piiFound).toContain('nationalId');
    });

    it('strips PAN card numbers', () => {
      const result = stripPII('PAN Number: ABCDE1234F');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
    });

    it('strips national IDs with dots and slashes', () => {
      const result = stripPII('National ID: AB.123/456');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      const result = stripPII('');
      expect(result.strippedText).toBe('');
      expect(result.redactionCount).toBe(0);
    });

    it('handles whitespace-only text', () => {
      const result = stripPII('   \n\t  ');
      expect(result.strippedText).toBe('   \n\t  ');
      expect(result.redactionCount).toBe(0);
    });

    it('does not false-positive on 4-digit years alone', () => {
      const result = stripPII('Class of 2024');
      expect(result.strippedText).toBe('Class of 2024');
    });

    it('does not false-positive on short number sequences', () => {
      const result = stripPII('Grade: 95, Credits: 120');
      expect(result.strippedText).toBe('Grade: 95, Credits: 120');
    });
  });
});
