#!/usr/bin/env npx tsx
/**
 * Nessie Reasoning Training Pipeline
 *
 * Generates chain-of-thought (CoT) reasoning training data for Nessie.
 * Instead of just input→JSON, Nessie learns to REASON through extraction:
 *
 * Input: PII-stripped credential text
 * Output: <reasoning>step-by-step analysis</reasoning>\n{extracted JSON}
 *
 * This teaches Nessie to:
 * 1. Identify document type from structural cues
 * 2. Reason about which fields are present vs inferred
 * 3. Detect inconsistencies and potential fraud signals
 * 4. Calibrate confidence based on evidence quality
 *
 * Uses golden dataset + existing training data as seed, then generates
 * reasoning traces via Gemini (teacher model) for each example.
 *
 * Usage:
 *   npx tsx scripts/nessie-reasoning-pipeline.ts --dry-run
 *   npx tsx scripts/nessie-reasoning-pipeline.ts --max-examples 500
 *   npx tsx scripts/nessie-reasoning-pipeline.ts --source golden
 *   npx tsx scripts/nessie-reasoning-pipeline.ts --source training --max-examples 2000
 */

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const sourceIdx = args.indexOf('--source');
const SOURCE = args.find(a => a.startsWith('--source='))?.split('=')[1] ??
  (sourceIdx >= 0 && args[sourceIdx + 1] && !args[sourceIdx + 1].startsWith('--') ? args[sourceIdx + 1] : 'both');
const maxIdx = args.indexOf('--max-examples');
const MAX_EXAMPLES = parseInt(
  args.find(a => a.startsWith('--max-examples='))?.split('=')[1] ??
    (maxIdx >= 0 && args[maxIdx + 1] ? args[maxIdx + 1] : '1000'),
  10,
);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY required');
  process.exit(1);
}

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
if (!TOGETHER_API_KEY && !DRY_RUN) {
  console.error('TOGETHER_API_KEY required for non-dry-run');
  process.exit(1);
}

const BASE_MODEL = 'carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-v3-22458d86';
const OUTPUT_DIR = path.join(__dirname, '..', 'training-data', 'reasoning');

const gemini = new GoogleGenerativeAI(GEMINI_API_KEY);

// ─── Types ───

interface TrainingExample {
  messages: Array<{ role: string; content: string }>;
}

interface ReasoningExample {
  input: string;
  credentialType: string;
  expectedOutput: string;
  reasoning: string;
}

// ─── Reasoning Generation Prompt ───

const REASONING_TEACHER_PROMPT = `You are an expert credential analysis teacher. Given a PII-stripped credential text and its correct extraction output, generate a detailed chain-of-thought reasoning trace.

The reasoning trace should demonstrate HOW an expert would analyze this document step by step:

1. **Document Type Identification**: What structural cues indicate the credential type?
   - Header patterns, terminology, formatting conventions
   - Distinguish between similar types (e.g., CERTIFICATE vs BADGE, LICENSE vs PROFESSIONAL)

2. **Field Extraction Reasoning**: For each extracted field, explain:
   - WHERE in the text the value was found
   - Whether it's directly stated or inferred
   - Any normalization applied (OCR correction, date format, name standardization)

3. **Missing Field Analysis**: Why were certain fields omitted?
   - Redacted values that shouldn't be extracted
   - Fields not applicable to this document type
   - Information not present in the text

4. **Fraud Signal Assessment**: Evaluate document authenticity:
   - Are there any date inconsistencies?
   - Does the issuer seem legitimate?
   - Are there format anomalies?
   - Explain why fraud signals ARE or ARE NOT warranted

5. **Confidence Calibration**: Justify the confidence score:
   - How many key fields were directly extractable?
   - What's the text quality (clean vs OCR artifacts)?
   - Are there ambiguities that lower confidence?

OUTPUT FORMAT:
Return ONLY the reasoning trace text (no JSON wrapping). It should read like an expert's thought process.
Keep it concise but thorough — 150-300 words. Use bullet points for clarity.

IMPORTANT: Do NOT include the final JSON output in your reasoning. The reasoning is the thinking BEFORE producing the output.`;

