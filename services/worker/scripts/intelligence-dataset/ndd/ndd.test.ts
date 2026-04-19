/**
 * NDD (Nessie Domain Depth) — unified test suite.
 *
 * Covers the 10 NDD stories (SCRUM-780..789). Every jurisdiction has
 * both an anchored source registry and a retrieval expectation set;
 * this suite proves the plumbing holds together end-to-end.
 */

import { describe, expect, it } from 'vitest';
import { NDD_SOURCES_BY_STORY, ALL_NDD_SOURCES } from './sources.js';
import { NDD_ENFORCEMENT_LADDERS } from './enforcement.js';
import { NDD_RETRIEVAL_TESTS } from './retrieval-tests.js';
import {
  NDD_CITATION_TARGET,
  NDD_TIER_TARGET,
  getNddPack,
  scoreNddStory,
  validateNddRegistry,
  type NddCandidateAnswer,
} from './scorer.js';
import type { NddStoryId } from './types.js';

const STORY_IDS: NddStoryId[] = [
  'ndd-01-ny', 'ndd-02-ca', 'ndd-03-hipaa-ocr', 'ndd-04-sox-pcaob',
  'ndd-05-ferpa', 'ndd-06-fcra-employment', 'ndd-07-kenya-odpc',
  'ndd-08-australia-app', 'ndd-09-gdpr-dpa', 'ndd-10-nigeria-sa',
];

describe('NDD registry integrity', () => {
  it('validates clean', () => {
    expect(validateNddRegistry()).toEqual([]);
  });

  it('has all 10 story registries', () => {
    for (const id of STORY_IDS) {
      expect(NDD_SOURCES_BY_STORY[id]).toBeDefined();
      expect(NDD_ENFORCEMENT_LADDERS[id]).toBeDefined();
      expect(NDD_RETRIEVAL_TESTS[id]).toBeDefined();
    }
  });

  it('every story has ≥3 anchored sources', () => {
    for (const id of STORY_IDS) {
      expect(NDD_SOURCES_BY_STORY[id].length).toBeGreaterThanOrEqual(3);
    }
  });

  it('every story has ≥2 retrieval tests', () => {
    for (const id of STORY_IDS) {
      expect(NDD_RETRIEVAL_TESTS[id].length).toBeGreaterThanOrEqual(2);
    }
  });

  it('every story has ≥1 enforcement rule', () => {
    for (const id of STORY_IDS) {
      expect(NDD_ENFORCEMENT_LADDERS[id].length).toBeGreaterThanOrEqual(1);
    }
  });

  it('source ids are globally unique across NDD', () => {
    const ids = new Set<string>();
    const dupes: string[] = [];
    for (const s of ALL_NDD_SOURCES) {
      if (ids.has(s.id)) dupes.push(s.id);
      ids.add(s.id);
    }
    expect(dupes).toEqual([]);
  });
});

describe('NDD scorer', () => {
  it('reports perfect score when every expectation is met', () => {
    const tests = NDD_RETRIEVAL_TESTS['ndd-01-ny'];
    const candidates: NddCandidateAnswer[] = tests.map((t) => ({
      query: t.query,
      citedSourceIds: [t.mustCiteAnyOf[0]],
      emittedTier: t.expectedTier,
    }));
    const report = scoreNddStory('ndd-01-ny', candidates);
    expect(report.citationHitRate).toBe(1);
    expect(report.tierAccuracy).toBe(1);
    expect(report.citationHitRate).toBeGreaterThanOrEqual(NDD_CITATION_TARGET);
    expect(report.tierAccuracy).toBeGreaterThanOrEqual(NDD_TIER_TARGET);
  });

  it('misses citation when candidate cites unrelated source', () => {
    const report = scoreNddStory('ndd-01-ny', [
      { query: 'NY SHIELD Act reasonable safeguards', citedSourceIds: ['unrelated-id'] },
    ]);
    const result = report.perQuery.find((r) => r.query.startsWith('NY SHIELD'));
    expect(result?.citationHit).toBe(false);
  });

  it('flags tier mismatch when candidate emits wrong enforcement tier', () => {
    const report = scoreNddStory('ndd-03-hipaa-ocr', [
      {
        query: 'HIPAA willful neglect uncorrected penalty tier',
        citedSourceIds: ['hitech-13410-tier-structure'],
        emittedTier: 'CIVIL_MINOR',
      },
    ]);
    const result = report.perQuery.find((r) => r.query.includes('willful neglect'));
    expect(result?.tierOk).toBe(false);
  });

  it('handles missing candidate as a full miss', () => {
    const report = scoreNddStory('ndd-02-ca', []);
    expect(report.citationHitRate).toBe(0);
    for (const p of report.perQuery) expect(p.citationHit).toBe(false);
  });

  it('getNddPack assembles sources + enforcement + tests', () => {
    const pack = getNddPack('ndd-09-gdpr-dpa', 'GDPR + DPA enforcement', 'federal-eu');
    expect(pack.storyId).toBe('ndd-09-gdpr-dpa');
    expect(pack.sources.length).toBeGreaterThan(0);
    expect(pack.enforcementRules.length).toBeGreaterThan(0);
    expect(pack.retrievalTests.length).toBeGreaterThan(0);
  });
});

