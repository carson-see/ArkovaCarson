/**
 * SCRUM-2293 / SCRUM-2299 / SCRUM-2300 — outbound CTDL/Registry value-level PII
 * scrub gate (CLAUDE.md §1.4, §1.6).
 *
 * WHY THIS MODULE EXISTS: `GET /api/v1/credentials/:publicId/ctdl` is PUBLIC and
 * UNAUTHENTICATED, and `ctdl-validation.ts` `UNSAFE_PUBLIC_KEYS` is a key-NAME
 * denylist — it never inspects VALUES. Credential Engine's Registry is
 * explicitly PII-free (Jeanne Kitchens, 2026-06-02), so no learner identity may
 * reach CTDL output or any future Registry publish path.
 *
 * VERIFIED LIVE 2026-08-01 (prod `git_sha 8e6a804e2`, `GET
 * https://api.arkova.ai/v1/credentials/<id>/ctdl`): a `credential_type =
 * 'TRANSCRIPT'` anchor served a person's full name in `ceterms:name` and
 * `ceterms:description`. Two independent holes let it through:
 *   1. The fail-closed gate keyed on `DEGREE`/`CERTIFICATE` ONLY — the
 *      `TRANSCRIPT` credential type was never covered.
 *   2. It additionally required a literal transcript/record keyword in the free
 *      text, so an academic record that never says "transcript" evaded it.
 * Both are closed here: the gate keys on the ACADEMIC-RECORD credential type
 * set, with no keyword precondition.
 *
 * This module is the SINGLE SOURCE OF TRUTH for outbound PII detection and
 * EXTENDS the existing fail-closed serializer chain (CE-01 publishability →
 * CE-02 CTID guard → THIS PII gate → CE-06a claims gate → validator); it is not
 * a parallel gate. Structure deliberately mirrors `ctdl-claims-guard.ts`:
 * value-free errors, a recursive assembled-body scan, and a depth budget that
 * fails CLOSED.
 *
 * Keep this module dependency-free so any future Registry publish path — and
 * the frontend test runner — can import it without dragging in the serializer.
 */

/**
 * Thrown when learner PII would reach serialized public output. Fail-closed:
 * callers must surface this as "no body" (the CTDL route returns 404 with audit
 * outcome `safety_blocked`), never as a published body carrying the value.
 *
 * Defined here rather than in `ctdl-serializer.ts` so the guard has no import
 * back-edge; the serializer re-exports it, so existing `instanceof` checks and
 * import sites are unchanged.
 */
export class CtdlPiiSafetyError extends Error {
  constructor(message = 'CTDL PII safety gate blocked public serialization') {
    // Deliberately value-free: never echo the offending (issuer- or
    // extraction-controlled) text into logs, Sentry, or error messages.
    super(message);
    this.name = 'CtdlPiiSafetyError';
  }
}

/**
 * Credential types that are ACADEMIC RECORDS about an identified learner. These
 * fail CLOSED (no public body at all) when any learner-identity signal survives
 * field-level suppression — the SCRUM-2293 acceptance criterion.
 *
 * `CPE`/`CLE` are deliberately EXCLUDED: continuing professional education is a
 * practitioner record, not a FERPA academic record, and the CE ContactHour
 * projection is the main partner-facing value of those types. They still get
 * (a) field-level suppression via `cleanPublicFreeText` and (b) the
 * high-confidence half of the assembled-body scan below. Widen this set only
 * with a documented privacy reason, never casually — every addition converts
 * published credentials into 404s.
 */
export const EDUCATION_CREDENTIAL_TYPES: ReadonlySet<string> = new Set([
  'DEGREE',
  'CERTIFICATE',
  'TRANSCRIPT',
]);

export function isEducationCredentialType(credentialType: string | null | undefined): boolean {
  return typeof credentialType === 'string'
    && EDUCATION_CREDENTIAL_TYPES.has(credentialType.toUpperCase());
}

// ---------------------------------------------------------------------------
// High-confidence detectors — unambiguous PII, suppressed for EVERY credential
// type. A false positive here costs one omitted free-text field, not a 404.
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const SSN_PATTERN = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/;
const PHONE_PATTERN =
  /(?:\+1\d{10}|\(\d{3}\)\s?\d{3}[-.]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\+(?:[2-9]\d)\d{7,11})/;

