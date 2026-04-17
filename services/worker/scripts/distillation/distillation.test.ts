/**
 * NVI-07 — Distillation pipeline tests (SCRUM-811).
 *
 * Covers variation generation + validation pipeline. Teacher-model calls
 * are NEVER made here — tests inject a `MockTeacher` that returns
 * deterministic structured answers.
 */

import { describe, expect, it } from 'vitest';
import type { QueryTemplate, TeacherModel, VariationQuery } from './types';
import {
  expandTemplate,
  expandTemplates,
  cartesianSlots,
  renderTemplate,
} from './variation-generator';
import { validateTeacherAnswer, summariseValidations } from './validation-pipeline';
import type { Registry } from '../intelligence-dataset/validators/verification-registry';
import type { IntelligenceAnswer } from '../intelligence-dataset/types';

const NOW = '2026-04-17T00:00:00.000Z';

function mkRegistry(ids: string[]): Registry {
  const sources: Registry['sources'] = {};
  for (const id of ids) {
    sources[id] = {
      lastVerifiedAt: NOW,
      overallPassed: true,
      overallHardFail: false,
      orphaned: false,
      results: [],
    };
  }
  return { version: '1', lastRun: NOW, sources };
}

function mkAnswer(over: Partial<IntelligenceAnswer> = {}): IntelligenceAnswer {
  return {
    analysis: 'Per §604(b)(3), …',
    citations: [{ record_id: 'fcra-604-b-3', quote: 'q', source: 'FCRA §604(b)(3)' }],
    risks: ['risk 1'],
    recommendations: ['rec 1'],
    confidence: 0.9,
    jurisdiction: 'federal',
    applicable_law: 'FCRA §604(b)(3)',
    ...over,
  };
}

function mkVariation(over: Partial<VariationQuery> = {}): VariationQuery {
  return {
    templateId: 't',
    id: 't::a=1',
    query: 'q',
    slotValues: { a: '1' },
    expectedSources: ['fcra-604-b-3'],
    category: 'cat',
    ...over,
  };
}

describe('renderTemplate', () => {
  it('fills in slots', () => {
    expect(renderTemplate('hello {name}', { name: 'world' })).toBe('hello world');
  });

  it('throws on unfilled slot', () => {
    expect(() => renderTemplate('hello {x}', {})).toThrow(/unfilled/);
  });

  it('substitutes multiple slots', () => {
    expect(renderTemplate('{a} then {b}', { a: '1', b: '2' })).toBe('1 then 2');
  });
});

describe('cartesianSlots', () => {
  it('empty slots → single empty combo', () => {
    expect(cartesianSlots({})).toEqual([{}]);
  });

  it('single slot', () => {
    expect(cartesianSlots({ a: ['x', 'y'] })).toEqual([{ a: 'x' }, { a: 'y' }]);
  });

  it('two slots — full product', () => {
    const out = cartesianSlots({ a: ['1', '2'], b: ['x', 'y'] });
    expect(out).toHaveLength(4);
    expect(out).toEqual([
      { a: '1', b: 'x' },
      { a: '1', b: 'y' },
      { a: '2', b: 'x' },
      { a: '2', b: 'y' },
    ]);
  });
});

describe('expandTemplate', () => {
  it('produces one variation per combo with deterministic ids', () => {
    const t: QueryTemplate = {
      id: 'foo',
      category: 'pre-adverse',
      template: 'in {state} can {size} do X',
      slots: { state: ['CA', 'NY'], size: ['small'] },
      expectedSources: ['fcra-604-b-3'],
    };
    const vs = expandTemplate(t);
    expect(vs).toHaveLength(2);
    expect(vs[0].id).toBe('foo::size=small::state=CA');
    expect(vs[0].query).toBe('in CA can small do X');
    expect(vs[1].id).toBe('foo::size=small::state=NY');
  });

  it('handles no-slot templates', () => {
    const t: QueryTemplate = {
      id: 'bare',
      category: 'perm',
      template: 'no slots here',
      slots: {},
      expectedSources: [],
    };
    expect(expandTemplate(t)).toEqual([
      {
        templateId: 'bare',
        id: 'bare',
        query: 'no slots here',
        slotValues: {},
        expectedSources: [],
        category: 'perm',
      },
    ]);
  });
});

