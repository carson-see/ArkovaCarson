import { describe, it, expect } from 'vitest';
import { toJsonLd } from './jsonLd';

describe('toJsonLd (SCRUM-4989 review)', () => {
  it('escapes </script so a string field cannot close the JSON-LD block', () => {
    const out = toJsonLd({ name: 'x</script><script>alert(1)</script>' });
    // Assert the property — no raw `<` reaches the tokenizer, and the payload
    // still round-trips — not one particular escape form.
    expect(out).not.toContain('</script');
    expect(out).not.toContain('<');
    expect(JSON.parse(out)).toEqual({ name: 'x</script><script>alert(1)</script>' });
  });

  it('is case-insensitive on the closing tag, and keeps the original casing', () => {
    const out = toJsonLd({ a: '</ScRiPt>' });
    expect(out).not.toMatch(/<\/script/i);
    // A case-insensitive replace that substitutes a lowercase literal silently
    // rewrites the payload: `</ScRiPt>` in a title came back out `</script>`.
    expect(JSON.parse(out).a).toBe('</ScRiPt>');
  });

  // `<!--` puts the HTML tokenizer into script-data-escaped state; a later
  // `<script` reaches double-escaped state, where the real closing tag no
  // longer ends the block and the rest of the document is swallowed.
  it('escapes <!-- and <script so the tokenizer cannot enter the escaped states', () => {
    const out = toJsonLd({ a: '<!--<script>alert(1)' });
    expect(out).not.toContain('<!--');
    expect(out).not.toMatch(/<script/i);
    expect(JSON.parse(out).a).toBe('<!--<script>alert(1)');
  });

  // JSON.stringify leaves these raw; they are JS line terminators, so any
  // consumer that evaluates rather than parses the block breaks on them.
  it('escapes U+2028 and U+2029', () => {
    const raw = 'a\u2028b\u2029c';
    const out = toJsonLd({ a: raw });
    expect(out).not.toContain('\u2028');
    expect(out).not.toContain('\u2029');
    expect(JSON.parse(out).a).toBe(raw);
  });

  it('leaves ordinary values untouched', () => {
    expect(toJsonLd({ a: 1, b: 'plain' })).toBe('{"a":1,"b":"plain"}');
  });
});
