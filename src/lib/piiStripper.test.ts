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

  // ─── Separator-insensitive ID labels ──────────────────────────────────
  // CSV headers are overwhelmingly snake_case. The keyword patterns used to
  // join their tokens with `\s+`, so the free-text form redacted while the
  // CSV form flowed through to /api/v1/ai/extract-batch unredacted. A student
  // or employee ID identifies an education/employment record (FERPA), so §1.6
  // requires it stripped in every separator form, not just the spaced one.
  describe('student ID labels are separator-insensitive', () => {
    it('strips snake_case student_id (the CSV header form)', () => {
      const result = stripPII('student_id: 88213');
      expect(result.strippedText).toBe('student_id: [STUDENT_ID_REDACTED]');
      expect(result.piiFound).toContain('studentId');
    });

    it('strips kebab-case student-id', () => {
      const result = stripPII('student-id: 88213');
      expect(result.strippedText).toBe('student-id: [STUDENT_ID_REDACTED]');
      expect(result.piiFound).toContain('studentId');
    });

    it('strips separator-less studentid', () => {
      const result = stripPII('studentid: 88213');
      expect(result.strippedText).toBe('studentid: [STUDENT_ID_REDACTED]');
      expect(result.piiFound).toContain('studentId');
    });

    it('still strips the spaced "Student ID:" form (no regression)', () => {
      const result = stripPII('Student ID: 88213');
      expect(result.strippedText).toBe('Student ID: [STUDENT_ID_REDACTED]');
      expect(result.piiFound).toContain('studentId');
    });

    it('strips snake_case id_number', () => {
      const result = stripPII('id_number: A12345678');
      expect(result.strippedText).toBe('id_number: [STUDENT_ID_REDACTED]');
      expect(result.piiFound).toContain('studentId');
    });

    it('strips employee_id in every separator form', () => {
      for (const label of ['employee_id', 'employee-id', 'employeeid', 'Employee ID']) {
        const result = stripPII(`${label}: 88213`);
        expect(result.strippedText).toBe(`${label}: [STUDENT_ID_REDACTED]`);
        expect(result.piiFound).toContain('studentId');
      }
    });

    it('strips member_id in every separator form', () => {
      for (const label of ['member_id', 'member-id', 'memberid', 'Member ID']) {
        const result = stripPII(`${label}: 88213`);
        expect(result.strippedText).toBe(`${label}: [STUDENT_ID_REDACTED]`);
        expect(result.piiFound).toContain('studentId');
      }
    });
  });

  describe('DOB / address / national ID labels are separator-insensitive', () => {
    it('strips snake_case date_of_birth', () => {
      const result = stripPII('date_of_birth: 01/15/1990');
      expect(result.strippedText).toBe('date_of_birth: [DOB_REDACTED]');
      expect(result.piiFound).toContain('dob');
    });

    it('strips snake_case birth_date', () => {
      const result = stripPII('birth_date: 1985-06-15');
      expect(result.strippedText).toBe('birth_date: [DOB_REDACTED]');
      expect(result.piiFound).toContain('dob');
    });

    it('strips snake_case postal_code', () => {
      const result = stripPII('postal_code: SW1A 2AA');
      expect(result.strippedText).toContain('[ADDRESS_REDACTED]');
      expect(result.strippedText).not.toContain('SW1A 2AA');
      expect(result.piiFound).toContain('address');
    });

    it('strips snake_case national_id', () => {
      const result = stripPII('national_id: AB.123/456');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
      expect(result.strippedText).not.toContain('AB.123/456');
      expect(result.piiFound).toContain('nationalId');
    });

    it('strips snake_case tax_id', () => {
      const result = stripPII('tax_id: 12-3456789');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
      expect(result.strippedText).not.toContain('12-3456789');
    });

    it('strips snake_case passport_number', () => {
      const result = stripPII('passport_number: X1234567');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
      expect(result.strippedText).not.toContain('X1234567');
    });

    it('strips snake_case steuer_id (underscore form of Steuer-ID)', () => {
      const result = stripPII('steuer_id: 12345678901');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
      expect(result.strippedText).not.toContain('12345678901');
    });
  });

  // Precision matters as much as recall: this module is SHARED with the
  // document path via stripPIIEnhanced, so a broadened keyword matcher must
  // not start eating ordinary structured columns.
  describe('precision: non-identifier columns are NOT redacted', () => {
    it('leaves scalar academic columns untouched', () => {
      const result = stripPII('credit_hours: 3\nscore: 88\nyear: 2024');
      expect(result.strippedText).toBe('credit_hours: 3\nscore: 88\nyear: 2024');
      expect(result.redactionCount).toBe(0);
      expect(result.piiFound).toEqual([]);
    });

    it('redacts identifier columns while preserving the rest of a CSV row', () => {
      const rowText = [
        'student_id: 88213',
        'employee_id: E44718',
        'member_id: M90210',
        'credential_name: Advanced Cardiac Life Support',
        'credit_hours: 3',
        'score: 88',
        'year: 2024',
        'issue_date: 2024-06-01',
      ].join('\n');

      const result = stripPII(rowText);

      // Identifiers gone
      expect(result.strippedText).not.toContain('88213');
      expect(result.strippedText).not.toContain('E44718');
      expect(result.strippedText).not.toContain('M90210');
      expect(result.piiFound).toContain('studentId');

      // Everything the extractor actually needs survives
      expect(result.strippedText).toContain('credential_name: Advanced Cardiac Life Support');
      expect(result.strippedText).toContain('credit_hours: 3');
      expect(result.strippedText).toContain('score: 88');
      expect(result.strippedText).toContain('year: 2024');
      expect(result.strippedText).toContain('issue_date: 2024-06-01');
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