// ─── Step 1: Load source data ───

async function loadGoldenDataset(): Promise<ReasoningExample[]> {
  // Dynamic import of golden dataset
  const goldenPath = path.join(__dirname, '..', 'src', 'ai', 'eval', 'golden-dataset.ts');
  const goldenPhase9Path = path.join(__dirname, '..', 'src', 'ai', 'eval', 'golden-dataset-phase9.ts');

  const examples: ReasoningExample[] = [];

  // Read the golden dataset file and extract entries
  const content = fs.readFileSync(goldenPath, 'utf-8');
  const phase9Exists = fs.existsSync(goldenPhase9Path);
  const phase9Content = phase9Exists ? fs.readFileSync(goldenPhase9Path, 'utf-8') : '';

  // Parse entries from the TypeScript files using regex
  const entryRegex = /\{\s*id:\s*'(GD-\d+)'[\s\S]*?strippedText:\s*'([\s\S]*?)',\s*\n\s*credential/g;
  const allContent = content + '\n' + phase9Content;

  // Simpler approach: use the training data JSONL which already has the right format
  const trainingPath = path.join(__dirname, '..', 'training-data', 'finetune-server-8b-full-v2.jsonl');
  if (!fs.existsSync(trainingPath)) {
    console.error('Training data not found at', trainingPath);
    return examples;
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(trainingPath),
    crlfDelay: Infinity,
  });

  let count = 0;
  const maxGolden = Math.min(MAX_EXAMPLES, 1500); // Cap golden at 1500

  for await (const line of rl) {
    if (count >= maxGolden) break;
    try {
      const entry = JSON.parse(line) as TrainingExample;
      const userMsg = entry.messages.find(m => m.role === 'user');
      const assistantMsg = entry.messages.find(m => m.role === 'assistant');
      if (!userMsg || !assistantMsg) continue;

      // Parse the expected output to get credentialType
      let credType = 'UNKNOWN';
      try {
        const parsed = JSON.parse(assistantMsg.content);
        credType = parsed.credentialType || 'UNKNOWN';
      } catch {
        continue; // Skip entries with invalid JSON output
      }

      examples.push({
        input: userMsg.content,
        credentialType: credType,
        expectedOutput: assistantMsg.content,
        reasoning: '', // Will be generated
      });
      count++;
    } catch {
      // Skip malformed lines
    }
  }

  return examples;
}

async function loadTrainingData(): Promise<ReasoningExample[]> {
  const trainingPath = path.join(__dirname, '..', 'training-data', 'finetune-server-8b-full-v2.jsonl');
  if (!fs.existsSync(trainingPath)) return [];

  const rl = readline.createInterface({
    input: fs.createReadStream(trainingPath),
    crlfDelay: Infinity,
  });

  const examples: ReasoningExample[] = [];
  let count = 0;

  for await (const line of rl) {
    if (count >= MAX_EXAMPLES) break;
    try {
      const entry = JSON.parse(line) as TrainingExample;
      const userMsg = entry.messages.find(m => m.role === 'user');
      const assistantMsg = entry.messages.find(m => m.role === 'assistant');
      if (!userMsg || !assistantMsg) continue;

      let credType = 'UNKNOWN';
      try {
        const parsed = JSON.parse(assistantMsg.content);
        credType = parsed.credentialType || 'UNKNOWN';
      } catch {
        continue;
      }

      examples.push({
        input: userMsg.content,
        credentialType: credType,
        expectedOutput: assistantMsg.content,
        reasoning: '',
      });
      count++;
    } catch {
      // Skip malformed lines
    }
  }

  return examples;
}

// ─── Step 2: Generate reasoning traces via Gemini ───

async function generateReasoningTrace(
  example: ReasoningExample,
): Promise<string> {
  const model = gemini.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: REASONING_TEACHER_PROMPT,
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
    },
  });

  const prompt = `CREDENTIAL TEXT:
${example.input.slice(0, 2000)}

CORRECT EXTRACTION OUTPUT:
${example.expectedOutput}

Generate the reasoning trace for this extraction:`;

  const response = await model.generateContent(prompt);
  return response.response.text().trim();
}

