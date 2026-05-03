#!/usr/bin/env tsx
/**
 * Constrained-decoding eval — runs FCRA eval with vLLM guided_json
 * forcing record_ids to a whitelist derived from the FCRA source registry.
 *
 * Hypothesis: vLLM guided decoding eliminates ID hallucination, pushing
 * citation accuracy from 43% (v27.2 unconstrained) toward 95%+.
 *
 * Usage:
 *   npx tsx scripts/eval-constrained.ts --limit 10
 *   npx tsx scripts/eval-constrained.ts --regulation fcra --limit 50
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  scoreCitationAccuracy,
  scoreFaithfulness,
  scoreAnswerRelevance,
  scoreRiskDetection,
} from '../src/ai/eval/intelligence-eval.js';
import type { IntelligenceEvalEntry } from '../src/ai/eval/intelligence-eval.js';
import { buildIntelligenceSystemPrompt } from '../src/ai/prompts/intelligence.js';
import type { IntelligenceMode } from '../src/ai/prompts/intelligence.js';
import { FCRA_EVAL_50 } from './intelligence-dataset/evals/fcra-eval.js';
import { HIPAA_EVAL_50 } from './intelligence-dataset/evals/hipaa-eval.js';
import { FCRA_SOURCES } from './intelligence-dataset/sources/fcra-sources.js';
import { HIPAA_SOURCES } from './intelligence-dataset/sources/hipaa-sources.js';

interface RunpodChatChoice {
  message?: { content?: unknown };
}

interface RunpodOutput {
  choices?: RunpodChatChoice[];
}

interface RunpodResponse {
  output?: RunpodOutput | RunpodOutput[];
}

interface ModelCitation {
  record_id: string;
  source?: string;
}

interface ConstrainedModelResponse {
  analysis?: unknown;
  citations?: unknown;
  risks?: unknown;
  confidence?: unknown;
}

function buildSchema(recordIds: string[]) {
  return {
    name: 'nessie_compliance_response',
    schema: {
      type: 'object',
      properties: {
        analysis: { type: 'string' },
        citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              record_id: { type: 'string', enum: recordIds },
              source: { type: 'string' },
              quote: { type: 'string' },
            },
            required: ['record_id', 'source'],
          },
        },
        risks: { type: 'array', items: { type: 'string' } },
        recommendations: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number' },
        jurisdiction: { type: 'string' },
        applicable_law: { type: 'string' },
      },
      required: ['analysis', 'citations', 'risks', 'recommendations', 'confidence'],
    },
  };
}

async function callConstrained(
  query: string,
  systemPrompt: string,
  schema: ReturnType<typeof buildSchema>,
): Promise<{ text: string; latencyMs: number }> {
  const key = process.env.RUNPOD_API_KEY!;
  const endpoint = process.env.RUNPOD_ENDPOINT_ID!;
  const model = process.env.NESSIE_MODEL!;
  const start = Date.now();

  const body = {
    input: {
      openai_route: '/v1/chat/completions',
      openai_input: {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: 'json_schema', json_schema: schema },
      },
    },
  };

  const doCall = async () => {
    const res = await fetch(`https://api.runpod.ai/v2/${endpoint}/runsync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as RunpodResponse;
    let out = data.output;
    if (Array.isArray(out)) out = out[0] ?? {};
    const content = out?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  };

  let text = await doCall();
  if (!text) {
    await new Promise((r) => setTimeout(r, 3000));
    text = await doCall();
  }
  return { text, latencyMs: Date.now() - start };
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const regIdx = args.indexOf('--regulation');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 10;
  const regulation = regIdx >= 0 ? args[regIdx + 1] : 'fcra';

  let dataset: IntelligenceEvalEntry[];
  let recordIds: string[];
  if (regulation === 'hipaa') {
    dataset = HIPAA_EVAL_50;
    recordIds = HIPAA_SOURCES.map((s) => s.id);
  } else {
    dataset = FCRA_EVAL_50;
    recordIds = FCRA_SOURCES.map((s) => s.id);
  }

  const schema = buildSchema(recordIds);
  console.log(`Constrained eval: ${regulation}, ${limit} entries, ${recordIds.length} whitelisted IDs`);

  const entries = dataset.slice(0, limit);
  const results: Array<{
    id: string; citationAcc: number; faithfulness: number; relevance: number;
    riskRecall: number; confidence: number; latencyMs: number;
  }> = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    console.log(`  [${i + 1}/${entries.length}] ${entry.id}...`);
    const sys = buildIntelligenceSystemPrompt(entry.taskType as IntelligenceMode);
    try {
      const { text, latencyMs } = await callConstrained(entry.query, sys, schema);
      const parsed = JSON.parse(text) as ConstrainedModelResponse;
      const answer = typeof parsed.analysis === 'string' ? parsed.analysis : '';
      const citations: ModelCitation[] = Array.isArray(parsed.citations)
        ? parsed.citations.filter(
            (citation): citation is ModelCitation =>
              typeof citation === 'object' &&
              citation !== null &&
              typeof (citation as { record_id?: unknown }).record_id === 'string',
          )
        : [];
      const risks: string[] = Array.isArray(parsed.risks)
        ? parsed.risks.filter((risk): risk is string => typeof risk === 'string')
        : [];
      const confidence =
        typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence) ? parsed.confidence : 0;

      const citationAcc = scoreCitationAccuracy(entry.expectedCitations, citations);
      const faithfulness = scoreFaithfulness(answer, [entry.query]);
      const relevance = scoreAnswerRelevance(answer, entry.expectedKeyPoints);
      const riskRecall = entry.expectedRisks.length > 0
        ? scoreRiskDetection(entry.expectedRisks, risks, answer)
        : -1;

      results.push({ id: entry.id, citationAcc, faithfulness, relevance, riskRecall, confidence, latencyMs });
      console.log(`    Citation: ${(citationAcc * 100).toFixed(0)}%, Relevance: ${(relevance * 100).toFixed(0)}%, Latency: ${latencyMs}ms`);
    } catch (e) {
      console.log(`    ERROR: ${(e as Error).message.slice(0, 100)}`);
      results.push({ id: entry.id, citationAcc: 0, faithfulness: 0, relevance: 0, riskRecall: 0, confidence: 0, latencyMs: 0 });
    }
  }

  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const riskResults = results.filter((r) => r.riskRecall >= 0);

  const report = [
    `# Nessie Constrained-Decoding Eval Report`,
    ``,
    `- Regulation: ${regulation.toUpperCase()}`,
    `- Entries: ${results.length}`,
    `- Whitelisted IDs: ${recordIds.length}`,
    `- Date: ${new Date().toISOString()}`,
    ``,
    `## Metrics (vLLM guided_json enforced)`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Citation Accuracy | ${(mean(results.map((r) => r.citationAcc)) * 100).toFixed(1)}% |`,
    `| Faithfulness | ${(mean(results.map((r) => r.faithfulness)) * 100).toFixed(1)}% |`,
    `| Answer Relevance | ${(mean(results.map((r) => r.relevance)) * 100).toFixed(1)}% |`,
    `| Risk Detection Recall | ${riskResults.length > 0 ? (mean(riskResults.map((r) => r.riskRecall)) * 100).toFixed(1) : 'N/A'}% |`,
    `| Mean Latency | ${Math.round(mean(results.map((r) => r.latencyMs)))}ms |`,
    ``,
    `## Per-entry`,
    ``,
    `| Entry | Cit | Faith | Rel | Risk | Conf | Latency |`,
    `|---|---|---|---|---|---|---|`,
    ...results.map((r) =>
      `| ${r.id} | ${(r.citationAcc * 100).toFixed(0)}% | ${(r.faithfulness * 100).toFixed(0)}% | ${(r.relevance * 100).toFixed(0)}% | ${r.riskRecall >= 0 ? (r.riskRecall * 100).toFixed(0) + '%' : 'N/A'} | ${(r.confidence * 100).toFixed(0)}% | ${r.latencyMs}ms |`,
    ),
  ].join('\n');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = join(process.cwd(), 'docs', 'eval', `eval-constrained-${regulation}-${timestamp}.md`);
  writeFileSync(outputPath, report, 'utf-8');
  console.log(`\nReport saved to: ${outputPath}`);
  console.log('\n' + report.split('## Per-entry')[0]);
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
