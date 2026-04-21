/**
 * NTF-02 (SCRUM-774) — LoRA ablation winner selector.
 *
 * Given per-rank eval metrics (macro F1, weighted F1, confidence correlation,
 * per-type F1 min, overall regression vs baseline) across a rank sweep
 * (typically 32 / 64 / 128), picks the rank that ships v6. Pure function —
 * no training, no LLM calls — so the decision is reproducible offline and
 * the NPH-14 retrain runbook can re-verify.
 *
 * Selection rubric, in priority order:
 *   1. Drop any rank that regresses macro F1 below the NTF-01 baseline.
 *   2. Drop any rank where minPerTypeF1 falls below the gate (≥0.70).
 *   3. Among the survivors, maximise macro F1. Ties broken by higher
 *      confidence correlation, then by smaller model (lower rank).
 */

import { V8_TARGETS } from '../nph/v8-eval-gates.js';

export interface RankMetrics {
  /** LoRA rank used in this ablation run. */
  rank: number;
  /** Macro F1 across all credential types, 0-1. */
  macroF1: number;
  /** Weighted F1, 0-1. */
  weightedF1: number;
  /** Pearson correlation between model confidence and accuracy. */
  confidenceCorrelation: number;
  /** Min per-type F1 across all credential types, 0-1. */
  minPerTypeF1: number;
  /** Training wall-clock minutes (informational only, not scored). */
  trainingMinutes?: number;
}

export interface AblationBaseline {
  /** Macro F1 from the pre-ablation checkpoint (NTF-01 for NTF-02). */
  macroF1: number;
}

export interface AblationFinding {
  rank: number;
  reason: string;
}

export interface AblationResult {
  /** Winning rank, or null when every candidate failed a gate. */
  winner: RankMetrics | null;
  /** Ranks that cleared every gate, ordered by the selection rubric. */
  shortlisted: RankMetrics[];
  /** Rejected ranks and why. */
  rejected: AblationFinding[];
}

export const MIN_PER_TYPE_F1_GATE = V8_TARGETS.minPerTypeF1;

/**
 * Select the winner from a LoRA ablation sweep.
 */
export function selectAblationWinner(
  candidates: readonly RankMetrics[],
  baseline: AblationBaseline,
): AblationResult {
  const rejected: AblationFinding[] = [];
  const shortlist: RankMetrics[] = [];

  for (const c of candidates) {
    if (c.macroF1 < baseline.macroF1) {
      rejected.push({
        rank: c.rank,
        reason: `macroF1 ${c.macroF1.toFixed(3)} regresses below baseline ${baseline.macroF1.toFixed(3)}`,
      });
      continue;
    }
    if (c.minPerTypeF1 < MIN_PER_TYPE_F1_GATE) {
      rejected.push({
        rank: c.rank,
        reason: `minPerTypeF1 ${c.minPerTypeF1.toFixed(3)} below gate ${MIN_PER_TYPE_F1_GATE}`,
      });
      continue;
    }
    shortlist.push(c);
  }

  shortlist.sort((a, b) => {
    if (b.macroF1 !== a.macroF1) return b.macroF1 - a.macroF1;
    if (b.confidenceCorrelation !== a.confidenceCorrelation) {
      return b.confidenceCorrelation - a.confidenceCorrelation;
    }
    return a.rank - b.rank;
  });

  return {
    winner: shortlist[0] ?? null,
    shortlisted: shortlist,
    rejected,
  };
}

/**
 * Human-readable one-line summary of an ablation outcome.
 * The retrain runbook pastes this into the PR description that cuts v6
 * over to the chosen rank.
 */
export function renderAblationSummary(result: AblationResult): string {
  if (!result.winner) {
    const reasons = result.rejected.map((r) => `r=${r.rank}: ${r.reason}`).join('; ');
    return `NTF-02 ablation: no winner — every rank failed a gate. ${reasons}`;
  }
  const w = result.winner;
  return `NTF-02 ablation winner: rank=${w.rank}, macroF1=${w.macroF1.toFixed(3)}, minPerType=${w.minPerTypeF1.toFixed(3)}, confR=${w.confidenceCorrelation.toFixed(3)}`;
}
