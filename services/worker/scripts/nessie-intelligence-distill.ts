#!/usr/bin/env tsx
/**
 * Nessie Intelligence Distillation Pipeline (NMT-07, Phase C)
 *
 * Uses Gemini as a teacher to generate intelligence training data from
 * public records. Produces compliance Q&A, risk analysis, recommendations,
 * and cross-reference examples with verified citations.
 *
 * This trains Nessie for its ACTUAL job: compliance intelligence engine.
 * NOT metadata extraction (that's Gemini Golden's job).
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/nessie-intelligence-distill.ts --dry-run
 *   npx tsx scripts/nessie-intelligence-distill.ts --limit 50
 *   npx tsx scripts/nessie-intelligence-distill.ts              # full run
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { GEMINI_GENERATION_MODEL } from '../src/ai/gemini-config.js';
dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

import {
  type IntelligenceTaskType,
  type IntelligenceQAPair,
  type IntelligenceContext,
  NESSIE_INTELLIGENCE_SYSTEM_PROMPT,
  TASK_PROMPTS,
  SEED_INTELLIGENCE_PAIRS,
  qaPairToTrainingExample,
  deduplicateExamples,
  validateExample,
  getDistributionStats,
} from '../src/ai/training/nessie-intelligence-data.js';

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 1000;
const OUTPUT_DIR = resolve(import.meta.dirname ?? '.', '../training-data/intelligence');

// --- Query Templates ---

interface QueryTemplate {
  taskType: IntelligenceTaskType;
  templates: string[];
}

const QUERY_TEMPLATES: QueryTemplate[] = [
  {
    taskType: 'compliance_qa',
    templates: [
      'What are the key compliance requirements disclosed in this document?',
      'Is this entity in good standing based on these filings?',
      'What regulatory obligations are described in this document?',
      'Does this document indicate any compliance deficiencies?',
      'What reporting requirements are established by this regulation?',
    ],
  },
  {
    taskType: 'risk_analysis',
    templates: [
      'Analyze this document for compliance risks and red flags.',
      'What potential fraud indicators exist in this credential?',
      'Identify any inconsistencies or suspicious elements in this filing.',
      'What risks should a compliance officer be aware of based on this document?',
      'Rate the risk level of this credential and explain your assessment.',
    ],
  },
  {
    taskType: 'document_summary',
    templates: [
      'Provide a compliance-focused summary of this document.',
      'What are the key takeaways from this filing for a compliance team?',
      'Summarize the regulatory significance of this document.',
      'What is the practical impact of this document on regulated entities?',
      'Distill the essential compliance information from this record.',
    ],
  },
  {
    taskType: 'recommendation',
    templates: [
      'Based on this document, what actions should a compliance team take?',
      'What steps should be taken to address the issues in this filing?',
      'Recommend a verification plan for this credential.',
      'What follow-up actions are needed based on this regulatory change?',
      'What should an organization do to stay compliant given this document?',
    ],
  },
  {
    taskType: 'cross_reference',
    templates: [
      'Cross-reference these documents for consistency and alignment.',
      'Do these credentials corroborate each other? Identify any conflicts.',
      'Compare the information in these documents and flag discrepancies.',
      'Verify that the timelines and facts across these documents are consistent.',
      'Assess whether these documents together form a complete compliance picture.',
    ],
  },
];

// --- Domain configurations ---

interface DomainConfig {
  domain: string;
  sources: string[];
  recordTypes: string[];
  targetCount: number;
}

const DOMAINS: DomainConfig[] = [
  { domain: 'sec', sources: ['edgar'], recordTypes: ['sec_filing'], targetCount: 200 },
  { domain: 'legal', sources: ['courtlistener'], recordTypes: ['court_opinion'], targetCount: 150 },
  { domain: 'regulatory', sources: ['federal_register'], recordTypes: ['notice', 'rule', 'proposed_rule'], targetCount: 150 },
  { domain: 'academic', sources: ['openalex'], recordTypes: ['article', 'book-chapter'], targetCount: 150 },
  { domain: 'education', sources: ['dapip'], recordTypes: ['accreditation'], targetCount: 50 },
];

// --- Gemini Teacher ---

async function callGeminiTeacher(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY required for distillation');

  const model = GEMINI_GENERATION_MODEL;
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const gemini = genAI.getGenerativeModel({
    model,
    systemInstruction: systemPrompt,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3,
    },
  });

  const response = await gemini.generateContent({
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
  });

  return response.response.text();
}

// --- Fetch public records from DB ---

async function fetchPublicRecords(
  source: string,
  recordTypes: string[],
  limit: number,
): Promise<IntelligenceContext[]> {
  // Dynamic import to handle missing deps gracefully in dry-run
  const { createClient } = await import('@supabase/supabase-js');
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }

  const db = createClient(supabaseUrl, supabaseKey);

  // Fetch records with content, preferring those with anchors.
  // eslint-disable-next-line arkova/missing-org-filter -- Offline intelligence distillation intentionally samples public records across organizations.
  const { data, error } = await db
    .from('public_records')
    .select('id, source, source_url, record_type, title, content_hash, metadata')
    .eq('source', source)
    .in('record_type', recordTypes)
    .not('title', 'is', null)
    .limit(limit)
    .order('created_at', { ascending: false });

  if (error) {
    console.error(`  Failed to fetch ${source} records:`, error.message);
    return [];
  }

  return (data ?? []).map((r) => {
    const meta = (r.metadata as Record<string, unknown>) ?? {};
    const content = (meta.abstract as string)
      ?? (meta.full_text as string)?.slice(0, 2000)
      ?? (meta.description as string)
      ?? `${r.record_type}: ${r.title ?? 'Untitled'}`;

    return {
      record_id: r.id,
      source: r.source,
      title: r.title ?? 'Untitled',
      record_type: r.record_type,
      content,
      content_hash: r.content_hash,
    };
  });
}

// --- Generate a single Q&A pair via Gemini teacher ---

async function generateQAPair(
  taskType: IntelligenceTaskType,
  query: string,
  context: IntelligenceContext[],
  domain: string,
  index: number,
): Promise<IntelligenceQAPair | null> {
  const systemPrompt = NESSIE_INTELLIGENCE_SYSTEM_PROMPT + TASK_PROMPTS[taskType];

  // Use short aliases (DOC-1, DOC-2) in the prompt so Gemini can cite them reliably.
  // Map back to real UUIDs after generation.
  const aliasMap = new Map<string, string>(); // alias -> real UUID
  const reverseMap = new Map<string, string>(); // real UUID -> alias
  context.forEach((doc, i) => {
    const alias = `DOC-${i + 1}`;
    aliasMap.set(alias, doc.record_id);
    reverseMap.set(doc.record_id, alias);
  });

  const contextBlock = context.map((doc, i) => {
    const alias = `DOC-${i + 1}`;
    return `--- DOCUMENT ${i + 1} ---
record_id: ${alias}
source: ${doc.source}
title: ${doc.title}
record_type: ${doc.record_type}
content_hash: ${doc.content_hash}
content: ${doc.content}`;
  }).join('\n\n');

  const userPrompt = `${query}

VERIFIED DOCUMENTS (${context.length} results):

${contextBlock}

Analyze these documents and respond. Use the record_id values (DOC-1, DOC-2, etc.) in your citations.`;

  try {
    const response = await callGeminiTeacher(systemPrompt, userPrompt);
    const parsed = JSON.parse(response) as {
      analysis: string;
      citations: Array<{ record_id: string; excerpt: string; source?: string }>;
      risks?: string[];
      recommendations?: string[];
      confidence: number;
      gaps?: string[];
    };

    // Map alias citations back to real UUIDs
    const mappedCitations = (parsed.citations ?? []).map((c) => ({
      ...c,
      record_id: aliasMap.get(c.record_id) ?? c.record_id,
    }));

    // Also remap aliases in the analysis text back to real UUIDs for training
    let mappedAnalysis = parsed.analysis;
    for (const [alias, realId] of aliasMap) {
      mappedAnalysis = mappedAnalysis.replaceAll(`[${alias}]`, `[${realId}]`);
    }

    // Validate citations reference actual context documents
    const validIds = new Set(context.map((c) => c.record_id));
    const validCitations = mappedCitations.filter((c) => validIds.has(c.record_id));

    if (validCitations.length === 0) {
      console.warn(`  [SKIP] No valid citations for ${taskType}/${domain}/${index}`);
      return null;
    }

    const id = `DIST-${domain.toUpperCase()}-${taskType.toUpperCase().replace('_', '')}-${String(index).padStart(4, '0')}`;

    return {
      id,
      taskType,
      domain,
      question: query,
      context,
      answer: mappedAnalysis,
      citations: validCitations.map((c) => ({
        record_id: c.record_id,
        excerpt: c.excerpt ?? '',
      })),
      confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.5)),
    };
  } catch (err) {
    console.warn(`  [ERROR] ${taskType}/${domain}/${index}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// --- Rate limiting ---

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log('=== Nessie Intelligence Distillation Pipeline ===');
  console.log(`Date:      ${new Date().toISOString()}`);
  console.log(`Dry run:   ${DRY_RUN}`);
  console.log(`Limit:     ${LIMIT} examples per domain`);
  console.log(`Output:    ${OUTPUT_DIR}`);
  console.log();

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Step 1: Start with seed pairs
  console.log('--- Step 1: Seed intelligence pairs ---');
  const allPairs: IntelligenceQAPair[] = [...SEED_INTELLIGENCE_PAIRS];
  console.log(`  ${allPairs.length} seed pairs loaded`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would fetch public records and generate intelligence pairs.');
    console.log(`Target: ${DOMAINS.reduce((s, d) => s + d.targetCount, 0)} examples across ${DOMAINS.length} domains`);
    console.log('\nDomain targets:');
    for (const domain of DOMAINS) {
      console.log(`  ${domain.domain}: ${domain.targetCount} examples from ${domain.sources.join(', ')}`);
    }
    console.log('\nTask types: compliance_qa, risk_analysis, document_summary, recommendation, cross_reference');
    console.log(`\nSeed pairs would produce ${allPairs.length} training examples.`);

    // Write seed-only output for validation
    const seedExamples = allPairs.map(qaPairToTrainingExample);
    const seedJsonl = seedExamples.map((ex) => JSON.stringify({ messages: ex.messages })).join('\n') + '\n';
    const seedFile = resolve(OUTPUT_DIR, 'intelligence-seed-only.jsonl');
    writeFileSync(seedFile, seedJsonl);
    console.log(`\nSeed examples written to: ${seedFile}`);

    const stats = getDistributionStats(seedExamples);
    console.log('\nSeed distribution:');
    for (const [type, stat] of Object.entries(stats)) {
      console.log(`  ${type}: ${stat.count} (${Object.entries(stat.domains).map(([d, c]) => `${d}:${c}`).join(', ')})`);
    }
    return;
  }

  // Step 2: Fetch public records per domain
  console.log('\n--- Step 2: Fetch public records ---');
  const domainRecords = new Map<string, IntelligenceContext[]>();

  for (const domain of DOMAINS) {
    const perSource = Math.ceil(domain.targetCount / domain.sources.length);
    let allRecords: IntelligenceContext[] = [];
    for (const source of domain.sources) {
      console.log(`  Fetching ${source} (${domain.domain})...`);
      const records = await fetchPublicRecords(source, domain.recordTypes, perSource * 2);
      allRecords = allRecords.concat(records);
      console.log(`    Got ${records.length} records`);
    }
    domainRecords.set(domain.domain, allRecords);
  }

  // Step 3: Generate intelligence pairs via Gemini teacher
  console.log('\n--- Step 3: Distill intelligence examples ---');

  const concurrency = parseInt(process.env.AI_BATCH_CONCURRENCY ?? '3', 10);
  let totalGenerated = 0;
  let totalFailed = 0;

  for (const domain of DOMAINS) {
    const records = domainRecords.get(domain.domain) ?? [];
    if (records.length === 0) {
      console.log(`  [SKIP] ${domain.domain}: no records available`);
      continue;
    }

    const domainLimit = Math.min(domain.targetCount, LIMIT);
    const queriesPerType = Math.ceil(domainLimit / QUERY_TEMPLATES.length);
    let domainGenerated = 0;

    console.log(`\n  ${domain.domain}: generating ${domainLimit} examples from ${records.length} records`);

    for (const template of QUERY_TEMPLATES) {
      for (let i = 0; i < queriesPerType && domainGenerated < domainLimit; i++) {
        // Select 1-3 random context documents
        const numDocs = template.taskType === 'cross_reference' ? Math.min(3, records.length) : 1;
        const shuffled = [...records].sort(() => Math.random() - 0.5);
        const contextDocs = shuffled.slice(0, numDocs);

        // Pick a random query from the template
        const query = template.templates[i % template.templates.length];

        const pair = await generateQAPair(
          template.taskType,
          query,
          contextDocs,
          domain.domain,
          totalGenerated + i,
        );

        if (pair) {
          allPairs.push(pair);
          domainGenerated++;
          totalGenerated++;
        } else {
          totalFailed++;
        }

        // Rate limit: ~20 requests/min for Gemini
        if ((totalGenerated + totalFailed) % concurrency === 0) {
          await delay(1000);
        }

        // Progress
        if (domainGenerated % 25 === 0 && domainGenerated > 0) {
          console.log(`    ${domain.domain}: ${domainGenerated}/${domainLimit} generated`);
        }
      }
    }

    console.log(`  ${domain.domain}: ${domainGenerated} generated, ${totalFailed} failed`);
  }

  // Step 4: Convert to training examples
  console.log('\n--- Step 4: Convert to training format ---');

  const examples = allPairs.map(qaPairToTrainingExample);

  // Validate all examples
  const validExamples = examples.filter((ex) => {
    const err = validateExample(ex);
    if (err) {
      console.warn(`  [INVALID] ${err}`);
      return false;
    }
    return true;
  });

  // Deduplicate
  const dedupedExamples = deduplicateExamples(validExamples);
  console.log(`  Total: ${examples.length}, Valid: ${validExamples.length}, After dedup: ${dedupedExamples.length}`);

  // Step 5: Split and export
  console.log('\n--- Step 5: Export training data ---');

  // 90/10 train/val split
  const shuffled = [...dedupedExamples].sort(() => Math.random() - 0.5);
  const valSize = Math.max(Math.floor(shuffled.length * 0.1), 5);
  const valExamples = shuffled.slice(0, valSize);
  const trainExamples = shuffled.slice(valSize);

  // Together AI format: JSONL with messages array
  const trainJsonl = trainExamples.map((ex) => JSON.stringify({ messages: ex.messages })).join('\n') + '\n';
  const valJsonl = valExamples.map((ex) => JSON.stringify({ messages: ex.messages })).join('\n') + '\n';

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const trainFile = resolve(OUTPUT_DIR, `intelligence-train-${timestamp}.jsonl`);
  const valFile = resolve(OUTPUT_DIR, `intelligence-val-${timestamp}.jsonl`);

  writeFileSync(trainFile, trainJsonl);
  writeFileSync(valFile, valJsonl);

  // Distribution stats
  const stats = getDistributionStats(dedupedExamples);

  console.log(`\n  Train: ${trainExamples.length} → ${trainFile}`);
  console.log(`  Val:   ${valExamples.length} → ${valFile}`);
  console.log('\n  Distribution:');
  for (const [type, stat] of Object.entries(stats)) {
    console.log(`    ${type}: ${stat.count} (${Object.entries(stat.domains).map(([d, c]) => `${d}:${c}`).join(', ')})`);
  }

  // Step 6: Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n========================================');
  console.log('  Intelligence Distillation Complete!');
  console.log('========================================');
  console.log(`  Time:         ${elapsed}s`);
  console.log(`  Generated:    ${totalGenerated} pairs`);
  console.log(`  Failed:       ${totalFailed} pairs`);
  console.log(`  Seed:         ${SEED_INTELLIGENCE_PAIRS.length} pairs`);
  console.log(`  Total valid:  ${dedupedExamples.length} examples`);
  console.log(`  Train/Val:    ${trainExamples.length}/${valExamples.length}`);
  console.log(`  Output:       ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error('\nPIPELINE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
