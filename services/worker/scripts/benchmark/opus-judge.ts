/**
 * NVI-12 — Claude Opus judge adapter (SCRUM-816).
 *
 * Thin wrapper over `scripts/common/anthropic.ts` that renders the
 * rubric into a system + user prompt and parses the JSON verdict.
 * Tests must not import this module — use a `MockJudge`.
 */

import type { BenchmarkQuestion } from '../intelligence-dataset/benchmark/benchmark';
import type { IntelligenceAnswer } from '../intelligence-dataset/types';
import type { Judge, JudgeScore } from './types';
import { callAnthropicJson } from '../common/anthropic';

const SYSTEM_PROMPT = `
You are an FCRA compliance attorney acting as an LLM-as-judge for a
benchmark. Given a question, a rubric, and a candidate model's answer,
assign a tier in {0, 1, 2, 3, 4} and a one-paragraph rationale.

Tiers:
  4 — expert-level: meets the rubric's expertCriteria
  3 — good: meets goodCriteria
  2 — adequate: meets adequateCriteria
  1 — partial: meets partialCriteria only
  0 — missed: fits missedCriteria

Respond with ONLY this JSON — no markdown, no prose outside:
{"tier": 0|1|2|3|4, "rationale": "…"}
`.trim();

function buildUserContent(q: BenchmarkQuestion, answer: IntelligenceAnswer): string {
  return [
    `# Question`,
    q.question,
    '',
    `# Rubric`,
    `Tier 4 (expert):   ${q.rubric.expertCriteria}`,
    `Tier 3 (good):     ${q.rubric.goodCriteria}`,
    `Tier 2 (adequate): ${q.rubric.adequateCriteria}`,
    `Tier 1 (partial):  ${q.rubric.partialCriteria}`,
    `Tier 0 (missed):   ${q.rubric.missedCriteria}`,
    '',
    `# Candidate answer`,
    '```json',
    JSON.stringify(answer, null, 2),
    '```',
  ].join('\n');
}

export interface OpusJudgeOpts {
  apiKey?: string;
  model?: string;
}

interface OpusJudgeResponse {
  tier: 0 | 1 | 2 | 3 | 4;
  rationale: string;
}

export function createOpusJudge(opts: OpusJudgeOpts = {}): Judge {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for Opus judge');
  const model = opts.model ?? 'claude-opus-4-7';

  return {
    id: `opus:${model}`,
    async score(q: BenchmarkQuestion, answer: IntelligenceAnswer): Promise<JudgeScore> {
      const parsed = await callAnthropicJson<OpusJudgeResponse>({
        apiKey,
        model,
        system: SYSTEM_PROMPT,
        userContent: buildUserContent(q, answer),
        maxTokens: 500,
      });
      return { judgeId: `opus:${model}`, questionId: q.id, tier: parsed.tier, rationale: parsed.rationale };
    },
  };
}
