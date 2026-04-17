/**
 * NVI-08 — Multi-turn conversation scenarios (SCRUM-812).
 *
 * All existing training is single-turn Q→A. Real compliance dialog is
 * iterative: the user asks a vague question, Nessie clarifies,  the user
 * provides facts, Nessie analyses. Without this archetype in training,
 * a production Nessie confronted with ambiguity hallucinates instead of
 * asking for the missing fact. This module defines the data shape +
 * validator + Together serialiser; the hand-crafted seed scenarios live
 * under `scenarios/fcra/multi-turn/`.
 */

import type { CategoryId, IntelligenceAnswer, TogetherTrainingRow } from './types';
import { NESSIE_INTELLIGENCE_PROMPT_V2 } from './prompts';

export const MULTI_TURN_ARCHETYPES = [
  'vague-initial',          // 1: user query has no jurisdiction / role, Nessie asks for it
  'incomplete-facts',       // 2: facts present but key fact missing (timing, size, etc.)
  'cross-regulation-scope', // 3: question touches multiple regs, Nessie scopes first
  'multi-state-location',   // 4: applicant may work in several states, Nessie asks which
  'retroactive-timing',     // 5: did event already happen or is it prospective?
  'applicant-type',         // 6: individual vs class, employee vs contractor vs gig
  'role-sensitivity',       // 7: regulated role (healthcare, childcare, finance) vs general
  'employer-size',          // 8: above/below state threshold
  'document-specifics',     // 9: user references a doc — Nessie asks what it says
  'cascading-followup',     // 10: initial answer implies a second issue worth raising
] as const;

export type MultiTurnArchetype = (typeof MULTI_TURN_ARCHETYPES)[number];

export type MultiTurnMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      /** Exactly one turn per scenario must be marked isFinal. */
      isFinal?: boolean;
      /** Required when isFinal=true — the structured answer we train to produce. */
      expected?: IntelligenceAnswer;
    };

export interface MultiTurnScenario {
  id: string;
  category: CategoryId;
  archetype: MultiTurnArchetype;
  /**
   * Ordered exchange. Must start with a user turn and end with an
   * assistant turn marked `isFinal: true` + `expected: IntelligenceAnswer`.
   * Roles must alternate (no two user or assistant turns in a row).
   * Minimum length: 4 (user / assistant / user / assistant-final).
   */
  turns: MultiTurnMessage[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Returns an array of error strings. Empty array = valid. */
export function validateMultiTurnScenario(sc: MultiTurnScenario): string[] {
  const errs: string[] = [];
  if (!MULTI_TURN_ARCHETYPES.includes(sc.archetype)) {
    errs.push(`unknown archetype "${sc.archetype}"`);
  }
  if (!Array.isArray(sc.turns) || sc.turns.length < 4) {
    errs.push(`at least 4 turns required (single-turn scenarios belong in the regular dataset); got ${sc.turns.length}`);
  }
  if (sc.turns.length > 0) {
    const first = sc.turns[0];
    if (first.role !== 'user') errs.push('first turn must be role=user');
  }
  const last = sc.turns[sc.turns.length - 1];
  if (!last || last.role !== 'assistant' || !(last as { isFinal?: boolean }).isFinal) {
    errs.push('final turn must be role=assistant with isFinal=true');
  } else if (!(last as { expected?: IntelligenceAnswer }).expected) {
    errs.push('isFinal turn missing expected IntelligenceAnswer');
  }

  // Alternation.
  for (let i = 1; i < sc.turns.length; i++) {
    if (sc.turns[i].role === sc.turns[i - 1].role) {
      errs.push(`turns ${i - 1} and ${i} have the same role — must alternate`);
      break;
    }
  }

  // Exactly one isFinal turn.
  const finals = sc.turns.filter((t) => t.role === 'assistant' && (t as { isFinal?: boolean }).isFinal);
  if (finals.length > 1) errs.push(`more than one turn marked isFinal=true`);

  return errs;
}

// ---------------------------------------------------------------------------
// Together JSONL serialisation
// ---------------------------------------------------------------------------

/**
 * Flatten a multi-turn scenario into a Together chat-completions row.
 * The final assistant turn's content is replaced by
 * `JSON.stringify(turn.expected)` so training targets the canonical
 * structured answer, not the natural-language prose from the scenario
 * draft.
 */
export function multiTurnToTogetherRow(sc: MultiTurnScenario): TogetherTrainingRow {
  const errs = validateMultiTurnScenario(sc);
  if (errs.length > 0) {
    throw new Error(`multi-turn scenario ${sc.id} failed validation: ${errs.join('; ')}`);
  }
  const messages: TogetherTrainingRow['messages'] = [
    { role: 'system', content: NESSIE_INTELLIGENCE_PROMPT_V2 },
  ];
  for (const t of sc.turns) {
    if (t.role === 'user') {
      messages.push({ role: 'user', content: t.content });
      continue;
    }
    // Assistant turn.
    if ((t as { isFinal?: boolean }).isFinal) {
      const expected = (t as { expected?: IntelligenceAnswer }).expected!;
      messages.push({ role: 'assistant', content: JSON.stringify(expected) });
    } else {
      messages.push({ role: 'assistant', content: t.content });
    }
  }
  return { messages };
}
