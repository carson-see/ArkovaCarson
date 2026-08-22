/**
 * Adversarial PII Stripping Tests (CISO THREAT-5 / Action-23)
 *
 * Tests PII stripping against edge cases that bypass simple regex patterns:
 * - Multi-line addresses
 * - International national ID formats (Aadhaar, NINO with dots, Cedula)
 * - Names not in recipientNames[] parameter
 * - Obfuscated PII (spaces in SSN, dots in phone)
 * - Mixed-language documents
 * - PII adjacent to redaction tokens
 * - Overlapping pattern scenarios
 *
 * These tests help ensure the PII stripping boundary (Constitution 1.6)
 * holds against real-world adversarial document content.
 */

import { describe, it, expect } from 'vitest';
import { stripPII } from './piiStripper';

describe('piiStripper adversarial tests (CISO THREAT-5)', () => {
  // ─── SSN edge cases ─────────────────────────────────────────────────
  describe('SSN adversarial', () => {
    it('strips SSN embedded in continuous text without label', () => {
      const result = stripPII('the number 123456789 was assigned');
      expect(result.strippedText).not.toContain('123456789');
      expect(result.piiFound).toContain('ssn');
    });

    it('strips SSN with mixed separators', () => {
      const result = stripPII('SSN: 123 45-6789');
      // This should be caught — space then dash separator mix
      expect(result.strippedText).not.toMatch(/123\s*45[-\s]*6789/);
    });

    it('known limitation: ZIP+4 may match SSN pattern (over-redaction is safer)', () => {
      // "90210-1234" matches SSN regex as "902" + "10" + "1234" — this is an
      // acceptable false positive. Over-redaction is safer than under-redaction
      // for PII compliance. ZIP codes in address context get ADDRESS_REDACTED.
      const result = stripPII('Delivery to area 90210-1234 confirmed');
      // Either SSN or no match is acceptable — the key is no PII leaks
      expect(result.strippedText).not.toContain('90210-1234');
    });

    it('correctly strips ZIP+4 after address keyword (intended behavior)', () => {
      // "ZIP:" IS an address keyword — stripping is correct behavior
      const result = stripPII('ZIP: 90210-1234');
      expect(result.strippedText).toContain('[ADDRESS_REDACTED]');
    });
  });

  // ─── International phone adversarial ────────────────────────────────
  describe('international phone adversarial', () => {
    it('strips Indian phone numbers (+91)', () => {
      const result = stripPII('Call: +919876543210');
      expect(result.strippedText).toBe('Call: [PHONE_REDACTED]');
    });

    it('strips Brazilian phone numbers (+55)', () => {
      const result = stripPII('WhatsApp: +5511987654321');
      expect(result.strippedText).toBe('WhatsApp: [PHONE_REDACTED]');
    });

    it('strips phone with dots separator', () => {
      const result = stripPII('Phone: 555.867.5309');
      expect(result.strippedText).toBe('Phone: [PHONE_REDACTED]');
    });

    it('strips phone with spaces separator', () => {
      const result = stripPII('Tel: 555 867 5309');
      expect(result.strippedText).toBe('Tel: [PHONE_REDACTED]');
    });
  });

  // ─── Email adversarial ──────────────────────────────────────────────
  describe('email adversarial', () => {
    it('strips email with plus addressing', () => {
      const result = stripPII('Email: user+tag@gmail.com');
      expect(result.strippedText).toBe('Email: [EMAIL_REDACTED]');
    });

    it('strips email with long TLD', () => {
      const result = stripPII('Contact: admin@university.education');
      expect(result.strippedText).toBe('Contact: [EMAIL_REDACTED]');
    });

    it('strips email with subdomain', () => {
      const result = stripPII('Send to: user@mail.department.university.edu');
      expect(result.strippedText).toBe('Send to: [EMAIL_REDACTED]');
    });

    it('strips email with numeric local part', () => {
      const result = stripPII('ID: 12345@student.university.edu');
      expect(result.strippedText).toBe('ID: [EMAIL_REDACTED]');
    });
  });

  // ─── National ID adversarial ────────────────────────────────────────
  describe('national ID adversarial', () => {
    it('strips NINO with spaces (UK National Insurance)', () => {
      const result = stripPII('NI Number: QQ 12 34 56 C');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
      expect(result.strippedText).not.toMatch(/QQ\s*12/);
    });

    it('strips Aadhaar without spaces (12 continuous digits)', () => {
      const result = stripPII('Aadhaar: 123456789012');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
    });

    it('strips DNI (Spanish national ID)', () => {
      const result = stripPII('DNI: 12345678Z');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
    });

    it('strips SIN (Canadian Social Insurance Number)', () => {
      const result = stripPII('SIN Number: 123 456 789');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
    });

    it('strips Cedula (Latin American ID)', () => {
      const result = stripPII('Cedula: 1234567890');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
    });

    it('strips passport with slash separator', () => {
      const result = stripPII('Passport No. AB/1234567');
      expect(result.strippedText).toContain('[NATIONAL_ID_REDACTED]');
    });
  });

  // ─── Multi-line address adversarial ─────────────────────────────────
  describe('multi-line address adversarial', () => {
    it('strips 3-line US address', () => {
      const text = 'Address: 123 Oak Avenue\nSuite 400\nSan Francisco, CA 94107';
      const result = stripPII(text);
      expect(result.strippedText).not.toContain('123 Oak Avenue');
      expect(result.strippedText).not.toContain('San Francisco');
      expect(result.piiFound).toContain('address');
    });

    it('strips UK address format', () => {
      const text = 'Address: 10 Downing Street\nLondon\nSW1A 2AA';
      const result = stripPII(text);
      expect(result.strippedText).not.toContain('10 Downing Street');
      expect(result.piiFound).toContain('address');
    });

    it('strips address with zip code keyword', () => {
      const result = stripPII('Zip Code: 90210-1234');
      expect(result.strippedText).toContain('[ADDRESS_REDACTED]');
    });
  });

  // ─── DOB adversarial ────────────────────────────────────────────────
  describe('DOB adversarial', () => {
    it('strips DOB with "Birthday:" keyword', () => {
      const result = stripPII('Birthday: 12/25/1990');
      expect(result.strippedText).toContain('[DOB_REDACTED]');
      expect(result.strippedText).not.toContain('12/25/1990');
    });

    it('strips DOB with "Birth Date:" keyword', () => {
      const result = stripPII('Birth Date: 1985-06-15');
      expect(result.strippedText).toContain('[DOB_REDACTED]');
    });

    it('preserves graduation dates (no DOB keyword)', () => {
      const result = stripPII('Graduation: 05/15/2024');
      expect(result.strippedText).toContain('05/15/2024');
    });

    it('preserves issue dates', () => {
      const result = stripPII('Date of Issue: 2024-01-15');
      expect(result.strippedText).toContain('2024-01-15');
    });
  });

  // ─── Compound / realistic documents ─────────────────────────────────
  describe('realistic credential documents', () => {
    it('strips all PII from a German university diploma', () => {
      const text = `
        Technische Universität München
        Urkunde

        Herr/Frau Max Mustermann
        DOB: 15.03.1995
        Steuer-ID: 12345678901
        Address: Leopoldstraße 28
        80802 München

        hat den akademischen Grad
        Master of Science
        im Studiengang Informatik erworben.

        München, den 15. Juli 2024
        Student ID: TU2019M1234
      `;

      const result = stripPII(text, { recipientNames: ['Max Mustermann'] });

      expect(result.strippedText).not.toContain('Max Mustermann');
      expect(result.strippedText).not.toContain('15.03.1995');
      expect(result.strippedText).not.toContain('12345678901');
      expect(result.strippedText).not.toContain('Leopoldstraße 28');
      expect(result.strippedText).not.toContain('TU2019M1234');

      // Preserve institutional info
      expect(result.strippedText).toContain('Technische Universität München');
      expect(result.strippedText).toContain('Master of Science');
      expect(result.strippedText).toContain('Informatik');
    });

    it('strips all PII from a US professional license', () => {
      const text = `
        State of California
        Board of Registered Nursing

        License Number: RN 12345678

        This certifies that Jane Eleanor Rodriguez
        SSN: 987-65-4321
        Email: jane.rodriguez@gmail.com
        Phone: (415) 555-0199
        DOB: 04/22/1988
        Address: 456 Valencia St
        Apt 7
        San Francisco, CA 94110

        is licensed to practice as a Registered Nurse.
        Effective: 01/01/2024  Expires: 12/31/2025
      `;

      const result = stripPII(text, { recipientNames: ['Jane Eleanor Rodriguez'] });

      expect(result.strippedText).not.toContain('Jane Eleanor Rodriguez');
      expect(result.strippedText).not.toContain('987-65-4321');
      expect(result.strippedText).not.toContain('jane.rodriguez@gmail.com');
      expect(result.strippedText).not.toContain('(415) 555-0199');
      expect(result.strippedText).not.toContain('04/22/1988');
      expect(result.strippedText).not.toContain('456 Valencia St');

      // Preserve license info
      expect(result.strippedText).toContain('State of California');
      expect(result.strippedText).toContain('Registered Nurse');
      expect(result.strippedText).toContain('RN 12345678'); // license number is NOT PII
    });

    it('strips all PII from an Indian credential', () => {
      const text = `
        Indian Institute of Technology Bombay
        Degree Certificate

        This is to certify that Rajesh Kumar
        Aadhaar: 1234 5678 9012
        PAN Number: ABCPK1234F
        DOB: 25/12/1996
        Phone: +919876543210
        Email: rajesh.kumar@iitb.ac.in

        has been awarded the degree of
        Bachelor of Technology in Computer Science

        Mumbai, 2024
      `;

      const result = stripPII(text, { recipientNames: ['Rajesh Kumar'] });

      expect(result.strippedText).not.toContain('Rajesh Kumar');
      expect(result.strippedText).not.toContain('9876543210');
      expect(result.strippedText).not.toContain('rajesh.kumar@iitb.ac.in');

      // Preserve institutional info
      expect(result.strippedText).toContain('Indian Institute of Technology Bombay');
      expect(result.strippedText).toContain('Bachelor of Technology');
    });
  });

  // ─── Overlapping patterns ───────────────────────────────────────────
  describe('overlapping pattern edge cases', () => {
    it('does not double-redact SSN that looks like phone', () => {
      // SSN and phone patterns could overlap — SSN should win (stripped first)
      const result = stripPII('SSN: 123-45-6789');
      const redactedCount = (result.strippedText.match(/REDACTED/g) || []).length;
      expect(redactedCount).toBe(1);
    });

    it('handles adjacent PII without merging', () => {
      const result = stripPII('Email: a@b.com Phone: 555-123-4567');
      expect(result.strippedText).toContain('[EMAIL_REDACTED]');
      expect(result.strippedText).toContain('[PHONE_REDACTED]');
    });

    it('strips name that contains email-like characters', () => {
      const result = stripPII('Recipient: John.O\'Brien received the award', {
        recipientNames: ["John.O'Brien"],
      });
      expect(result.strippedText).not.toContain("John.O'Brien");
    });
  });

  // ─── Zero-redaction warning scenarios (THREAT-5 confidence check) ───
  describe('zero-redaction detection for PII confidence', () => {
    it('returns zero redactions on clean institutional text', () => {
      const result = stripPII(
        'University of Michigan awarded Bachelor of Science in Computer Science, May 2024. ' +
        'Cumulative GPA: 3.85/4.00. Dean\'s List: Fall 2022, Spring 2023.',
      );
      expect(result.redactionCount).toBe(0);
      expect(result.piiFound).toEqual([]);
    });

    it('detects at least some PII in a typical personal document', () => {
      // A document with visible personal info SHOULD have redactions
      const result = stripPII(
        'Name: John Smith. Email: john@example.com. ' +
        'Phone: 555-123-4567. SSN: 123-45-6789.',
        { recipientNames: ['John Smith'] },
      );
      expect(result.redactionCount).toBeGreaterThanOrEqual(4);
    });
  });

  // ─── Special characters and encoding ────────────────────────────────
  describe('special characters', () => {
    it('handles names with accented characters', () => {
      const result = stripPII('Awarded to José García for excellence', {
        recipientNames: ['José García'],
      });
      expect(result.strippedText).not.toContain('José García');
      expect(result.piiFound).toContain('name');
    });

    it('handles names with hyphens', () => {
      const result = stripPII('Recipient: Mary Smith-Johnson', {
        recipientNames: ['Mary Smith-Johnson'],
      });
      expect(result.strippedText).not.toContain('Mary Smith-Johnson');
    });

    it('handles names with apostrophes', () => {
      const result = stripPII("Certified: Patrick O'Malley", {
        recipientNames: ["Patrick O'Malley"],
      });
      expect(result.strippedText).not.toContain("O'Malley");
    });
  });

  // ─── Keyword-label separator evasion ────────────────────────────────
  // The keyword rules used to join their tokens with `\s+`. That made the
  // separator itself an evasion channel: `Student ID: 88213` redacted while
  // `student_id: 88213` — the shape every CSV header actually uses — did not.
  // Widening the separator is only half the job: the widened matcher must not
  // start swallowing ordinary words that merely *contain* a keyword ("taxidermy"
  // contains "tax id"). Both directions are pinned here.
  describe('keyword-label separator evasion', () => {
    it('redacts a student ID label across every separator form', () => {
      for (const label of ['Student ID', 'student_id', 'student-id', 'studentid', 'STUDENT_ID']) {
        const result = stripPII(`${label}: 88213`);
        expect(result.strippedText, label).not.toContain('88213');
        expect(result.piiFound, label).toContain('studentId');
      }
    });

    it('tolerates repeated and mixed separators', () => {
      for (const label of ['Student  ID', 'student__id', 'student-_id', 'Student _ ID']) {
        const result = stripPII(`${label}: 88213`);
        expect(result.strippedText, label).not.toContain('88213');
      }
    });

    it('redacts an ID label that is the suffix of a longer snake_case header', () => {
      const result = stripPII('intl_student_id: 88213');
      expect(result.strippedText).not.toContain('88213');
      expect(result.piiFound).toContain('studentId');
    });

    it('does not treat "student identification" prose as a student ID label', () => {
      const text = 'The student identification policy was revised in 2024';
      const result = stripPII(text);
      expect(result.strippedText).toBe(text);
      expect(result.redactionCount).toBe(0);
    });

    it('does not treat "student_notes" as a "student no." label', () => {
      const text = 'student_notes: excellent laboratory progress';
      const result = stripPII(text);
      expect(result.strippedText).toBe(text);
    });

    it('does not treat "Taxidermy" as a tax ID label', () => {
      const text = 'Taxidermy License issued 2024 by the state board';
      const result = stripPII(text);
      expect(result.strippedText).toBe(text);
      expect(result.piiFound).not.toContain('nationalId');
    });

    it('does not treat "valid_number" as an ID number label', () => {
      const text = 'valid_number: 12345';
      const result = stripPII(text);
      expect(result.strippedText).toBe(text);
    });

    it('does not treat "Zipper" as a ZIP label', () => {
      const text = 'Zipper pouches included in the graduation kit';
      const result = stripPII(text);
      expect(result.strippedText).toBe(text);
      expect(result.piiFound).not.toContain('address');
    });

    it('does not let a national ID value run past the end of its own line', () => {
      // The value class used to use `\s`, which includes `\n`: a 10-char ID ran
      // greedily onto the next line and swallowed that line's label, destroying
      // the credential title the extractor reads. A national ID never spans lines.
      const result = stripPII('national_id: AB.123/456\ncourse_name: Advanced Cardiac Life Support');
      expect(result.strippedText).not.toContain('AB.123/456');
      expect(result.strippedText).toContain('course_name: Advanced Cardiac Life Support');
    });

    it('holds across a multi-line CSV-style row (bulk-upload shape)', () => {
      // Mirrors the "<column>: <value>" per line text the bulk-upload wizard
      // builds before POSTing to /api/v1/ai/extract-batch.
      const rowText = [
        'student_id: 88213',
        'employee-id: E44718',
        'memberid: M90210',
        'date_of_birth: 03/14/1997',
        'national_id: AB.123/456',
        'course_name: Advanced Cardiac Life Support',
        'credit_hours: 3',
        'score: 88',
        'year: 2024',
      ].join('\n');

      const result = stripPII(rowText);

      for (const leaked of ['88213', 'E44718', 'M90210', '03/14/1997', 'AB.123/456']) {
        expect(result.strippedText, leaked).not.toContain(leaked);
      }
      expect(result.piiFound).toContain('studentId');
      expect(result.piiFound).toContain('dob');
      expect(result.piiFound).toContain('nationalId');

      // Precision: the non-identifier columns the extractor reads are intact.
      expect(result.strippedText).toContain('course_name: Advanced Cardiac Life Support');
      expect(result.strippedText).toContain('credit_hours: 3');
      expect(result.strippedText).toContain('score: 88');
      expect(result.strippedText).toContain('year: 2024');
    });
  });
});
