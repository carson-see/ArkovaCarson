/**
 * KAU-05 (SCRUM-753) + KAU-06 (SCRUM-754) — Kenya/Australia tests.
 *
 * Covers credential taxonomy matching + NDB retrieval expectations.
 */

import { describe, expect, it } from 'vitest';
import {
  KAU_CREDENTIAL_TYPES,
  kauFewShotExamples,
  matchKauCredential,
  validateKauCoverage,
} from './credentials';
import {
  KAU_NDB_PROCEDURES,
  KAU_NDB_RETRIEVAL_TESTS,
  KAU_NDB_SOURCES,
  getNdbProcedure,
  ndbSource,
  validateKauNdb,
} from './ndb-sources';

describe('KAU credential taxonomy', () => {
  it('meets the minimum coverage bar (≥5 per jurisdiction)', () => {
    const errs = validateKauCoverage();
    expect(errs).toEqual([]);
  });

  it('has no duplicate ids', () => {
    const ids = new Set(KAU_CREDENTIAL_TYPES.map((c) => c.id));
    expect(ids.size).toBe(KAU_CREDENTIAL_TYPES.length);
  });

  it('every id is stable kebab-case', () => {
    for (const c of KAU_CREDENTIAL_TYPES) {
      expect(c.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('every id is prefixed by jurisdiction code (ke- or au-)', () => {
    for (const c of KAU_CREDENTIAL_TYPES) {
      const prefix = c.jurisdiction.startsWith('AU') ? 'au-' : 'ke-';
      expect(c.id.startsWith(prefix)).toBe(true);
    }
  });

  it('matches KNEC text to Kenya KCSE certificate', () => {
    const hit = matchKauCredential('Kenya Certificate of Secondary Education');
    expect(hit?.id).toBe('ke-knec-kcse');
  });

  it('matches AHPRA text to the AHPRA registration entry', () => {
    const hit = matchKauCredential('AHPRA registration number 12345');
    expect(hit?.id).toBe('au-ahpra-registration');
  });

  it('returns null for ambiguous matches (future: human review required)', () => {
    // Intentionally empty keywords — nothing to match against.
    const hit = matchKauCredential('unrelated document content');
    expect(hit).toBeNull();
  });

  it('prefers longer keyword matches when multiple apply', () => {
    // Both `Law Society of Kenya` and `Law Society of New South Wales` would
    // hit `Law Society`; the NSW match wins on length.
    const hit = matchKauCredential('Law Society of New South Wales practising certificate');
    expect(hit?.id).toBe('au-nsw-law-society');
  });

  it('few-shot examples point at real credential ids', () => {
    const examples = kauFewShotExamples();
    expect(examples.length).toBeGreaterThanOrEqual(5);
    const ids = new Set(KAU_CREDENTIAL_TYPES.map((c) => c.id));
    for (const ex of examples) {
      expect(ids.has(ex.output.subType)).toBe(true);
      expect(ex.output.confidence).toBeGreaterThan(0.5);
      expect(ex.output.confidence).toBeLessThanOrEqual(0.99);
    }
  });
});

describe('KAU NDB procedures', () => {
  it('validates clean', () => {
    expect(validateKauNdb()).toEqual([]);
  });

  it('every retrieval test anchors to a registered source', () => {
    const ids = new Set(KAU_NDB_SOURCES.map((s) => s.id));
    for (const t of KAU_NDB_RETRIEVAL_TESTS) {
      for (const a of t.mustCiteAnyOf) expect(ids.has(a)).toBe(true);
    }
  });

  it('Kenya NDB timeline is exactly 72 hours', () => {
    const ke = getNdbProcedure('KE');
    expect(ke.timeline).toBe('72h');
  });

  it('Australia NDB assessment window is 30 days', () => {
    const au = getNdbProcedure('AU');
    expect(au.timeline).toBe('30d');
  });

  it('Kenya procedure anchors KDPA §43', () => {
    const ke = getNdbProcedure('KE');
    expect(ke.anchorSources).toContain('kdpa-43-notification');
  });

  it('Australia procedure anchors Part IIIC and §26WE', () => {
    const au = getNdbProcedure('AU');
    expect(au.anchorSources).toContain('au-privacy-part-iiic');
    expect(au.anchorSources).toContain('au-ndb-eligible-breach');
  });

  it('source lookup throws on unknown id', () => {
    expect(() => ndbSource('does-not-exist')).toThrow(/not found/);
  });

  it('retrieval test "Kenya breach notification timeline" cites KDPA §43', () => {
    const t = KAU_NDB_RETRIEVAL_TESTS.find((x) => x.query.startsWith('Kenya breach'));
    expect(t?.mustCiteAnyOf).toContain('kdpa-43-notification');
  });

  it('at least 2 retrieval tests per jurisdiction', () => {
    const ke = KAU_NDB_RETRIEVAL_TESTS.filter((t) => t.jurisdiction === 'KE').length;
    const au = KAU_NDB_RETRIEVAL_TESTS.filter((t) => t.jurisdiction === 'AU').length;
    expect(ke).toBeGreaterThanOrEqual(2);
    expect(au).toBeGreaterThanOrEqual(2);
  });

  it('each procedure enumerates required notification content', () => {
    for (const p of KAU_NDB_PROCEDURES) {
      expect(p.requiredContent.length).toBeGreaterThanOrEqual(3);
    }
  });
});
