/**
 * NVI-08 — Multi-turn scenario tests (SCRUM-812).
 *
 * Covers type-level invariants (last assistant turn carries a structured
 * `expected`) + the Together-JSONL serialiser. Offline / deterministic.
 */

import { describe, expect, it } from 'vitest';
import {
  MULTI_TURN_ARCHETYPES,
  multiTurnToTogetherRow,
  validateMultiTurnScenario,
  type MultiTurnScenario,
} from './multi-turn';
import type { IntelligenceAnswer } from './types';

const ANSWER: IntelligenceAnswer = {
  analysis: 'a',
  citations: [{ record_id: 'fcra-604-b-3', quote: 'q', source: 'FCRA §604(b)(3)' }],
  risks: ['r'],
  recommendations: ['rec'],
  confidence: 0.9,
  jurisdiction: 'federal',
  applicable_law: 'FCRA §604(b)(3)',
};

function mkScenario(over: Partial<MultiTurnScenario> = {}): MultiTurnScenario {
  return {
    id: 'mt-1',
    category: 'pre-adverse',
    archetype: 'vague-initial',
    turns: [
      { role: 'user', content: 'Is this compliant?' },
      { role: 'assistant', content: 'I can answer once I know the jurisdiction. Which state and role type?' },
      { role: 'user', content: 'California, warehouse associate, pre-offer.' },
      { role: 'assistant', content: JSON.stringify(ANSWER), isFinal: true, expected: ANSWER },
    ],
    ...over,
  };
}

describe('MULTI_TURN_ARCHETYPES — the 10 canonical archetypes', () => {
  it('has exactly 10 archetype ids', () => {
    expect(MULTI_TURN_ARCHETYPES).toHaveLength(10);
  });

  it('contains the ticket\'s named archetypes', () => {
    expect(MULTI_TURN_ARCHETYPES).toContain('vague-initial');
    expect(MULTI_TURN_ARCHETYPES).toContain('cascading-followup');
    expect(MULTI_TURN_ARCHETYPES).toContain('multi-state-location');
  });
});

describe('validateMultiTurnScenario', () => {
  it('passes on a well-formed 4-turn scenario', () => {
    const errs = validateMultiTurnScenario(mkScenario());
    expect(errs).toEqual([]);
  });

  it('rejects when final turn is not assistant', () => {
    const sc = mkScenario({
      turns: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    expect(validateMultiTurnScenario(sc)).toContain('final turn must be role=assistant with isFinal=true');
  });

  it('rejects when no turn is marked isFinal', () => {
    const sc = mkScenario({
      turns: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ],
    });
    expect(validateMultiTurnScenario(sc)).toContain('final turn must be role=assistant with isFinal=true');
  });

  it('rejects when isFinal assistant turn has no expected IntelligenceAnswer', () => {
    const sc = mkScenario({
      turns: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
        { role: 'assistant', content: '{}', isFinal: true },
      ],
    });
    expect(validateMultiTurnScenario(sc)).toContain('isFinal turn missing expected IntelligenceAnswer');
  });

  it('rejects two-turn scenarios (must have at least one clarifying round)', () => {
    const sc = mkScenario({
      turns: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b', isFinal: true, expected: ANSWER },
      ],
    });
    expect(validateMultiTurnScenario(sc).join(' ')).toMatch(/at least 4 turns|single-turn/);
  });

  it('rejects consecutive same-role turns (must alternate)', () => {
    const sc = mkScenario({
      turns: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'a2' },
        { role: 'assistant', content: 'b' },
        { role: 'assistant', content: JSON.stringify(ANSWER), isFinal: true, expected: ANSWER },
      ],
    });
    expect(validateMultiTurnScenario(sc).join(' ')).toMatch(/alternate/i);
  });

  it('rejects unknown archetype', () => {
    // @ts-expect-error — intentionally invalid
    const sc = mkScenario({ archetype: 'made-up-archetype' });
    expect(validateMultiTurnScenario(sc).join(' ')).toMatch(/archetype/);
  });
});

describe('multiTurnToTogetherRow', () => {
  it('produces system + alternating user/assistant messages ending with the final JSON answer', () => {
    const row = multiTurnToTogetherRow(mkScenario());
    expect(row.messages[0].role).toBe('system');
    expect(row.messages[1].role).toBe('user');
    expect(row.messages[2].role).toBe('assistant');
    expect(row.messages[3].role).toBe('user');
    expect(row.messages[4].role).toBe('assistant');
    expect(JSON.parse((row.messages[4] as { content: string }).content).applicable_law).toBe('FCRA §604(b)(3)');
  });

  it('serialises the final assistant turn as JSON even if its content is prose', () => {
    const sc = mkScenario({
      turns: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'clarify?' },
        { role: 'user', content: 'ans' },
        { role: 'assistant', content: 'prose — ignored at training time', isFinal: true, expected: ANSWER },
      ],
    });
    const row = multiTurnToTogetherRow(sc);
    const lastContent = (row.messages[row.messages.length - 1] as { content: string }).content;
    expect(() => JSON.parse(lastContent)).not.toThrow();
  });
});
