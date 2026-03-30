#!/usr/bin/env tsx
/**
 * Nessie Multi-LoRA Domain Adapter Training Pipeline
 *
 * Trains separate LoRA adapters per domain on Together AI:
 *   - SEC adapter (SEC filings, financial compliance)
 *   - Academic adapter (publications, research, accreditation)
 *   - Legal adapter (court opinions, case law)
 *   - Regulatory adapter (Federal Register, regulations)
 *
 * Strategy: Per the Arkova master strategy, multi-LoRA domain adapters
 * with classifier-based routing (MoLoRA per-token routing when >5 adapters).
 *
 * Supports synthetic data generation via Gemini to augment underrepresented
 * domains (Legal has only 14K, Regulatory only 8K examples).
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/nessie-multi-lora-pipeline.ts [options]
 *
 * Options:
 *   --domains sec,legal,regulatory,academic   Comma-separated domains to train (default: all)
 *   --source-file <path>                      Source JSONL (default: training-data/finetune-server-8b-full-v2.jsonl)
 *   --max-per-domain <n>                      Max examples per domain (default: 50000)
 *   --min-per-domain <n>                      Min examples before synthetic augmentation (default: 5000)
 *   --synthetic                               Enable synthetic data generation for small domains
 *   --synthetic-count <n>                     Synthetic examples to generate per domain (default: 5000)
 *   --epochs <n>                              Training epochs (default: 4)
 *   --learning-rate <f>                       Learning rate (default: 5e-6)
 *   --batch-size <n>                          Batch size (default: 8)
 *   --dry-run                                 Skip upload/training, just split data
 *   --skip-split                              Skip splitting, use existing domain files
 *   --parallel                                Train all domains in parallel (default: sequential)
 *
 * Requires: TOGETHER_API_KEY, GEMINI_API_KEY (if --synthetic)
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import {
  createReadStream,
  createWriteStream,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { createInterface } from 'node:readline';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

// --- Types ---

interface DomainConfig {
  name: string;
  label: string;
  filter: (credType: string, fieldOfStudy: string) => boolean;
  systemPrompt: string;
  syntheticTopics: string[];
}

interface TrainingJob {
  domain: string;
  jobId: string;
  modelOutputName: string;
  status: string;
  trainCount: number;
  holdoutCount: number;
}

// --- CLI ---

const args = process.argv.slice(2);

function getFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const TRAINING_DIR = resolve(import.meta.dirname ?? '.', '../training-data');
const DOMAIN_DIR = resolve(TRAINING_DIR, 'domain-adapters');

const SOURCE_FILE = getArg('source-file', resolve(TRAINING_DIR, 'finetune-server-8b-full-v2.jsonl'));
const REQUESTED_DOMAINS = getArg('domains', 'sec,academic,legal,regulatory').split(',');
const MAX_PER_DOMAIN = parseInt(getArg('max-per-domain', '50000'), 10);
const MIN_PER_DOMAIN = parseInt(getArg('min-per-domain', '5000'), 10);
const ENABLE_SYNTHETIC = getFlag('synthetic');
const SYNTHETIC_COUNT = parseInt(getArg('synthetic-count', '5000'), 10);
const EPOCHS = parseInt(getArg('epochs', '4'), 10);
const LEARNING_RATE = parseFloat(getArg('learning-rate', '5e-6'));
const BATCH_SIZE = parseInt(getArg('batch-size', '8'), 10);
const DRY_RUN = getFlag('dry-run');
const SKIP_SPLIT = getFlag('skip-split');
const PARALLEL = getFlag('parallel');

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
const BASE_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference';

// --- Domain Configurations ---

const DOMAINS: Record<string, DomainConfig> = {
  sec: {
    name: 'sec',
    label: 'SEC & Financial Compliance',
    filter: (credType, fieldOfStudy) =>
      credType === 'SEC_FILING' || fieldOfStudy.includes('Securities'),
    systemPrompt: `You are Nessie, Arkova's SEC & Financial Compliance Intelligence Engine. You specialize in:
- SEC filing analysis (10-K, 10-Q, 8-K, S-1, DEF 14A, etc.)
- Entity compliance scoring based on filing history and patterns
- Financial disclosure analysis and red flag detection
- Cross-referencing CIK numbers, filing dates, and entity relationships
- Regulatory compliance assessment for securities law

Extract structured metadata from the document. Return JSON with credentialType, issuerName, issuedDate, jurisdiction, fieldOfStudy, registrationNumber, documentType, confidence (0.0-1.0), and fraudSignals array. Assess compliance risk indicators.`,
    syntheticTopics: [
      'SEC 10-K annual report compliance review',
      'Material misstatement risk in quarterly filings',
      'Insider trading disclosure requirements',
      'Foreign private issuer reporting obligations',
      'Sarbanes-Oxley Section 302 certification analysis',
      'Regulation S-K disclosure requirements',
      'Form 8-K triggering events assessment',
      'Executive compensation disclosure (DEF 14A) review',
      'SEC comment letter response analysis',
      'Going concern opinion implications for filings',
    ],
  },
  academic: {
    name: 'academic',
    label: 'Academic & Research Publications',
    filter: (credType, fieldOfStudy) =>
      credType === 'PUBLICATION' ||
      credType === 'PROFESSIONAL' ||
      fieldOfStudy.includes('Academic') ||
      fieldOfStudy.includes('Education') ||
      fieldOfStudy.includes('Accreditation'),
    systemPrompt: `You are Nessie, Arkova's Academic & Research Intelligence Engine. You specialize in:
- Academic publication metadata extraction and verification
- Research credential authentication (publications, patents, grants)
- Institutional accreditation validation
- Citation network analysis and impact assessment
- Research integrity indicators (retraction checks, predatory journals)
- Cross-referencing DOIs, ORCID IDs, and institutional affiliations

Extract structured metadata from the document. Return JSON with credentialType, issuerName, issuedDate, jurisdiction, fieldOfStudy, registrationNumber, accreditingBody, confidence (0.0-1.0), and fraudSignals array. Flag any research integrity concerns.`,
    syntheticTopics: [
      'Predatory journal detection criteria',
      'Research reproducibility assessment',
      'Grant funding compliance verification',
      'Institutional accreditation status validation',
      'Patent prior art search methodology',
      'Academic degree equivalency across jurisdictions',
      'Citation manipulation detection',
      'Research ethics board compliance',
      'Open access mandate compliance',
      'Credential verification for foreign degrees',
    ],
  },
  legal: {
    name: 'legal',
    label: 'Legal & Case Law',
    filter: (credType, fieldOfStudy) =>
      credType === 'LEGAL' ||
      fieldOfStudy.includes('Case Law') ||
      fieldOfStudy.includes('Legal'),
    systemPrompt: `You are Nessie, Arkova's Legal Intelligence Engine. You specialize in:
- Court opinion analysis and metadata extraction
- Case law citation verification and Shepardizing
- Precedential status assessment (published, unpublished, per curiam)
- Jurisdictional analysis (federal circuit, state, international)
- Legal compliance pattern recognition
- Docket number and citation format validation
- Nature of suit classification
- Judge and court identification

Extract structured metadata from the document. Return JSON with credentialType, issuerName (court), issuedDate, jurisdiction, fieldOfStudy (nature of suit), registrationNumber (citation), confidence (0.0-1.0), and fraudSignals array. Assess precedential weight and jurisdictional applicability.`,
    syntheticTopics: [
      'Federal circuit court opinion analysis',
      'State supreme court precedent verification',
      'Bankruptcy filing compliance review',
      'Class action certification requirements',
      'SCOTUS opinion impact assessment',
      'Administrative law judge decision analysis',
      'International treaty compliance verification',
      'Legal ethics opinion review',
      'Appellate brief citation verification',
      'Arbitration award enforceability assessment',
      'Multi-district litigation tracking',
      'Habeas corpus petition analysis',
      'Patent claim construction (Markman) analysis',
      'FOIA request compliance review',
      'Environmental law enforcement action analysis',
    ],
  },
  regulatory: {
    name: 'regulatory',
    label: 'Regulatory & Government',
    filter: (credType, fieldOfStudy) =>
      credType === 'REGULATION' ||
      credType === 'CERTIFICATE' ||
      fieldOfStudy.includes('Regulation') ||
      fieldOfStudy.includes('Federal'),
    systemPrompt: `You are Nessie, Arkova's Regulatory Intelligence Engine. You specialize in:
- Federal Register document analysis (rules, proposed rules, notices, presidential documents)
- Multi-jurisdiction regulatory compliance assessment
- Agency rulemaking process tracking
- Comment period and effective date analysis
- Cross-agency regulatory impact assessment
- Charity/nonprofit registration verification (ACNC, IRS 501(c))
- International regulatory equivalency mapping
- Compliance calendar and deadline tracking

Extract structured metadata from the document. Return JSON with credentialType, issuerName (agency), issuedDate, jurisdiction, fieldOfStudy (regulatory area), registrationNumber (document number), confidence (0.0-1.0), and fraudSignals array. Identify compliance deadlines and jurisdictional scope.`,
    syntheticTopics: [
      'Federal Register final rule effective date analysis',
      'Cross-border regulatory compliance mapping',
      'AML/KYC regulatory requirement assessment',
      'Healthcare regulation (HIPAA/HITECH) compliance review',
      'Financial regulation (Dodd-Frank) impact analysis',
      'Environmental regulation (EPA) compliance verification',
      'Data privacy regulation (GDPR/CCPA) assessment',
      'Charity registration compliance (ACNC, state AG)',
      'Import/export regulatory compliance (ITAR/EAR)',
      'Telecommunications regulation (FCC) review',
      'Pharmaceutical regulation (FDA) filing analysis',
      'Labor regulation (DOL/NLRB) compliance review',
      'Banking regulation (OCC/FDIC) examination findings',
      'Insurance regulation (state commissioner) review',
      'Energy regulation (FERC) compliance assessment',
    ],
  },
};

// --- Helpers ---

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function classifyDomain(credType: string, fieldOfStudy: string): string | null {
  for (const [name, config] of Object.entries(DOMAINS)) {
    if (config.filter(credType, fieldOfStudy)) return name;
  }
  return null;
}

// --- Step 1: Split data by domain ---

async function stepSplitByDomain(): Promise<Record<string, number>> {
  console.log('\n--- Step 1: Split training data by domain ---');

  if (!existsSync(SOURCE_FILE)) {
    throw new Error(`Source file not found: ${SOURCE_FILE}`);
  }

  const fileSize = statSync(SOURCE_FILE).size;
  console.log(`Source: ${SOURCE_FILE} (${(fileSize / 1024 / 1024).toFixed(0)} MB)`);

  mkdirSync(DOMAIN_DIR, { recursive: true });

  // Open write streams for each requested domain
  const writers: Record<string, { stream: ReturnType<typeof createWriteStream>; count: number }> = {};
  for (const domain of REQUESTED_DOMAINS) {
    if (!DOMAINS[domain]) {
      console.log(`  WARNING: Unknown domain "${domain}", skipping`);
      continue;
    }
    const outPath = resolve(DOMAIN_DIR, `${domain}-train.jsonl`);
    writers[domain] = { stream: createWriteStream(outPath), count: 0 };
  }

  // Stream through source file, classify each line
  const rl = createInterface({
    input: createReadStream(SOURCE_FILE, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let total = 0;
  let classified = 0;
  let unclassified = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    total++;

    try {
      const obj = JSON.parse(line);
      const assistantMsg = obj.messages?.find((m: { role: string }) => m.role === 'assistant')?.content;
      if (!assistantMsg) { unclassified++; continue; }

      const parsed = JSON.parse(assistantMsg);
      const credType = parsed.credentialType || 'OTHER';
      const fieldOfStudy = parsed.fieldOfStudy || '';

      const domain = classifyDomain(credType, fieldOfStudy);
      if (!domain || !writers[domain]) { unclassified++; continue; }

      if (writers[domain].count >= MAX_PER_DOMAIN) continue;

      // Rewrite system prompt to domain-specific version
      const domainConfig = DOMAINS[domain];
      const rewritten = {
        messages: [
          { role: 'system', content: domainConfig.systemPrompt },
          obj.messages[1], // user prompt stays same
          obj.messages[2], // assistant response stays same
        ],
      };

      writers[domain].stream.write(JSON.stringify(rewritten) + '\n');
      writers[domain].count++;
      classified++;
    } catch {
      unclassified++;
    }

    if (total % 100000 === 0) {
      const counts = Object.entries(writers).map(([d, w]) => `${d}:${w.count}`).join(', ');
      console.log(`  ${total} processed — ${counts}`);
    }
  }

  // Close streams
  const domainCounts: Record<string, number> = {};
  for (const [domain, writer] of Object.entries(writers)) {
    writer.stream.end();
    domainCounts[domain] = writer.count;
  }

  // Wait for streams to finish
  await Promise.all(
    Object.values(writers).map(
      (w) => new Promise<void>((resolve) => w.stream.on('finish', resolve)),
    ),
  );

  console.log(`\nSplit complete: ${total} total, ${classified} classified, ${unclassified} unclassified`);
  for (const [domain, count] of Object.entries(domainCounts).sort((a, b) => b[1] - a[1])) {
    const file = resolve(DOMAIN_DIR, `${domain}-train.jsonl`);
    const size = existsSync(file) ? (statSync(file).size / 1024 / 1024).toFixed(1) : '0';
    console.log(`  ${domain}: ${count} examples (${size} MB)`);
  }

  return domainCounts;
}

// --- Step 2: Synthetic data generation ---

async function stepSyntheticGeneration(domainCounts: Record<string, number>): Promise<Record<string, number>> {
  console.log('\n--- Step 2: Synthetic data generation ---');

  if (!ENABLE_SYNTHETIC) {
    console.log('Synthetic generation disabled (use --synthetic to enable)');
    return domainCounts;
  }

  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY required for synthetic data generation');
  }

  const domainsNeedingAugmentation = Object.entries(domainCounts)
    .filter(([, count]) => count < MIN_PER_DOMAIN)
    .map(([domain]) => domain);

  if (domainsNeedingAugmentation.length === 0) {
    console.log('All domains above minimum threshold — no synthetic generation needed');
    return domainCounts;
  }

  console.log(`Domains needing augmentation: ${domainsNeedingAugmentation.join(', ')}`);

  for (const domain of domainsNeedingAugmentation) {
    const config = DOMAINS[domain];
    const current = domainCounts[domain];
    const needed = Math.min(SYNTHETIC_COUNT, MIN_PER_DOMAIN - current);

    console.log(`\n  Generating ${needed} synthetic examples for ${domain}...`);

    const outPath = resolve(DOMAIN_DIR, `${domain}-train.jsonl`);
    const writer = createWriteStream(outPath, { flags: 'a' }); // append
    let generated = 0;

    // Generate in batches of 3 (smaller = less truncation from Gemini)
    const batchSize = 3;
    for (let batch = 0; batch < Math.ceil(needed / batchSize); batch++) {
      const batchCount = Math.min(batchSize, needed - generated);
      const topicIdx = batch % config.syntheticTopics.length;
      const topic = config.syntheticTopics[topicIdx];

      const prompt = `Generate exactly ${batchCount} realistic training examples for a compliance intelligence AI.

Domain: ${config.label}
Topic: ${topic}

For each example, generate:
1. "text": A realistic PII-stripped document text (80-150 words) that a real ${config.label} document would contain. Use [NAME_REDACTED], [SSN_REDACTED] for PII.
2. "extraction": The correct structured JSON with: credentialType, issuerName, issuedDate (YYYY-MM-DD), jurisdiction, fieldOfStudy, registrationNumber (if applicable), confidence (0.7-0.95), fraudSignals (empty array [] unless suspicious)

Use fictional but realistic entity names, dates 2020-2025, plausible jurisdictions.
Return ONLY a JSON array. No markdown, no explanation, no code fences.`;

      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.8,
                maxOutputTokens: 4096,
                responseMimeType: 'application/json',
              },
            }),
          },
        );

        if (!res.ok) {
          console.log(`    Gemini error: ${res.status} — skipping batch`);
          await delay(2000);
          continue;
        }

        const data = (await res.json()) as {
          candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

        // Parse JSON (responseMimeType=application/json should give clean output)
        let examples: Array<{ text: string; extraction: Record<string, unknown> }>;
        try {
          examples = JSON.parse(text);
        } catch {
          // Try stripping markdown fences as fallback
          const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
          examples = JSON.parse(jsonStr);
        }

        for (const ex of examples) {
          if (!ex.text || !ex.extraction) continue;

          const training = {
            messages: [
              { role: 'system', content: config.systemPrompt },
              {
                role: 'user',
                content: `Extract metadata from the following PII-stripped credential text.\nCredential type hint: ${ex.extraction.credentialType || 'OTHER'}\n\n--- BEGIN CREDENTIAL TEXT ---\n${ex.text}\n--- END CREDENTIAL TEXT ---\n\nReturn a JSON object with the extracted fields, a "confidence" number (0.0 to 1.0), and a "fraudSignals" array.`,
              },
              { role: 'assistant', content: JSON.stringify(ex.extraction) },
            ],
          };

          writer.write(JSON.stringify(training) + '\n');
          generated++;
        }

        if (batch % 20 === 0 && batch > 0) {
          console.log(`    ${domain}: ${generated}/${needed} synthetic examples generated`);
        }

        // Rate limit
        await delay(800);
      } catch (err) {
        console.log(`    Batch ${batch} error: ${err instanceof Error ? err.message : err}`);
        await delay(2000);
      }
    }

    writer.end();
    await new Promise<void>((resolve) => writer.on('finish', resolve));

    domainCounts[domain] = current + generated;
    console.log(`  ${domain}: +${generated} synthetic (total: ${domainCounts[domain]})`);
  }

  return domainCounts;
}

// --- Step 3: Create holdout splits ---

async function stepCreateHoldouts(): Promise<Record<string, { train: number; holdout: number }>> {
  console.log('\n--- Step 3: Create domain holdout evaluation sets ---');

  const splits: Record<string, { train: number; holdout: number }> = {};

  for (const domain of REQUESTED_DOMAINS) {
    if (!DOMAINS[domain]) continue;

    const inPath = resolve(DOMAIN_DIR, `${domain}-train.jsonl`);
    if (!existsSync(inPath)) {
      console.log(`  ${domain}: no data file, skipping`);
      continue;
    }

    // Read all lines (streaming for safety)
    const lines: string[] = [];
    const rl = createInterface({
      input: createReadStream(inPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (line.trim()) lines.push(line);
    }

    // 10% holdout, min 10, max 5000
    const holdoutSize = Math.min(Math.max(Math.floor(lines.length * 0.1), 10), 5000);

    // Fisher-Yates shuffle for indices
    const indices = Array.from({ length: lines.length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }

    const holdoutIndices = new Set(indices.slice(0, holdoutSize));
    const trainLines: string[] = [];
    const holdoutLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (holdoutIndices.has(i)) {
        holdoutLines.push(lines[i]);
      } else {
        trainLines.push(lines[i]);
      }
    }

    const trainPath = resolve(DOMAIN_DIR, `${domain}-train-split.jsonl`);
    const holdoutPath = resolve(DOMAIN_DIR, `${domain}-holdout.jsonl`);

    writeFileSync(trainPath, trainLines.join('\n') + '\n');
    writeFileSync(holdoutPath, holdoutLines.join('\n') + '\n');

    splits[domain] = { train: trainLines.length, holdout: holdoutLines.length };
    console.log(`  ${domain}: ${trainLines.length} train / ${holdoutLines.length} holdout`);
  }

  return splits;
}

// --- Step 4: Upload and train domain adapters ---

async function stepTrainAdapter(
  domain: string,
  trainFile: string,
  trainCount: number,
): Promise<TrainingJob> {
  console.log(`\n  Training ${domain} adapter (${trainCount} examples)...`);

  if (!TOGETHER_API_KEY) {
    throw new Error('TOGETHER_API_KEY required');
  }

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would train ${domain}: ${trainCount} examples, ${EPOCHS} epochs`);
    return {
      domain,
      jobId: `dry-run-${domain}`,
      modelOutputName: `dry-run-model-${domain}`,
      status: 'dry-run',
      trainCount,
      holdoutCount: 0,
    };
  }

  // Stream-read file for upload (handles large files)
  const { readFileSync: readSync } = await import('node:fs');
  const content = readSync(trainFile, 'utf-8');

  // Upload
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([content], { type: 'application/jsonl' }),
    `${domain}-training.jsonl`,
  );
  formData.append('file_name', `arkova-nessie-${domain}-adapter.jsonl`);
  formData.append('purpose', 'fine-tune');

  const uploadRes = await fetch(`${TOGETHER_BASE_URL}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOGETHER_API_KEY}` },
    body: formData,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Upload failed for ${domain}: ${uploadRes.status} ${err}`);
  }

  const uploadData = (await uploadRes.json()) as { id: string };
  console.log(`  ${domain} uploaded: ${uploadData.id}`);

  // Adjust hyperparams based on domain size
  let domainEpochs = EPOCHS;
  let domainLR = LEARNING_RATE;

  if (trainCount < 5000) {
    domainEpochs = Math.max(EPOCHS, 8); // More epochs for small datasets
    domainLR = LEARNING_RATE * 2; // Higher LR for small datasets
    console.log(`  ${domain}: small dataset adjustments — epochs=${domainEpochs}, lr=${domainLR}`);
  } else if (trainCount > 100000) {
    domainEpochs = Math.min(EPOCHS, 3); // Fewer epochs for large datasets
    console.log(`  ${domain}: large dataset adjustments — epochs=${domainEpochs}`);
  }

  // Start fine-tune
  const ftRes = await fetch(`${TOGETHER_BASE_URL}/fine-tunes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOGETHER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      training_file: uploadData.id,
      model: BASE_MODEL,
      n_epochs: domainEpochs,
      n_checkpoints: Math.min(domainEpochs, 5),
      learning_rate: domainLR,
      batch_size: BATCH_SIZE,
      warmup_ratio: 0.1,
      lr_scheduler_type: 'cosine',
      suffix: `arkova-nessie-${domain}`,
    }),
  });

  if (!ftRes.ok) {
    const err = await ftRes.text();
    throw new Error(`Fine-tune creation failed for ${domain}: ${ftRes.status} ${err}`);
  }

  const ftData = (await ftRes.json()) as { id: string; status: string; model_output_name: string };
  console.log(`  ${domain} job created: ${ftData.id}`);
  console.log(`  ${domain} output model: ${ftData.model_output_name}`);

  return {
    domain,
    jobId: ftData.id,
    modelOutputName: ftData.model_output_name,
    status: ftData.status,
    trainCount,
    holdoutCount: 0,
  };
}

async function stepTrainAllAdapters(
  splits: Record<string, { train: number; holdout: number }>,
): Promise<TrainingJob[]> {
  console.log('\n--- Step 4: Train domain adapters ---');

  const jobs: TrainingJob[] = [];

  if (PARALLEL) {
    console.log('Training all domains in parallel...');
    const promises = Object.entries(splits).map(([domain, { train }]) => {
      const trainFile = resolve(DOMAIN_DIR, `${domain}-train-split.jsonl`);
      return stepTrainAdapter(domain, trainFile, train);
    });
    const results = await Promise.all(promises);
    jobs.push(...results);
  } else {
    for (const [domain, { train }] of Object.entries(splits)) {
      const trainFile = resolve(DOMAIN_DIR, `${domain}-train-split.jsonl`);
      const job = await stepTrainAdapter(domain, trainFile, train);
      jobs.push(job);

      // Small delay between job submissions
      if (!DRY_RUN) await delay(5000);
    }
  }

  return jobs;
}

// --- Step 5: Poll all jobs ---

async function stepPollAll(jobs: TrainingJob[]): Promise<TrainingJob[]> {
  console.log('\n--- Step 5: Polling all training jobs ---');

  if (DRY_RUN) {
    console.log('[DRY RUN] Skipping poll');
    return jobs;
  }

  if (!TOGETHER_API_KEY) throw new Error('TOGETHER_API_KEY required');

  const POLL_INTERVAL = 60_000;
  const MAX_POLLS = 720; // 12 hours
  const pending = new Set(jobs.map((j) => j.jobId));

  for (let i = 0; i < MAX_POLLS; i++) {
    if (pending.size === 0) break;

    await delay(POLL_INTERVAL);

    for (const job of jobs) {
      if (!pending.has(job.jobId)) continue;

      try {
        const res = await fetch(`${TOGETHER_BASE_URL}/fine-tunes/${job.jobId}`, {
          headers: { Authorization: `Bearer ${TOGETHER_API_KEY}` },
        });

        if (!res.ok) continue;

        const data = (await res.json()) as { status: string };
        job.status = data.status;

        if (data.status === 'completed' || data.status === 'succeeded') {
          console.log(`  [${Math.floor((i * POLL_INTERVAL) / 60000)}min] ${job.domain}: COMPLETED`);
          pending.delete(job.jobId);
        } else if (data.status === 'failed' || data.status === 'cancelled' || data.status === 'error') {
          console.log(`  [${Math.floor((i * POLL_INTERVAL) / 60000)}min] ${job.domain}: ${data.status.toUpperCase()}`);
          pending.delete(job.jobId);
        }
      } catch {
        // Retry next poll
      }
    }

    // Status update every 5 minutes
    if (i % 5 === 0) {
      const elapsed = Math.floor((i * POLL_INTERVAL) / 60000);
      const statuses = jobs.map((j) => `${j.domain}:${j.status}`).join(', ');
      console.log(`  [${elapsed}min] ${statuses} (${pending.size} pending)`);
    }
  }

  if (pending.size > 0) {
    console.log(`WARNING: ${pending.size} jobs still pending after 12 hours`);
  }

  return jobs;
}

// --- Step 6: Generate domain router config ---

function stepGenerateRouter(jobs: TrainingJob[]): void {
  console.log('\n--- Step 6: Generate domain router configuration ---');

  const completedJobs = jobs.filter(
    (j) => j.status === 'completed' || j.status === 'succeeded' || j.status === 'dry-run',
  );

  if (completedJobs.length === 0) {
    console.log('No completed jobs — skipping router generation');
    return;
  }

  // Generate router config
  const routerConfig = {
    version: 1,
    created: new Date().toISOString(),
    baseModel: BASE_MODEL,
    routingStrategy: 'classifier', // Will upgrade to 'molora' when >5 adapters
    defaultAdapter: 'academic', // Largest domain = safest default
    adapters: completedJobs.map((j) => ({
      domain: j.domain,
      label: DOMAINS[j.domain]?.label ?? j.domain,
      modelId: j.modelOutputName,
      trainCount: j.trainCount,
      keywords: getRouterKeywords(j.domain),
    })),
    classifierRules: [
      {
        credentialTypes: ['SEC_FILING'],
        fields: ['Securities', 'Exchange', 'financial', 'SEC', 'CIK', '10-K', '10-Q', '8-K'],
        adapter: 'sec',
      },
      {
        credentialTypes: ['LEGAL'],
        fields: ['Case Law', 'court', 'opinion', 'docket', 'habeas', 'plaintiff', 'defendant'],
        adapter: 'legal',
      },
      {
        credentialTypes: ['REGULATION', 'CERTIFICATE'],
        fields: ['Regulation', 'Federal', 'regulatory', 'CFR', 'rulemaking', 'agency'],
        adapter: 'regulatory',
      },
      {
        credentialTypes: ['PUBLICATION', 'PROFESSIONAL'],
        fields: ['Academic', 'Research', 'journal', 'DOI', 'ORCID', 'accreditation'],
        adapter: 'academic',
      },
    ],
  };

  const configPath = resolve(DOMAIN_DIR, 'router-config.json');
  writeFileSync(configPath, JSON.stringify(routerConfig, null, 2) + '\n');
  console.log(`Router config written: ${configPath}`);

  // Generate TypeScript router module
  const routerModule = `/**
 * Nessie Multi-LoRA Domain Router
 *
 * Routes queries to the appropriate domain-specific LoRA adapter
 * based on credential type and content keywords.
 *
 * Generated by nessie-multi-lora-pipeline.ts on ${new Date().toISOString()}
 *
 * Strategy: classifier-based routing (upgrade to MoLoRA per-token
 * routing when adapter count exceeds 5 domains).
 */

