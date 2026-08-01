/**
 * SCRUM-2300 — adversarial transcript fixtures: a learner's name, date of birth,
 * or student ID must NEVER reach public CTDL output.
 *
 * Every fixture runs through the REAL serializer (`buildCtdlJsonLd`), not the
 * detectors in isolation, so each assertion covers the whole chain: the
 * academic-record free-text suppression, field-level cleaning, and the
 * assembled-body scan.
 *
 * A fixture may legitimately resolve either way —
 *   - SCRUBBED:    a body is produced with the PII absent, or
 *   - FAIL CLOSED: the build throws `CtdlPiiSafetyError` (route → 404) —
 * but it may NEVER produce a body that still carries the PII.
 *
 * The name cases are deliberately written in the shapes that defeat detection
 * heuristics — bare name with no surrounding context, record-noun-first order,
 * all-caps, non-ASCII, hyphenated, apostrophes, name mid-string. Those are
 * exactly the shapes a regex cannot catch, which is why academic records emit
 * no issuer free text at all. If someone ever reintroduces a name heuristic in
 * place of that structural rule, these fixtures fail.
 *
 * The story text names `src/lib/piiStripper.adversarial.test.ts` (the
 * client-side stripper). These fixtures live here instead because the CTDL
 * projection is built server-side from `anchors` rows and never passes through
 * the browser stripper, so a test there could not prove anything about these
 * bytes.
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

/** The PII token must not survive anywhere in the body, whichever way the gate resolves. */
function expectNeverEmitted(anchor: CtdlAnchor, ...secrets: string[]): void {
  let body: string;
  try {
    body = JSON.stringify(buildCtdlJsonLd(anchor, VERIFY));
  } catch (error) {
    expect(error).toBeInstanceOf(CtdlPiiSafetyError);
    return;
  }
  for (const secret of secrets) expect(body).not.toContain(secret);
}

