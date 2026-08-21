/**
 * PII Stripping Module (P8-S18)
 *
 * CLIENT-SIDE ONLY — this module must NEVER be imported in services/worker/.
 *
 * Constitution 4A: PII must be stripped client-side before any data leaves
 * the browser. This module removes SSN, phone, email, DOB, student / employee /
 * member IDs, and provided recipient names from raw OCR text.
 *
 * SHARED MODULE: reached from the document path (via `stripPIIEnhanced` in
 * `aiExtraction.ts`) AND the CSV bulk-upload path. Keyword rules must therefore
 * be judged on precision as well as recall — a matcher widened for CSV headers
 * must not start eating ordinary prose.
 *
 * The stripped text + structured metadata may then be sent to the server
 * for AI processing. The raw OCR text and document bytes never leave the client.
 */

export interface StrippingOptions {
  /** Recipient names to strip (case-insensitive matching) */
  recipientNames?: string[];
}

export interface StrippingReport {
  /** Text with all PII replaced by redaction tokens */
  strippedText: string;
  /** Categories of PII found (e.g., ['ssn', 'email', 'phone']) */
  piiFound: string[];
  /** Total number of individual redactions made */
  redactionCount: number;
  /** Original text length in characters */
  originalLength: number;
  /** Stripped text length in characters */
  strippedLength: number;
}

// ─── Separator-insensitive keyword labels ───────────────────────────────
//
// Keyword rules used to join their tokens with `\s+`, which made the SEPARATOR
// an evasion channel: `Student ID: 88213` redacted, `student_id: 88213` did not.
// CSV headers are overwhelmingly snake_case, so the CSV bulk-upload path shipped
// those values to the server in the clear. A student/employee ID identifies an
// education record under FERPA, so §1.6 requires every separator form stripped.
//
// The pieces below are deliberately boring: single quantifiers over
// character classes, no nested quantifiers (no ReDoS), no lookbehind (Safari
// <16.4 does not support it). Matching stays linear in input length.

/** Separator between keyword tokens: space(s), underscore, hyphen, or nothing. */
const KEYWORD_SEP = '[\\s_-]*';

/**
 * Left boundary. CONSUMING rather than a lookbehind, which Safari <16.4 lacks.
 * Consuming is lossless here because every caller captures the whole keyword as
 * `prefix` and re-emits it verbatim ahead of the redaction token.
 *
 * `[^A-Za-z0-9]` (not `\b`) so that `_` and `-` count as boundaries: this is
 * what lets `intl_student_id` match while `valid_number` does not.
 */
const KEYWORD_START = '(?:^|[^A-Za-z0-9])';

/**
 * Right boundary. Without it, a zero-width separator lets a keyword match the
 * PREFIX of an ordinary word — `tax id` inside "taxidermy", `student id` inside
 * "studentidentifier", `zip` inside "zipper" — and the value pattern then eats
 * the rest of the line. Digits are deliberately still allowed to follow, so
 * unseparated forms like `ZIP90210` keep matching.
 */
const KEYWORD_END = '(?![A-Za-z])';

/** Joins keyword tokens separator-insensitively: `tok('student','id')` → `student[\s_-]*id`. */
const tok = (...tokens: string[]): string => tokens.join(KEYWORD_SEP);

/** Builds a bounded, separator-insensitive keyword prefix pattern (keyword + optional `:`). */
function keywordPattern(alternatives: string[]): RegExp {
  return new RegExp(
    `${KEYWORD_START}(?:${alternatives.join('|')})${KEYWORD_END}\\s*:?\\s*`,
    'gi',
  );
}

// SSN: XXX-XX-XXXX, XXX XX XXXX, or XXXXXXXXX
const SSN_PATTERN = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;

// Email
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Phone: US formats + international prefixes (PII-06: intl phone support)
// US: (XXX) XXX-XXXX, XXX-XXX-XXXX, XXX.XXX.XXXX, +1XXXXXXXXXX
// Intl: +CC followed by 7-12 digits (covers UK +44, FR +33, DE +49, JP +81, etc.)
const PHONE_PATTERN = /(?:\+1\d{10}|\(\d{3}\)\s?\d{3}[-.]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\+(?:4[0-9]|3[0-9]|2[0-9]|5[0-9]|6[0-9]|7[0-9]|8[0-9]|9[0-9])\d{7,11})/g;

