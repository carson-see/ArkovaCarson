/**
 * String-aware TypeScript comment stripper for the CTDL lint-style tests
 * (ctdl-claims-lint.test.ts, ctdl-credit-conflation-guard.test.ts).
 *
 * Round-1 review finding 6: the previous per-line `indexOf('//')` treated the
 * `//` inside a URL string literal (e.g. `'https://x/billing/credits'`) as a
 * line comment and dropped everything after it — blinding the lint to any
 * marker that appeared after `https://` on a line. This stripper tracks
 * string-literal state ('…', "…", `…`) so line comments and block comments are
 * removed only when they occur in actual code, never inside a string.
 *
 * Newlines are preserved (line comments keep their terminating newline; block
 * comments keep their embedded newlines) so match-index → line-number
 * reporting in the lint tests stays accurate.
 *
 * Known limitation (accepted): a regex literal whose body contains two
 * consecutive slashes or a slash-star pair can be mis-read as a comment
 * opener — none of the scanned production sources use such a literal, and a
 * false trim there would only ever hide regex source text, not a publishable
 * string.
 */
export function stripTsComments(source: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (mode === 'code') {
      if (ch === '/' && next === '/') {
        mode = 'line';
        i += 2;
      } else if (ch === '/' && next === '*') {
        mode = 'block';
        i += 2;
      } else {
        if (ch === "'") mode = 'single';
        else if (ch === '"') mode = 'double';
        else if (ch === '`') mode = 'template';
        out += ch;
        i += 1;
      }
      continue;
    }

    if (mode === 'line') {
      if (ch === '\n') {
        mode = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }

    if (mode === 'block') {
      if (ch === '*' && next === '/') {
        mode = 'code';
        i += 2;
      } else {
        if (ch === '\n') out += ch; // preserve line numbering
        i += 1;
      }
      continue;
    }

    // Inside a string literal: copy verbatim, honour escapes, exit on the
    // matching quote. Template-literal interpolation is treated as string
    // content (conservative: nothing inside a template is ever stripped).
    if (ch === '\\') {
      out += ch + (next ?? '');
      i += 2;
      continue;
    }
    if (
      (mode === 'single' && ch === "'") ||
      (mode === 'double' && ch === '"') ||
      (mode === 'template' && ch === '`')
    ) {
      mode = 'code';
    }
    out += ch;
    i += 1;
  }

  return out;
}
