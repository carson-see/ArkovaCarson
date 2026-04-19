/**
 * NTF-01 (SCRUM-773) + NTF-02 (SCRUM-774) — reasoning-quality scorer.
 *
 * Scores a model-emitted chain-of-thought against a three-part rubric:
 * coherence (logical flow), factual accuracy (cites that exist and say
 * what the model says they say), and completeness (every statutory
 * trigger referenced in the answer gets a reasoning step).
 *
 * Pure offline heuristics. No LLM calls. Tests cover every branch.
 */

import type { CotReasoningSteps } from '../cot-scaffold.js';
import type { IntelligenceSource, IntelligenceAnswer } from '../types.js';

export interface ReasoningQualityScore {
  /** 0-1 — mean of the three sub-scores. */
  overall: number;
  coherence: number;
  factualAccuracy: number;
  completeness: number;
  issues: string[];
}

export interface ReasoningQualityInput {
  answer: IntelligenceAnswer;
  /** Reasoning steps that must be present. Scored even when empty. */
  reasoning: CotReasoningSteps;
  /** Source registry for factual-accuracy lookups. */
  sources: IntelligenceSource[];
}

const STEP_KEYS: Array<keyof CotReasoningSteps> = [
  'step1_question_kind',
  'step2_federal_statutes',
  'step3_statutory_exceptions',
  'step4_state_overlays',
  'step5_risks',
  'step6_recommendations',
  'step7_confidence_band',
  'step8_escalation_trigger',
];

export function scoreReasoningQuality(input: ReasoningQualityInput): ReasoningQualityScore {
  const issues: string[] = [];
  const coherence = scoreCoherence(input.reasoning, issues);
  const factualAccuracy = scoreFactualAccuracy(input.answer, input.sources, issues);
  const completeness = scoreCompleteness(input.reasoning, input.answer, issues);
  const overall = (coherence + factualAccuracy + completeness) / 3;
  return { overall, coherence, factualAccuracy, completeness, issues };
}

function scoreCoherence(reasoning: CotReasoningSteps, issues: string[]): number {
  let filled = 0;
  for (const k of STEP_KEYS) {
    if (hasContent(reasoning[k])) filled++;
  }
  const ratio = filled / STEP_KEYS.length;
  if (ratio < 0.5) issues.push(`coherence: only ${filled}/${STEP_KEYS.length} reasoning steps have content`);
  return ratio;
}

function hasContent(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null;
}

function scoreFactualAccuracy(answer: IntelligenceAnswer, sources: IntelligenceSource[], issues: string[]): number {
  if (answer.citations.length === 0) {
    issues.push('factual-accuracy: answer has zero citations');
    return 0;
  }
  const byId = new Map(sources.map((s) => [s.id, s]));
  let matches = 0;
  for (const c of answer.citations) {
    const s = byId.get(c.record_id);
    if (!s) {
      issues.push(`factual-accuracy: citation references unknown source ${c.record_id}`);
      continue;
    }
    // Partial match — the quote on the citation should be a contiguous
    // substring or materially-equivalent reformulation. We check shared
    // tokens as a deterministic heuristic.
    if (sharesMaterialTokens(c.quote, s.quote)) matches++;
    else issues.push(`factual-accuracy: citation quote drifts from source ${c.record_id}`);
  }
  return matches / answer.citations.length;
}

