/**
 * NVI-06 — Chain-of-thought scaffold tests (SCRUM-810).
 *
 * Offline heuristics only. The scaffolder must NEVER call an LLM in tests
 * — all LLM enrichment goes through an injectable `LlmEnricher` interface.
 */

import { describe, expect, it } from 'vitest';
import {
  scaffoldCot,
  mergeCotIntoAnswer,
  confidenceBand,
  extractFederalStatuteRefs,
  classifyQuestionKind,
  type CotReasoningSteps,
} from './cot-scaffold';
import type { IntelligenceScenario } from './types';

function mkScenario(over: Partial<IntelligenceScenario> = {}): IntelligenceScenario {
  return {
    id: 'demo-1',
    category: 'permissible-purpose',
    query: 'What are the permissible purposes under FCRA §604(a)?',
    expected: {
      analysis: '§604(a) [15 U.S.C. §1681b(a)] enumerates seven permissible purposes...',
      citations: [{ record_id: 'fcra-604-a', quote: 'q', source: 'FCRA §604(a)' }],
      risks: ['pulls outside §604(a) are §604(f) violations'],
      recommendations: ['Classify each pull with a purpose code'],
      confidence: 0.92,
      jurisdiction: 'federal',
      applicable_law: 'FCRA §604(a)',
    },
    ...over,
  };
}

describe('classifyQuestionKind', () => {
  it('classifies "what are..." as compliance_qa', () => {
    expect(classifyQuestionKind(mkScenario({ query: 'What are the rules under X?' }))).toBe('compliance_qa');
  });

  it('classifies queries about risks as risk_analysis', () => {
    expect(classifyQuestionKind(mkScenario({ query: 'What is the risk of using this form?' }))).toBe('risk_analysis');
  });

  it('classifies queries about document summary as document_summary', () => {
    expect(classifyQuestionKind(mkScenario({ query: 'Summarize this vendor contract clause.' }))).toBe('document_summary');
  });

  it('classifies queries about multiple statutes as cross_reference', () => {
    expect(
      classifyQuestionKind(
        mkScenario({ query: 'How does FCRA interact with ADA when running medical checks?' }),
      ),
    ).toBe('cross_reference');
  });

  it('classifies "what should I do..." as recommendation', () => {
    expect(
      classifyQuestionKind(mkScenario({ query: 'What should I do before firing an applicant based on a report?' })),
    ).toBe('recommendation');
  });
});

describe('extractFederalStatuteRefs', () => {
  it('pulls "§604(a)" and "§615(c)" refs out of prose', () => {
    const refs = extractFederalStatuteRefs(
      'Per §604(a) [15 U.S.C. §1681b(a)] and §615(c), the employer must …',
    );
    expect(refs).toContain('§604(a)');
    expect(refs).toContain('§615(c)');
    expect(refs).toContain('15 U.S.C. §1681b(a)');
  });

  it('returns empty array when no statute refs present', () => {
    expect(extractFederalStatuteRefs('No statutes here.')).toEqual([]);
  });

  it('dedupes identical refs', () => {
    const refs = extractFederalStatuteRefs('§604(a) and again §604(a)');
    expect(refs.filter((r) => r === '§604(a)').length).toBe(1);
  });
});

describe('confidenceBand', () => {
  it('0.85+ is clear-statute', () => {
    expect(confidenceBand(0.99).band).toBe('clear-statute');
    expect(confidenceBand(0.85).band).toBe('clear-statute');
  });

  it('0.70 to 0.85 is common-interpretation', () => {
    expect(confidenceBand(0.84).band).toBe('common-interpretation');
    expect(confidenceBand(0.70).band).toBe('common-interpretation');
  });

  it('below 0.70 is grey-area', () => {
    expect(confidenceBand(0.69).band).toBe('grey-area');
    expect(confidenceBand(0.55).band).toBe('grey-area');
  });
});

