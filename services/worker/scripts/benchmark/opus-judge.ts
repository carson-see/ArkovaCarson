/**
 * NVI-12 — Claude Opus judge adapter (SCRUM-816).
 *
 * Wraps the Anthropic Messages API (via `fetch`, no SDK dep) and asks
 * Opus to score a candidate answer against a benchmark question's
 * rubric. Returns a tier in 0..4 + rationale string.
 *
 * Tests MUST NOT import this module — use MockJudge instead.
 */

import type { BenchmarkQuestion } from '../intelligence-dataset/benchmark/benchmark';
import type { IntelligenceAnswer } from '../intelligence-dataset/types';
import type { Judge, JudgeScore } from './types';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

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

export function createOpusJudge(opts: OpusJudgeOpts = {}): Judge {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY required for Opus judge');
  const model = opts.model ?? 'claude-opus-4-7';

  return {
    id: `opus:${model}`,
    async score(q: BenchmarkQuestion, answer: IntelligenceAnswer): Promise<JudgeScore> {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildUserContent(q, answer) }],
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Anthropic judge ${res.status}: ${body.slice(0, 400)}`);
      }
      const body = (await res.json()) as { content: Array<{ type: string; text?: string }> };
      const text = body.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text!).join('').trim();
      const jsonText = text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
      const parsed = JSON.parse(jsonText) as { tier: 0 | 1 | 2 | 3 | 4; rationale: string };
      return { judgeId: `opus:${model}`, questionId: q.id, tier: parsed.tier, rationale: parsed.rationale };
    },
  };
}
