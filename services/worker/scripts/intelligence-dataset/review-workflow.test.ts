/**
 * NVI-05 — Attorney-review workflow tests (SCRUM-809).
 *
 * Covers tier classification + packet generation. All tests are offline and
 * deterministic.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyEntry,
  classifyRegistry,
  renderTier3Packet,
  renderTier1Summary,
  renderTier2Summary,
  type ReviewTier,
} from './review-workflow';
import type { Registry } from './validators/verification-registry';
import type { VerificationResult } from './validators/types';

const NOW = '2026-04-17T00:00:00.000Z';

function mkResult(over: Partial<VerificationResult> = {}): VerificationResult {
  return {
    sourceId: 'x',
    validator: 'statute-quote',
    passed: false,
    hardFail: true,
    notes: 'format bad',
    verifiedAt: NOW,
    ...over,
  };
}

describe('classifyEntry — NVI-05 tier classification', () => {
  it('orphaned sources go to Tier 3 (attorney)', () => {
    const decision = classifyEntry('orphan-1', {
      lastVerifiedAt: NOW,
      overallPassed: false,
      overallHardFail: false,
      orphaned: true,
      results: [],
    });
    expect(decision.tier).toBe(3);
    expect(decision.reasons.join(' ')).toMatch(/orphan/i);
  });

  it('case-law hard-fails go to Tier 3 (interpretation)', () => {
    const decision = classifyEntry('case-1', {
      lastVerifiedAt: NOW,
      overallPassed: false,
      overallHardFail: true,
      orphaned: false,
      results: [
        mkResult({ validator: 'case-law', notes: 'no decision year in parentheses' }),
      ],
    });
    expect(decision.tier).toBe(3);
  });

  it('state-statute hard-fails go to Tier 3 (state overlay)', () => {
    const decision = classifyEntry('state-1', {
      lastVerifiedAt: NOW,
      overallPassed: false,
      overallHardFail: true,
      orphaned: false,
      results: [
        mkResult({ validator: 'state-statute', notes: 'section label does not match state code prefix' }),
      ],
    });
    expect(decision.tier).toBe(3);
  });

  it('soft-fails-only go to Tier 1 (mechanical)', () => {
    const decision = classifyEntry('soft-1', {
      lastVerifiedAt: NOW,
      overallPassed: false,
      overallHardFail: false,
      orphaned: false,
      results: [
        mkResult({ validator: 'case-law', passed: false, hardFail: false, notes: 'no reporter cite detected' }),
      ],
    });
    expect(decision.tier).toBe(1);
  });

  it('agency-bulletin hard-fails go to Tier 2 (LLM consensus)', () => {
    const decision = classifyEntry('agency-1', {
      lastVerifiedAt: NOW,
      overallPassed: false,
      overallHardFail: true,
      orphaned: false,
      results: [
        mkResult({ validator: 'agency-bulletin', notes: 'no agency identifier matched' }),
      ],
    });
    expect(decision.tier).toBe(2);
  });

  it('statute-quote hard-fails go to Tier 1 when fix is mechanical (section-number missing)', () => {
    const decision = classifyEntry('statute-1', {
      lastVerifiedAt: NOW,
      overallPassed: false,
      overallHardFail: true,
      orphaned: false,
      results: [
        mkResult({ validator: 'statute-quote', notes: 'quote does not reference section number §604(b)(3)' }),
      ],
    });
    expect(decision.tier).toBe(1);
  });

  it('passing sources are not routed (tier = null)', () => {
    const decision = classifyEntry('ok-1', {
      lastVerifiedAt: NOW,
      overallPassed: true,
      overallHardFail: false,
      orphaned: false,
      results: [mkResult({ passed: true, hardFail: false, notes: 'ok' })],
    });
    expect(decision.tier).toBeNull();
  });
});

describe('classifyRegistry — bulk routing', () => {
  it('buckets every failing entry into a tier and leaves passing entries out', () => {
    const reg: Registry = {
      version: '1',
      lastRun: NOW,
      sources: {
        ok: {
          lastVerifiedAt: NOW,
          overallPassed: true,
          overallHardFail: false,
          orphaned: false,
          results: [mkResult({ passed: true, hardFail: false })],
        },
        orphan: {
          lastVerifiedAt: NOW,
          overallPassed: false,
          overallHardFail: false,
          orphaned: true,
          results: [],
        },
        caseFail: {
          lastVerifiedAt: NOW,
          overallPassed: false,
          overallHardFail: true,
          orphaned: false,
          results: [mkResult({ validator: 'case-law' })],
        },
        softFail: {
          lastVerifiedAt: NOW,
          overallPassed: false,
          overallHardFail: false,
          orphaned: false,
          results: [mkResult({ hardFail: false })],
        },
      },
    };
    const buckets = classifyRegistry(reg);
    expect(buckets.tier1.map((d) => d.sourceId).sort()).toEqual(['softFail']);
    expect(buckets.tier2.map((d) => d.sourceId)).toEqual([]);
    expect(buckets.tier3.map((d) => d.sourceId).sort()).toEqual(['caseFail', 'orphan']);
    expect(buckets.passed.sort()).toEqual(['ok']);
  });
});

describe('packet rendering', () => {
  it('renders a Tier 3 markdown packet with attorney-ready framing', () => {
    const md = renderTier3Packet({
      sourceId: 'syed-2017',
      tier: 3,
      reasons: ['case-law validator hard-failed: no decision year'],
      results: [
        mkResult({ validator: 'case-law', notes: 'no decision year in parentheses' }),
      ],
    });
    expect(md).toMatch(/Tier 3/);
    expect(md).toMatch(/syed-2017/);
    expect(md).toMatch(/Attorney question/i);
    expect(md).toMatch(/Proposed fix/i);
  });

  it('renders Tier 1 summary as one line per source', () => {
    const line = renderTier1Summary({
      sourceId: 'fcra-604',
      tier: 1,
      reasons: ['statute-quote soft: missing section number'],
      results: [mkResult({ hardFail: false })],
    });
    expect(line).toMatch(/fcra-604/);
    expect(line).toMatch(/Tier 1/);
  });

  it('renders Tier 2 summary including validator names', () => {
    const line = renderTier2Summary({
      sourceId: 'cfpb-bulletin-2012-09',
      tier: 2,
      reasons: ['agency-bulletin hard fail'],
      results: [mkResult({ validator: 'agency-bulletin' })],
    });
    expect(line).toMatch(/cfpb-bulletin-2012-09/);
    expect(line).toMatch(/agency-bulletin/);
  });
});

describe('ReviewTier discriminator type — compile-time sanity', () => {
  it('accepts 1, 2, 3 as valid tiers', () => {
    const t: ReviewTier[] = [1, 2, 3];
    expect(t.length).toBe(3);
  });
});