export interface DomainAdapter {
  domain: string;
  label: string;
  modelId: string;
}

export interface RouterConfig {
  adapters: Record<string, DomainAdapter>;
  defaultAdapter: string;
}

const ROUTER_CONFIG: RouterConfig = {
  defaultAdapter: '${routerConfig.defaultAdapter}',
  adapters: {
${completedJobs
  .map(
    (j) =>
      `    ${j.domain}: { domain: '${j.domain}', label: '${DOMAINS[j.domain]?.label ?? j.domain}', modelId: '${j.modelOutputName}' }`,
  )
  .join(',\n')},
  },
};

/** Keyword sets for classifier-based routing */
const DOMAIN_KEYWORDS: Record<string, Set<string>> = {
  sec: new Set(['sec', 'securities', 'exchange', 'cik', '10-k', '10-q', '8-k', 's-1', 'def 14a', 'filing', 'edgar', 'sarbanes', 'sox']),
  legal: new Set(['court', 'case law', 'opinion', 'docket', 'plaintiff', 'defendant', 'habeas', 'scotus', 'circuit', 'appellate', 'litigation']),
  regulatory: new Set(['regulation', 'federal register', 'cfr', 'rulemaking', 'agency', 'notice', 'proposed rule', 'compliance', 'acnc', 'charity']),
  academic: new Set(['publication', 'journal', 'research', 'doi', 'orcid', 'accreditation', 'degree', 'university', 'patent', 'grant']),
};