describe('story-specific coverage spot checks', () => {
  it('NDD-01 covers SHIELD Act + 23 NYCRR 500 + NYC biometric', () => {
    const ids = new Set(NDD_SOURCES_BY_STORY['ndd-01-ny'].map((s) => s.id));
    expect(ids.has('ny-shield-act-899-bb')).toBe(true);
    expect(ids.has('ny-23-nycrr-500')).toBe(true);
    expect(ids.has('nyc-biometric-disclosure')).toBe(true);
  });

  it('NDD-02 covers CCPA + CPRA + CMIA + Delete Act', () => {
    const ids = new Set(NDD_SOURCES_BY_STORY['ndd-02-ca'].map((s) => s.id));
    expect(ids.has('ca-ccpa-1798-100')).toBe(true);
    expect(ids.has('ca-cpra-1798-121')).toBe(true);
    expect(ids.has('ca-cmia-56-10')).toBe(true);
    expect(ids.has('ca-delete-act-sb-362')).toBe(true);
  });

  it('NDD-03 HIPAA OCR includes HITECH tier structure + Anthem case', () => {
    const ids = new Set(NDD_SOURCES_BY_STORY['ndd-03-hipaa-ocr'].map((s) => s.id));
    expect(ids.has('hitech-13410-tier-structure')).toBe(true);
    expect(ids.has('anthem-2018-settlement')).toBe(true);
  });

  it('NDD-04 SOX includes §302 + §404 + §906 + PCAOB AS 2201', () => {
    const ids = new Set(NDD_SOURCES_BY_STORY['ndd-04-sox-pcaob'].map((s) => s.id));
    expect(ids.has('sox-section-302')).toBe(true);
    expect(ids.has('sox-section-404')).toBe(true);
    expect(ids.has('sox-section-906')).toBe(true);
    expect(ids.has('pcaob-as-2201')).toBe(true);
  });

  it('NDD-06 FCRA covers federal pre-adverse + CA ICRAA + NYC Fair Chance', () => {
    const ids = new Set(NDD_SOURCES_BY_STORY['ndd-06-fcra-employment'].map((s) => s.id));
    expect(ids.has('fcra-604-b-pre-adverse')).toBe(true);
    expect(ids.has('ca-icraa-1786-40')).toBe(true);
    expect(ids.has('nyc-fair-chance-act')).toBe(true);
  });

  it('NDD-09 GDPR covers Articles 5 + 35 + 46 + Schrems II', () => {
    const ids = new Set(NDD_SOURCES_BY_STORY['ndd-09-gdpr-dpa'].map((s) => s.id));
    expect(ids.has('gdpr-article-5-principles')).toBe(true);
    expect(ids.has('gdpr-article-35-dpia')).toBe(true);
    expect(ids.has('gdpr-article-46-transfers')).toBe(true);
    expect(ids.has('schrems-ii-c-311-18')).toBe(true);
  });

  it('NDD-10 covers Nigeria NDPA + South Africa POPIA (penalty sections separated from registration/transfer provisions)', () => {
    const ids = new Set(NDD_SOURCES_BY_STORY['ndd-10-nigeria-sa'].map((s) => s.id));
    expect(ids.has('ndpa-2023-section-26')).toBe(true);
    expect(ids.has('ndpa-2023-section-48')).toBe(true);
    expect(ids.has('ndpa-2023-section-52-penalty')).toBe(true);
    expect(ids.has('popia-section-11')).toBe(true);
    expect(ids.has('popia-section-72-transfer')).toBe(true);
    expect(ids.has('popia-section-109-penalties')).toBe(true);
  });
});

describe('enforcement tier ladders', () => {
  it('HIPAA ladder includes CIVIL_MAX willful neglect tier', () => {
    const tiers = NDD_ENFORCEMENT_LADDERS['ndd-03-hipaa-ocr'].map((r) => r.tier);
    expect(tiers).toContain('CIVIL_MAX');
  });

  it('SOX ladder includes CRIMINAL tier for §906', () => {
    const tiers = NDD_ENFORCEMENT_LADDERS['ndd-04-sox-pcaob'].map((r) => r.tier);
    expect(tiers).toContain('CRIMINAL');
  });

  it('Australia ladder caps at CIVIL_MAX (AUD 50M / 30% turnover)', () => {
    const tiers = NDD_ENFORCEMENT_LADDERS['ndd-08-australia-app'].map((r) => r.tier);
    expect(tiers).toContain('CIVIL_MAX');
  });

  it('GDPR ladder covers Article 83(4) + 83(5)', () => {
    const tiers = NDD_ENFORCEMENT_LADDERS['ndd-09-gdpr-dpa'].map((r) => r.tier);
    expect(tiers).toContain('CIVIL_MAJOR');
    expect(tiers).toContain('CIVIL_MAX');
  });
});
