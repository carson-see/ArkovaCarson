/**
 * NVI-12 — Runner tests (SCRUM-816).
 *
 * Offline. Uses MockCandidate + MockJudge. Never touches an LLM API.
 */

import { describe, expect, it } from 'vitest';
import {
  detectDisagreement,
  meanTier,
  renderBenchmarkMarkdown,
  runBenchmark,
} from './runner';
import type { CandidateModel, Judge, JudgeScore } from './types';
import type { BenchmarkQuestion } from '../intelligence-dataset/benchmark/benchmark';
import type { IntelligenceAnswer } from '../intelligence-dataset/types';

const ANSWER: IntelligenceAnswer = {
  analysis: 'a',
  citations: [{ record_id: 'fcra-604-b-3', quote: 'q', source: 'FCRA §604(b)(3)' }],
  risks: ['r'],
  recommendations: ['rec'],
  confidence: 0.9,
  jurisdiction: 'federal',
  applicable_law: 'FCRA §604(b)(3)',
};

const QUESTION: BenchmarkQuestion = {
  id: 'bench-q',
  quadrant: 'pre-adverse',
  question: 'q',
  referenceAnswer: ANSWER,
  requiredCitations: ['fcra-604-b-3'],
  requiredRiskKeywords: ['r'],
  requiredRecommendationKeywords: ['rec'],
  rubric: {
    expertCriteria: 'e',
    goodCriteria: 'g',
    adequateCriteria: 'a',
    partialCriteria: 'p',
    missedCriteria: 'm',
  },
  authorCredential: 'pending attorney review',
  heldOut: true,
};

function mockCandidate(id: string, ans: IntelligenceAnswer = ANSWER): CandidateModel {
  return {
    id,
    async answer() {
      return ans;
    },
  };
}

function mockJudge(id: string, tier: 0 | 1 | 2 | 3 | 4): Judge {
  return {
    id,
    async score(q, _answer): Promise<JudgeScore> {
      return { judgeId: id, questionId: q.id, tier, rationale: `mock ${tier}` };
    },
  };
}

describe('meanTier / detectDisagreement', () => {
  it('meanTier of [4,4,4] is 4', () => {
    expect(meanTier([4, 4, 4])).toBe(4);
  });

  it('meanTier of [2,3,4] is 3', () => {
    expect(meanTier([2, 3, 4])).toBe(3);
  });

  it('detectDisagreement([4,4,4]) is false', () => {
    expect(detectDisagreement([4, 4, 4])).toBe(false);
  });

  it('detectDisagreement([4,4,2]) is true (spread ≥ 2)', () => {
    expect(detectDisagreement([4, 4, 2])).toBe(true);
  });

  it('detectDisagreement([3,4,4]) is false (spread = 1)', () => {
    expect(detectDisagreement([3, 4, 4])).toBe(false);
  });

  it('detectDisagreement([]) is false (singleton / empty)', () => {
    expect(detectDisagreement([])).toBe(false);
  });
});

describe('runBenchmark', () => {
  const candidate = mockCandidate('cand-1');
  const judges = [mockJudge('opus', 4), mockJudge('gpt4o', 4), mockJudge('gemini', 4)];

  it('requires ≥ 3 judges', async () => {
    await expect(runBenchmark([QUESTION], [candidate], [judges[0], judges[1]])).rejects.toThrow(/3 judges/);
  });

  it('scores a candidate across all questions with all judges', async () => {
    const run = await runBenchmark([QUESTION], [candidate], judges);
    expect(run.candidateResults['cand-1'].totalScore).toBe(4);
    expect(run.candidateResults['cand-1'].percent).toBe(100);
    expect(run.candidateResults['cand-1'].disagreementCount).toBe(0);
  });

  it('flags disagreement when judges span ≥ 2 tiers on the same question', async () => {
    const disagreeJudges = [mockJudge('opus', 4), mockJudge('gpt4o', 4), mockJudge('gemini', 2)];
    const run = await runBenchmark([QUESTION], [candidate], disagreeJudges);
    expect(run.candidateResults['cand-1'].disagreementCount).toBe(1);
  });

  it('percent = totalScore / (4 × N) × 100', async () => {
    const twoQuestionsJudges = [mockJudge('opus', 2), mockJudge('gpt4o', 2), mockJudge('gemini', 2)];
    const q2: BenchmarkQuestion = { ...QUESTION, id: 'bench-q2' };
    const run = await runBenchmark([QUESTION, q2], [candidate], twoQuestionsJudges);
    // 2 questions × mean tier 2 each = total 4 / (4 × 2) = 50%
    expect(run.candidateResults['cand-1'].percent).toBeCloseTo(50, 1);
  });

  it('scores multiple candidates independently', async () => {
    const weaker = mockCandidate('cand-weak');
    const weakJudges = [
      {
        id: 'opus',
        async score(q: BenchmarkQuestion, a: IntelligenceAnswer): Promise<JudgeScore> {
          return { judgeId: 'opus', questionId: q.id, tier: a === ANSWER ? 4 : 1, rationale: '' };
        },
      },
      mockJudge('gpt4o', 4),
      mockJudge('gemini', 4),
    ];
    const run = await runBenchmark([QUESTION], [candidate, weaker], weakJudges);
    expect(run.candidateResults['cand-1'].totalScore).toBe(4);
    expect(run.candidateResults['cand-weak'].totalScore).toBe(4); // same mock answer
  });
});

describe('renderBenchmarkMarkdown', () => {
  it('renders a summary table sorted by percent', async () => {
    const cand1 = mockCandidate('cand-1');
    const cand2 = mockCandidate('cand-2');
    const judges = [mockJudge('opus', 4), mockJudge('gpt4o', 4), mockJudge('gemini', 4)];
    const run = await runBenchmark([QUESTION], [cand1, cand2], judges);
    const md = renderBenchmarkMarkdown(run, '2026-04-17');
    expect(md).toMatch(/# FCRA gold-standard benchmark — 2026-04-17/);
    expect(md).toMatch(/cand-1/);
    expect(md).toMatch(/cand-2/);
    expect(md).toMatch(/100.0%/);
  });
});
