/**
 * SCRUM-2293 / SCRUM-2299 / SCRUM-2300 — outbound CTDL value-level PII scrub gate.
 *
 * Unit coverage for the detector module itself. The serializer-level fail-closed
 * behaviour and the adversarial transcript fixtures live in
 * `ctdl-pii-guard.adversarial.test.ts`; the route-level 404 lives in
 * `../api/v1/credentials-ctdl.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  CtdlPiiSafetyError,
  EDUCATION_CREDENTIAL_TYPES,
  assertNoPiiInJsonLd,
  containsHighConfidencePii,
  containsLearnerIdentityPii,
  isEducationCredentialType,
} from './ctdl-pii-guard.js';

describe('containsHighConfidencePii', () => {
  it.each([
    ['email', 'contact jane.student@example.edu for details'],
    ['phone (dashed)', 'call 555-867-5309 to verify'],
    ['phone (parenthesised)', 'reach the office at (313) 555-0142'],
    ['SSN', 'SSN 123-45-6789 on file'],
  ])('detects %s', (_label, value) => {
    expect(containsHighConfidencePii(value)).toBe(true);
  });

  // SCRUM-2299 — the ticket's explicit gap list: bare DOB and student/learner IDs
  // were never detected, only email/phone/SSN.
  it.each([
    ['DOB label + slashed date', 'DOB: 04/12/1998'],
    ['DOB label + ISO date', 'D.O.B. 1998-04-12'],
    ['spelled-out date of birth', 'Date of Birth: April 12, 1998'],
    ['born-on phrasing', 'born on 12 April 1998'],
    ['bare year after label', 'date of birth 1998'],
  ])('detects a date of birth — %s', (_label, value) => {
    expect(containsHighConfidencePii(value)).toBe(true);
  });

  it.each([
    ['student id', 'Student ID: 00123456'],
    ['student number', 'Student Number 998877'],
    ['learner id with prefix', 'Learner ID: AB-4451920'],
    ['enrollment id', 'Enrollment ID #778812'],
    ['SID abbreviation', 'SID: 4451920'],
  ])('detects a student/learner identifier — %s', (_label, value) => {
    expect(containsHighConfidencePii(value)).toBe(true);
  });

  // Precision guards: the gate is fail-closed, so a false positive 404s a
  // legitimate public credential. These must NOT trip.
  it.each([
    ['a canonical ISO timestamp', '2026-03-27T04:08:53+00:00'],
    ['a course code', 'Course PHIL 2020 — Applied Ethics'],
    ['a credit-hour statement', 'Awards 1.5 contact hours'],
    ['an academic year range', 'Academic year 2024-2025'],
    ['a public issuer website', 'https://example.edu/programs/nursing'],
  ])('does not trip on %s', (_label, value) => {
    expect(containsHighConfidencePii(value)).toBe(false);
  });
});

describe('containsLearnerIdentityPii', () => {
  it.each([
    ['relational "with"', 'Summary of discussion with Graham Bell'],
    ['relational "for"', 'Official transcript for Jane Q Student'],
    ['issued to', 'Certificate issued to Robert Allen Smith'],
    ['awarded to', 'Certificate awarded to Jane Q Student'],
    ['held by', 'Completion credential held by Jane Q Student'],
    ['name-first possessive', "Jane Q Student's transcript"],
    ['name-first noun', 'Robert Smith certificate of completion'],
    ['attn form', 'Attn: Marcus Webb'],
    ['regarding form', 'Regarding Priya Raman'],
  ])('detects a person name — %s', (_label, value) => {
    expect(containsLearnerIdentityPii(value)).toBe(true);
  });

  // The institutional/subject vocabulary veto. Without it the two-capitalised-
  // word heuristic 404s a large share of the legitimate corpus.
  it.each([
    ['university of', 'University of Southern California'],
    ['degree title', 'Bachelor of Fine Arts'],
    ['subject title', 'Master of Public Health'],
    ['issuer name', 'Michigan Legal Education Board'],
    ['programme title', 'Advanced Excel Certificate'],
    ['course with preposition', 'Introduction to Computer Science'],
    ['department', 'Awarded by the Nursing Department'],
    ['association', 'Issued by American Nurses Association'],
    ['plain credential title', 'Ethics and Professional Responsibility'],
    ['continuing education record', 'Continuing Legal Education completion record.'],
  ])('does not trip on %s', (_label, value) => {
    expect(containsLearnerIdentityPii(value)).toBe(false);
  });
});

describe('isEducationCredentialType', () => {
  it.each(['DEGREE', 'CERTIFICATE', 'TRANSCRIPT'])('treats %s as an academic-record type', (type) => {
    expect(isEducationCredentialType(type)).toBe(true);
    expect(EDUCATION_CREDENTIAL_TYPES.has(type)).toBe(true);
  });

  // Professional continuing education is deliberately OUT of the fail-closed
  // set: those are practitioner records, not FERPA academic records. They still
  // get field-level suppression + the global high-confidence body scan.
  it.each(['CPE', 'CLE', 'LICENSE', 'BADGE', 'OTHER', null, undefined])(
    'does not treat %s as an academic-record type',
    (type) => {
      expect(isEducationCredentialType(type)).toBe(false);
    },
  );
});

describe('assertNoPiiInJsonLd', () => {
  const cleanBody = {
    '@type': 'ceterms:Certificate',
    'ceterms:name': 'Ethics and Professional Responsibility',
    'ceterms:dateEffective': '2026-03-27T04:08:53+00:00',
    'ceterms:offeredBy': { 'ceterms:name': 'Michigan Legal Education Board' },
  };

  it('passes a clean body for every credential type', () => {
    expect(() => assertNoPiiInJsonLd(cleanBody, { educationRecord: false })).not.toThrow();
    expect(() => assertNoPiiInJsonLd(cleanBody, { educationRecord: true })).not.toThrow();
  });

  it('throws on high-confidence PII anywhere in the body, for any credential type', () => {
    const body = {
      ...cleanBody,
      'ceterms:offeredBy': { 'ceterms:subjectWebpage': 'https://example.edu/?contact=jane@example.edu' },
    };
    expect(() => assertNoPiiInJsonLd(body, { educationRecord: false })).toThrow(CtdlPiiSafetyError);
  });

  it('throws on a learner identity only for academic-record types', () => {
    const body = { ...cleanBody, 'ceterms:name': 'Summary of discussion with Graham Bell' };
    expect(() => assertNoPiiInJsonLd(body, { educationRecord: true })).toThrow(CtdlPiiSafetyError);
    expect(() => assertNoPiiInJsonLd(body, { educationRecord: false })).not.toThrow();
  });

  it('scans nested arrays and objects', () => {
    const body = { ...cleanBody, 'ceterms:keyword': [{ note: 'SSN 123-45-6789' }] };
    expect(() => assertNoPiiInJsonLd(body, { educationRecord: false })).toThrow(CtdlPiiSafetyError);
  });

  // Mirrors the CE-02 / CE-06a depth-budget rule: a body too deep to scan is
  // refused, never published unscanned.
  it('fails closed when the body exceeds the recursion depth budget', () => {
    let deep: Record<string, unknown> = { leaf: 'ok' };
    for (let i = 0; i < 20; i += 1) deep = { nest: deep };
    expect(() => assertNoPiiInJsonLd(deep, { educationRecord: false })).toThrow(/depth budget/);
  });

  it('never echoes the offending value in the error message', () => {
    const secret = 'jane.student@example.edu';
    try {
      assertNoPiiInJsonLd({ note: secret }, { educationRecord: false });
      expect.unreachable('expected the PII gate to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
