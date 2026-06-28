import { describe, expect, it } from 'vitest';
import {
  FabricatedCtidError,
  assertRealCtidOrAbsent,
  assertNoFabricatedCtidInJsonLd,
  isRealCtid,
} from './ctdl-ctid-guard.js';

// SCRUM-2373 (CE-02) — no fake CTIDs.
//
// A real Credential Engine CTID is a `ce-` prefix followed by a v4-style UUID
// (`ce-` + 8-4-4-4-12 hex). Anything else — a synthesized placeholder derived
// from an Arkova public id, a `urn:ctid:` form, a bare `ce-xxxx` stub, or empty
// noise — is fabricated and must be REJECTED before it can reach serialized
// public output. A genuinely absent CTID is honest and must be allowed (the
// serializer simply omits the optional `ceterms:ctid` field).

const REAL_CTID = 'ce-26fa1c52-7e4b-4f0a-9b1e-3d2c5a8f0011';

describe('isRealCtid', () => {
  it('accepts a real Credential Engine CTID (ce- + UUID)', () => {
    expect(isRealCtid(REAL_CTID)).toBe(true);
    expect(isRealCtid('ce-11111111-1111-1111-1111-111111111111')).toBe(true);
  });

  it('rejects fabricated / placeholder CTID shapes', () => {
    expect(isRealCtid('ce-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')).toBe(false);
    expect(isRealCtid('ce-ARK-2026-CTDL-001')).toBe(false);
    expect(isRealCtid('ce-ORG-ARKOVA-U')).toBe(false);
    expect(isRealCtid('urn:ctid:ARK-2026-CTDL-001')).toBe(false);
    expect(isRealCtid('ce-1234')).toBe(false);
    expect(isRealCtid('ARK-2026-CTDL-001')).toBe(false);
    expect(isRealCtid('ce-')).toBe(false);
  });

  it('rejects non-string / empty values', () => {
    expect(isRealCtid(null)).toBe(false);
    expect(isRealCtid(undefined)).toBe(false);
    expect(isRealCtid('')).toBe(false);
    expect(isRealCtid('   ')).toBe(false);
    expect(isRealCtid(42 as unknown)).toBe(false);
  });
});

describe('assertRealCtidOrAbsent', () => {
  it('returns the canonical CTID when a real CTID is provided', () => {
    expect(assertRealCtidOrAbsent(REAL_CTID, 'credential')).toBe(REAL_CTID);
    expect(assertRealCtidOrAbsent(`  ${REAL_CTID}  `, 'credential')).toBe(REAL_CTID);
  });

  it('returns undefined for an absent CTID (null / undefined / empty)', () => {
    expect(assertRealCtidOrAbsent(null, 'credential')).toBeUndefined();
    expect(assertRealCtidOrAbsent(undefined, 'issuer')).toBeUndefined();
    expect(assertRealCtidOrAbsent('', 'credential')).toBeUndefined();
    expect(assertRealCtidOrAbsent('   ', 'issuer')).toBeUndefined();
  });

  it('THROWS FabricatedCtidError for a fabricated CTID rather than silently dropping it', () => {
    expect(() => assertRealCtidOrAbsent('ce-ARK-2026-CTDL-001', 'credential')).toThrow(FabricatedCtidError);
    expect(() => assertRealCtidOrAbsent('ce-ORG-ARKOVA-U', 'issuer')).toThrow(FabricatedCtidError);
    expect(() => assertRealCtidOrAbsent('urn:ctid:made-up', 'credential')).toThrow(FabricatedCtidError);
    expect(() => assertRealCtidOrAbsent('ce-xxxx', 'credential')).toThrow(FabricatedCtidError);
  });

  it('never includes the offending CTID value in the error message (no echo of bad data)', () => {
    try {
      assertRealCtidOrAbsent('ce-secret-leak-ARK-2026', 'credential');
      throw new Error('expected FabricatedCtidError');
    } catch (error) {
      expect(error).toBeInstanceOf(FabricatedCtidError);
      expect((error as Error).message).not.toContain('secret-leak');
      expect((error as Error).message).toContain('credential');
    }
  });
});

describe('assertNoFabricatedCtidInJsonLd (defense-in-depth output scan)', () => {
  it('passes a body with no CTID at all', () => {
    expect(() => assertNoFabricatedCtidInJsonLd({ '@type': 'ceterms:Certificate' })).not.toThrow();
  });

  it('passes a body whose ceterms:ctid fields are all real', () => {
    expect(() =>
      assertNoFabricatedCtidInJsonLd({
        'ceterms:ctid': REAL_CTID,
        'ceterms:offeredBy': { 'ceterms:ctid': 'ce-22222222-2222-2222-2222-222222222222' },
      }),
    ).not.toThrow();
  });

  it('THROWS when any ceterms:ctid anywhere in the body is fabricated', () => {
    expect(() =>
      assertNoFabricatedCtidInJsonLd({ 'ceterms:ctid': 'ce-ARK-2026-CTDL-001' }),
    ).toThrow(FabricatedCtidError);
    expect(() =>
      assertNoFabricatedCtidInJsonLd({
        'ceterms:ctid': REAL_CTID,
        'ceterms:offeredBy': { 'ceterms:ctid': 'urn:ctid:fake-org' },
      }),
    ).toThrow(FabricatedCtidError);
  });

  it('THROWS when a ceterms:ctid key holds an empty/blank string (never emit an empty CTID)', () => {
    expect(() => assertNoFabricatedCtidInJsonLd({ 'ceterms:ctid': '' })).toThrow(FabricatedCtidError);
  });
});