describe('expandTemplates', () => {
  it('concatenates in input order', () => {
    const a: QueryTemplate = { id: 'a', category: 'c', template: 'a {s}', slots: { s: ['1', '2'] }, expectedSources: [] };
    const b: QueryTemplate = { id: 'b', category: 'c', template: 'b', slots: {}, expectedSources: [] };
    const vs = expandTemplates([a, b]);
    expect(vs.map((v) => v.id)).toEqual(['a::s=1', 'a::s=2', 'b']);
  });
});

describe('validateTeacherAnswer', () => {
  const registry = mkRegistry(['fcra-604-b-3', 'fcra-604-a']);

  it('accepts a well-formed answer', () => {
    const result = validateTeacherAnswer(mkVariation(), mkAnswer(), { registry });
    expect(result.accepted).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('rejects empty analysis', () => {
    const r = validateTeacherAnswer(mkVariation(), mkAnswer({ analysis: '' }), { registry });
    expect(r.accepted).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/analysis/);
  });

  it('rejects empty risks', () => {
    const r = validateTeacherAnswer(mkVariation(), mkAnswer({ risks: [] }), { registry });
    expect(r.accepted).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/risks/);
  });

  it('rejects empty recommendations', () => {
    const r = validateTeacherAnswer(mkVariation(), mkAnswer({ recommendations: [] }), { registry });
    expect(r.accepted).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/recommendations/);
  });

  it('rejects out-of-range confidence', () => {
    const r = validateTeacherAnswer(mkVariation(), mkAnswer({ confidence: 1.5 }), { registry });
    expect(r.accepted).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/confidence/);
  });

  it('rejects missing jurisdiction', () => {
    // @ts-expect-error — testing runtime rejection
    const r = validateTeacherAnswer(mkVariation(), mkAnswer({ jurisdiction: '' }), { registry });
    expect(r.accepted).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/jurisdiction/);
  });

  it('rejects unverified citations', () => {
    const r = validateTeacherAnswer(
      mkVariation(),
      mkAnswer({ citations: [{ record_id: 'not-in-registry', quote: 'q', source: 's' }] }),
      { registry },
    );
    expect(r.accepted).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/not in registry/);
  });

  it('rejects citations where registry entry failed verification', () => {
    const failingReg: Registry = {
      ...registry,
      sources: {
        ...registry.sources,
        'fcra-604-b-3': {
          ...registry.sources['fcra-604-b-3'],
          overallPassed: false,
        },
      },
    };
    const r = validateTeacherAnswer(mkVariation(), mkAnswer(), { registry: failingReg });
    expect(r.accepted).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/not passing/);
  });

  it('rejects naked answer with no citations', () => {
    const r = validateTeacherAnswer(mkVariation(), mkAnswer({ citations: [] }), { registry });
    expect(r.accepted).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/naked/);
  });
});

describe('summariseValidations', () => {
  it('counts accepted vs rejected by bucket', () => {
    const results = [
      { variationId: 'a', accepted: true, reasons: [], answer: mkAnswer() },
      { variationId: 'b', accepted: false, reasons: ['empty risks'], answer: mkAnswer() },
      { variationId: 'c', accepted: false, reasons: ['empty risks', 'empty recommendations'], answer: mkAnswer() },
      { variationId: 'd', accepted: false, reasons: ['unverified citations: x (not in registry)'], answer: mkAnswer() },
    ];
    const s = summariseValidations(results);
    expect(s.accepted).toBe(1);
    expect(s.rejectedByReason['empty risks']).toBe(2);
    expect(s.rejectedByReason['empty recommendations']).toBe(1);
    expect(s.rejectedByReason['unverified citations']).toBe(1);
  });
});

describe('TeacherModel — mock end-to-end', () => {
  it('runs a full expand → infer → validate loop on a mock teacher', async () => {
    const t: QueryTemplate = {
      id: 'demo',
      category: 'pre-adverse',
      template: 'In {state}, is pre-offer OK?',
      slots: { state: ['CA', 'NY'] },
      expectedSources: ['fcra-604-b-3'],
    };
    const variations = expandTemplate(t);

    const mockTeacher: TeacherModel = {
      name: 'mock-opus',
      async infer(v: VariationQuery): Promise<IntelligenceAnswer> {
        return mkAnswer({ analysis: `Answer for ${v.query}` });
      },
    };

    const registry = mkRegistry(['fcra-604-b-3']);
    const results = await Promise.all(
      variations.map(async (v) => validateTeacherAnswer(v, await mockTeacher.infer(v, ''), { registry })),
    );

    expect(results.every((r) => r.accepted)).toBe(true);
    expect(results).toHaveLength(2);
  });
});
