/**
 * SCRUM-2293 / SCRUM-2299 / SCRUM-2300 — outbound CTDL value-level PII scrub gate.
 *
 * Unit coverage for the detector module. Serializer-level behaviour and the
 * adversarial transcript fixtures live in `ctdl-pii-guard.adversarial.test.ts`;
 * the route-level 404 lives in `../api/v1/credentials-ctdl.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  CtdlPiiSafetyError,
  EDUCATION_CREDENTIAL_TYPES,
  MAX_SCAN_CHARS,
  assertNoPiiInJsonLd,
  containsHighConfidencePii,
  containsLearnerNamePii,
  containsOutboundFreeTextPii,
  isEducationCredentialType,
  stripUrlQueryAndFragment,
} from './ctdl-pii-guard.js';
import { academicRecordName } from './ctdl-type-map.js';

describe('containsHighConfidencePii', () => {
  it.each([
    ['email', 'contact jane.student@example.edu for details'],
    ['US phone (dashed)', 'call 555-867-5309 to verify'],
    ['US phone (parenthesised)', 'reach the office at (313) 555-0142'],
    ['SSN with dashes', 'reference 123-45-6789 on file'],
    ['SSN with spaces', 'reference 123 45 6789 on file'],
    ['SSN behind its keyword, unseparated', 'SSN: 123456789'],
  ])('detects %s', (_label, value) => {
    expect(containsHighConfidencePii(value)).toBe(true);
  });

  // Review finding: the E.164-with-spaces form humans actually type never
  // matched, because the old pattern required contiguous digits.
  it.each([
    ['UK landline', 'Contact the registrar on +44 20 7946 0958'],
    ['UK mobile', 'Contact +44 7911 123456 for verification'],
    ['India', 'Contact +91-98765-43210'],
    ['Australia (single-digit area code)', 'Contact +61 2 9374 4000'],
  ])('detects an international phone — %s', (_label, value) => {
    expect(containsHighConfidencePii(value)).toBe(true);
  });

  // SCRUM-2299's explicit gap list: bare DOB and student/learner IDs were never
  // detected, only email/phone/SSN.
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

  // PRECISION. This detector set gates a fail-closed scan, so a false positive
  // takes a legitimate public credential offline.
  it.each([
    ['a canonical ISO timestamp', '2026-03-27T04:08:53+00:00'],
    ['a UTC-offset timestamp', '2026-03-27T04:08:53+05:30'],
    ['a course code', 'Course PHIL 2020 — Applied Ethics'],
    ['a credit-hour statement', 'Awards 1.5 contact hours'],
    ['an academic year range', 'Academic year 2024-2025'],
    ['a public issuer website', 'https://example.edu/programs/nursing'],
    // Review finding: a bare 9-digit run is not SSN evidence. An ordinary
    // numeric id in an issuer URL used to 404 every credential that org owns.
    ['a 9-digit tracking id in a URL', 'https://example.org/verify/123456789'],
    ['a campaign parameter', 'https://example.org/a?utm=1&id=123456789'],
    ['a bare 9-digit order number', 'Order 123456789 confirmed'],
  ])('does not trip on %s', (_label, value) => {
    expect(containsHighConfidencePii(value)).toBe(false);
  });

  // Review finding: `\s*X?\s*` between keyword and value enumerated O(n²)
  // splits of a whitespace run. Bounded separator classes + the scan cap fix it.
  it('stays fast on a long whitespace run after a keyword', () => {
    const payload = `born${' '.repeat(128_000)}z`;
    const started = performance.now();
    expect(containsHighConfidencePii(payload)).toBe(false);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('stays fast on a very long free-text value', () => {
    const payload = 'Ab Cd '.repeat(64_000);
    const started = performance.now();
    containsHighConfidencePii(payload);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('bounds the scanned prefix', () => {
    // PII beyond the cap is not scanned — an accepted, documented limit. The
    // emitted fields themselves cap far below MAX_SCAN_CHARS.
    expect(containsHighConfidencePii(`${'x'.repeat(MAX_SCAN_CHARS)} a@b.co`)).toBe(false);
    expect(containsHighConfidencePii('a@b.co')).toBe(true);
  });

  it('is not defeated by embedded control characters', () => {
    // The NUL is built, not literal: a raw control byte in the source makes git
    // classify this whole file as binary, so the primary unit tests for a
    // security gate become undiffable and invisible to grep.
    const withNul = `jane${String.fromCharCode(0)}.student@example.edu`;
    expect(containsHighConfidencePii(withNul)).toBe(true);
  });
});

describe('containsLearnerNamePii (suppression-only heuristic)', () => {
  it.each([
    ['issued to', 'Certificate issued to Robert Allen Smith'],
    ['awarded to', 'Certificate awarded to Jane Q Student'],
    ['held by', 'Completion credential held by Jane Q Student'],
    ['for', 'Official transcript for Jane Q Student'],
    ['name-first possessive', "Jane Q Student's transcript"],
  ])('flags a learner name — %s', (_label, value) => {
    expect(containsLearnerNamePii(value)).toBe(true);
  });

  // These are the false positives that made a broader heuristic unshippable.
  // The kept patterns must not reproduce them. See the design note in
  // ctdl-pii-guard.ts.
  it.each([
    'Issued by Johns Hopkins',
    'Issued by Red Hat',
    'Issued by Carnegie Mellon',
    'Issued by American Nurses Association',
    'Introduction to Machine Learning',
    'Introduction to Python Programming',
    'Bachelor of Arts with High Distinction',
    'Credits transferred from Johns Hopkins',
    'University of Southern California',
    'Master of Public Health',
    'Michigan Legal Education Board',
    'Delivered in partnership with Johnson Controls',
  ])('does not flag %s', (value) => {
    expect(containsLearnerNamePii(value)).toBe(false);
  });
});

describe('isEducationCredentialType', () => {
  it.each(['DEGREE', 'CERTIFICATE', 'TRANSCRIPT'])('treats %s as an academic record', (type) => {
    expect(isEducationCredentialType(type)).toBe(true);
    expect(EDUCATION_CREDENTIAL_TYPES.has(type)).toBe(true);
  });

  // Professional continuing education is deliberately OUT: practitioner
  // records, not FERPA academic records, and their descriptive title plus the
  // CE ContactHour projection are the partner-facing value.
  it.each(['CPE', 'CLE', 'LICENSE', 'BADGE', 'OTHER', null, undefined])(
    'does not treat %s as an academic record',
    (type) => {
      expect(isEducationCredentialType(type)).toBe(false);
    },
  );
});

describe('academicRecordName', () => {
  it.each([
    ['ceterms:Degree', 'Academic Degree'],
    ['ceterms:AssociateDegree', "Associate's Degree"],
    ['ceterms:BachelorDegree', "Bachelor's Degree"],
    ['ceterms:MasterDegree', "Master's Degree"],
    ['ceterms:DoctoralDegree', 'Doctoral Degree'],
    ['ceterms:ProfessionalDegree', 'Professional Degree'],
    ['ceterms:Certificate', 'Certificate'],
    ['ceterms:Credential', 'Academic Transcript'],
  ])('labels %s as %s', (ctdlType, expected) => {
    expect(academicRecordName(ctdlType)).toBe(expected);
  });

  // An unmapped future type must degrade to a truthful generic, never to a
  // munged string derived from the type name.
  it('falls back honestly for an unmapped type', () => {
    expect(academicRecordName('ceterms:CQMCredential')).toBe('Academic Credential');
  });
});

describe('stripUrlQueryAndFragment', () => {
  it.each([
    ['https://example.edu/r?student=jane@example.edu', 'https://example.edu/r'],
    ['https://example.edu/a?utm=1#section', 'https://example.edu/a'],
    ['https://example.edu/programs/nursing', 'https://example.edu/programs/nursing'],
    // Userinfo is a carrier too — and one the previous form left in place.
    ['https://jane.student@example.edu/lookup', 'https://example.edu/lookup'],
    ['https://user:pw@example.edu/x?a=1#f', 'https://example.edu/x'],
  ])('%s -> %s', (input, expected) => {
    expect(stripUrlQueryAndFragment(input)).toBe(expected);
  });

  it.each(['not a url', 'javascript:alert(1)', 'ftp://example.edu/x'])(
    'rejects %s',
    (input) => {
      expect(stripUrlQueryAndFragment(input)).toBeNull();
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

  it('passes a clean body', () => {
    expect(() => assertNoPiiInJsonLd(cleanBody)).not.toThrow();
  });

  it('throws on high-confidence PII anywhere in the body', () => {
    expect(() => assertNoPiiInJsonLd({ ...cleanBody, note: 'jane@example.edu' }))
      .toThrow(CtdlPiiSafetyError);
  });

  // The scan must NOT apply name heuristics — it fails closed for every type,
  // so a heuristic false positive would take a legitimate credential offline.
  it('does not throw on a merely name-like string', () => {
    expect(() => assertNoPiiInJsonLd({ ...cleanBody, 'ceterms:name': 'Issued by Johns Hopkins' }))
      .not.toThrow();
  });

  it('scans nested arrays and objects', () => {
    expect(() => assertNoPiiInJsonLd({ ...cleanBody, 'ceterms:keyword': [{ n: 'ref 123-45-6789' }] }))
      .toThrow(CtdlPiiSafetyError);
  });

  // Mirrors the CE-02 / CE-06a depth-budget rule: a body too deep to scan is
  // refused, never published unscanned.
  it('fails closed when the body exceeds the recursion depth budget', () => {
    let deep: Record<string, unknown> = { leaf: 'ok' };
    for (let i = 0; i < 20; i += 1) deep = { nest: deep };
    expect(() => assertNoPiiInJsonLd(deep)).toThrow(/depth budget/);
  });

  it('never echoes the offending value in the error message', () => {
    const secret = 'jane.student@example.edu';
    try {
      assertNoPiiInJsonLd({ note: secret });
      expect.unreachable('expected the PII gate to throw');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

// One predicate so a caller cannot forget half the check.
describe('containsOutboundFreeTextPii', () => {
  it.each([
    'contact jane.student@example.edu',
    'reference 123-45-6789',
    'DOB: 04/12/1998',
    'Student ID: 00123456',
    'Certificate awarded to Jane Q Student',
  ])('flags %s', (value) => {
    expect(containsOutboundFreeTextPii(value)).toBe(true);
  });

  it.each([
    'Bachelor of Fine Arts',
    'Issued by Johns Hopkins',
    'Academic year 2024-2025',
  ])('does not flag %s', (value) => {
    expect(containsOutboundFreeTextPii(value)).toBe(false);
  });

  it('is the union of the high-confidence and learner-name detectors', () => {
    const samples = [
      'contact jane@example.edu',
      'Certificate awarded to Jane Q Student',
      'Bachelor of Fine Arts',
      'DOB: 04/12/1998',
      'Introduction to Machine Learning',
    ];
    for (const value of samples) {
      expect(containsOutboundFreeTextPii(value))
        .toBe(containsHighConfidencePii(value) || containsLearnerNamePii(value));
    }
  });
});