describe('SCRUM-2300 — adversarial transcript fixtures never leak learner PII', () => {
  // REGRESSION, verified live in prod 2026-08-01 (git_sha 8e6a804e2): a
  // TRANSCRIPT-typed anchor served a person's full name in ceterms:name AND
  // ceterms:description.
  it('never emits a bare learner name from a TRANSCRIPT label (live prod regression)', () => {
    expectNeverEmitted(
      {
        ...baseTranscript,
        label: 'Summary of discussion with Graham Bell',
        description: 'Summary of discussion with Graham Bell',
      },
      'Graham Bell',
    );
  });

  // Every one of these defeats regex name detection. The structural rule —
  // academic records emit no issuer free text — handles them all identically.
  it.each([
    ['bare name as the entire label', { label: 'Jane Doe' }, ['Jane Doe']],
    ['bare name with an initial', { label: 'Jane Q. Doe' }, ['Jane Q. Doe']],
    ['record-noun-first order', { label: 'Transcript: Jane Doe' }, ['Jane Doe']],
    ['pipe-delimited', { label: 'Academic Record | Jane Doe | 2024' }, ['Jane Doe']],
    ['name then capitalised noun', { label: 'Jane Doe Transcript' }, ['Jane Doe']],
    ['all-caps name', { label: 'OFFICIAL TRANSCRIPT FOR MARIA GONZALEZ' }, ['MARIA GONZALEZ']],
    ['non-ASCII name', { label: 'Transcript issued to José García' }, ['José García']],
    ['diacritics + ligature', { label: 'Awarded to Zoë François' }, ['Zoë François']],
    ['apostrophe surname', { label: "Academic record issued to Sean O'Brien" }, ["Sean O'Brien"]],
    ['hyphenated given name', { label: 'Transcript issued to Mary-Jane Robinson' }, ['Mary-Jane Robinson']],
    ['name mid-string', { label: 'Transcript for Amanda Justice Program of Nursing' }, ['Amanda Justice']],
    ['name in the description', { description: 'Academic record held by Robert Allen Smith.' }, ['Robert Allen Smith']],
    ['name only in metadata', { label: null, description: null, metadata: { credential_name: 'Transcript issued to Priya Raman' } }, ['Priya Raman']],
    ['name in the revocation reason', { status: 'REVOKED', revokedAt: '2026-04-01T00:00:00.000Z', revocationReason: 'Withdrawn by Jane Q Student' }, ['Jane Q Student']],
  ])('never emits %s', (_label, patch, secrets) => {
    expectNeverEmitted({ ...baseTranscript, ...(patch as Partial<CtdlAnchor>) }, ...secrets);
  });

  // Format- and keyword-anchored PII, which the detectors DO handle, across
  // every credential type.
  it.each([
    ['date of birth', { description: 'Undergraduate record. DOB: 04/12/1998.' }, ['04/12/1998']],
    ['spelled-out date of birth', { description: 'Date of Birth: April 12, 1998' }, ['April 12, 1998']],
    ['student identifier', { description: 'Student ID: 00123456 — cumulative GPA 3.81.' }, ['00123456']],
    ['learner id in metadata', { metadata: { course_title: 'Learner ID: AB-4451920 coursework' } }, ['AB-4451920']],
    ['SSN', { description: 'Verification reference 123-45-6789.' }, ['123-45-6789']],
    ['contact email', { description: 'Questions: jane.student@example.edu' }, ['jane.student@example.edu']],
    ['US phone', { description: 'Registrar contact 313-555-0142.' }, ['313-555-0142']],
    ['international phone', { description: 'Registrar contact +44 20 7946 0958.' }, ['+44 20 7946 0958']],
    [
      'PII in the issuer website query string',
      { issuer: { ...baseTranscript.issuer, websiteUrl: 'https://example.edu/r?student=jane.student@example.edu' } },
      ['jane.student@example.edu'],
    ],
  ])('never emits %s', (_label, patch, secrets) => {
    expectNeverEmitted({ ...baseTranscript, ...(patch as Partial<CtdlAnchor>) }, ...secrets);
  });

  it.each(['DEGREE', 'CERTIFICATE', 'TRANSCRIPT'])(
    'suppresses issuer free text for credential_type %s',
    (credentialType) => {
      const jsonLd = buildCtdlJsonLd(
        {
          ...baseTranscript,
          credentialType,
          subType: 'bachelor',
          label: 'Awarded to Jane Q Student',
          description: 'Conferred upon Jane Q Student.',
        },
        VERIFY,
      );
      const body = JSON.stringify(jsonLd);
      expect(body).not.toContain('Jane Q Student');
      expect(jsonLd).not.toHaveProperty('ceterms:description');
    },
  );

  // The controlled-vocabulary name is derived from the resolved CTDL @type, so
  // an academic record still publishes something truthful and useful.
  it.each([
    ['DEGREE', 'bachelor', 'Bachelor Degree'],
    ['DEGREE', 'master', 'Master Degree'],
    ['CERTIFICATE', null, 'Certificate'],
    ['TRANSCRIPT', null, 'Academic Transcript'],
  ])('names a %s/%s record from controlled vocabulary', (credentialType, subType, expected) => {
    const jsonLd = buildCtdlJsonLd(
      { ...baseTranscript, credentialType, subType, label: 'Jane Doe', description: 'Jane Doe' },
      VERIFY,
    );
    expect(jsonLd['ceterms:name']).toBe(expected);
  });

  // PRECISION. A fail-closed gate must not take legitimate credentials offline.
  // These are the exact strings that a name-detection heuristic 404'd.
  it.each([
    'Issued by Johns Hopkins',
    'Issued by Red Hat',
    'Issued by Carnegie Mellon',
    'Issued by American Nurses Association',
    'Introduction to Machine Learning',
    'Introduction to Python Programming',
    'Guide to Technical Writing',
    'Aligned to Common Core',
    'Delivered in partnership with Johnson Controls',
    'Ethics and Professional Responsibility',
  ])('still publishes a non-academic credential titled %s', (label) => {
    const jsonLd = buildCtdlJsonLd(
      { ...baseTranscript, credentialType: 'CLE', subType: 'ethics_cle', label, description: null },
      VERIFY,
    );
    expect(jsonLd['ceterms:name']).toBe(label);
  });

  it.each([
    ['a numeric path segment', 'https://example.org/verify/123456789'],
    ['a campaign parameter', 'https://example.org/programs?utm=1&id=123456789'],
  ])('still publishes when the issuer website carries %s', (_label, websiteUrl) => {
    const jsonLd = buildCtdlJsonLd(
      {
        ...baseTranscript,
        credentialType: 'CPE',
        label: 'Accounting Update',
        description: null,
        issuer: { ...baseTranscript.issuer, websiteUrl },
      },
      VERIFY,
    );
    expect(jsonLd['ceterms:name']).toBe('Accounting Update');
  });

  // A single unauthenticated request must not be able to stall the event loop.
  it('serializes a very large free-text anchor quickly', () => {
    const anchor: CtdlAnchor = {
      ...baseTranscript,
      credentialType: 'CLE',
      label: 'Ethics Update',
      description: 'Ab Cd '.repeat(32_000),
      metadata: { notes: 'Term Grade Credit Hours Cumulative Totals '.repeat(4_000) },
    };
    const started = performance.now();
    buildCtdlJsonLd(anchor, VERIFY);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
