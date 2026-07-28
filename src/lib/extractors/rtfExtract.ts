/**
 * RTF control-word stripper (F3 / SCRUM sprint amendment A3).
 *
 * CLIENT-SIDE ONLY — pure string parsing, no DOM/network/file-system access.
 * Constitution §1.6: never import this in `services/worker/`.
 *
 * Rich Text Format documents are `{\rtf1 ... }` group trees where visible text
 * is interleaved with control words (`\b`, `\par`, `\fs24`, ...), control
 * symbols (`\~`, `\-`, `\'hh`), and non-visible "destination" groups
 * (`\fonttbl`, `\colortbl`, `\pict`, ...). The previous behavior routed .rtf
 * through the plain-text reader, which dumped every control word into the
 * extracted text verbatim ("garbage output"). This module walks the RTF
 * token stream directly:
 *
 *  - Group depth (`{` / `}`) tracked as a stack; each group inherits its
 *    parent's "skip" (non-visible destination) flag and unicode-fallback
 *    count, so `{...}` scoping of `\b`/`\i`-style formatting never
 *    corrupts destination detection.
 *  - `\*` immediately followed by a control word marks an unknown /
 *    extension destination — skipped, per the RTF spec's "ignorable
 *    destination" convention.
 *  - Known non-visible destinations (`\fonttbl`, `\colortbl`, `\stylesheet`,
 *    `\info`, `\pict`, `\object`, ...) are skipped entirely.
 *  - `\par` / `\line` / `\page` become newlines, `\tab` becomes a tab.
 *  - Typographic control words (`\lquote`, `\emdash`, `\bullet`, ...) map to
 *    their real Unicode characters.
 *  - `\'hh` hex escapes are decoded via a CP-1252 byte table (RTF's default
 *    ANSI code page — matches Word's actual export encoding for curly quotes
 *    / em-dashes typed directly rather than via named control words).
 *  - `\uN` Unicode escapes read the signed 16-bit code point and then skip
 *    the `\ucN`-declared number of trailing fallback characters (default 1)
 *    that non-Unicode-aware readers would render instead.
 *
 * This is a pragmatic, spec-informed parser — not a full RTF 1.9.1
 * implementation (no font/codepage-table-driven decoding, no embedded
 * `\pict` image extraction). It is a pure state machine over the input
 * string: `i` is monotonically increasing, group-stack pops are guarded
 * against underflow, and there is no recursion — so it cannot hang and
 * cannot throw on malformed/truncated/non-RTF input. Worst case for garbage
 * input is a best-effort near-passthrough of literal characters.
 */

/** RTF destinations whose content is never visible document text. */
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'generator', 'pict', 'object',
  'filetbl', 'listtable', 'listoverridetable', 'rsidtbl', 'latentstyles',
  'xmlnstbl', 'themedata', 'colorschememapping', 'panose', 'wgrffmtfilter',
  'datastore', 'template', 'header', 'footer', 'footnote', 'annotation',
  'field', 'fldinst', 'nonshppict', 'bkmkstart', 'bkmkend', 'shpinst',
  'mmath', 'do', 'dptxbxtext',
]);

/** Control words that map directly to a visible character/whitespace unit. */
const CONTROL_WORD_CHARS: Record<string, string> = {
  par: '\n',
  line: '\n',
  page: '\n',
  tab: '\t',
  emdash: '—',
  endash: '–',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
  bullet: '•',
};

/**
 * CP-1252 (Windows-1252) mapping for the 0x80–0x9F range, the only byte
 * range where CP-1252 diverges from Latin-1/ISO-8859-1. RTF's default ANSI
 * code page is CP-1252, and `\'hh` hex escapes in real-world Word exports
 * commonly land in this range (curly quotes, em/en dash, ellipsis, trademark).
 */
const CP1252_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function decodeCp1252Byte(byte: number): string {
  return String.fromCharCode(CP1252_HIGH[byte] ?? byte);
}

