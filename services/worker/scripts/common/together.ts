/**
 * Shared Together chat-completions row builder.
 *
 * Used by single-turn (`build-dataset.ts::scenarioToTogetherRow`), multi-turn
 * (NVI-08), and document-grounded (NVI-09) training emitters. Consolidated
 * here so the canonical system-prompt + message shape live once.
 */

import { NESSIE_INTELLIGENCE_PROMPT_V2 } from '../intelligence-dataset/prompts';
import type { IntelligenceAnswer, TogetherTrainingRow } from '../intelligence-dataset/types';

/** Build a standard 3-turn Together row (system + user + structured assistant JSON). */
export function toTogetherRow(userContent: string, expected: IntelligenceAnswer): TogetherTrainingRow {
  return {
    messages: [
      { role: 'system', content: NESSIE_INTELLIGENCE_PROMPT_V2 },
      { role: 'user', content: userContent },
      { role: 'assistant', content: JSON.stringify(expected) },
    ],
  };
}