async function generateReasoningBatch(
  examples: ReasoningExample[],
  batchSize: number = 5,
): Promise<ReasoningExample[]> {
  const results: ReasoningExample[] = [];
  let errorCount = 0;

  for (let i = 0; i < examples.length; i += batchSize) {
    const batch = examples.slice(i, i + batchSize);
    const promises = batch.map(async (ex) => {
      try {
        const reasoning = await generateReasoningTrace(ex);
        return { ...ex, reasoning };
      } catch (err) {
        errorCount++;
        if (errorCount % 10 === 0) {
          console.log(`    ${errorCount} errors so far`);
        }
        return null;
      }
    });

    const batchResults = await Promise.all(promises);
    for (const r of batchResults) {
      if (r && r.reasoning.length > 50) {
        results.push(r);
      }
    }

    if ((i + batchSize) % 50 === 0 || i + batchSize >= examples.length) {
      console.log(`    ${results.length}/${examples.length} reasoning traces generated`);
    }

    // Rate limiting
    if (i + batchSize < examples.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return results;
}

// ─── Step 3: Format for Together AI SFT ───

function formatForTraining(examples: ReasoningExample[]): TrainingExample[] {
  const SYSTEM_PROMPT = `You are Nessie, Arkova's credential metadata extraction model. You analyze PII-stripped credential text and extract structured metadata.

IMPORTANT: Think step by step before producing your output. Wrap your reasoning in <reasoning> tags, then output the JSON extraction.

Your output format MUST be:
<reasoning>
[Your step-by-step analysis of the document]
</reasoning>
{JSON extraction result}

Rules:
- The input text is PII-stripped. Never reconstruct redacted PII.
- Extract only fields you can confidently identify.
- Omit fields you cannot determine (no null or empty strings).
- Dates in ISO 8601 (YYYY-MM-DD).
- Confidence 0.0-1.0 reflecting extraction certainty.
- fraudSignals array only when explicit evidence of fraud exists.`;

  return examples.map(ex => ({
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: ex.input },
      {
        role: 'assistant',
        content: `<reasoning>\n${ex.reasoning}\n</reasoning>\n${ex.expectedOutput}`,
      },
    ],
  }));
}

// ─── Step 4: Upload and train ───

