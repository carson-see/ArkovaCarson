#!/usr/bin/env tsx
/**
 * Nessie v4 Training Data Pipeline (NMT-06)
 *
 * Builds high-quality training data by distilling from Gemini Golden (90.4% F1)
 * and validating against source metadata. Addresses three critical gaps:
 *
 * 1. Quality over quantity: Curated examples validated against source data
 * 2. Realistic confidence: Computed from extraction completeness, not hardcoded
 * 3. General data mix: 25% instruction data prevents catastrophic forgetting
 * 4. LoRA-appropriate hyperparameters: 2e-4 LR, rank 16, 2 epochs
 *
 * Strategy: "Distillation with validation"
 * - Use Gemini Golden (our best model) to extract from real public record text
 * - Validate extracted fields against source structured metadata
 * - Assign realistic confidence based on completeness
 * - Mix in general instruction data
 * - Export JSONL for Together AI fine-tuning
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/nessie-v4-pipeline.ts --domain sec --max-examples 500 --dry-run
 *   npx tsx scripts/nessie-v4-pipeline.ts --all-domains --max-examples 2000
 *   npx tsx scripts/nessie-v4-pipeline.ts --all-domains --max-examples 2000 --train
 *
 * Required env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional env: TOGETHER_API_KEY (for --train), GEMINI_TUNED_MODEL (for Golden)
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { GEMINI_DISTILLATION_MODEL } from '../src/ai/gemini-config.js';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

import {
  computeRealisticConfidence,
  deduplicateByContent,
  validateTrainingExample,
  buildDistillationPrompt,
  mixGeneralData,
  V4_TRAINING_DEFAULTS,
  V4_DOMAIN_CONFIGS,
  type V4TrainingExample,
} from '../src/ai/training/nessie-v4-data.js';

// --- CLI ---

const args = process.argv.slice(2);
function getFlag(name: string): boolean { return args.includes(`--${name}`); }
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const DOMAIN = getArg('domain', '');
const ALL_DOMAINS = getFlag('all-domains');
const MAX_EXAMPLES = parseInt(getArg('max-examples', '500'), 10);
const DRY_RUN = getFlag('dry-run');
const TRAIN = getFlag('train');
const CONCURRENCY = parseInt(getArg('concurrency', '5'), 10);
const SKIP_DISTILLATION = getFlag('skip-distillation');
const OUTPUT_DIR = resolve(import.meta.dirname ?? '.', '../training-data/v4');

// Credential type → domain mapping (inverse of V4_DOMAIN_CONFIGS)
const CREDENTIAL_TYPE_TO_DOMAIN: Record<string, string> = {};
for (const dc of V4_DOMAIN_CONFIGS) {
  for (const ct of dc.credentialTypes) {
    CREDENTIAL_TYPE_TO_DOMAIN[ct] = dc.domain;
  }
}

// Source → credential type mapping
const SOURCE_TO_CREDENTIAL_TYPE: Record<string, string> = {
  'sec_filing': 'SEC_FILING',
  'article': 'PUBLICATION',
  'notice': 'REGULATION',
  'rule': 'REGULATION',
  'proposed_rule': 'REGULATION',
  'presidential_document': 'REGULATION',
  'opinion': 'LEGAL',
  'court_opinion': 'LEGAL',
};

// Domain system prompts — domain-specific expertise instructions
const DOMAIN_SYSTEM_PROMPTS: Record<string, string> = {
  sec: `You are a securities compliance extraction specialist. You analyze SEC filings (10-K, 10-Q, 8-K, S-1, DEF 14A) and extract structured metadata with high precision.

You understand:
- SEC filing types and their purposes (annual reports, quarterly reports, material events)
- CIK numbers, SIC codes, and EDGAR filing conventions
- Financial terminology (EBITDA, MD&A, materiality, safe harbor)
- Risk factor analysis and Item-level document structure
- The difference between the filing entity and subsidiary entities

Extract metadata fields from PII-stripped text. Return valid JSON with: credentialType, issuerName, issuedDate, jurisdiction, fieldOfStudy, registrationNumber, accreditingBody, confidence (0.0-1.0), fraudSignals array.
Omit fields you cannot determine. Assess confidence honestly based on evidence available.`,

  legal: `You are a legal document analysis specialist. You analyze court opinions, case law, dockets, and litigation documents to extract structured metadata.

You understand:
- Federal vs state court systems and jurisdiction hierarchies
- Case citation formats (e.g., "347 U.S. 483 (1954)")
- Precedential vs non-precedential opinions
- Nature of suit codes and their meanings
- Court naming conventions (SCOTUS, Circuit Courts, District Courts)
- Legal terminology: stare decisis, certiorari, mandamus, habeas corpus

Extract metadata fields from PII-stripped text. Return valid JSON with: credentialType, issuerName, issuedDate, jurisdiction, fieldOfStudy, registrationNumber, accreditingBody, confidence (0.0-1.0), fraudSignals array.
Omit fields you cannot determine. Assess confidence honestly.`,

  regulatory: `You are a regulatory compliance extraction specialist. You analyze federal regulations, CFR entries, Federal Register notices, agency rules, and compliance documents.

You understand:
- Code of Federal Regulations (CFR) structure: titles, chapters, parts, sections
- Federal Register document types: rules, proposed rules, notices, presidential documents
- Agency abbreviations (EPA, FDA, SEC, FTC, OSHA, CFPB)
- Rulemaking process: NPRM, public comment, final rule
- Regulatory impact analysis and cost-benefit assessment
- Cross-references between regulations and enabling statutes

Extract metadata fields from PII-stripped text. Return valid JSON with: credentialType, issuerName, issuedDate, jurisdiction, fieldOfStudy, registrationNumber, accreditingBody, confidence (0.0-1.0), fraudSignals array.
Omit fields you cannot determine. Assess confidence honestly.`,

  academic: `You are an academic credential and research publication specialist. You analyze journal articles, conference papers, academic credentials, and accreditation documents.

You understand:
- DOI system and academic citation formats
- Journal impact factors and publication hierarchies
- Academic accreditation bodies (AACSB, ABET, regional accreditors)
- ORCID identifiers and author disambiguation
- Retraction notices and expression of concern patterns
- Open access vs subscription models

Extract metadata fields from PII-stripped text. Return valid JSON with: credentialType, issuerName, issuedDate, jurisdiction, fieldOfStudy, registrationNumber, accreditingBody, confidence (0.0-1.0), fraudSignals array.
Omit fields you cannot determine. Assess confidence honestly.`,
};

// ============================================================================
// DATA FETCHING
// ============================================================================

interface PublicRecord {
  id: string;
  source: string;
  record_type: string;
  title: string;
  metadata: Record<string, unknown>;
  content_hash: string;
}

function buildSourceText(record: PublicRecord): string {
  const meta = record.metadata;
  const lines: string[] = [record.title];

  // Build natural-looking document text from metadata
  // This creates text that looks more like real OCR'd documents
  // rather than structured metadata echo (the v3 mistake)
  if (meta.entity_name) lines.push(`Entity: ${meta.entity_name}`);
  if (meta.charity_legal_name) lines.push(`Organization: ${meta.charity_legal_name}`);
  if (meta.form_type) lines.push(`Form Type: ${meta.form_type}`);
  if (meta.filing_date) lines.push(`Filing Date: ${meta.filing_date}`);
  if (meta.publication_date) lines.push(`Date: ${meta.publication_date}`);
  if (meta.registration_date) lines.push(`Registered: ${meta.registration_date}`);
  if (meta.journal) lines.push(`Published in: ${meta.journal}`);
  if (meta.doi) lines.push(`DOI: ${meta.doi}`);
  if (meta.abn) lines.push(`ABN: ${meta.abn}`);
  if (meta.state) lines.push(`State: ${meta.state}`);
  if (meta.jurisdiction) lines.push(`Jurisdiction: ${meta.jurisdiction}`);
  if (meta.agencies && Array.isArray(meta.agencies)) lines.push(`Agency: ${(meta.agencies as string[]).join(', ')}`);
  if (meta.purposes && Array.isArray(meta.purposes)) lines.push(`Purpose: ${(meta.purposes as string[]).join('; ')}`);
  if (meta.accreditor) lines.push(`Accredited by: ${meta.accreditor}`);
  if (meta.institution_name) lines.push(`Institution: ${meta.institution_name}`);
  if (meta.document_number) lines.push(`Document No: ${meta.document_number}`);
  if (meta.file_description) lines.push(meta.file_description as string);
  if (meta.court_name) lines.push(`Court: ${meta.court_name}`);
  if (meta.case_name) lines.push(`Case: ${meta.case_name}`);
  if (meta.date_filed) lines.push(`Filed: ${meta.date_filed}`);
  if (meta.docket_number) lines.push(`Docket: ${meta.docket_number}`);
  if (meta.citations && Array.isArray(meta.citations)) lines.push(`Citation: ${(meta.citations as string[]).join('; ')}`);
  if (meta.nature_of_suit) lines.push(`Nature of Suit: ${meta.nature_of_suit}`);
  if (meta.precedential_status) lines.push(`Precedential Status: ${meta.precedential_status}`);
  if (meta.topics && Array.isArray(meta.topics)) lines.push(`Topics: ${(meta.topics as string[]).join(', ')}`);
  if (meta.authors && Array.isArray(meta.authors)) lines.push(`Authors: ${(meta.authors as string[]).join(', ')}`);

  return lines.join('\n');
}

function buildGroundTruthFields(record: PublicRecord): Record<string, unknown> {
  const meta = record.metadata;
  const credType = SOURCE_TO_CREDENTIAL_TYPE[record.record_type] || 'OTHER';
  const fields: Record<string, unknown> = { credentialType: credType };

  // Build ground truth from structured metadata
  // This is used to validate Gemini's extraction — NOT as training output
  switch (record.source) {
    case 'edgar':
      if (meta.entity_name) fields.issuerName = meta.entity_name;
      if (meta.filing_date) fields.issuedDate = meta.filing_date;
      if (meta.ciks) fields.registrationNumber = (meta.ciks as string[])[0];
      fields.jurisdiction = 'United States';
      fields.fieldOfStudy = 'Securities & Exchange';
      break;
    case 'openalex':
      if (meta.journal) fields.issuerName = meta.journal;
      else if (meta.authors) fields.issuerName = (meta.authors as string[])[0];
      if (meta.publication_date) fields.issuedDate = meta.publication_date;
      if (meta.doi) fields.registrationNumber = meta.doi;
      if (meta.topics && (meta.topics as string[]).length > 0) {
        fields.fieldOfStudy = (meta.topics as string[])[0];
      }
      break;
    case 'federal_register':
      if (meta.agencies && (meta.agencies as string[]).length > 0) {
        fields.issuerName = (meta.agencies as string[])[0];
      }
      if (meta.publication_date) fields.issuedDate = meta.publication_date;
      if (meta.document_number) fields.registrationNumber = meta.document_number;
      fields.jurisdiction = 'United States';
      break;
    case 'courtlistener':
      if (meta.court_name) fields.issuerName = meta.court_name;
      if (meta.date_filed) fields.issuedDate = meta.date_filed;
      if (meta.court_id) {
        const courtId = meta.court_id as string;
        fields.jurisdiction = ['scotus', 'ca1', 'ca2', 'ca3', 'ca4', 'ca5', 'ca6', 'ca7', 'ca8', 'ca9', 'ca10', 'ca11', 'cadc', 'cafc'].includes(courtId)
          ? 'United States (Federal)'
          : 'United States';
      }
      if (meta.nature_of_suit) fields.fieldOfStudy = meta.nature_of_suit;
      if (meta.citations && Array.isArray(meta.citations) && (meta.citations as string[]).length > 0) {
        fields.registrationNumber = (meta.citations as string[])[0];
      }
      break;
  }

  return fields;
}

async function fetchRecordsForDomain(
  supabase: SupabaseClient,
  domain: string,
  limit: number,
): Promise<PublicRecord[]> {
  const config = V4_DOMAIN_CONFIGS.find(d => d.domain === domain);
  if (!config) throw new Error(`Unknown domain: ${domain}`);

  // Map domain → record_types to query
  const recordTypeMap: Record<string, string[]> = {
    sec: ['sec_filing'],
    legal: ['opinion', 'court_opinion'],
    regulatory: ['notice', 'rule', 'proposed_rule', 'presidential_document'],
    academic: ['article'],
  };

  const recordTypes = recordTypeMap[domain] ?? [];
  if (recordTypes.length === 0) throw new Error(`No record types for domain: ${domain}`);

  const allRecords: PublicRecord[] = [];
  const pageSize = Math.min(limit, 1000);
  let offset = 0;

  while (allRecords.length < limit) {
    const { data, error } = await supabase
      .from('public_records')
      .select('id, source, record_type, title, metadata, content_hash')
      .in('record_type', recordTypes)
      .not('metadata', 'is', null)
      .not('title', 'is', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) throw new Error(`Query failed: ${error.message}`);
    if (!data || data.length === 0) break;

    // Filter for quality
    const quality = data.filter((r: PublicRecord) =>
      r.title && r.title.length >= 15 &&
      r.metadata && Object.keys(r.metadata).length >= 2
    );
    allRecords.push(...quality);
    offset += pageSize;

    if (data.length < pageSize) break; // No more data
  }

  return allRecords.slice(0, limit);
}

// ============================================================================
// GEMINI DISTILLATION
// ============================================================================

interface DistillationResult {
  record: PublicRecord;
  sourceText: string;
  geminiExtraction: Record<string, unknown> | null;
  groundTruth: Record<string, unknown>;
  validationScore: number;
  error?: string;
}

async function distillWithGemini(
  record: PublicRecord,
  domain: string,
): Promise<DistillationResult> {
  const sourceText = buildSourceText(record);
  const groundTruth = buildGroundTruthFields(record);
  const credType = SOURCE_TO_CREDENTIAL_TYPE[record.record_type] || 'OTHER';

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY required');

  const model = GEMINI_DISTILLATION_MODEL;

  const userPrompt = buildDistillationPrompt(sourceText, credType);
  const systemPrompt = DOMAIN_SYSTEM_PROMPTS[domain] ?? DOMAIN_SYSTEM_PROMPTS.sec;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        }),
      },
    );

    if (!response.ok) {
      const err = await response.text();
      return { record, sourceText, geminiExtraction: null, groundTruth, validationScore: 0, error: `API ${response.status}: ${err.substring(0, 200)}` };
    }

    const result = await response.json() as {
      candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    let text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    // Strip markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) text = jsonMatch[1].trim();

    const parsed = JSON.parse(text);

    // Validate extraction against ground truth
    const validationScore = computeValidationScore(parsed, groundTruth);

    return { record, sourceText, geminiExtraction: parsed, groundTruth, validationScore };
  } catch (err) {
    return {
      record, sourceText, geminiExtraction: null, groundTruth, validationScore: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Score how well Gemini's extraction matches ground truth metadata.
 * Used to filter out bad extractions before they become training data.
 *
 * Returns 0.0-1.0 where:
 * - 1.0 = all ground truth fields matched
 * - 0.0 = nothing matched
 */
