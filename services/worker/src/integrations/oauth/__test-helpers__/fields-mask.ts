/**
 * Structural validator for a Google Drive API partial-response `fields`
 * mask (SCRUM-2903 / SCRUM-3661 fields-mask incident).
 *
 * Root cause this exists to guard against: `listChanges` in `../drive.ts`
 * built its `fields` param via
 * `['newStartPageToken', 'nextPageToken', 'changes(...', ...].join('')` — an
 * EMPTY-STRING join, so consecutive top-level entries fused together with no
 * comma. Google answered every call with HTTP 400
 * `Invalid field selection newStartPageTokennextP...` — every Drive change
 * notification failed, silently, since the 2026-05-04 commit that introduced
 * it.
 *
 * SCOPE NOTE — read before trusting this validator alone. A `.join('')` bug
 * with NO separator character fuses two field names into one longer,
 * syntactically-VALID-looking identifier: `newStartPageToken` + `nextPageToken`
 * becomes the single token `newStartPageTokennextPageToken`. A structural
 * tokenizer has no way to know that is two field names wearing a trenchcoat —
 * doing so would require hardcoding Google's actual field vocabulary, which
 * this module deliberately does not (Drive's schema is Google's to change,
 * not ours to freeze). This validator is defense-in-depth against a
 * DIFFERENT, syntactically-detectable malformation class: unbalanced
 * parentheses, a stray/empty/trailing comma, or a whitespace-joined mask
 * (e.g. an accidental `.join(' ')`, which DOES leave two identifier tokens
 * genuinely adjacent with a separator between them, and that this validator
 * does catch).
 *
 * Every call site's test therefore asserts the DECODED fields string against
 * an EXACT expected literal in addition to calling this validator — the
 * exact-string assertion is what pins the true regression down; this
 * function narrows the space of "how else could a mask be wrong" beyond
 * copy-paste drift in that literal.
 */
export function assertValidFieldsMask(mask: string): void {
  if (mask.length === 0) {
    throw new Error('fields mask is empty');
  }
  if (/\s/.test(mask)) {
    throw new Error(
      `fields mask contains whitespace — a Drive fields mask is never whitespace-separated: ${JSON.stringify(mask)}`,
    );
  }

  type TokenKind = 'ident' | ',' | '(' | ')' | '/' | '*';
  interface Token {
    kind: TokenKind;
    value: string;
  }

  const tokens: Token[] = [];
  const tokenPattern = /[A-Za-z_][A-Za-z0-9_]*|[,()/*]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(mask)) !== null) {
    if (match.index !== cursor) {
      throw new Error(
        `fields mask has an unrecognized character at index ${cursor}: ${JSON.stringify(mask.slice(cursor, match.index))} in ${JSON.stringify(mask)}`,
      );
    }
    const value = match[0];
    cursor = match.index + value.length;
    const kind: TokenKind = /^[A-Za-z_]/.test(value) ? 'ident' : (value as TokenKind);
    tokens.push({ kind, value });
  }
  if (cursor !== mask.length) {
    throw new Error(
      `fields mask has an unrecognized character at index ${cursor}: ${JSON.stringify(mask.slice(cursor))} in ${JSON.stringify(mask)}`,
    );
  }
  if (tokens.length === 0) {
    throw new Error('fields mask has no tokens');
  }

  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const prev = tokens[i - 1];

    if (token.kind === '(') depth += 1;
    if (token.kind === ')') {
      depth -= 1;
      if (depth < 0) {
        throw new Error(`fields mask has an unmatched ')' (unbalanced parentheses): ${JSON.stringify(mask)}`);
      }
    }

    // Two identifiers back-to-back with no separating token. A join-with-no-
    // separator bug fuses into ONE ident token and can never produce this —
    // this catches the case where a stray SEPARATOR character (e.g. a space
    // from a wrong `.join(' ')`) left two real tokens adjacent instead.
    if (token.kind === 'ident' && prev?.kind === 'ident') {
      throw new Error(
        `fields mask has two adjacent identifiers with no comma between them: "${prev.value}" then "${token.value}" in ${JSON.stringify(mask)}`,
      );
    }

    if (token.kind === ',' && (prev === undefined || prev.kind === ',' || prev.kind === '(')) {
      throw new Error(`fields mask has an empty or stray comma (token ${i}) in ${JSON.stringify(mask)}`);
    }
  }

  if (depth !== 0) {
    throw new Error(`fields mask has ${depth} unmatched '(' (unbalanced parentheses): ${JSON.stringify(mask)}`);
  }

  const last = tokens[tokens.length - 1];
  if (last.kind === ',') {
    throw new Error(`fields mask ends with a trailing comma: ${JSON.stringify(mask)}`);
  }
  if (last.kind === '(') {
    throw new Error(`fields mask ends with an unclosed '(': ${JSON.stringify(mask)}`);
  }
}
