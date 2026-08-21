/**
 * PII Stripping Module (P8-S18)
 *
 * CLIENT-SIDE ONLY — this module must NEVER be imported in services/worker/.
 *
 * Constitution 4A: PII must be stripped client-side before any data leaves
 * the browser. This module removes SSN, phone, email, DOB, student IDs,
 * and provided recipient names from raw OCR text.
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

// SSN: XXX-XX-XXXX, XXX XX XXXX, or XXXXXXXXX
const SSN_PATTERN = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;

// Email
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Phone: US formats + international prefixes (PII-06: intl phone support)
// US: (XXX) XXX-XXXX, XXX-XXX-XXXX, XXX.XXX.XXXX, +1XXXXXXXXXX
// Intl: +CC followed by 7-12 digits (covers UK +44, FR +33, DE +49, JP +81, etc.)
const PHONE_PATTERN = /(?:\+1\d{10}|\(\d{3}\)\s?\d{3}[-.]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\+(?:4[0-9]|3[0-9]|2[0-9]|5[0-9]|6[0-9]|7[0-9]|8[0-9]|9[0-9])\d{7,11})/g;

/**
 * Word separator inside a context keyword.
 *
 * These keywords used to join their words with `\s+`, which is right for OCR prose
 * but wrong for the CSV bulk-upload path: `csvRowText.ts` serialises each row as
 * `"<column>: <value>"` lines straight from the CSV headers, and real-world CSV
 * headers are overwhelmingly snake_case. The result was that `Student ID: 88213`
 * redacted while `student_id: 88213` shipped the raw identifier to
 * `/api/v1/ai/extract-batch` — a §1.6 breach on the highest-volume path in the app.
 *
 * `-` is last inside the class so it is a literal, not a range.
 */
const SEP = '[\\s_-]+';

/** Separator for keywords whose trailing word is itself optional (`zip` / `zip_code`). */
const SEP_OPT = '[\\s_-]*';

/** Padding and optional `:` between the end of a keyword and its value. */
const KEYWORD_TAIL = '\\s*:?\\s*';

// DOB: MM/DD/YYYY or MM-DD-YYYY after DOB-like keywords, or YYYY-MM-DD after DOB keywords
const DOB_KEYWORD_PATTERN = new RegExp(
  `(?:dob|date${SEP}of${SEP}birth|born|birthday|birth${SEP}date)${KEYWORD_TAIL}`,
  'gi',
);
const DATE_MMDDYYYY = /\d{2}[/-]\d{2}[/-]\d{4}/;
const DATE_YYYYMMDD = /\d{4}-\d{2}-\d{2}/;

/**
 * Roles that denote a human being, for identifier keywords.
 *
 * Deliberately an allowlist of PERSON roles, mirroring `PERSON_ROLE_TOKENS` in
 * `csvRowText.ts`. A person's identifier is PII; `course_id`, `credential_id`,
 * `issuer_id` and `batch_id` name a thing and must survive, because the extractor
 * is called to read exactly that metadata.
 *
 * This — an in-cell, keyword-anchored redaction — is the right mechanism for these
 * columns, NOT the CSV name-column classifier. A value handed to `stripPII` as a
 * recipient name is removed from the WHOLE row text, so classifying `employee_id`
 * as a name column would scrub that identifier out of every other line it appears
 * in. That is the over-redaction bug PR #2302 fixed; do not re-introduce it.
 */
const PERSON_ID_ROLE =
  'student|employee|member|learner|participant|attendee|candidate|recipient|holder';

/**
 * Person identifiers: `Student ID`, `student_id`, `employee-id`, `ID Number`,
 * `Student No.`, `member_number`, ... The leading lookbehind keeps the role token
 * on a segment boundary so `remember_id` cannot match via `member_id`.
 * `number` precedes `no\.?` so the longer alternative wins without backtracking.
 */
const STUDENT_ID_KEYWORD = new RegExp(
  `(?<![A-Za-z0-9])(?:(?:${PERSON_ID_ROLE})s?${SEP}(?:id|number|no\\.?)|id${SEP}number)${KEYWORD_TAIL}`,
  'gi',
);

