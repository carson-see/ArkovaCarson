/**
 * CSV row → PII-stripped extraction text.
 *
 * Constitution §1.6: documents never leave the user's device, and "client-side PII
 * stripping removes all PII before anything leaves browser. Only PII-stripped
 * structured metadata + fingerprint may flow to server."
 *
 * The CSV bulk-upload path previously built its extraction text inline in
 * `AIExtractionStep.tsx` by serialising every column verbatim, with no stripping
 * anywhere in the CSV path. Raw SSNs, emails, phone numbers and dates of birth were
 * POSTed to `/api/v1/ai/extract-batch`. This module is the single choke point that
 * makes that impossible: the only exported way to build the text also strips it.
 *
 * Why column-role redaction rather than NER here: the document path uses
 * `stripPIIEnhanced` (transformer NER) because OCR output is unstructured free text
 * where a name can appear anywhere. A CSV is *structured* — we already know which
 * column holds the recipient. Redacting by column role is deterministic, catches
 * names the regex layer cannot, and costs nothing per row, which matters because
 * this path runs over thousands of rows.
 */
import { stripPII, type StrippingOptions } from './piiStripper';
import type { CsvColumn, CsvRow } from './csvParser';

/**
 * Column-role classification.
 *
 * A header classified here as a person-name column has its *value* handed to
 * `stripPII` as a literal to redact, and `stripPII` removes that literal from the
 * WHOLE row text — not just its own cell. So the classification is load-bearing in
 * both directions:
 *
 *   - too narrow -> a real person's name leaves the browser (§1.6 breach)
 *   - too broad  -> the credential title / issuer is scrubbed out of every line it
 *                   appears in, and the extractor receives a row stripped of the
 *                   very metadata it was called to read
 *
 * Bare token matching gets the second half wrong for the *common* real-world CSV:
 * `course_name`, `credential_name`, `certificate_name`, `issuer_name` and
 * `organization_name` all contain the token `name` while naming a thing, not a
 * person. Three rules separate them:
 *
 *   1. an explicit allowlist of unambiguous person headers (`surname` has no
 *      segment boundary before `name`, so it needs naming outright);
 *   2. a person-role token standing as its own `_` / space / `-` delimited segment;
 *   3. minus the cases where that token is qualified into a thing — either by a
 *      preceding non-person qualifier (`course_name`) or by a suffix that marks the
 *      column as an identifier rather than a display name (`employee_id`).
 *
 * Ties break toward redaction. An unrecognised qualifier (`nominee_name`) or a
 * person token sitting outside the qualified pair (`student_course_name`) still
 * matches, because losing a course title is a bug and leaking a name is a breach.
 */

/** Roles that denote a human being. */
const PERSON_ROLE_TOKENS =
  'name|recipient|holder|student|employee|attendee|participant|learner|candidate|member';

/**
 * Words that turn a following person-role token into the name of a *thing*.
 * Longer alternatives precede their prefixes so the intended one wins.
 */
const NON_PERSON_QUALIFIERS =
  'course|program|school|credential|certificate|cert|issuer|organization|org|company|employer|' +
  'institution|department|dept|file|event|product|class|badge|award|degree|business|team|' +
  'project|group|role|title';

/** Headers that are unambiguously a person's name, including ones with no separator. */
const EXPLICIT_PERSON_HEADER = /^(?:full_?name|first_?name|last_?name|surname|given_?name)$/i;

/** A person-role token standing as its own delimited segment. */
const NAME_COLUMN_PATTERN = new RegExp(
  `(?:^|[_\\s-])(?:${PERSON_ROLE_TOKENS})(?:$|[_\\s-])`,
  'i',
);

/** `<qualifier><sep><person token>` — a thing's name, e.g. `course_name`. */
const QUALIFIED_NON_PERSON_PATTERN = new RegExp(
  `(?:^|[_\\s-])(?:${NON_PERSON_QUALIFIERS})[_\\s-](?:${PERSON_ROLE_TOKENS})(?:$|[_\\s-])`,
  'gi',
);

/**
 * Suffixes that make a column an identifier, code or scalar rather than a display
 * name. `employee_id` and `participant_count` never hold a person's name, so
 * redacting their values only destroys row content.
 */
const NON_NAME_SUFFIX_PATTERN = /[_\s-](?:id|count|number|code|type|date|url)$/i;

/**
 * True when the column header denotes a person whose name must be redacted.
 */
function isPersonNameColumn(header: string): boolean {
  if (NON_NAME_SUFFIX_PATTERN.test(header)) return false;
  if (EXPLICIT_PERSON_HEADER.test(header)) return true;

  // Blank out qualified pairs first, so a qualified `name` cannot satisfy the token
  // test while an unqualified person token elsewhere in the header still can.
  const unqualified = header.replace(QUALIFIED_NON_PERSON_PATTERN, ' ');
  return NAME_COLUMN_PATTERN.test(unqualified);
}

export interface BuildRowTextOptions extends StrippingOptions {
  /**
   * Extra names to redact. Merged with names auto-derived from name-role columns.
   */
  recipientNames?: string[];
}

/**
 * Collect values from columns whose header looks like a person-name field, so they
 * can be handed to `stripPII` as literal names to redact.
 */
function deriveRecipientNames(row: CsvRow, columns: readonly CsvColumn[]): string[] {
  const names: string[] = [];
  for (const col of columns) {
    if (!isPersonNameColumn(col.name)) continue;
    const value = row.data[col.name];
    // A single character cannot be meaningfully redacted and would match everywhere.
    if (typeof value === 'string' && value.trim().length > 1) {
      names.push(value.trim());
    }
  }
  return names;
}

/**
 * Build the extraction text for one CSV row, with PII removed.
 *
 * Formatting contract is unchanged from the original inline implementation —
 * `"<column>: <value>"` per line, empty values omitted — so the extractor prompt
 * shape is preserved. The difference is that the result is stripped.
 */
export function buildStrippedRowText(
  row: CsvRow,
  columns: readonly CsvColumn[],
  options: BuildRowTextOptions = {},
): string {
  const raw = columns
    .map((col) => {
      const value = row.data[col.name] ?? '';
      return `${col.name}: ${value}`;
    })
    .filter((line) => !line.endsWith(': '))
    .join('\n');

  const recipientNames = [
    ...deriveRecipientNames(row, columns),
    ...(options.recipientNames ?? []),
  ];

  return stripPII(raw, { ...options, recipientNames }).strippedText;
}