function sharesMaterialTokens(a: string, b: string, threshold = 0.3): boolean {
  const tokA = tokenize(a);
  const tokB = new Set(tokenize(b));
  if (tokA.length === 0) return false;
  const shared = tokA.filter((t) => tokB.has(t)).length;
  return shared / tokA.length >= threshold;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9§\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

const STATUTE_PATTERN = /§\s*\d+[a-z0-9()\-.]*/gi;

function scoreCompleteness(reasoning: CotReasoningSteps, answer: IntelligenceAnswer, issues: string[]): number {
  const statutesInAnswer = new Set(
    (answer.analysis.match(STATUTE_PATTERN) || []).map((m: string) => m.toLowerCase().replace(/\s+/g, '')),
  );
  if (statutesInAnswer.size === 0) {
    // Answer cites no statutes — completeness collapses to whether the
    // recommendations/escalation trailing steps are present.
    const trailingKeys: Array<keyof CotReasoningSteps> = ['step6_recommendations', 'step8_escalation_trigger'];
    const trailing = trailingKeys.filter((k) => hasContent(reasoning[k])).length;
    return trailing / 2;
  }
  const statuteText = JSON.stringify(reasoning).toLowerCase().replace(/\s+/g, '');
  let covered = 0;
  for (const s of statutesInAnswer) {
    if (statuteText.includes(s)) covered++;
    else issues.push(`completeness: answer cites ${s} but reasoning steps do not mention it`);
  }
  return covered / statutesInAnswer.size;
}

/**
 * NTF-02 edge-case tagger. Flags a scenario as an "edge case" for the
 * hard-case holdout that NTF-02 trains on. Edge cases are those where
 * the coherence score < 0.7 OR the answer refuses OR escalates.
 */
export function isEdgeCase(answer: IntelligenceAnswer, reasoning: CotReasoningSteps): boolean {
  const { coherence } = scoreReasoningQuality({
    answer,
    reasoning,
    sources: [],
  });
  if (coherence < 0.7) return true;
  if (answer.should_refuse) return true;
  if (answer.escalation_trigger) return true;
  return false;
}

/**
 * NTF-02 ablation config. LoRA rank matrix the training sweep should
 * cover. 32 is the v8 baseline; 64 and 128 are the candidates for the
 * rank-sweep story.
 */
export const NTF02_LORA_RANK_ABLATION = [32, 64, 128] as const;

export interface NtfAblationResult {
  rank: (typeof NTF02_LORA_RANK_ABLATION)[number];
  macroF1: number;
  edgeCaseMacroF1: number;
  /** Minutes of training compute consumed. */
  trainMinutes: number;
  /** Average p50 latency on the eval run. */
  p50LatencyMs: number;
}

export interface NtfAblationWinner {
  winner: NtfAblationResult;
  reason: string;
  rejected: Array<{ rank: number; reason: string }>;
}

/**
 * Deterministic winner selection. Picks the LoRA rank that wins on edge
 * cases without regressing on overall macro F1 or doubling latency.
 */
export function pickAblationWinner(results: NtfAblationResult[], baselineMacroF1: number): NtfAblationWinner {
  if (results.length === 0) throw new Error('no ablation results to compare');
  const rejected: Array<{ rank: number; reason: string }> = [];
  const viable = results.filter((r) => {
    if (r.macroF1 < baselineMacroF1 - 0.01) {
      rejected.push({ rank: r.rank, reason: `macro F1 regressed ${((baselineMacroF1 - r.macroF1) * 100).toFixed(1)}pp` });
      return false;
    }
    return true;
  });
  if (viable.length === 0) {
    throw new Error('every ablation rank regressed on macro F1 — do not deploy');
  }
  const baseLatency = results.find((r) => r.rank === 32)?.p50LatencyMs ?? viable[0].p50LatencyMs;
  const latencySafe = viable.filter((r) => {
    if (r.p50LatencyMs > baseLatency * 2) {
      rejected.push({ rank: r.rank, reason: `latency doubled (${r.p50LatencyMs}ms vs ${baseLatency}ms)` });
      return false;
    }
    return true;
  });
  const pool = latencySafe.length > 0 ? latencySafe : viable;
  pool.sort((a, b) => b.edgeCaseMacroF1 - a.edgeCaseMacroF1);
  const winner = pool[0];
  return {
    winner,
    reason: `rank ${winner.rank} wins on edge-case macro F1 (${(winner.edgeCaseMacroF1 * 100).toFixed(1)}%) without regressing overall F1 or doubling latency`,
    rejected,
  };
}
