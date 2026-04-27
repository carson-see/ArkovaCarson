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
import { FORBIDDEN_TERMS, findTermViolations } from './check-copy-terms.js';

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

describe('copy term scanner — JSX text with className', () => {
  it('flags banned compound text even when the JSX line also has className', () => {
    const violations = findTermViolations(
      '<span className="text-[10px] text-muted-foreground">Block Height</span>',
      1,
      'src/pages/PipelineAdminPage.tsx',
    );

    expect(violations.some((v) => v.term.toLowerCase() === 'block height')).toBe(true);
  });

  it('does not treat Tailwind class names as user-facing copy', () => {
    const violations = findTermViolations(
      '<div className="block text-sm">Network Checkpoint</div>',
      1,
      'src/pages/PipelineAdminPage.tsx',
    );

    expect(violations).toHaveLength(0);
  });
});
