/**
 * CIBA-HARDEN-05 — ensure the new [A-Za-z0-9] boundaries catch the leak
 * vectors that the old \w boundaries missed.
 *
 * The old pattern `(?<![-\w])service_role(?![-\w])` failed on
 * SUPABASE_SERVICE_ROLE_KEY because `_` is a word character, so the
 * lookbehind matched adjacent `_` and rejected. Swapping to [A-Za-z0-9]
 * lets `_` act as a boundary.
 */

import { describe, it, expect } from 'vitest';
import { FORBIDDEN_TERMS, stripClassNameAttributes } from './check-copy-terms.js';

function matches(term: string, haystack: string): boolean {
  return new RegExp(term, 'gi').test(haystack);
}

function findTerm(substring: string): string {
  const term = FORBIDDEN_TERMS.find((t) => t.includes(substring));
  if (!term) throw new Error(`No FORBIDDEN_TERMS entry contains "${substring}"`);
  return term;
}

describe('FORBIDDEN_TERMS — service_role / service role boundaries', () => {
  const term = findTerm('service_role');

  it('matches the service_role env-var name embedded in a larger identifier', () => {
    expect(matches(term, 'SUPABASE_SERVICE_ROLE_KEY not set')).toBe(true);
    expect(matches(term, 'Using service_role permissions')).toBe(true);
  });

  it('does not match genuinely unrelated words', () => {
    expect(matches(term, 'ideaservice_roles are outside scope')).toBe(false);
  });
});

describe('FORBIDDEN_TERMS — postgrest CamelCase', () => {
  const term = findTerm('postgrest');

  it('matches PostgRESTError case-insensitively', () => {
    expect(matches(term, 'PostgRESTError: connection reset')).toBe(true);
    expect(matches(term, 'error.PostgRESTError')).toBe(true);
  });

  it('matches plain "postgrest" references', () => {
    expect(matches(term, 'postgrest rejected the upsert')).toBe(true);
  });

  it('does not match unrelated words sharing a prefix', () => {
    expect(matches(term, 'postgresql is the DB')).toBe(false);
  });
});

describe('stripClassNameAttributes — compound-phrase bypass (SCRUM-951)', () => {
  it('strips a string-literal className value', () => {
    const out = stripClassNameAttributes(
      '<p className="text-[10px] block text-block-fg">Block Height</p>',
    );
    expect(out).not.toContain('text-[10px]');
    expect(out).toContain('Block Height');
  });

  it('strips a single-quoted className value', () => {
    const out = stripClassNameAttributes("<p className='inline-block'>Block Height</p>");
    expect(out).not.toContain('inline-block');
    expect(out).toContain('Block Height');
  });

  it('strips a brace-expression className with a template literal', () => {
    const out = stripClassNameAttributes(
      '<p className={`text-${primary} block`}>Block Height</p>',
    );
    expect(out).toContain('Block Height');
    expect(out).not.toMatch(/`text-\$\{primary\} block`/);
  });

  it('strips a brace-expression className with a function call', () => {
    const out = stripClassNameAttributes(
      "<p className={cn('inline-block', isOpen && 'block')}>Block Height</p>",
    );
    expect(out).toContain('Block Height');
    expect(out).not.toContain("'inline-block'");
  });

  it('removes JSX comments so engineering notes can mention banned terms by name', () => {
    const out = stripClassNameAttributes(
      '<div>{/* SCRUM-951 — Block Height label rename */}<p>OK</p></div>',
    );
    expect(out).not.toContain('Block Height');
    expect(out).toContain('OK');
  });

  it('preserves user-visible JSX text outside attributes', () => {
    const out = stripClassNameAttributes(
      '<button className="bg-block">Click here to view receipt</button>',
    );
    expect(out).toContain('Click here to view receipt');
  });
});

/**
 * The `isCodeIdentifier` post-filter must skip JSX components (`<Hash`),
 * closing tags (`</Hash>`), and property access (`obj.bitcoin`) — but it
 * must NOT mask user-visible copy that happens to share a prefix character.
 */
describe('isCodeIdentifier — does not over-skip user-visible copy', () => {
  it('flags banned word after a bare slash (URL-like) — bare slash is not a code prefix', () => {
    const term = findTerm('hash');
    const cleaned = stripClassNameAttributes('<p>Please visit /hash for guidance.</p>');
    const regex = new RegExp(term, 'gi');
    const match = regex.exec(cleaned);
    expect(match).not.toBeNull();
    // Without the `</` tightening, isCodeIdentifier returned true for any
    // preceding `/`, silently masking this hit.
    expect(cleaned[match!.index - 1]).toBe('/');
  });

  it('flags a banned word that follows a sentence-ending period', () => {
    const term = findTerm('postgrest');
    const cleaned = stripClassNameAttributes('<p>Done. PostgRESTError thrown.</p>');
    expect(matches(term, cleaned)).toBe(true);
  });
});

describe('FORBIDDEN_TERMS — block compound-phrase detection (SCRUM-951)', () => {
  const blockTerm = findTerm('block(');

  it('flags free-standing "Block Height" in JSX text after className strip', () => {
    const cleaned = stripClassNameAttributes(
      '<p className="text-[10px] text-[#859398]">Block Height</p>',
    );
    expect(matches(blockTerm, cleaned)).toBe(true);
  });

  it('flags "Block Hash" in JSX text after className strip', () => {
    const cleaned = stripClassNameAttributes(
      '<span className="font-mono">Block Hash</span>',
    );
    expect(matches(blockTerm, cleaned)).toBe(true);
  });

  it('does not flag Tailwind tokens like inline-block or text-block-fg', () => {
    // hyphen boundaries on both sides — never a user-copy match.
    const cleaned = stripClassNameAttributes(
      '<p className="inline-block text-block-fg">Network Checkpoint</p>',
    );
    expect(matches(blockTerm, cleaned)).toBe(false);
  });
});
