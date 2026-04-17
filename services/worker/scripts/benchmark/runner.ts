/**
 * NVI-12 — LLM-as-judge benchmark runner (SCRUM-816).
 *
 * Pure-function orchestration over:
 *   - candidate models (Nessie vNN, frontier LLMs) that answer a question
 *   - judges (≥ 3) that score each candidate's answer against the rubric
 *
 * The runner is I/O-free beyond the injected interfaces. Tests wire up
 * MockCandidate + MockJudge. Production wires up Nessie + Opus + GPT-4o
 * + Gemini 2.5 Pro via HTTP adapters (see nessie-candidate.ts,
 * opus-judge.ts, …) — those live in sibling modules so the pure runner
 * stays deterministic.
 *
 * Disagreement: when judges differ by ≥ 2 tiers on the same candidate
 * answer, flag the cell for human attorney spot-check (NVI-05 Tier 3).
 */

import type { BenchmarkQuestion } from '../intelligence-dataset/benchmark/benchmark';
import type {
  BenchmarkRun,
  CandidateModel,
  CandidateReport,
  Judge,
  QuestionResult,
} from './types';

export function detectDisagreement(tiers: Array<0 | 1 | 2 | 3 | 4>): boolean {
  if (tiers.length < 2) return false;
  const max = Math.max(...tiers);
  const min = Math.min(...tiers);
  return max - min >= 2;
}

export function meanTier(tiers: Array<0 | 1 | 2 | 3 | 4>): number {
  if (tiers.length === 0) return 0;
  const sum = tiers.reduce((a, b) => a + b, 0);
  return sum / tiers.length;
}

export async function runBenchmark(
  questions: BenchmarkQuestion[],
  candidates: CandidateModel[],
  judges: Judge[],
): Promise<BenchmarkRun> {
  if (judges.length < 3) {
    throw new Error(`LLM-as-judge requires ≥ 3 judges to detect disagreement; got ${judges.length}`);
  }
  const startedAt = new Date().toISOString();
  const candidateResults: Record<string, CandidateReport> = {};

  for (const c of candidates) {
    const perQuestion: QuestionResult[] = [];
    for (const q of questions) {
      const answer = await c.answer(q);
      const judgeScores = await Promise.all(judges.map((j) => j.score(q, answer)));
      const tiers = judgeScores.map((s) => s.tier);
      perQuestion.push({
        questionId: q.id,
        candidateId: c.id,
        candidateAnswer: answer,
        judgeScores,
        aggregateTier: meanTier(tiers),
        disagreement: detectDisagreement(tiers),
      });
    }
    const totalScore = perQuestion.reduce((a, r) => a + r.aggregateTier, 0);
    const percent = questions.length > 0 ? (totalScore / (4 * questions.length)) * 100 : 0;
    candidateResults[c.id] = {
      candidateId: c.id,
      perQuestion,
      totalScore,
      percent,
      disagreementCount: perQuestion.filter((r) => r.disagreement).length,
    };
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    candidateResults,
  };
}

// ---------------------------------------------------------------------------
// Markdown reporter
// ---------------------------------------------------------------------------

export function renderBenchmarkMarkdown(run: BenchmarkRun, date: string): string {
  const lines: string[] = [];
  lines.push(`# FCRA gold-standard benchmark — ${date}`);
  lines.push('');
  lines.push(`Run started: ${run.startedAt}`);
  lines.push(`Run finished: ${run.finishedAt}`);
  lines.push('');
  lines.push(`## Summary (mean tier per candidate)`);
  lines.push('');
  lines.push(`| Candidate | Total | Percent | Disagreements |`);
  lines.push(`|-----------|-------|---------|---------------|`);
  const reports = Object.values(run.candidateResults).sort((a, b) => b.percent - a.percent);
  for (const r of reports) {
    lines.push(
      `| \`${r.candidateId}\` | ${r.totalScore.toFixed(1)} | ${r.percent.toFixed(1)}% | ${r.disagreementCount} |`,
    );
  }
  lines.push('');
  lines.push(`Disagreements are cells where judge tiers span ≥ 2 — flag for NVI-05 tier-3 attorney spot-check.`);
  return lines.join('\n') + '\n';
}
