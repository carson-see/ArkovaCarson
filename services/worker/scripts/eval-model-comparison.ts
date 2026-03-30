#!/usr/bin/env tsx
/**
 * Model Comparison Eval Script
 *
 * Compares Nessie fine-tuned models on local MLX inference or RunPod.
 * Uses the golden dataset for accuracy measurement.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/eval-model-comparison.ts --pod-url http://127.0.0.1:8000 --label v3_baseline --sample 50
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

import type {
  IAIProvider,
  ExtractionRequest,
  ExtractionResult,
  EmbeddingResult,
  EmbeddingTaskType,
  ProviderHealth,
} from '../src/ai/types.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from '../src/ai/prompts/extraction.js';
import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import { runEval, formatEvalReport } from '../src/ai/eval/runner.js';
import { analyzeCalibration } from '../src/ai/eval/calibration.js';

/**
 * Minimal system prompt for fine-tuned models.
 * The full 101KB prompt is too large for local inference (26K tokens).
 * Fine-tuned models already learned the task — just need field definitions.
 */
const MINIMAL_SYSTEM_PROMPT = `You are a credential metadata extraction assistant. Extract structured metadata fields from PII-stripped credential text.

RULES:
- Input text has been PII-stripped. Redacted items appear as [NAME_REDACTED], [SSN_REDACTED], etc.
- Return a valid JSON object with only the fields you can confidently extract.
- If you cannot determine a field, OMIT it entirely.
- Dates MUST be in ISO 8601 format (YYYY-MM-DD).
- Include a "confidence" field (0.0-1.0) reflecting extraction certainty.

FIELDS TO EXTRACT:
- credentialType: DEGREE | CERTIFICATE | LICENSE | TRANSCRIPT | PROFESSIONAL | CLE | BADGE | ATTESTATION | FINANCIAL | LEGAL | INSURANCE | RESUME | MEDICAL | MILITARY | IDENTITY | SEC_FILING | PATENT | REGULATION | PUBLICATION | OTHER
- issuerName: Full official name of the issuing institution/organization
- issuedDate: When issued (YYYY-MM-DD)
- expiryDate: When it expires, if applicable (YYYY-MM-DD)
- fieldOfStudy: Field of study, specialization, or subject area
- degreeLevel: Bachelor | Master | Doctorate | Associate | Certificate | Diploma
- licenseNumber: License or certification number (only if visible and not redacted)
- accreditingBody: Accrediting or certifying organization (distinct from issuer)
- jurisdiction: Geographic jurisdiction (e.g., "California, USA" or "United Kingdom")
- recipientIdentifier: A redacted or hashed identifier for the recipient (if visible)
- creditHours: CLE credit hours (numeric, CLE only)
- creditType: CLE credit type (CLE only)
- barNumber: Bar number (CLE only)
- activityNumber: CLE activity ID (CLE only)
- providerName: CLE provider (CLE only)
- approvedBy: Approving bar (CLE only)
- fraudSignals: Array of fraud flags (default [])

Return ONLY a valid JSON object.`;

// --- CLI ---
const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const SAMPLE_SIZE = parseInt(getArg('sample', '50'), 10);
const CONCURRENCY = parseInt(getArg('concurrency', '1'), 10);
const POD_URL = getArg('pod-url', 'http://127.0.0.1:8000');
const MODEL_ID = getArg('model-id', '/tmp/nessie-v3-mlx-4bit');

class LocalProvider implements IAIProvider {
  readonly name: string;
  private readonly apiBase: string;
  private readonly modelId: string;
  private readonly apiKey: string;

  constructor(name: string, modelId: string, apiBase: string, apiKey = '') {
    this.name = name;
    this.modelId = modelId;
    this.apiBase = apiBase.endsWith('/v1') ? apiBase : `${apiBase}/v1`;
    this.apiKey = apiKey;
  }

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    const prompt = buildExtractionPrompt(
      request.strippedText,
      request.credentialType,
      request.issuerHint,
    );

    // Use minimal prompt for local inference (16GB RAM limit)
    // Full 101KB prompt = ~26K tokens, causes OOM on Apple Silicon
    const useMinimal = args.includes('--minimal-prompt');
    const systemPrompt = useMinimal ? MINIMAL_SYSTEM_PROMPT : EXTRACTION_SYSTEM_PROMPT;
    const response = await this.chatCompletion(systemPrompt, prompt);
    let text = response.choices[0]?.message?.content ?? '';

