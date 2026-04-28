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
import { FORBIDDEN_TERMS, COMPOUND_BANNED_PHRASES } from './check-copy-terms.js';

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

describe('COMPOUND_BANNED_PHRASES (SCRUM-951)', () => {
  function compoundMatches(phrase: string, haystack: string): boolean {
    const re = new RegExp(`(?<![-\\w])${phrase.replace(/ /g, '\\s+')}(?![-\\w])`, 'gi');
    return re.test(haystack);
  }

  it('flags "Block Height" inside a className-bearing JSX line', () => {
    const phrase = COMPOUND_BANNED_PHRASES.find(p => p === 'block height');
    expect(phrase).toBeDefined();
    expect(compoundMatches(phrase!, '<p className="text-xs text-muted-foreground">Block Height</p>')).toBe(true);
  });

  it('flags "Block Height" case-insensitively', () => {
    expect(compoundMatches('block height', 'block height')).toBe(true);
    expect(compoundMatches('block height', 'BLOCK HEIGHT')).toBe(true);
    expect(compoundMatches('block height', 'Block  Height')).toBe(true); // multi-space
  });

  it('flags "Transaction Hash" + "Gas Fee" + "Gas Price"', () => {
    expect(compoundMatches('transaction hash', 'tx Transaction Hash here')).toBe(true);
    expect(compoundMatches('gas fee', 'pay the Gas Fee')).toBe(true);
    expect(compoundMatches('gas price', 'high Gas Price')).toBe(true);
  });

  it('does not match adjacent words from different phrases', () => {
    expect(compoundMatches('block height', 'the block of code has a height attribute')).toBe(false);
    expect(compoundMatches('gas fee', 'the gas station has a fee schedule')).toBe(false);
  });

  it('does not match inside identifiers (hyphen / underscore boundaries)', () => {
    expect(compoundMatches('block height', 'cssBlock-height-class')).toBe(false);
    expect(compoundMatches('block height', 'data-block_height')).toBe(false);
  });

  it('exposes a non-empty compound-phrase list', () => {
    expect(COMPOUND_BANNED_PHRASES.length).toBeGreaterThan(0);
    expect(COMPOUND_BANNED_PHRASES).toContain('block height');
  });
});