function computeValidationScore(
  extraction: Record<string, unknown>,
  groundTruth: Record<string, unknown>,
): number {
  const gtFields = Object.keys(groundTruth).filter(k => k !== 'credentialType');
  if (gtFields.length === 0) return 0.5; // No ground truth to validate against

  let matches = 0;
  for (const field of gtFields) {
    const gtVal = String(groundTruth[field] ?? '').toLowerCase().trim();
    const exVal = String(extraction[field] ?? '').toLowerCase().trim();

    if (!gtVal) continue;

    // Exact match
    if (exVal === gtVal) { matches++; continue; }
    // Contained match (e.g., "Apple Inc." contains "Apple")
    if (exVal.includes(gtVal) || gtVal.includes(exVal)) { matches += 0.8; continue; }
    // Token overlap
    const gtTokens = new Set(gtVal.split(/\s+/).filter(t => t.length > 2));
    const exTokens = new Set(exVal.split(/\s+/).filter(t => t.length > 2));
    const overlap = [...gtTokens].filter(t => exTokens.has(t)).length;
    if (gtTokens.size > 0 && overlap / gtTokens.size >= 0.5) { matches += 0.5; }
  }

  return Math.min(1.0, matches / gtFields.length);
}

// ============================================================================
// TRAINING EXAMPLE CONSTRUCTION
// ============================================================================