/**
 * Route a query to the appropriate domain adapter.
 *
 * Uses a two-pass classifier:
 * 1. Exact credential type match
 * 2. Keyword scoring from query text
 */
export function routeToDomain(
  credentialType?: string,
  queryText?: string,
): DomainAdapter {
  // Pass 1: Credential type match
  if (credentialType) {
    const ct = credentialType.toUpperCase();
    if (ct === 'SEC_FILING') return ROUTER_CONFIG.adapters.sec ?? getDefault();
    if (ct === 'LEGAL') return ROUTER_CONFIG.adapters.legal ?? getDefault();
    if (ct === 'REGULATION' || ct === 'CERTIFICATE') return ROUTER_CONFIG.adapters.regulatory ?? getDefault();
    if (ct === 'PUBLICATION' || ct === 'PROFESSIONAL') return ROUTER_CONFIG.adapters.academic ?? getDefault();
  }

  // Pass 2: Keyword scoring
  if (queryText) {
    const lower = queryText.toLowerCase();
    let bestDomain = ROUTER_CONFIG.defaultAdapter;
    let bestScore = 0;

    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestDomain = domain;
      }
    }

    if (bestScore > 0 && ROUTER_CONFIG.adapters[bestDomain]) {
      return ROUTER_CONFIG.adapters[bestDomain];
    }
  }

  return getDefault();
}