// DOB: MM/DD/YYYY or MM-DD-YYYY after DOB-like keywords, or YYYY-MM-DD after DOB keywords
// Covers `Date of Birth`, `date_of_birth`, `birth-date`, `birthdate`, ...
const DOB_KEYWORD_PATTERN = keywordPattern([
  'dob',
  tok('date', 'of', 'birth'),
  'born',
  'birthday',
  tok('birth', 'date'),
]);
const DATE_MMDDYYYY = /\d{2}[/-]\d{2}[/-]\d{4}/;
const DATE_YYYYMMDD = /\d{4}-\d{2}-\d{2}/;

// Student / employee / member ID: after ID-bearing keywords, in any separator form
// (`Student ID`, `student_id`, `student-id`, `studentid`, `employee_id`, ...).
// employee/member IDs identify an employment or membership record and were not
// covered by this rule in ANY form before — not just the snake_case one.
const STUDENT_ID_KEYWORD = keywordPattern([
  tok('student', 'id'),
  tok('employee', 'id'),
  tok('member', 'id'),
  tok('id', 'number'),
  `${tok('student', 'no')}\\.?`,
]);
const ID_VALUE = /[A-Za-z0-9]{5,12}/;

// PII-07: Postal/ZIP codes (context-aware — only after address keywords)
const ADDRESS_KEYWORD = keywordPattern([
  'address',
  'street',
  tok('postal', 'code'),
  tok('zip', '(?:code)?'),
  'postcode',
]);

// PII-06: EU-format DOB (DD/MM/YYYY, DD.MM.YYYY) after DOB keywords
const DATE_DDMMYYYY = /\d{2}[/.-]\d{2}[/.-]\d{4}/;

// PII-07: National ID patterns (after relevant keywords)
// CRIT-4: Expanded keyword list + broader value pattern to catch Aadhaar, passports with slashes/dots
// Note: SSN is handled separately by SSN_PATTERN — do NOT add it here to avoid double-matching
const NATIONAL_ID_KEYWORD = keywordPattern([
  tok('national', 'id'),
  tok('tax', 'id'),
  tok('steuer', 'id'),
  tok('ni', 'number'),
  'nino',
  tok('passport', '(?:no\\.?|number)'),
  'aadhaar',
  'aadhar',
  tok('pan', '(?:no\\.?|number|card)'),
  'cedula',
  'dni',
  tok('sin', '(?:no\\.?|number)'),
]);

/**
 * Strip PII from raw text. Returns the stripped text and a report of what was found.
 *
 * Order of operations matters — SSN is stripped first (most specific digit pattern)
 * to avoid phone/DOB patterns overlapping.
 */
export function stripPII(text: string, options: StrippingOptions = {}): StrippingReport {
  const piiFoundSet = new Set<string>();
  let redactionCount = 0;
  let result = text;

  // 1. Strip names first (longest match first to avoid partial redaction)
  if (options.recipientNames && options.recipientNames.length > 0) {
    const sortedNames = [...options.recipientNames].sort((a, b) => b.length - a.length);
    for (const name of sortedNames) {
      const escaped = escapeRegex(name);
      const namePattern = new RegExp(escaped, 'gi');
      const matches = result.match(namePattern);
      if (matches) {
        result = result.replace(namePattern, '[NAME_REDACTED]');
        redactionCount += matches.length;
        piiFoundSet.add('name');
      }
    }
  }

  // 2. Strip SSNs (before phone to avoid overlap)
  const ssnMatches = result.match(SSN_PATTERN);
  if (ssnMatches) {
    result = result.replace(SSN_PATTERN, '[SSN_REDACTED]');
    redactionCount += ssnMatches.length;
    piiFoundSet.add('ssn');
  }

  // 3. Strip emails
  const emailMatches = result.match(EMAIL_PATTERN);
  if (emailMatches) {
    result = result.replace(EMAIL_PATTERN, '[EMAIL_REDACTED]');
    redactionCount += emailMatches.length;
    piiFoundSet.add('email');
  }

  // 4. Strip phones
  const phoneMatches = result.match(PHONE_PATTERN);
  if (phoneMatches) {
    result = result.replace(PHONE_PATTERN, '[PHONE_REDACTED]');
    redactionCount += phoneMatches.length;
    piiFoundSet.add('phone');
  }

  // 5. Strip DOB (context-aware: only after DOB-related keywords)
  result = stripDOB(result, piiFoundSet, (count) => { redactionCount += count; });

  // 6. Strip student IDs (context-aware: only after ID-related keywords)
  result = stripStudentIds(result, piiFoundSet, (count) => { redactionCount += count; });

  // 7. PII-07: Strip addresses (context-aware: only after address keywords)
  result = stripAddressValues(result, piiFoundSet, (count) => { redactionCount += count; });

  // 8. PII-07: Strip national IDs (context-aware: only after national ID keywords)
  result = stripNationalIds(result, piiFoundSet, (count) => { redactionCount += count; });

  return {
    strippedText: result,
    piiFound: Array.from(piiFoundSet),
    redactionCount,
    originalLength: text.length,
    strippedLength: result.length,
  };
}