/** Matches a control word: letters, optional signed numeric parameter, optional single trailing space delimiter. */
const CONTROL_WORD_RE = /^([a-zA-Z]+)(-?\d+)?( )?/;

/**
 * Strip RTF markup and return the plain-text document content.
 * Safe on malformed/truncated/non-RTF input — never throws, never hangs
 * (single forward pass, no recursion, no unbounded backtracking regex).
 */
export function extractTextFromRtf(input: string): string {
  const out: string[] = [];
  // Per-group state, inherited on `{` push, restored on `}` pop.
  const skipStack: boolean[] = [false];
  const ucStack: number[] = [1];
  let skipCount = 0; // remaining fallback units to swallow after a \uN escape

  const len = input.length;
  let i = 0;

  const isSkipping = () => skipStack[skipStack.length - 1];

  while (i < len) {
    const ch = input[i];

    if (ch === '{') {
      skipStack.push(skipStack[skipStack.length - 1]);
      ucStack.push(ucStack[ucStack.length - 1]);
      i++;
      continue;
    }

    if (ch === '}') {
      if (skipStack.length > 1) skipStack.pop();
      if (ucStack.length > 1) ucStack.pop();
      i++;
      continue;
    }

    if (ch === '\\') {
      const rest = input.slice(i + 1);
      const first = rest[0];

      // Escaped literal: \\  \{  \}
      if (first === '\\' || first === '{' || first === '}') {
        i += 2;
        if (skipCount > 0) {
          skipCount--;
        } else if (!isSkipping()) {
          out.push(first);
        }
        continue;
      }

      // Hex escape: \'hh
      if (first === "'") {
        const hex = rest.slice(1, 3);
        i += 4; // backslash + ' + 2 hex chars
        if (skipCount > 0) {
          skipCount--;
          continue;
        }
        if (!isSkipping() && /^[0-9a-fA-F]{2}$/.test(hex)) {
          out.push(decodeCp1252Byte(parseInt(hex, 16)));
        }
        continue;
      }

      // Control word
      const wordMatch = CONTROL_WORD_RE.exec(rest);
      if (wordMatch) {
        const [full, word, paramStr] = wordMatch;
        i += 1 + full.length;
        const param = paramStr !== undefined ? parseInt(paramStr, 10) : undefined;

        if (word === 'uc') {
          ucStack[ucStack.length - 1] = param !== undefined && param >= 0 ? param : 1;
          continue;
        }

        if (word === 'u') {
          if (!isSkipping() && param !== undefined) {
            const codePoint = param < 0 ? param + 65536 : param;
            out.push(String.fromCharCode(codePoint));
          }
          skipCount = ucStack[ucStack.length - 1];
          continue;
        }

        if (SKIP_DESTINATIONS.has(word)) {
          skipStack[skipStack.length - 1] = true;
          continue;
        }

        if (word in CONTROL_WORD_CHARS) {
          if (!isSkipping()) out.push(CONTROL_WORD_CHARS[word]);
          continue;
        }

        // Any other recognized-shape control word (formatting, e.g. \b, \fs24,
        // \ansi, \deff0) is consumed silently — no visible output.
        continue;
      }

      // `\*` ignorable-destination marker (not followed by a plain control
      // word match above — handled here so `\*\fonttbl` and bare `\*` both
      // mark the current group as non-visible).
      if (first === '*') {
        skipStack[skipStack.length - 1] = true;
        i += 2;
        continue;
      }

      // Unrecognized control symbol (single non-letter char after `\`).
      i += first === undefined ? 1 : 2;
      continue;
    }

    // Plain literal character. Source-formatting newlines/carriage returns
    // inside the RTF token stream are not document content.
    i++;
    if (ch === '\r' || ch === '\n') continue;
    if (skipCount > 0) {
      skipCount--;
      continue;
    }
    if (!isSkipping()) out.push(ch);
  }

  return normalizeRtfText(out.join(''));
}

function normalizeRtfText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