    // Strip <reasoning>...</reasoning> tags
    const reasoningMatch = text.match(/<reasoning>([\s\S]*?)<\/reasoning>\s*/);
    if (reasoningMatch) {
      text = text.slice(reasoningMatch[0].length).trim();
    }

    // Extract JSON from markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      text = jsonMatch[1].trim();
    }

    // Strip EOS tokens that MLX may include
    text = text.replace(/<\|eot_id\|>/g, '').replace(/<\|end_of_text\|>/g, '').trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log(`\n   [DEBUG] JSON parse failed. Raw: ${text.substring(0, 300)}`);
      throw new Error(`JSON parse failed`);
    }
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
    const { confidence: _, ...rawFields } = parsed;

    return {
      fields: rawFields as Record<string, unknown>,
      confidence,
      provider: this.name,
      tokensUsed: response.usage?.total_tokens,
    };
  }

  async generateEmbedding(_text: string, _taskType?: EmbeddingTaskType): Promise<EmbeddingResult> {
    throw new Error('Not supported');
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: true, provider: this.name, latencyMs: 0, mode: 'local-mlx' };
  }

  private async chatCompletion(
    systemPrompt: string,
    userPrompt: string,
    timeoutMs = 120_000,
  ): Promise<{
    choices: Array<{ message: { content: string } }>;
    usage?: { total_tokens: number };
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const res = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 2048,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`API error ${res.status}: ${err}`);
      }

      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function main() {
  const label = getArg('label', 'v3_baseline');

  console.log('=== Nessie Eval (Local) ===');
  console.log(`Date:        ${new Date().toISOString()}`);
  console.log(`Label:       ${label}`);
  console.log(`Model ID:    ${MODEL_ID}`);
  console.log(`Server:      ${POD_URL}`);
  console.log(`Dataset:     ${FULL_GOLDEN_DATASET.length} total entries`);
  console.log(`Sample:      ${SAMPLE_SIZE}`);
  console.log(`Concurrency: ${CONCURRENCY}`);

  const step = Math.max(1, Math.floor(FULL_GOLDEN_DATASET.length / SAMPLE_SIZE));
  const evalEntries = FULL_GOLDEN_DATASET.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);
  console.log(`Sampled ${evalEntries.length} entries\n`);

  const outputDir = resolve(import.meta.dirname ?? '.', '../docs/eval');
  mkdirSync(outputDir, { recursive: true });

  const provider = new LocalProvider(label, MODEL_ID, POD_URL);

  const result = await runEval({
    provider,
    entries: evalEntries,
    concurrency: CONCURRENCY,
    onProgress: (completed, total) => {
      process.stdout.write(`\r   Progress: ${completed}/${total} (${((completed / total) * 100).toFixed(0)}%)`);
    },
  });

  console.log('');
  console.log(`\n--- Results: ${label} ---`);
  console.log(`   Macro F1:         ${(result.overall.macroF1 * 100).toFixed(1)}%`);
  console.log(`   Weighted F1:      ${(result.overall.weightedF1 * 100).toFixed(1)}%`);
  console.log(`   Mean Confidence:  ${(result.overall.meanReportedConfidence * 100).toFixed(1)}%`);
  console.log(`   Mean Accuracy:    ${(result.overall.meanActualAccuracy * 100).toFixed(1)}%`);
  console.log(`   Conf Corr (r):    ${result.overall.confidenceCorrelation.toFixed(3)}`);
  console.log(`   Mean Latency:     ${result.overall.meanLatencyMs.toFixed(0)}ms`);

  const cal = analyzeCalibration(result.entryResults);
  console.log(`   ECE:              ${(cal.expectedCalibrationError * 100).toFixed(1)}%`);
  console.log(`   Calibrated:       ${cal.isCalibrated ? 'YES' : 'NO'}`);

  console.log('\n   Per-type:');
  for (const tm of result.byCredentialType.sort((a, b) => b.totalEntries - a.totalEntries)) {
    console.log(`     ${tm.scope.padEnd(18)} F1: ${(tm.macroF1 * 100).toFixed(1).padStart(5)}%  n=${tm.totalEntries}`);
  }

  const report = formatEvalReport(result);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const reportPath = resolve(outputDir, `eval-${label}-${timestamp}.md`);
  const jsonPath = resolve(outputDir, `eval-${label}-${timestamp}.json`);
  writeFileSync(reportPath, report);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  console.log(`\nReport: ${reportPath}`);
  console.log(`JSON:   ${jsonPath}`);
}

main().catch((err) => {
  console.error('\nEval failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