const MONTH_NAME = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*`;
/**
 * A date in any of the shapes an extractor realistically emits, plus a bare
 * 4-digit year. Only ever used KEYWORD-ADJACENT (see {@link DOB_PATTERN}) — a
 * bare date is far too common in credential copy ("Academic year 2024-2025",
 * "Issued 2026-03-27") to treat as PII on its own.
 */
const ANY_DATE = String.raw`(?:\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}|${MONTH_NAME}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+${MONTH_NAME}\s+\d{4}|\d{4})`;

/**
 * SCRUM-2299 — date of birth. Keyword-anchored on both the abbreviated
 * (`DOB`, `D.O.B.`) and spelled-out (`date of birth`, `birth date`, `born`,
 * `born on`) forms, with tolerant separators.
 */
const DOB_KEYWORD = String.raw`(?:\bd\.?\s?o\.?\s?b\.?|\bdate\s+of\s+birth\b|\bbirth\s?date\b|\bbirthdate\b|\bborn(?:\s+on)?\b)`;
const DOB_PATTERN = new RegExp(String.raw`${DOB_KEYWORD}\s*[:\-–—]?\s*${ANY_DATE}`, 'i');

/**
 * SCRUM-2299 — student / learner / enrollment identifiers. Keyword-anchored and
 * digit-bearing (>= 4 digits) so a bare word like "Student" or a course code
 * ("PHIL 2020") can never trip it.
 */
const STUDENT_ID_PATTERN = new RegExp(
  String.raw`\b(?:(?:student|learner|enroll?ment|matriculation|candidate|registrant|pupil)\s*(?:id|i\.d\.|no\.?|number|#)|s\.?i\.?d\.?)\b\s*[:#\-–—]?\s*[A-Za-z]{0,4}[-]?\d{4,}`,
  'i',
);

const HIGH_CONFIDENCE_PATTERNS: readonly RegExp[] = [
  EMAIL_PATTERN,
  SSN_PATTERN,
  PHONE_PATTERN,
  DOB_PATTERN,
  STUDENT_ID_PATTERN,
];

/**
 * True when the text carries unambiguous PII: email, phone, SSN, a
 * keyword-anchored date of birth, or a keyword-anchored student/learner ID.
 */
export function containsHighConfidencePii(value: string): boolean {
  return HIGH_CONFIDENCE_PATTERNS.some((pattern) => pattern.test(value));
}

// ---------------------------------------------------------------------------
// Learner-identity (person-name) detection.
//
// Detecting a bare personal name in free text is inherently a precision problem:
// the naive "two capitalised words" heuristic matches "Fine Arts", "Southern
// California", "Nurses Association" and would 404 most of the legitimate
// corpus. The approach here is deliberately two-sided:
//   1. A name candidate must sit next to a RELATIONAL trigger ("for/to/by/with/
//      attn/regarding …") or be followed by an academic-record noun
//      ("… 's transcript", "… certificate") — i.e. the text must be talking
//      ABOUT a person, not naming a thing.
//   2. Any candidate whose own tokens come from the institutional / subject /
//      credential vocabulary is VETOED — that is a programme or organisation
//      name, not a learner.
// Matching is case-SENSITIVE for the name itself (a case-insensitive
// `[A-Z][a-z]+` degenerates into "any word" and destroys precision); only the
// surrounding trigger words are compared case-insensitively, by lowercasing the
// extracted token rather than by relaxing the pattern.
// ---------------------------------------------------------------------------

const NAME_TOKEN = String.raw`[A-Z][a-z]{1,}`;
const OPTIONAL_MIDDLE = String.raw`(?:\s+(?:[A-Z]\.?|${NAME_TOKEN}))?`;
const FULL_NAME = String.raw`${NAME_TOKEN}${OPTIONAL_MIDDLE}\s+${NAME_TOKEN}`;
const FULL_NAME_SCAN = new RegExp(String.raw`\b${FULL_NAME}\b`, 'g');

/**
 * Words that, immediately before a name candidate, mean the text is referring to
 * a PERSON. Two-word forms ("issued to", "awarded to", "completed by", "held
 * by") are covered by their trailing preposition, which is already listed.
 */
const RELATIONAL_TRIGGERS: ReadonlySet<string> = new Set([
  'for', 'to', 'by', 'with', 'from',
  'learner', 'student', 'recipient', 'candidate', 'graduate', 'honoree', 'holder', 'named',
  'attn', 'attention', 're', 'regarding', 'concerning', 'between', 'presented', 'congratulations',
]);

/**
 * Nouns that, immediately AFTER a name candidate, mean the preceding words were
 * a person ("Jane Q Student's transcript", "Robert Smith certificate").
 */
const TRAILING_RECORD_NOUNS: ReadonlySet<string> = new Set([
  'transcript', 'transcripts', 'record', 'records', 'certificate', 'credential',
  'degree', 'diploma', 'completion', 'gpa', 'grades', 'coursework', 'enrollment',
]);

/**
 * Institutional / subject / credential vocabulary. A name candidate containing
 * ANY of these tokens is an organisation, programme, or subject — never a
 * learner — so it is vetoed before the trigger test runs.
 *
 * Deliberately does NOT contain `student` / `learner` / `candidate`: those are
 * the very words a learner-name placeholder uses, and vetoing them would
 * reopen the hole this module exists to close.
 */
const INSTITUTIONAL_VOCABULARY: ReadonlySet<string> = new Set([
  // Organisation shapes
  'university', 'universities', 'college', 'institute', 'institution', 'school', 'academy',
  'seminary', 'conservatory', 'polytechnic', 'faculty', 'department', 'division', 'center',
  'centre', 'campus', 'board', 'association', 'society', 'council', 'commission', 'authority',
  'bureau', 'agency', 'ministry', 'foundation', 'trust', 'alliance', 'network', 'consortium',
  'chapter', 'guild', 'union', 'federation', 'committee', 'company', 'corporation', 'holdings',
  'partners', 'consulting', 'group', 'services', 'solutions', 'systems', 'labs', 'laboratory',
  // Credential / programme shapes
  'certificate', 'certification', 'certified', 'diploma', 'degree', 'bachelor', 'bachelors',
  'master', 'masters', 'doctor', 'doctoral', 'doctorate', 'associate', 'honors', 'honours',
  'credential', 'license', 'licence', 'licensed', 'registered', 'professional', 'specialist',
  'technician', 'technologist', 'program', 'programme', 'course', 'curriculum', 'training',
  'workshop', 'seminar', 'symposium', 'conference', 'module', 'unit', 'level', 'award',
  'achievement', 'proficiency', 'competency', 'apprenticeship', 'fellowship', 'residency',
  // Subject / discipline vocabulary
  'science', 'sciences', 'arts', 'studies', 'education', 'health', 'healthcare', 'nursing',
  'medicine', 'medical', 'dental', 'veterinary', 'pharmacy', 'law', 'legal', 'justice',
  'business', 'management', 'administration', 'accounting', 'finance', 'economics',
  'marketing', 'technology', 'technologies', 'information', 'computer', 'computing',
  'software', 'data', 'security', 'cyber', 'cybersecurity', 'engineering', 'architecture',
  'construction', 'manufacturing', 'logistics', 'aviation', 'automotive', 'welding',
  'mathematics', 'statistics', 'physics', 'chemistry', 'biology', 'psychology', 'sociology',
  'anthropology', 'history', 'philosophy', 'theology', 'literature', 'linguistics',
  'communication', 'communications', 'journalism', 'design', 'media', 'music', 'theatre',
  'theater', 'dance', 'culinary', 'hospitality', 'tourism', 'agriculture', 'environmental',
  'sustainability', 'ethics', 'safety', 'quality', 'leadership', 'resources', 'workforce',
  'development', 'research', 'analytics', 'operations', 'supply', 'project', 'product',
  // Qualifiers commonly adjacent to the above
  'american', 'national', 'international', 'global', 'state', 'county', 'city', 'regional',
  'district', 'public', 'community', 'general', 'advanced', 'applied', 'continuing',
  'introductory', 'intermediate', 'fundamentals', 'principles', 'practice', 'clinical',
  'northern', 'southern', 'eastern', 'western', 'central', 'metropolitan', 'valley',
]);

function normalizeToken(token: string): string {
  return token.replace(/[^A-Za-z]/g, '').toLowerCase();
}

function isInstitutionalPhrase(candidate: string): boolean {
  return candidate
    .split(/\s+/)
    .some((token) => INSTITUTIONAL_VOCABULARY.has(normalizeToken(token)));
}

/** All lowercased alphabetic words before `index`, in order. */
function precedingTokens(text: string, index: number): string[] {
  return text.slice(0, index).split(/[^A-Za-z]+/).filter(Boolean).map((t) => t.toLowerCase());
}

/** The lowercased word immediately following a match, ignoring a possessive. */
function followingToken(text: string, endIndex: number): string | null {
  const match = /^(?:['’]s)?[\s:,;—–-]+([A-Za-z]+)/.exec(text.slice(endIndex));
  return match ? normalizeToken(match[1]) || null : null;
}

/**
 * Is the name candidate at `start` introduced by a person-referring word?
 *
 * A bare "of" is deliberately NOT a standing trigger — it would make
 * "University of North Texas" a learner name. It counts only directly after a
 * record noun ("transcript of Jane Doe", "record of Jane Doe").
 */
function hasRelationalTrigger(text: string, start: number): boolean {
  const tokens = precedingTokens(text, start);
  const previous = tokens.at(-1);
  if (!previous) return false;
  if (RELATIONAL_TRIGGERS.has(previous)) return true;
  return previous === 'of' && TRAILING_RECORD_NOUNS.has(tokens.at(-2) ?? '');
}

/**
 * Decide whether one `FULL_NAME`-shaped candidate is a person reference.
 *
 * The `FULL_NAME` scan is greedy, so a capitalised leading trigger can be
 * swallowed into the match ("Regarding Priya Raman" matches whole). Peel that
 * leading trigger off and judge the remainder, otherwise the trigger hides the
 * very name it introduces.
 */
function isPersonReference(text: string, candidate: string, start: number): boolean {
  const tokens = candidate.split(/\s+/);
  if (tokens.length >= 3 && RELATIONAL_TRIGGERS.has(normalizeToken(tokens[0]))) {
    return !isInstitutionalPhrase(tokens.slice(1).join(' '));
  }
  if (isInstitutionalPhrase(candidate)) return false;
  if (hasRelationalTrigger(text, start)) return true;
  const after = followingToken(text, start + candidate.length);
  return after !== null && TRAILING_RECORD_NOUNS.has(after);
}

/**
 * True when the text names an identifiable PERSON (a learner, recipient, or
 * other individual) rather than an organisation, programme, or subject.
 */
export function containsLearnerIdentityPii(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  FULL_NAME_SCAN.lastIndex = 0;
  for (const match of text.matchAll(FULL_NAME_SCAN)) {
    if (isPersonReference(text, match[0], match.index ?? 0)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Assembled-body scan (defense in depth).
// ---------------------------------------------------------------------------

export interface CtdlPiiScanOptions {
  /**
   * True for the ACADEMIC-RECORD credential types (see
   * {@link EDUCATION_CREDENTIAL_TYPES}). When true the scan ALSO fails closed on
   * learner-identity signals, not just high-confidence PII.
   */
  educationRecord: boolean;
}

/**
 * Recursion budget, matching `ctdl-claims-guard.ts`. Real CTDL bodies are ~4
 * levels deep; anything deeper is not something the serializer can produce.
 */
const MAX_JSONLD_SCAN_DEPTH = 12;

/**
 * Recursively scan an ALREADY-BUILT JSON-LD body and throw
 * {@link CtdlPiiSafetyError} if any string value carries PII. Field-level
 * suppression (`cleanPublicFreeText`) is the first line of defence; this is the
 * belt-and-suspenders check on the final object, so a value reaching the body
 * by ANY other route — a URL query string on `ceterms:subjectWebpage`, a field
 * that never routed through the free-text cleaner, or a future code path — can
 * never ship.
 *
 * FAILS CLOSED on depth, mirroring the CE-02 CTID scan and the CE-06a claims
 * scan: a body too deep to scan is refused, never published unscanned.
 */
export function assertNoPiiInJsonLd(
  value: unknown,
  options: CtdlPiiScanOptions,
  depth = 0,
): void {
  if (value === null || value === undefined) return;
  if (depth > MAX_JSONLD_SCAN_DEPTH) {
    // Value-free by construction: reports the budget, never the content.
    throw new CtdlPiiSafetyError(
      `CTDL PII scan exceeded its depth budget of ${MAX_JSONLD_SCAN_DEPTH} — ` +
        'refusing to serialize an unscannable body (fail closed).',
    );
  }
  if (typeof value === 'string') {
    if (containsHighConfidencePii(value)) throw new CtdlPiiSafetyError();
    if (options.educationRecord && containsLearnerIdentityPii(value)) throw new CtdlPiiSafetyError();
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoPiiInJsonLd(item, options, depth + 1);
    return;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    assertNoPiiInJsonLd(child, options, depth + 1);
  }
}