async function uploadToTogetherAI(filePath: string): Promise<string> {
  const formData = new FormData();
  const fileContent = fs.readFileSync(filePath);
  formData.append('file', new Blob([fileContent]), path.basename(filePath));
  formData.append('purpose', 'fine-tune');

  const response = await fetch('https://api.together.xyz/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOGETHER_API_KEY}` },
    body: formData,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Upload failed: ${response.status} ${err}`);
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

async function launchTraining(
  trainFileId: string,
  valFileId: string,
): Promise<string> {
  const response = await fetch('https://api.together.xyz/v1/fine-tunes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOGETHER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: BASE_MODEL,
      training_file: trainFileId,
      validation_file: valFileId,
      n_epochs: 3,
      learning_rate: 3e-6,
      batch_size: 4,
      suffix: 'arkova-nessie-reasoning',
      wandb_api_key: process.env.WANDB_API_KEY || undefined,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Training launch failed: ${response.status} ${err}`);
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

// ─── Main ───

async function main() {
  console.log('=== Nessie Reasoning Training Pipeline ===');
  console.log(`Date:         ${new Date().toISOString()}`);
  console.log(`Source:       ${SOURCE}`);
  console.log(`Max examples: ${MAX_EXAMPLES}`);
  console.log(`Base model:   ${BASE_MODEL}`);
  console.log(`Dry run:      ${DRY_RUN}`);
  console.log();

  // Step 1: Load source data
  console.log('--- Step 1: Load source data ---');
  let examples: ReasoningExample[] = [];

  if (SOURCE === 'golden' || SOURCE === 'both') {
    const golden = await loadGoldenDataset();
    console.log(`  Loaded ${golden.length} golden/training examples`);
    examples.push(...golden);
  }

  if (SOURCE === 'training' || SOURCE === 'both') {
    if (SOURCE === 'both') {
      // Already loaded from training data in golden step
      console.log(`  (Training data included in golden load)`);
    } else {
      const training = await loadTrainingData();
      console.log(`  Loaded ${training.length} training examples`);
      examples.push(...training);
    }
  }

  // Deduplicate and shuffle
  const seen = new Set<string>();
  examples = examples.filter(ex => {
    const key = ex.input.slice(0, 200);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Shuffle for training diversity
  for (let i = examples.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [examples[i], examples[j]] = [examples[j], examples[i]];
  }

  examples = examples.slice(0, MAX_EXAMPLES);
  console.log(`  Total unique examples: ${examples.length}`);

  // Type distribution
  const typeDist: Record<string, number> = {};
  for (const ex of examples) {
    typeDist[ex.credentialType] = (typeDist[ex.credentialType] || 0) + 1;
  }
  console.log('\nCredential type distribution:');
  for (const [type, count] of Object.entries(typeDist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count} (${((count / examples.length) * 100).toFixed(1)}%)`);
  }

  // Step 2: Generate reasoning traces
  console.log('\n--- Step 2: Generate reasoning traces ---');
  if (DRY_RUN) {
    // Generate just 3 samples
    const samples = examples.slice(0, 3);
    const withReasoning = await generateReasoningBatch(samples, 3);
    console.log(`\nSample reasoning traces (${withReasoning.length}):\n`);
    for (const ex of withReasoning) {
      console.log(`  Type: ${ex.credentialType}`);
      console.log(`  Reasoning (first 300 chars): ${ex.reasoning.slice(0, 300)}...`);
      console.log();
    }
    console.log('[DRY RUN] Skipping full generation, upload, and training');
    return;
  }

  const withReasoning = await generateReasoningBatch(examples, 5);
  console.log(`  Generated ${withReasoning.length} reasoning traces (${examples.length - withReasoning.length} failed)`);

  // Step 3: Format for training
  console.log('\n--- Step 3: Format training data ---');
  const formatted = formatForTraining(withReasoning);

  // Split 90/10
  const splitIdx = Math.floor(formatted.length * 0.9);
  const train = formatted.slice(0, splitIdx);
  const val = formatted.slice(splitIdx);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const trainPath = path.join(OUTPUT_DIR, 'reasoning-train.jsonl');
  const valPath = path.join(OUTPUT_DIR, 'reasoning-validation.jsonl');

  fs.writeFileSync(trainPath, train.map(e => JSON.stringify(e)).join('\n'));
  fs.writeFileSync(valPath, val.map(e => JSON.stringify(e)).join('\n'));

  console.log(`  Train: ${train.length} examples -> ${trainPath}`);
  console.log(`  Val:   ${val.length} examples -> ${valPath}`);

  // Step 4: Upload and train
  console.log('\n--- Step 4: Upload to Together AI ---');
  const trainFileId = await uploadToTogetherAI(trainPath);
  console.log(`  Train file: ${trainFileId}`);
  const valFileId = await uploadToTogetherAI(valPath);
  console.log(`  Val file:   ${valFileId}`);

  console.log('\n--- Step 5: Launch reasoning fine-tune ---');
  const jobId = await launchTraining(trainFileId, valFileId);
  console.log(`  Job ID: ${jobId}`);
  console.log(`  Monitor: https://api.together.xyz/v1/fine-tunes/${jobId}`);

  console.log('\n=== Pipeline complete ===');
  console.log('After training completes:');
  console.log('1. Update NESSIE_MODEL env var with new model ID');
  console.log('2. Update nessie.ts DEFAULT_NESSIE_MODEL');
  console.log('3. Update nessie-domain-router.ts if domain-specific');
  console.log('4. Run eval suite to compare reasoning vs non-reasoning');
}

main().catch(err => {
  console.error('Pipeline error:', err);
  process.exit(1);
});
