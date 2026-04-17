/**
 * NVI-09 — Document-grounded scenario tests (SCRUM-813).
 *
 * Offline / deterministic. Covers type-level invariants, corpus lookup,
 * and Together-JSONL serialisation with document text injected as user
 * context.
 */

import { describe, expect, it } from 'vitest';
import {
  type DocumentGroundedScenario,
  type DocumentEntry,
  lookupDocument,
  documentGroundedToTogetherRow,
  validateDocumentGroundedScenario,
  buildCorpusIndex,
} from './document-grounded';
import type { IntelligenceAnswer } from './types';

const NOW = '2026-04-17';
const ANSWER: IntelligenceAnswer = {
  analysis: 'a',
  citations: [{ record_id: 'fcra-615-a', quote: 'q', source: 'FCRA §615(a)' }],
  risks: ['r'],
  recommendations: ['rec'],
  confidence: 0.9,
  jurisdiction: 'federal',
  applicable_law: 'FCRA §615(a)',
};

const DOC: DocumentEntry = {
  id: 'aa-notice-001',
  kind: 'adverse-action-notice',
  description: 'Deficient §615(a) notice — missing CRA contact info',
  anonymisedAt: NOW,
  text: 'Dear Applicant, we cannot proceed. Thank you.',
};

function mkScenario(over: Partial<DocumentGroundedScenario> = {}): DocumentGroundedScenario {
  return {
    id: 'dg-001',
    category: 'adverse-action',
    documentCorpusId: 'aa-notice-001',
    query: 'Is this adverse-action notice FCRA §615(a)-compliant?',
    expected: ANSWER,
    ...over,
  };
}

describe('buildCorpusIndex / lookupDocument', () => {
  it('indexes documents by id', () => {
    const idx = buildCorpusIndex([DOC]);
    expect(lookupDocument(idx, 'aa-notice-001')).toBe(DOC);
  });

  it('returns undefined for missing id', () => {
    const idx = buildCorpusIndex([DOC]);
    expect(lookupDocument(idx, 'not-there')).toBeUndefined();
  });

  it('throws on duplicate ids', () => {
    expect(() => buildCorpusIndex([DOC, DOC])).toThrow(/duplicate/);
  });
});

describe('validateDocumentGroundedScenario', () => {
  const corpus = buildCorpusIndex([DOC]);

  it('passes when corpus id resolves', () => {
    expect(validateDocumentGroundedScenario(mkScenario(), corpus)).toEqual([]);
  });

  it('rejects when corpus id is missing from index', () => {
    const errs = validateDocumentGroundedScenario(mkScenario({ documentCorpusId: 'nope' }), corpus);
    expect(errs.join(' ')).toMatch(/not in corpus/i);
  });

  it('rejects when expected answer is malformed', () => {
    // @ts-expect-error — intentionally invalid
    const errs = validateDocumentGroundedScenario(mkScenario({ expected: { analysis: '' } }), corpus);
    expect(errs.length).toBeGreaterThan(0);
  });

  it('rejects empty query', () => {
    const errs = validateDocumentGroundedScenario(mkScenario({ query: '   ' }), corpus);
    expect(errs.join(' ')).toMatch(/empty query/i);
  });
});

describe('documentGroundedToTogetherRow', () => {
  const corpus = buildCorpusIndex([DOC]);

  it('injects document text into the user message under a clear delimiter', () => {
    const row = documentGroundedToTogetherRow(mkScenario(), corpus);
    const userMsg = row.messages[1];
    expect(userMsg.role).toBe('user');
    expect((userMsg as { content: string }).content).toMatch(/Dear Applicant, we cannot proceed/);
    expect((userMsg as { content: string }).content).toMatch(/Is this adverse-action notice FCRA §615\(a\)-compliant\?/);
  });

  it('serialises expected answer as JSON in final assistant message', () => {
    const row = documentGroundedToTogetherRow(mkScenario(), corpus);
    const assistant = row.messages[2] as { role: string; content: string };
    expect(assistant.role).toBe('assistant');
    const parsed = JSON.parse(assistant.content);
    expect(parsed.applicable_law).toBe('FCRA §615(a)');
  });

  it('throws when validation fails', () => {
    expect(() =>
      documentGroundedToTogetherRow(mkScenario({ documentCorpusId: 'nope' }), corpus),
    ).toThrow(/corpus/i);
  });
});