/**
 * Strip dates that appear after DOB-related keywords.
 * Preserves issue dates, expiry dates, etc.
 */
function stripDOB(
  text: string,
  piiFoundSet: Set<string>,
  addCount: (n: number) => void,
): string {
  let result = text;
  let count = 0;

  // Match DOB keyword followed by a date (US, ISO, or EU format)
  result = result.replace(
    new RegExp(
      `(${DOB_KEYWORD_PATTERN.source})(${DATE_MMDDYYYY.source}|${DATE_YYYYMMDD.source}|${DATE_DDMMYYYY.source})`,
      'gi',
    ),
    (_match, prefix: string) => {
      count++;
      piiFoundSet.add('dob');
      return `${prefix}[DOB_REDACTED]`;
    },
  );

  if (count > 0) addCount(count);
  return result;
}

/**
 * Strip ID values that appear after student / employee / member ID keywords,
 * in any separator form (`Student ID`, `student_id`, `student-id`, `studentid`).
 */
function stripStudentIds(
  text: string,
  piiFoundSet: Set<string>,
  addCount: (n: number) => void,
): string {
  let result = text;
  let count = 0;

  result = result.replace(
    new RegExp(`(${STUDENT_ID_KEYWORD.source})(${ID_VALUE.source})`, 'gi'),
    (_match, prefix: string) => {
      count++;
      piiFoundSet.add('studentId');
      return `${prefix}[STUDENT_ID_REDACTED]`;
    },
  );

  if (count > 0) addCount(count);
  return result;
}

/**
 * PII-07: Strip address values that appear after address keywords.
 * CRIT-4: Captures multi-line addresses (up to 3 lines) not just single line.
 */
function stripAddressValues(
  text: string,
  piiFoundSet: Set<string>,
  addCount: (n: number) => void,
): string {
  let result = text;
  let count = 0;

  // Multi-line address: keyword followed by up to 3 lines of address content
  // Each line: 5-80 non-empty chars. Captures patterns like:
  //   Address: 123 Main St
  //   Apt 4B
  //   New York, NY 10001
  result = result.replace(
    new RegExp(
      `(${ADDRESS_KEYWORD.source})([^\\n]{5,80}(?:\\n[^\\n]{3,80}){0,2})`,
      'gi',
    ),
    (_match, prefix: string) => {
      count++;
      piiFoundSet.add('address');
      return `${prefix}[ADDRESS_REDACTED]`;
    },
  );

  if (count > 0) addCount(count);
  return result;
}

/**
 * PII-07: Strip national ID values that appear after national ID keywords.
 */
function stripNationalIds(
  text: string,
  piiFoundSet: Set<string>,
  addCount: (n: number) => void,
): string {
  let result = text;
  let count = 0;

  // CRIT-4: Broader value pattern — handles dots, slashes, and longer IDs (e.g. Aadhaar: 12 digits)
  // Negative lookahead prevents matching redaction tokens like [SSN_REDACTED]
  //
  // The value class holds space and tab but NOT a line break. It used to use
  // `\s`, which includes `\n`, so a 10-char ID ran greedily past the end of its
  // own line and swallowed the NEXT line's label — in the "<column>: <value>"
  // per-line text the CSV bulk upload builds, `national_id: AB.123/456` ate the
  // `course_name` header on the following line and destroyed the credential
  // title the extractor reads. A national ID never spans lines, so this is
  // strictly narrowing: no real ID stops matching.
  result = result.replace(
    new RegExp(`(${NATIONAL_ID_KEYWORD.source})(?!\\[)([A-Za-z0-9 \\t_./-]{4,30})`, 'gi'),
    (_match, prefix: string) => {
      count++;
      piiFoundSet.add('nationalId');
      return `${prefix}[NATIONAL_ID_REDACTED]`;
    },
  );

  if (count > 0) addCount(count);
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
