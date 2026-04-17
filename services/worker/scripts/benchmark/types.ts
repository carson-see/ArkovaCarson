/**
 * NVI-12 — LLM-as-judge benchmark runner types (SCRUM-816).
 */

import type { IntelligenceAnswer } from '../intelligence-dataset/types';
import type { BenchmarkQuestion } from '../intelligence-dataset/benchmark/benchmark';

/**
 * A model under test. Given a benchmark question, emit a structured
 * compliance answer in the canonical IntelligenceAnswer shape. Tests use
 * MockCandidate; production adapters wrap Nessie / Opus / GPT-4o /
 * Gemini 2.5 Pro / base Gemini 3 via their respective HTTP APIs.
 */
export interface CandidateModel {
  id: string;
  answer(q: BenchmarkQuestion): Promise<IntelligenceAnswer>;
}

/**
 * A judge that scores a candidate's answer against the question's rubric.
 * Returns a tier in 0..4. Tests use MockJudge; production adapters wrap
 * Claude Opus / GPT-4o / Gemini 2.5 Pro.
 */
export interface Judge {
  id: string;
  score(q: BenchmarkQuestion, answer: IntelligenceAnswer): Promise<JudgeScore>;
}

export interface JudgeScore {
  judgeId: string;
  questionId: string;
  tier: 0 | 1 | 2 | 3 | 4;
  rationale: string;
}

/** One candidate-vs-question cell: three judges' tiers + aggregate. */
export interface QuestionResult {
  questionId: string;
  candidateId: string;
  candidateAnswer: IntelligenceAnswer;
  judgeScores: JudgeScore[];
  /** Mean of the judges' tiers (float). */
  aggregateTier: number;
  /** True when judges disagree by ≥ 2 tiers — flags for human review. */
  disagreement: boolean;
}

export interface BenchmarkRun {
  startedAt: string;
  finishedAt: string;
  candidateResults: Record<string, CandidateReport>;
}

export interface CandidateReport {
  candidateId: string;
  perQuestion: QuestionResult[];
  /** Sum of aggregateTier across all questions. 0-4 per-q × N questions. */
  totalScore: number;
  /** totalScore / (4 × N) × 100. */
  percent: number;
  disagreementCount: number;
}
