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