function buildTrainingExample(
  result: DistillationResult,
  domain: string,
): V4TrainingExample | null {
  if (!result.geminiExtraction) return null;

  const extraction = result.geminiExtraction;
  const sourceText = result.sourceText;

  // Replace hardcoded confidence with realistic computed confidence
  const confidence = computeRealisticConfidence(extraction, sourceText);
  extraction.confidence = confidence;

  // Ensure fraudSignals exists
  if (!extraction.fraudSignals) extraction.fraudSignals = [];

  const systemPrompt = DOMAIN_SYSTEM_PROMPTS[domain] ?? DOMAIN_SYSTEM_PROMPTS.sec;
  const credType = extraction.credentialType || SOURCE_TO_CREDENTIAL_TYPE[result.record.record_type] || 'OTHER';

  const userPrompt = buildDistillationPrompt(sourceText, credType as string);

  const example: V4TrainingExample = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: JSON.stringify(extraction) },
    ],
    domain,
  };

  // Validate before returning
  if (!validateTrainingExample(example)) return null;

  return example;
}

// ============================================================================
// MAIN PIPELINE
// ============================================================================

async function main() {
  console.log('=== Nessie v4 Training Data Pipeline (NMT-06) ===');
  console.log(`Date:            ${new Date().toISOString()}`);
  console.log(`Mode:            ${DRY_RUN ? 'DRY RUN' : TRAIN ? 'EXPORT + TRAIN' : 'EXPORT ONLY'}`);
  console.log(`Max examples:    ${MAX_EXAMPLES} per domain`);
  console.log(`Concurrency:     ${CONCURRENCY}`);
  console.log(`General mix:     ${V4_TRAINING_DEFAULTS.generalDataMixRatio * 100}%`);
  console.log(`Learning rate:   ${V4_TRAINING_DEFAULTS.learningRate}`);
  console.log(`Epochs:          ${V4_TRAINING_DEFAULTS.epochs}`);
  console.log(`LoRA rank:       ${V4_TRAINING_DEFAULTS.loraRank} (alpha=${V4_TRAINING_DEFAULTS.loraAlpha})`);
  console.log('');

  // Determine which domains to process
  const domains = ALL_DOMAINS
    ? V4_DOMAIN_CONFIGS.map(d => d.domain)
    : DOMAIN ? [DOMAIN] : [];

  if (domains.length === 0) {
    console.error('ERROR: Specify --domain <name> or --all-domains');
    process.exit(1);
  }

  // Verify env
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY required for distillation');
    process.exit(1);
  }
  if (!DRY_RUN && !process.env.SUPABASE_URL) {
    console.error('ERROR: SUPABASE_URL required');
    process.exit(1);
  }
  if (TRAIN && !process.env.TOGETHER_API_KEY) {
    console.error('ERROR: TOGETHER_API_KEY required for --train');
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const supabase = !DRY_RUN
    ? createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    : null;

  let allExamples: V4TrainingExample[] = [];

  for (const domain of domains) {
    console.log(`\n--- Domain: ${domain.toUpperCase()} ---`);

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would fetch ${MAX_EXAMPLES} records for domain "${domain}"`);
      console.log(`[DRY RUN] Would distill with Gemini and validate against ground truth`);
      continue;
    }

    // Step 1: Fetch records
    console.log(`Fetching up to ${MAX_EXAMPLES} records...`);
    const records = await fetchRecordsForDomain(supabase!, domain, MAX_EXAMPLES * 2); // fetch 2x for filtering headroom
    console.log(`  Fetched ${records.length} quality records`);

    if (records.length === 0) {
      console.log(`  WARNING: No records found for domain "${domain}". Skipping.`);
      continue;
    }

    // Step 2: Distill with Gemini (batched)
    if (!SKIP_DISTILLATION) {
      console.log(`Distilling with Gemini (concurrency=${CONCURRENCY})...`);
      const examples: V4TrainingExample[] = [];
      let processed = 0;
      let errors = 0;
      let lowQuality = 0;

      // Process in batches
      const toProcess = records.slice(0, MAX_EXAMPLES * 1.5); // Process 1.5x to account for filtering
      for (let i = 0; i < toProcess.length && examples.length < MAX_EXAMPLES; i += CONCURRENCY) {
        const batch = toProcess.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(record => distillWithGemini(record, domain)),
        );

        for (const result of results) {
          processed++;

          if (result.error) {
            errors++;
            if (errors <= 3) console.log(`  Error: ${result.error.substring(0, 100)}`);
            continue;
          }

          // Filter by validation score — only keep high-quality extractions
          if (result.validationScore < 0.4) {
            lowQuality++;
            continue;
          }

          const example = buildTrainingExample(result, domain);
          if (example) examples.push(example);
        }

        process.stdout.write(`\r  Progress: ${processed}/${toProcess.length} → ${examples.length} valid examples (${errors} errors, ${lowQuality} low quality)`);

        // Rate limiting: 100ms between batches
        await new Promise(r => setTimeout(r, 100));
      }

      console.log('');
      console.log(`  Domain ${domain}: ${examples.length} valid examples from ${processed} processed`);
      allExamples.push(...examples);
    }
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Pipeline validated. Use without --dry-run to execute.');
    printConfig();
    return;
  }

  if (allExamples.length === 0) {
    console.log('\nNo examples generated. Check data availability and Gemini API.');
    return;
  }

  // Step 3: Deduplicate
  console.log(`\n--- Deduplication ---`);
  const before = allExamples.length;
  allExamples = deduplicateByContent(allExamples);
  console.log(`  ${before} → ${allExamples.length} (removed ${before - allExamples.length} duplicates)`);

  // Step 4: Mix general instruction data
  console.log(`\n--- General Data Mixing (${V4_TRAINING_DEFAULTS.generalDataMixRatio * 100}%) ---`);
  const mixed = mixGeneralData(allExamples, V4_TRAINING_DEFAULTS.generalDataMixRatio);
  const generalCount = mixed.filter(e => e.domain === 'general').length;
  console.log(`  ${allExamples.length} domain + ${generalCount} general = ${mixed.length} total`);

  // Step 5: Train/holdout split (90/10)
  const shuffled = [...mixed].sort(() => Math.random() - 0.5);
  const holdoutSize = Math.max(10, Math.min(500, Math.floor(shuffled.length * 0.1)));
  const holdout = shuffled.slice(0, holdoutSize);
  const train = shuffled.slice(holdoutSize);

  console.log(`\n--- Split ---`);
  console.log(`  Train: ${train.length} examples`);
  console.log(`  Holdout: ${holdout.length} examples`);

  // Step 6: Export JSONL
  const trainPath = resolve(OUTPUT_DIR, `nessie-v4-train.jsonl`);
  const holdoutPath = resolve(OUTPUT_DIR, `nessie-v4-holdout.jsonl`);

  // JSONL format: strip the 'domain' field (not part of Together AI format)
  const toJSONL = (examples: V4TrainingExample[]) =>
    examples.map(e => JSON.stringify({ messages: e.messages })).join('\n') + '\n';

  writeFileSync(trainPath, toJSONL(train));
  writeFileSync(holdoutPath, toJSONL(holdout));

  console.log(`\n--- Export ---`);
  console.log(`  Train: ${trainPath}`);
  console.log(`  Holdout: ${holdoutPath}`);

  // Step 7: Stats
  printStats(mixed);
  printConfig();

  // Step 8: Train (optional)
  if (TRAIN) {
    console.log(`\n--- Training on Together AI ---`);
    await submitTraining(trainPath);
  }

  console.log('\nDone.');
}

function printStats(examples: V4TrainingExample[]) {
  console.log(`\n--- Dataset Stats ---`);
  const byDomain: Record<string, number> = {};
  for (const e of examples) {
    byDomain[e.domain] = (byDomain[e.domain] || 0) + 1;
  }
  for (const [domain, count] of Object.entries(byDomain).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / examples.length) * 100).toFixed(1);
    console.log(`  ${domain.padEnd(15)} ${String(count).padStart(5)} (${pct}%)`);
  }

  // Confidence distribution
  const confs: number[] = [];
  for (const e of examples) {
    try {
      const assistant = e.messages.find(m => m.role === 'assistant')?.content;
      if (assistant) {
        const parsed = JSON.parse(assistant);
        if (typeof parsed.confidence === 'number') confs.push(parsed.confidence);
      }
    } catch { /* skip */ }
  }
  if (confs.length > 0) {
    const mean = confs.reduce((a, b) => a + b, 0) / confs.length;
    const min = Math.min(...confs);
    const max = Math.max(...confs);
    console.log(`\n  Confidence: mean=${mean.toFixed(3)} min=${min.toFixed(2)} max=${max.toFixed(2)}`);
    const low = confs.filter(c => c < 0.5).length;
    const med = confs.filter(c => c >= 0.5 && c < 0.8).length;
    const high = confs.filter(c => c >= 0.8).length;
    console.log(`  Distribution: low(<0.5)=${low} med(0.5-0.8)=${med} high(>0.8)=${high}`);
  }
}

function printConfig() {
  console.log(`\n--- v4 Training Config (per best practices doc) ---`);
  console.log(`  Base model:      ${V4_TRAINING_DEFAULTS.baseModel}`);
  console.log(`  Learning rate:   ${V4_TRAINING_DEFAULTS.learningRate} (v3 was 5e-6 — 40x too low)`);
  console.log(`  Epochs:          ${V4_TRAINING_DEFAULTS.epochs} (v3 was 4 — risk of overfitting)`);
  console.log(`  LoRA rank:       ${V4_TRAINING_DEFAULTS.loraRank} (alpha=${V4_TRAINING_DEFAULTS.loraAlpha})`);
  console.log(`  Target modules:  ${V4_TRAINING_DEFAULTS.loraTargetModules.join(', ')}`);
  console.log(`  Precision:       ${V4_TRAINING_DEFAULTS.precision}`);
  console.log(`  LR scheduler:    ${V4_TRAINING_DEFAULTS.lrScheduler} (warmup=${V4_TRAINING_DEFAULTS.warmupRatio})`);
  console.log(`  Max grad norm:   ${V4_TRAINING_DEFAULTS.maxGradNorm}`);
  console.log(`  Batch size:      ${V4_TRAINING_DEFAULTS.batchSize} × ${V4_TRAINING_DEFAULTS.gradientAccumulationSteps} = ${V4_TRAINING_DEFAULTS.batchSize * V4_TRAINING_DEFAULTS.gradientAccumulationSteps} effective`);
  console.log(`  General mix:     ${V4_TRAINING_DEFAULTS.generalDataMixRatio * 100}%`);
}

async function submitTraining(trainPath: string) {
  const apiKey = process.env.TOGETHER_API_KEY!;

  // Upload file
  console.log('  Uploading training file...');
  const formData = new FormData();
  const fileContent = readFileSync(trainPath, 'utf-8');
  formData.append('file', new Blob([fileContent]), 'nessie-v4-train.jsonl');
  formData.append('purpose', 'fine-tune');

  const uploadRes = await fetch('https://api.together.xyz/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`File upload failed: ${err}`);
  }

  const uploadData = await uploadRes.json() as { id: string };
  console.log(`  File uploaded: ${uploadData.id}`);

  // Create fine-tune job
  console.log('  Creating fine-tune job...');
  const ftRes = await fetch('https://api.together.xyz/v1/fine-tunes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      training_file: uploadData.id,
      model: V4_TRAINING_DEFAULTS.baseModel,
      n_epochs: V4_TRAINING_DEFAULTS.epochs,
      learning_rate: V4_TRAINING_DEFAULTS.learningRate,
      batch_size: V4_TRAINING_DEFAULTS.batchSize * V4_TRAINING_DEFAULTS.gradientAccumulationSteps,
      warmup_ratio: V4_TRAINING_DEFAULTS.warmupRatio,
      suffix: 'arkova-nessie-v4',
      lora: true,
      lora_r: V4_TRAINING_DEFAULTS.loraRank,
      lora_alpha: V4_TRAINING_DEFAULTS.loraAlpha,
      lora_dropout: V4_TRAINING_DEFAULTS.loraDropout,
    }),
  });

  if (!ftRes.ok) {
    const err = await ftRes.text();
    throw new Error(`Fine-tune creation failed: ${err}`);
  }

  const ftData = await ftRes.json() as { id: string };
  console.log(`  Fine-tune job created: ${ftData.id}`);
  console.log(`  Monitor: https://api.together.xyz/v1/fine-tunes/${ftData.id}`);
}

main().catch(err => {
  console.error('\nPipeline failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
