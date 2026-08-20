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
 * Column names whose *values* are treated as person names and redacted wholesale.
 * Matched case-insensitively against the column header.
 */
const NAME_COLUMN_PATTERN =
  /(?:^|[_\s-])(?:name|recipient|holder|student|employee|attendee|participant|learner|candidate|member)(?:$|[_\s-])|^(?:full_?name|first_?name|last_?name|surname|given_?name)$/i;

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
    if (!NAME_COLUMN_PATTERN.test(col.name)) continue;
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