describe('scaffoldCot — heuristic 8-step scaffolding', () => {
  it('produces all 8 steps', () => {
    const cot = scaffoldCot(mkScenario());
    expect(Object.keys(cot).sort()).toEqual([
      'step1_question_kind',
      'step2_federal_statutes',
      'step3_statutory_exceptions',
      'step4_state_overlays',
      'step5_risks',
      'step6_recommendations',
      'step7_confidence_band',
      'step8_escalation_trigger',
    ]);
  });

  it('copies existing risks into step5 verbatim', () => {
    const sc = mkScenario({
      expected: {
        ...mkScenario().expected,
        risks: ['risk A', 'risk B'],
      },
    });
    const cot = scaffoldCot(sc);
    expect(cot.step5_risks).toEqual(['risk A', 'risk B']);
  });

  it('copies existing recommendations into step6 verbatim', () => {
    const sc = mkScenario({
      expected: {
        ...mkScenario().expected,
        recommendations: ['rec 1', 'rec 2'],
      },
    });
    const cot = scaffoldCot(sc);
    expect(cot.step6_recommendations).toEqual(['rec 1', 'rec 2']);
  });

  it('picks confidence band from answer.confidence', () => {
    const cot = scaffoldCot(mkScenario({ expected: { ...mkScenario().expected, confidence: 0.6 } }));
    expect(cot.step7_confidence_band).toMatch(/grey-area/);
  });

  it('flags state-overlay step as TODO when jurisdiction is federal-only', () => {
    const cot = scaffoldCot(mkScenario({ expected: { ...mkScenario().expected, jurisdiction: 'federal' } }));
    expect(cot.step4_state_overlays).toMatch(/none|TODO|no state/i);
  });

  it('extracts state codes into step4 when jurisdiction is federal+state', () => {
    const cot = scaffoldCot(
      mkScenario({
        expected: {
          ...mkScenario().expected,
          jurisdiction: 'federal+state',
          analysis:
            'California §12952 (5+ employees), Illinois JOQAA (15+ employees), NYC §8-107(11-a), Colorado C.R.S. §8-2-130 apply.',
        },
      }),
    );
    expect(cot.step4_state_overlays).toMatch(/California|§12952/);
  });

  it('adds escalation trigger TODO when confidence is grey-area', () => {
    const cot = scaffoldCot(mkScenario({ expected: { ...mkScenario().expected, confidence: 0.6 } }));
    expect(cot.step8_escalation_trigger).toMatch(/counsel|consult/i);
  });

  it('marks escalation as "not needed" when confidence is high', () => {
    const cot = scaffoldCot(mkScenario({ expected: { ...mkScenario().expected, confidence: 0.95 } }));
    expect(cot.step8_escalation_trigger).toMatch(/not routinely|high.?confidence|no/i);
  });
});

describe('mergeCotIntoAnswer — serialize CoT into assistant content', () => {
  it('adds reasoning_steps onto a copy of the answer', () => {
    const sc = mkScenario();
    const cot = scaffoldCot(sc);
    const merged = mergeCotIntoAnswer(sc.expected, cot);
    expect(merged.reasoning_steps).toEqual(cot);
    expect(merged.analysis).toBe(sc.expected.analysis); // did not mutate analysis
  });

  it('does not mutate the original answer object', () => {
    const sc = mkScenario();
    const cot = scaffoldCot(sc);
    const original = JSON.parse(JSON.stringify(sc.expected));
    mergeCotIntoAnswer(sc.expected, cot);
    expect(sc.expected).toEqual(original);
  });

  it('round-trips through JSON.stringify / JSON.parse', () => {
    const sc = mkScenario();
    const merged = mergeCotIntoAnswer(sc.expected, scaffoldCot(sc));
    const round = JSON.parse(JSON.stringify(merged));
    expect(round.reasoning_steps).toBeDefined();
    expect((round.reasoning_steps as CotReasoningSteps).step1_question_kind).toBeDefined();
  });
});