function getDefault(): DomainAdapter {
  return ROUTER_CONFIG.adapters[ROUTER_CONFIG.defaultAdapter] ?? {
    domain: 'base',
    label: 'Base Model',
    modelId: '${BASE_MODEL}',
  };
}

export { ROUTER_CONFIG };
`;

  const routerPath = resolve(DOMAIN_DIR, 'nessie-domain-router.ts');
  writeFileSync(routerPath, routerModule);
  console.log(`Router module written: ${routerPath}`);
}

function getRouterKeywords(domain: string): string[] {
  const kw: Record<string, string[]> = {
    sec: ['sec', 'securities', 'exchange', 'cik', '10-k', '10-q', 'filing', 'edgar'],
    legal: ['court', 'case law', 'opinion', 'docket', 'plaintiff', 'defendant', 'circuit'],
    regulatory: ['regulation', 'federal register', 'cfr', 'rulemaking', 'agency', 'compliance'],
    academic: ['publication', 'journal', 'research', 'doi', 'accreditation', 'degree', 'university'],
  };
  return kw[domain] ?? [];
}

// --- Step 7: Report ---

function stepReport(
  domainCounts: Record<string, number>,
  splits: Record<string, { train: number; holdout: number }>,
  jobs: TrainingJob[],
  startTime: number,
): void {
  console.log('\n========================================');
  console.log('  Nessie Multi-LoRA Training Report     ');
  console.log('========================================\n');

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);

  console.log(`Time elapsed:    ${elapsed} minutes`);
  console.log(`Base model:      ${BASE_MODEL}`);
  console.log(`Epochs:          ${EPOCHS}`);
  console.log(`Learning rate:   ${LEARNING_RATE}`);
  console.log(`Batch size:      ${BATCH_SIZE}`);
  console.log(`Synthetic:       ${ENABLE_SYNTHETIC}`);
  console.log('');

  console.log('Domain Adapters:');
  for (const job of jobs) {
    const split = splits[job.domain];
    console.log(`  ${job.domain}:`);
    console.log(`    Examples:     ${domainCounts[job.domain]}`);
    console.log(`    Train/Holdout:${split?.train ?? '?'} / ${split?.holdout ?? '?'}`);
    console.log(`    Job ID:       ${job.jobId}`);
    console.log(`    Model:        ${job.modelOutputName}`);
    console.log(`    Status:       ${job.status}`);
  }

  console.log('\nRouter config:');
  console.log(`  Strategy:  classifier-based (upgrade to MoLoRA at >5 adapters)`);
  console.log(`  Default:   academic`);
  console.log(`  Config:    ${resolve(DOMAIN_DIR, 'router-config.json')}`);
  console.log(`  Module:    ${resolve(DOMAIN_DIR, 'nessie-domain-router.ts')}`);

  console.log('\nNext steps:');
  console.log('  1. Monitor training jobs:');
  for (const job of jobs) {
    if (job.status !== 'dry-run') {
      console.log(`     curl -H "Authorization: Bearer $TOGETHER_API_KEY" https://api.together.xyz/v1/fine-tunes/${job.jobId}`);
    }
  }
  console.log('  2. After training, integrate router into NessieProvider');
  console.log('  3. Deploy adapters to RunPod vLLM (multi-LoRA serving)');
  console.log('  4. Run DPO training for citation accuracy (after SFT)');
  console.log('  5. Add synthetic compliance Q&A pairs for next round');
  console.log('');
}

