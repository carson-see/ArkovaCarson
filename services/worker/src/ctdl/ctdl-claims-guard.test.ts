/**
 * SCRUM-2377 (CE-06a) — fail-closed claims-review gate (CLAUDE.md §1.13 R-7).
 *
 * Credential Engine approved Arkova TO PUBLISH; nothing is LISTED in the
 * Registry. Public output must never assert Registry-listing status (or any
 * "legally sufficient" claim) we do not hold. This suite pins the runtime
 * mechanism: phrase detection, the value-free error, the recursive body scan,
 * and the safe default wording.
 */

import { describe, expect, it } from 'vitest';
import {
  CE_PUBLICATION_STATUS_WORDING,
  ProhibitedClaimError,
  assertNoProhibitedClaimInJsonLd,
  containsProhibitedClaim,
} from './ctdl-claims-guard.js';

describe('containsProhibitedClaim', () => {
  it.each([
    'This credential is listed in the Registry.',
    'Now listed in the Credential Registry!',
    'LISTED IN THE REGISTRY',
    'listed   in the\tregistry', // whitespace-mangled variants still match
    'A Registry-listed credential',
    'registry listed since 2026',
    'Appears in the Credential Registry',
    // Round-1 review bypasses — phrase-family variants that slipped past the
    // original literal patterns (adversarial review 2026-07-06, finding 1).
    'listed in the CE Registry',
    'listed in the Credential Engine Registry',
    "listed in Credential Engine's Registry",
    'published in the Registry',
    'live in the Registry',
    'listed on the Registry',
    'listed with the Registry',
    'listed with Credential Engine',
    'appears in the Registry',
    'published on the Credential Engine Registry',
    'This proof is legally sufficient for court use.',
    'Legally  sufficient evidence',
  ])('flags the overclaim: %s', (overclaim) => {
    expect(containsProhibitedClaim(overclaim)).toBe(true);
  });

  it.each([
    // The one safe status wording (CE approved us TO PUBLISH — nothing more).
    'Arkova is approved to publish to Credential Engine.',
    'Approved to publish',
    // Arkova's OWN public credential registry surfaces are not CE Registry claims.
    'Search the public credential registry',
    'your credential registry is visible',
    'Issuer Registry',
    // Adjacent-but-honest phrasings.
    'submitted to the Registry for review',
    'Registry listing is not asserted',
    'not listed anywhere',
    'approved to publish to the Registry',
    'publishing to the Registry is not enabled',
    '',
  ])('does not flag honest wording: %s', (honest) => {
    expect(containsProhibitedClaim(honest)).toBe(false);
  });
});

describe('assertNoProhibitedClaimInJsonLd', () => {
  const cleanBody = {
    '@type': 'ceterms:Certificate',
    'ceterms:name': 'Ethics CLE Completion',
    'ceterms:offeredBy': { 'ceterms:name': 'Michigan Legal Education Board' },
    tags: ['continuing education', 'ethics'],
  };

  it('accepts a body with no prohibited claims', () => {
    expect(() => assertNoProhibitedClaimInJsonLd(cleanBody)).not.toThrow();
  });

  it('throws ProhibitedClaimError for an overclaim in a top-level string', () => {
    expect(() =>
      assertNoProhibitedClaimInJsonLd({
        ...cleanBody,
        'ceterms:description': 'This credential is listed in the Registry.',
      }),
    ).toThrow(ProhibitedClaimError);
  });

  it('throws for an overclaim nested deep in objects and arrays', () => {
    expect(() =>
      assertNoProhibitedClaimInJsonLd({
        ...cleanBody,
        nested: { deeper: [{ note: 'a Registry-listed credential' }] },
      }),
    ).toThrow(ProhibitedClaimError);
  });

  it('throws for a "legally sufficient" claim anywhere in the body', () => {
    expect(() =>
      assertNoProhibitedClaimInJsonLd({
        ...cleanBody,
        'ceterms:revocationReason': 'Reinstated; record legally sufficient.',
      }),
    ).toThrow(ProhibitedClaimError);
  });

  it('never echoes the offending value in the error message (value-free)', () => {
    try {
      assertNoProhibitedClaimInJsonLd({
        note: 'listed in the Registry — secret-marker-xyz',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ProhibitedClaimError);
      expect((error as Error).message).not.toContain('secret-marker-xyz');
      expect((error as Error).message).toMatch(/approved to publish/i);
    }
  });

  it('handles null / primitives / cyclic-depth without throwing on clean input', () => {
    expect(() => assertNoProhibitedClaimInJsonLd(null)).not.toThrow();
    expect(() => assertNoProhibitedClaimInJsonLd(42)).not.toThrow();
    expect(() => assertNoProhibitedClaimInJsonLd('approved to publish')).not.toThrow();
  });
});

// Round-1 review finding 3: exceeding the recursion budget must FAIL CLOSED
// (throw), never silently return — otherwise an overclaim nested deeper than
// the budget ships unscanned. Legit CTDL bodies are ~4 levels deep, so any
// body deeper than the budget is itself suspect and is refused outright.
describe('assertNoProhibitedClaimInJsonLd — recursion budget fails closed', () => {
  function nest(depth: number, leaf: unknown): unknown {
    let value: unknown = leaf;
    for (let i = 0; i < depth; i += 1) value = { nested: value };
    return value;
  }

  it('throws when the body exceeds the depth budget even when every string is clean', () => {
    expect(() => assertNoProhibitedClaimInJsonLd(nest(14, 'approved to publish'))).toThrow(/depth/i);
  });

  it('cannot be bypassed by hiding an overclaim deeper than the scan budget', () => {
    expect(() =>
      assertNoProhibitedClaimInJsonLd(nest(14, 'listed in the Registry')),
    ).toThrow();
  });

  it('throws for an over-deep array nesting as well as object nesting', () => {
    let value: unknown = 'listed in the Registry';
    for (let i = 0; i < 14; i += 1) value = [value];
    expect(() => assertNoProhibitedClaimInJsonLd(value)).toThrow();
  });

  it('still accepts a clean body within the budget', () => {
    expect(() => assertNoProhibitedClaimInJsonLd(nest(10, 'approved to publish'))).not.toThrow();
  });

  it('still throws ProhibitedClaimError for an overclaim within the budget', () => {
    expect(() =>
      assertNoProhibitedClaimInJsonLd(nest(10, 'listed in the Registry')),
    ).toThrow(ProhibitedClaimError);
  });
});

describe('CE_PUBLICATION_STATUS_WORDING (safe default wording)', () => {
  it('is "approved to publish" — never a listing assertion', () => {
    expect(CE_PUBLICATION_STATUS_WORDING).toBe('approved to publish');
    expect(containsProhibitedClaim(CE_PUBLICATION_STATUS_WORDING)).toBe(false);
    expect(CE_PUBLICATION_STATUS_WORDING.toLowerCase()).not.toContain('listed');
  });
});
