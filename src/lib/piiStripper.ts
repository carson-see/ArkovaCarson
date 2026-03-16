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

// DOB: MM/DD/YYYY or MM-DD-YYYY after DOB-like keywords, or YYYY-MM-DD after DOB keywords
const DOB_KEYWORD_PATTERN = /(?:dob|date\s+of\s+birth|born|birthday|birth\s+date)\s*:?\s*/gi;
const DATE_MMDDYYYY = /\d{2}[/-]\d{2}[/-]\d{4}/;
const DATE_YYYYMMDD = /\d{4}-\d{2}-\d{2}/;

// Student ID: after "Student ID", "ID Number", "Student No." keywords
const STUDENT_ID_KEYWORD = /(?:student\s+id|id\s+number|student\s+no\.?)\s*:?\s*/gi;
const ID_VALUE = /[A-Za-z0-9]{5,12}/;

// PII-07: Postal/ZIP codes (context-aware — only after address keywords)
const ADDRESS_KEYWORD = /(?:address|street|postal\s+code|zip\s*(?:code)?|postcode)\s*:?\s*/gi;

// PII-06: EU-format DOB (DD/MM/YYYY, DD.MM.YYYY) after DOB keywords
const DATE_DDMMYYYY = /\d{2}[/.-]\d{2}[/.-]\d{4}/;

// PII-07: National ID patterns (after relevant keywords)
const NATIONAL_ID_KEYWORD = /(?:national\s+id|tax\s+id|steuer[-\s]?id|ni\s+number|nino|passport\s+(?:no\.?|number))\s*:?\s*/gi;

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
 * Captures up to the next line break or end-of-string.
 */
function stripAddressValues(
  text: string,
  piiFoundSet: Set<string>,
  addCount: (n: number) => void,
): string {
  let result = text;
  let count = 0;

  result = result.replace(
    new RegExp(`(${ADDRESS_KEYWORD.source})([^\\n]{5,80})`, 'gi'),
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

  result = result.replace(
    new RegExp(`(${NATIONAL_ID_KEYWORD.source})([A-Za-z0-9\\s-]{4,20})`, 'gi'),
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
