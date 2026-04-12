/**
 * Nessie Intelligence Eval Runner (NMT-07 → NCE-05)
 *
 * Evaluates Nessie Intelligence model against a dataset of compliance
 * questions with expected citations, key points, and risks.
 *
 * NCE-05 expands the dataset from 8 to 100 entries across 5 domains.
 * Use --dataset v2 to use the expanded 100-entry dataset.
 *
 * Usage:
 *   npx tsx scripts/eval-intelligence.ts [--provider gemini|together] [--limit N] [--dataset v1|v2]
 *
 * Requires: GEMINI_API_KEY or (TOGETHER_API_KEY + NESSIE_INTELLIGENCE_MODEL)
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  scoreCitationAccuracy,
  scoreFaithfulness,
  scoreAnswerRelevance,
  scoreRiskDetection,
  pearsonCorrelation,
} from '../src/ai/eval/intelligence-eval.js';
import type {
  IntelligenceEvalEntry,
  IntelligenceEvalResult,
  IntelligenceEvalReport,
} from '../src/ai/eval/intelligence-eval.js';
import { buildIntelligenceSystemPrompt } from '../src/ai/prompts/intelligence.js';
import type { IntelligenceMode } from '../src/ai/prompts/intelligence.js';
import { INTELLIGENCE_EVAL_DATASET_V2 } from '../src/ai/eval/intelligence-eval-dataset.js';

// ---------------------------------------------------------------------------
// Eval dataset — FCRA/employment compliance questions
// ---------------------------------------------------------------------------

const INTELLIGENCE_EVAL_DATASET: IntelligenceEvalEntry[] = [
  {
    id: 'intel-fcra-001',
    taskType: 'compliance_qa',
    domain: 'employment_screening',
    query: 'What are the FCRA requirements for pre-adverse action notices?',
    contextDocIds: ['fcra-adverse-001', 'fcra-adverse-002'],
    expectedKeyPoints: [
      'copy of consumer report must be provided',
      'summary of rights under FCRA',
      'opportunity to dispute before final decision',
      '15 U.S.C. 1681',
    ],
    expectedRisks: [],
    expectedCitations: ['fcra-adverse-001'],
    minConfidence: 0.70,
  },
  {
    id: 'intel-fcra-002',
    taskType: 'risk_analysis',
    domain: 'employment_screening',
    query: 'Analyze the risks in this nursing license verification showing disciplinary action.',
    contextDocIds: ['fcra-lic-002'],
    expectedKeyPoints: [
      'license expired',
      'disciplinary action',
      'consent order',
      'suspension',
    ],
    expectedRisks: [
      'expired license',
      'active disciplinary restrictions',
      'medication administration restriction',
    ],
    expectedCitations: ['fcra-lic-002'],
    minConfidence: 0.75,
  },
  {
    id: 'intel-fcra-003',
    taskType: 'cross_reference',
    domain: 'employment_screening',
    query: 'Cross-reference the employment verification against the background check for any discrepancies.',
    contextDocIds: ['fcra-empver-002', 'fcra-bgc-002'],
    expectedKeyPoints: [
      'employment gap',
      'education discrepancy',
      'unverifiable degree',
    ],
    expectedRisks: [
      'resume inconsistency',
      'fabricated education credential',
    ],
    expectedCitations: ['fcra-empver-002', 'fcra-bgc-002'],
    minConfidence: 0.65,
  },
  {
    id: 'intel-fcra-004',
    taskType: 'recommendation',
    domain: 'employment_screening',
    query: 'What actions should an employer take after receiving an E-Verify tentative nonconfirmation?',
    contextDocIds: ['fcra-everify-001'],
    expectedKeyPoints: [
      'notify employee in private',
      '8 federal government work days',
      'no adverse action during referral',
      'DHS referral letter',
    ],
    expectedRisks: [],
    expectedCitations: ['fcra-everify-001'],
    minConfidence: 0.70,
  },
  {
    id: 'intel-fcra-005',
    taskType: 'compliance_qa',
    domain: 'employment_screening',
    query: 'What are the ban-the-box requirements in California vs New York City?',
    contextDocIds: ['fcra-btb-001', 'fcra-btb-002'],
    expectedKeyPoints: [
      'California Fair Chance Act',
      'individualized assessment',
      'NYC Fair Chance Act',
      'Article 23-A',
      'conditional offer',
    ],
    expectedRisks: [],
    expectedCitations: ['fcra-btb-001', 'fcra-btb-002'],
    minConfidence: 0.75,
  },
  {
    id: 'intel-fcra-006',
    taskType: 'risk_analysis',
    domain: 'employment_screening',
    query: 'Analyze risks in this multi-state criminal background check.',
    contextDocIds: ['fcra-multi-001'],
    expectedKeyPoints: [
      'varying lookback periods',
      'Texas DWI deferred adjudication',
      'EEOC individualized assessment',
    ],
    expectedRisks: [
      'criminal record found in Texas',
      'different state lookback periods apply',
    ],
    expectedCitations: ['fcra-multi-001'],
    minConfidence: 0.70,
  },
  {
    id: 'intel-fcra-007',
    taskType: 'document_summary',
    domain: 'professional_certification',
    query: 'Summarize this PMP certification verification for compliance purposes.',
    contextDocIds: ['fcra-cert-002'],
    expectedKeyPoints: [
      'expired',
      'PDU requirement not met',
      'beyond reinstatement period',
      'must re-examine',
    ],
    expectedRisks: [
      'expired certification',
    ],
    expectedCitations: ['fcra-cert-002'],
    minConfidence: 0.75,
  },
  {
    id: 'intel-fcra-008',
    taskType: 'recommendation',
    domain: 'medical_license',
    query: 'What should a hospital credentialing office verify for this physician?',
    contextDocIds: ['fcra-lic-001'],
    expectedKeyPoints: [
      'active license',
      'DEA registration',
      'board certification',
      'malpractice claims',
      'NPI verification',
    ],
    expectedRisks: [],
    expectedCitations: ['fcra-lic-001'],
    minConfidence: 0.80,
  },
];

// ---------------------------------------------------------------------------
// Eval runner
// ---------------------------------------------------------------------------

async function callIntelligenceAPI(
  query: string,
  taskType: string,
  provider: 'gemini' | 'together',
): Promise<{ text: string; latencyMs: number; tokensUsed: number }> {
  const systemPrompt = buildIntelligenceSystemPrompt(taskType as IntelligenceMode);
  const start = Date.now();

  if (provider === 'together') {
    const key = process.env.TOGETHER_API_KEY;
    const model = process.env.NESSIE_INTELLIGENCE_MODEL;
    if (!key || !model) throw new Error('TOGETHER_API_KEY and NESSIE_INTELLIGENCE_MODEL required');

    const res = await fetch('https://api.together.xyz/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      }),
    });
    const data = await res.json() as { choices: Array<{ message: { content: string } }>; usage?: { total_tokens: number } };
    return {
      text: data.choices[0]?.message?.content ?? '',
      latencyMs: Date.now() - start,
      tokensUsed: data.usage?.total_tokens ?? 0,
    };
  }

  // Gemini
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY required');
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview',
    systemInstruction: systemPrompt,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });
  const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: query }] }] });
  return {
    text: result.response.text(),
    latencyMs: Date.now() - start,
    tokensUsed: result.response.usageMetadata?.totalTokenCount ?? 0,
  };
}

async function evaluateEntry(
  entry: IntelligenceEvalEntry,
  provider: 'gemini' | 'together',
): Promise<IntelligenceEvalResult> {
  try {
    const { text, latencyMs } = await callIntelligenceAPI(entry.query, entry.taskType, provider);

    const parsed = JSON.parse(text) as {
      analysis?: string;
      answer?: string;
      citations?: Array<{ record_id: string }>;
      risks?: string[];
      recommendations?: string[];
      confidence?: number;
    };

    const answer = parsed.analysis ?? parsed.answer ?? '';
    const citations = parsed.citations ?? [];
    const risks = parsed.risks ?? [];
    const confidence = parsed.confidence ?? 0;

    const citationAcc = scoreCitationAccuracy(entry.expectedCitations, citations);
    const faithfulness = scoreFaithfulness(answer, [entry.query]); // simplified — in prod use actual context docs
    const answerRel = scoreAnswerRelevance(answer, entry.expectedKeyPoints);
    const riskRecall = entry.expectedRisks.length > 0
      ? scoreRiskDetection(entry.expectedRisks, risks)
      : -1; // N/A

    const actualQuality = (citationAcc * 0.3 + faithfulness * 0.2 + answerRel * 0.3 + (riskRecall >= 0 ? riskRecall * 0.2 : 0.2));

    return {
      entryId: entry.id,
      citationAccuracy: citationAcc,
      faithfulness,
      answerRelevance: answerRel,
      riskDetectionRecall: riskRecall,
      reportedConfidence: confidence,
      actualQuality,
      latencyMs,
      rawResponse: text.slice(0, 500),
    };
  } catch (err) {
    return {
      entryId: entry.id,
      citationAccuracy: 0,
      faithfulness: 0,
      answerRelevance: 0,
      riskDetectionRecall: 0,
      reportedConfidence: 0,
      actualQuality: 0,
      latencyMs: 0,
      rawResponse: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function formatReport(results: IntelligenceEvalResult[], provider: string): string {
  const n = results.length;
  const mean = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  const citAcc = mean(results.map((r) => r.citationAccuracy));
  const faith = mean(results.map((r) => r.faithfulness));
  const ansRel = mean(results.map((r) => r.answerRelevance));
  const riskResults = results.filter((r) => r.riskDetectionRecall >= 0);
  const riskRecall = mean(riskResults.map((r) => r.riskDetectionRecall));
  const confCorr = pearsonCorrelation(
    results.map((r) => r.reportedConfidence),
    results.map((r) => r.actualQuality),
  );
  const meanLatency = mean(results.map((r) => r.latencyMs));

  const lines = [
    `# Nessie Intelligence Eval Report`,
    ``,
    `- **Date:** ${new Date().toISOString()}`,
    `- **Provider:** ${provider}`,
    `- **Entries:** ${n}`,
    ``,
    `## Overall Metrics`,
    ``,
    `| Metric | Value | Target |`,
    `|--------|-------|--------|`,
    `| Citation Accuracy | ${(citAcc * 100).toFixed(1)}% | >95% |`,
    `| Faithfulness | ${(faith * 100).toFixed(1)}% | >90% |`,
    `| Answer Relevance | ${(ansRel * 100).toFixed(1)}% | >85% |`,
    `| Risk Detection Recall | ${(riskRecall * 100).toFixed(1)}% | >80% |`,
    `| Confidence Correlation (r) | ${confCorr.toFixed(3)} | >0.60 |`,
    `| Mean Latency | ${meanLatency.toFixed(0)}ms | <5000ms |`,
    ``,
    `## Per-Entry Results`,
    ``,
    `| Entry | Task | Citation | Faithfulness | Relevance | Risk Recall | Confidence | Quality | Latency |`,
    `|-------|------|----------|-------------|-----------|-------------|------------|---------|---------|`,
  ];

  for (const r of results) {
    lines.push(
      `| ${r.entryId} | — | ${(r.citationAccuracy * 100).toFixed(0)}% | ${(r.faithfulness * 100).toFixed(0)}% | ${(r.answerRelevance * 100).toFixed(0)}% | ${r.riskDetectionRecall >= 0 ? (r.riskDetectionRecall * 100).toFixed(0) + '%' : 'N/A'} | ${(r.reportedConfidence * 100).toFixed(0)}% | ${(r.actualQuality * 100).toFixed(0)}% | ${r.latencyMs}ms |`,
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const providerIdx = args.indexOf('--provider');
  const limitIdx = args.indexOf('--limit');

  const provider = (providerIdx >= 0 ? args[providerIdx + 1] : 'gemini') as 'gemini' | 'together';
  const datasetIdx = args.indexOf('--dataset');
  const datasetVersion = datasetIdx >= 0 ? args[datasetIdx + 1] : 'v1';
  const dataset = datasetVersion === 'v2' ? INTELLIGENCE_EVAL_DATASET_V2 : INTELLIGENCE_EVAL_DATASET;
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : dataset.length;

  const entries = dataset.slice(0, limit);
  console.log(`Running intelligence eval: ${entries.length} entries, provider: ${provider}`);

  const results: IntelligenceEvalResult[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    console.log(`  [${i + 1}/${entries.length}] ${entry.id} (${entry.taskType})...`);
    const result = await evaluateEntry(entry, provider);
    results.push(result);
    console.log(`    Citation: ${(result.citationAccuracy * 100).toFixed(0)}%, Relevance: ${(result.answerRelevance * 100).toFixed(0)}%, Quality: ${(result.actualQuality * 100).toFixed(0)}%`);
  }

  const report = formatReport(results, provider);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = join(process.cwd(), 'docs', 'eval', `eval-intelligence-${timestamp}.md`);

  writeFileSync(outputPath, report, 'utf-8');
  console.log(`\nReport saved to: ${outputPath}`);
  console.log('\n' + report);
}

main().catch((err) => {
  console.error('Eval failed:', err);
  process.exit(1);
});