/**
 * An identifier value. Starts and ends alphanumeric with internal separators
 * allowed, so real IDs like `EMP-000418` and `2026/AB/0417` are caught whole rather
 * than missed for containing a `-`. It matches neither whitespace nor a newline, so
 * it cannot run past the end of its own CSV cell.
 *
 * Known residual: the 5-character floor is inherited, so a 4-digit `student_id`
 * still passes through. Widening it further trades against redacting ordinary
 * short tokens; see `agents.md`.
 */
const ID_VALUE = /[A-Za-z0-9][A-Za-z0-9._/-]{3,22}[A-Za-z0-9]/;

/**
 * PII-07: Postal/ZIP codes and street addresses (context-aware).
 *
 * The optional leading qualifier keeps common CSV headers intact in the output —
 * without it `street_address:` matched only its `street` half and the value regex
 * swallowed `_address: `, emitting a mangled `street[ADDRESS_REDACTED]`.
 * `zip` alone requires a non-alphanumeric next character so `zipper` is not an
 * address keyword.
 */
const ADDRESS_KEYWORD = new RegExp(
  `(?:(?:home|mailing|postal|street|business|work|permanent|current|residential)${SEP})?` +
    `(?:address|street|postal${SEP}code|zip${SEP_OPT}code|zip(?![A-Za-z0-9])|postcode)` +
    KEYWORD_TAIL,
  'gi',
);

/**
 * A line that opens a new `<label>: <value>` field. Used as a stop condition so a
 * multi-line address capture cannot swallow the following CSV columns.
 */
const FIELD_LABEL_LINE = '[ \\t]*[A-Za-z][A-Za-z0-9 _-]{0,40}:';

// PII-06: EU-format DOB (DD/MM/YYYY, DD.MM.YYYY) after DOB keywords
const DATE_DDMMYYYY = /\d{2}[/.-]\d{2}[/.-]\d{4}/;

// PII-07: National ID patterns (after relevant keywords)
// CRIT-4: Expanded keyword list + broader value pattern to catch Aadhaar, passports with slashes/dots
// Note: SSN is handled separately by SSN_PATTERN — do NOT add it here to avoid double-matching
const NATIONAL_ID_KEYWORD = new RegExp(
  `(?:national${SEP}id|tax${SEP}id|steuer${SEP_OPT}id|ni${SEP}number|nino|` +
    `passport${SEP}(?:number|no\\.?)|aadhaar|aadhar|pan${SEP}(?:number|no\\.?|card)|` +
    `cedula|dni|sin${SEP}(?:number|no\\.?))${KEYWORD_TAIL}`,
  'gi',
);

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
 * Strip ID values that appear after student ID keywords.
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
  //
  // A continuation line stops at anything that opens a new `<label>: <value>` field.
  // Without that guard the CSV bulk-upload path — one column per line — lost the two
  // columns after any address column outright: `postal_code: SW1A 1AA\nissue_date:
  // 2026-03-14` collapsed to `postal_code: [ADDRESS_REDACTED]` and the issue date
  // never reached the extractor. Genuine continuations (`Apt 4B`,
  // `New York, NY 10001`) carry no such label and are still captured.
  result = result.replace(
    new RegExp(
      `(${ADDRESS_KEYWORD.source})([^\\n]{5,80}(?:\\n(?!${FIELD_LABEL_LINE})[^\\n]{3,80}){0,2})`,
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
  // Horizontal whitespace only. `\s` includes `\n`, so on the CSV bulk-upload path —
  // where each column is its own `"<column>: <value>"` line — a 30-character greedy
  // match ran off the end of its cell and ate the NEXT column's header, turning
  // `national_id: AB123456\nissue_date: 2026-03-14` into
  // `national_id: [NATIONAL_ID_REDACTED]: 2026-03-14`. Spaces still match, so the UK
  // NINO form `QQ 12 34 56 C` is still caught whole.
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