// --- Main ---

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log('=== Nessie Multi-LoRA Domain Adapter Pipeline ===');
  console.log(`Date:         ${new Date().toISOString()}`);
  console.log(`Domains:      ${REQUESTED_DOMAINS.join(', ')}`);
  console.log(`Source:       ${SOURCE_FILE}`);
  console.log(`Max/domain:   ${MAX_PER_DOMAIN}`);
  console.log(`Min/domain:   ${MIN_PER_DOMAIN}`);
  console.log(`Synthetic:    ${ENABLE_SYNTHETIC}`);
  console.log(`Epochs:       ${EPOCHS}`);
  console.log(`LR:           ${LEARNING_RATE}`);
  console.log(`Batch size:   ${BATCH_SIZE}`);
  console.log(`Parallel:     ${PARALLEL}`);
  console.log(`Dry run:      ${DRY_RUN}`);

  // Step 1: Split data by domain
  let domainCounts: Record<string, number>;
  if (SKIP_SPLIT) {
    console.log('\n--- Step 1: SKIPPED (--skip-split) ---');
    domainCounts = {};
    for (const domain of REQUESTED_DOMAINS) {
      const file = resolve(DOMAIN_DIR, `${domain}-train.jsonl`);
      if (existsSync(file)) {
        // Count lines
        let count = 0;
        const rl = createInterface({
          input: createReadStream(file, { encoding: 'utf-8' }),
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          if (line.trim()) count++;
        }
        domainCounts[domain] = count;
        console.log(`  ${domain}: ${count} existing examples`);
      }
    }
  } else {
    domainCounts = await stepSplitByDomain();
  }

  // Step 2: Synthetic augmentation
  domainCounts = await stepSyntheticGeneration(domainCounts);

  // Step 3: Create holdout splits
  const splits = await stepCreateHoldouts();

  // Step 4: Train adapters
  const jobs = await stepTrainAllAdapters(splits);

  // Step 5: Poll for completion
  const completedJobs = await stepPollAll(jobs);

  // Step 6: Generate router
  stepGenerateRouter(completedJobs);

  // Step 7: Report
  stepReport(domainCounts, splits, completedJobs, startTime);
}

main().catch((err) => {
  console.error('\nPIPELINE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
