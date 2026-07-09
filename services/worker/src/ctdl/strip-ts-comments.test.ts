/**
 * Round-1 review finding 6 — the lint tests' comment stripper must NOT treat
 * the `//` inside a URL string literal as a line comment. The old per-line
 * `indexOf('//')` truncated `'https://x/billing/credits'` right after
 * `https:`, blinding the conflation/claims lints to any marker appearing
 * after a URL scheme on the same line.
 */

import { describe, expect, it } from 'vitest';
import { stripTsComments } from './strip-ts-comments.js';

describe('stripTsComments', () => {
  it('preserves string content after https:// on a line (the review bypass fixture)', () => {
    const source = "const url = 'https://example.com/billing/credits';\n";
    const stripped = stripTsComments(source);
    expect(stripped).toContain('billing/credits');
    expect(stripped).toContain('https://example.com/billing/credits');
  });

  it('preserves double-quoted and template-literal URLs too', () => {
    expect(stripTsComments('const a = "https://ce.org/registry/publish";')).toContain(
      'registry/publish',
    );
    expect(stripTsComments('const b = `https://ce.org/credit_ledger`;')).toContain(
      'credit_ledger',
    );
  });

  it('still strips a real line comment', () => {
    const stripped = stripTsComments('const x = 1; // credit_ledger in a comment\n');
    expect(stripped).not.toContain('credit_ledger');
    expect(stripped).toContain('const x = 1;');
  });

  it('strips a trailing line comment after a URL string on the same line', () => {
    const stripped = stripTsComments(
      "const url = 'https://example.com/ok'; // mentions credit_ledger\n",
    );
    expect(stripped).toContain('https://example.com/ok');
    expect(stripped).not.toContain('credit_ledger');
  });

  it('still strips block comments, preserving line numbering', () => {
    const stripped = stripTsComments('/* credit_ledger\nspans lines */const y = 2;');
    expect(stripped).not.toContain('credit_ledger');
    expect(stripped).toBe('\nconst y = 2;');
  });

  it('does not treat comment openers inside strings as comments', () => {
    const stripped = stripTsComments("const s = 'not /* a block */ comment';");
    expect(stripped).toContain('not /* a block */ comment');
  });

  it('honours escaped quotes inside strings', () => {
    const stripped = stripTsComments("const s = 'it\\'s https://x/credit_ledger';");
    expect(stripped).toContain('credit_ledger');
  });

  it('keeps line comments terminating at the newline (following code survives)', () => {
    const stripped = stripTsComments('// only a comment\nconst z = 3;');
    expect(stripped).toBe('\nconst z = 3;');
  });
});
