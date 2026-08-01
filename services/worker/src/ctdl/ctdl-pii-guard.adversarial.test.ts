/**
 * SCRUM-2300 — adversarial transcript fixtures: a learner's name, date of birth,
 * or student ID must NEVER reach public CTDL output.
 *
 * Each fixture is run through the REAL serializer (`buildCtdlJsonLd`), not the
 * detector in isolation, so the assertion covers the whole chain: field-level
 * suppression, the academic-record fail-closed gate, and the assembled-body
 * scan. A fixture may legitimately resolve either way —
 *   - FAIL CLOSED: the build throws `CtdlPiiSafetyError` (route → 404), or
 *   - SCRUBBED:    a body is produced with the PII omitted —
 * but it may NEVER produce a body that still carries the PII. That is the
 * invariant every case below asserts.
 *
 * The story text names `src/lib/piiStripper.adversarial.test.ts` (the
 * client-side stripper). These fixtures live here instead because this is the
 * surface that actually emits the public bytes: the CTDL projection is built
 * server-side from `anchors` rows and never passes through the browser
 * stripper, so a test there could not prove anything about this output.
 */
import { describe, expect, it } from 'vitest';
import { buildCtdlJsonLd, type CtdlAnchor } from './ctdl-serializer.js';
import { CtdlPiiSafetyError } from './ctdl-pii-guard.js';

const VERIFY = { verifyUrl: 'https://app.arkova.ai/verify/ARK-2026-PII-001' };

const baseTranscript: CtdlAnchor = {
  publicId: 'ARK-2026-PII-001',
  status: 'SECURED',
  credentialType: 'TRANSCRIPT',
  subType: null,
  label: 'Official Academic Record',
  description: 'Undergraduate coursework summary.',
  createdAt: '2026-03-27T04:08:53.000Z',
  chainTimestamp: '2026-03-27T04:12:00.000Z',
  issuedAt: '2026-03-26T00:00:00.000Z',
  expiresAt: null,
  issuer: {
    name: 'Michigan Legal Education Board',
    publicId: 'ORG-MI-CLE',
    websiteUrl: 'https://example.edu/registrar',
  },
  metadata: {},
};

/**
 * The PII token must not survive anywhere in the serialized body — whichever
 * way the gate resolves.
 */
function expectNeverEmitted(anchor: CtdlAnchor, ...secrets: string[]): void {
  let body: string;
  try {
    body = JSON.stringify(buildCtdlJsonLd(anchor, VERIFY));
  } catch (error) {
    // Fail-closed is an acceptable — and preferred — resolution.
    expect(error).toBeInstanceOf(CtdlPiiSafetyError);
    return;
  }
  for (const secret of secrets) expect(body).not.toContain(secret);
}

describe('SCRUM-2300 — adversarial transcript fixtures never leak learner PII', () => {
  // REGRESSION, verified live in prod 2026-08-01 (git_sha 8e6a804e2): a
  // TRANSCRIPT-typed anchor served a person's full name in ceterms:name AND
  // ceterms:description. The old gate keyed on DEGREE/CERTIFICATE only and
  // additionally required a literal "transcript" keyword, so this evaded it
  // twice over.
  it('fails closed on a bare learner name in a TRANSCRIPT label (live prod regression)', () => {
    expect(() =>
      buildCtdlJsonLd(
        {
          ...baseTranscript,
          label: 'Summary of discussion with Graham Bell',
          description: 'Summary of discussion with Graham Bell',
        },
        VERIFY,
      ),
    ).toThrow(CtdlPiiSafetyError);
  });

  it.each([
    [
      'bare student name in the label',
      { label: 'Transcript for Jane Q Student' },
      ['Jane Q Student'],
    ],
    [
      'bare student name in the description',
      { description: 'Academic record held by Robert Allen Smith.' },
      ['Robert Allen Smith'],
    ],
    [
      'learner name reached only through metadata',
      { label: null, description: null, metadata: { credential_name: 'Transcript issued to Priya Raman' } },
      ['Priya Raman'],
    ],
    [
      'date of birth alongside the record',
      { description: 'Undergraduate record. DOB: 04/12/1998.' },
      ['04/12/1998'],
    ],
    [
      'spelled-out date of birth',
      { description: 'Date of Birth: April 12, 1998' },
      ['April 12, 1998'],
    ],
    [
      'student identifier',
      { description: 'Student ID: 00123456 — cumulative GPA 3.81.' },
      ['00123456'],
    ],
    [
      'learner identifier in metadata',
      { metadata: { course_title: 'Learner ID: AB-4451920 coursework' } },
      ['AB-4451920'],
    ],
    [
      'SSN-shaped identifier',
      { description: 'Verification reference 123-45-6789.' },
      ['123-45-6789'],
    ],
    [
      'contact email on the record',
      { description: 'Questions: jane.student@example.edu' },
      ['jane.student@example.edu'],
    ],
    [
      'phone number on the record',
      { description: 'Registrar contact 313-555-0142.' },
      ['313-555-0142'],
    ],
    [
      'PII smuggled through the issuer website query string',
      { issuer: { ...baseTranscript.issuer, websiteUrl: 'https://example.edu/r?student=jane.student@example.edu' } },
      ['jane.student@example.edu'],
    ],
    [
      'PII smuggled through the revocation reason',
      { status: 'REVOKED', revokedAt: '2026-04-01T00:00:00.000Z', revocationReason: 'Revoked — contact jane.student@example.edu' },
      ['jane.student@example.edu'],
    ],
  ])('never emits %s', (_label, patch, secrets) => {
    expectNeverEmitted({ ...baseTranscript, ...(patch as Partial<CtdlAnchor>) }, ...secrets);
  });

  // DEGREE and CERTIFICATE are academic records too — the gate must not be
  // TRANSCRIPT-only in the other direction either.
  it.each(['DEGREE', 'CERTIFICATE', 'TRANSCRIPT'])(
    'fails closed for a learner name on credential_type %s',
    (credentialType) => {
      expect(() =>
        buildCtdlJsonLd(
          { ...baseTranscript, credentialType, label: 'Awarded to Jane Q Student', description: null },
          VERIFY,
        ),
      ).toThrow(CtdlPiiSafetyError);
    },
  );

  // Precision: the fail-closed gate must not 404 an ordinary academic record.
  // A false positive here takes a legitimate public credential offline.
  it.each([
    'Bachelor of Fine Arts',
    'Master of Public Health — University of Southern California',
    'Associate Degree in Applied Science',
    'Official Academic Record',
    'Undergraduate coursework summary, academic year 2024-2025.',
  ])('still publishes an ordinary academic record: %s', (label) => {
    const jsonLd = buildCtdlJsonLd({ ...baseTranscript, label, description: null }, VERIFY);
    expect(jsonLd['ceterms:name']).toBe(label);
  });
});
