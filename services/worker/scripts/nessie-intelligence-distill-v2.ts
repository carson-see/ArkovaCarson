#!/usr/bin/env tsx
/**
 * Nessie Intelligence Distillation Pipeline v2 (NMT-11)
 *
 * Uses Gemini Golden as teacher to generate 500+ intelligence training
 * examples from real public records. Covers all 5 intelligence task types:
 *   1. compliance_qa       — Answer compliance questions
 *   2. risk_analysis       — Identify risks/red flags
 *   3. document_summary    — Summarize for compliance context
 *   4. recommendation      — Recommend actions
 *   5. cross_reference     — Cross-reference multiple docs
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/nessie-intelligence-distill-v2.ts
 *   npx tsx scripts/nessie-intelligence-distill-v2.ts --dry-run
 *   npx tsx scripts/nessie-intelligence-distill-v2.ts --target 100
 *
 * Output: training-data/nessie-intelligence-v2.jsonl
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

import {
  type IntelligenceTaskType,
  type IntelligenceTrainingExample,
  type IntelligenceQAPair,
  type IntelligenceContext,
  NESSIE_INTELLIGENCE_SYSTEM_PROMPT,
  TASK_PROMPTS,
  qaPairToTrainingExample,
  deduplicateExamples,
  validateExample,
  getDistributionStats,
  SEED_INTELLIGENCE_PAIRS,
} from '../src/ai/training/nessie-intelligence-data.js';

// --- CLI ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TARGET_PER_TYPE = parseInt(
  args[args.indexOf('--target') + 1] || '100',
  10,
);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY && !DRY_RUN) {
  console.error('Error: GEMINI_API_KEY not set');
  process.exit(1);
}

const OUTPUT_PATH = resolve(
  import.meta.dirname ?? '.',
  '../training-data/nessie-intelligence-v2.jsonl',
);

// ============================================================================
// QUESTION TEMPLATES BY TASK TYPE
// ============================================================================

const QUESTION_TEMPLATES: Record<IntelligenceTaskType, string[]> = {
  compliance_qa: [
    'Is this organization in compliance with {regulation} requirements?',
    'What are the compliance obligations arising from this {docType}?',
    'Does this {docType} satisfy the requirements under {regulation}?',
    'What regulatory deadlines or obligations does this document create?',
    'Are there any compliance gaps evident from this filing?',
    'What disclosure requirements apply to this entity based on this document?',
    'Has this entity met its reporting obligations under {regulation}?',
    'What penalties or consequences could arise from non-compliance with this filing?',
    'Does this credential meet the minimum requirements for {jurisdiction} licensure?',
    'What continuing education obligations does this license create?',
  ],
  risk_analysis: [
    'What compliance risks are evident in this credential?',
    'Are there any red flags or fraud indicators in this document?',
    'Assess the validity and risk level of this {docType}.',
    'What suspicious patterns exist in this credential\'s timeline?',
    'Rate the overall risk level of accepting this credential at face value.',
    'Are there issuer inconsistencies or verification concerns?',
    'What due diligence steps should be taken given the risks identified?',
    'Is there evidence of document tampering or misrepresentation?',
    'What jurisdictional risks exist with this cross-border credential?',
    'Are the accreditation claims in this document verifiable?',
  ],
  document_summary: [
    'Summarize this {docType} for a compliance review.',
    'What are the key provisions and obligations in this document?',
    'Provide a compliance-focused summary of this filing.',
    'What is the regulatory significance of this document?',
    'Summarize the credential details and verification status.',
    'What are the material facts in this {docType}?',
    'Provide a brief for the compliance team on this document.',
    'What does this document tell us about the entity\'s regulatory standing?',
    'Summarize the key dates, obligations, and status from this credential.',
    'Extract the actionable compliance information from this document.',
  ],
  recommendation: [
    'What actions should the compliance team take based on this document?',
    'What verification steps are needed for this credential?',
    'Recommend next steps for processing this {docType}.',
    'What risk mitigation measures should be implemented?',
    'Based on the identified gaps, what corrective actions are needed?',
    'What monitoring should be put in place after accepting this credential?',
    'Recommend a verification workflow for this type of credential.',
    'What escalation actions are warranted given these findings?',
    'How should this credential be weighted in the overall assessment?',
    'What additional documents should be requested to resolve the identified issues?',
  ],
  cross_reference: [
    'Cross-reference these credentials for consistency.',
    'Do the dates and details align across these documents?',
    'Are there contradictions between these credential records?',
    'Verify the issuer claims match between these documents.',
    'Check the jurisdiction and timeline consistency across these records.',
    'Do these documents corroborate or contradict each other?',
    'Assess whether the credential chain is complete and consistent.',
    'Are the qualification claims supported across all documents?',
    'Identify any gaps or overlaps in the timeline across these records.',
    'Do the organizational affiliations match across documents?',
  ],
};

const DOC_TYPES = ['SEC filing', 'court opinion', 'regulation', 'credential', 'license', 'degree', 'certificate', 'accreditation report'];
const REGULATIONS = ['SEC Rule 10b-5', 'FCRA Section 605', 'FERPA', 'SOX Section 302', 'ADA Title III', 'HIPAA Privacy Rule', '34 CFR Part 602', 'state licensing statute'];
const JURISDICTIONS = ['California', 'New York', 'Texas', 'United Kingdom', 'Australia', 'Canada', 'federal'];

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fillTemplate(template: string): string {
  return template
    .replace('{docType}', pickRandom(DOC_TYPES))
    .replace('{regulation}', pickRandom(REGULATIONS))
    .replace('{jurisdiction}', pickRandom(JURISDICTIONS));
}

// ============================================================================
// GEMINI TEACHER CALL
// ============================================================================

interface GeminiResponse {
  analysis: string;
  citations: Array<{ record_id: string; source?: string; excerpt: string }>;
  risks: string[];
  recommendations: string[];
  confidence: number;
  gaps: string[];
}

async function callGeminiTeacher(
  taskType: IntelligenceTaskType,
  question: string,
  context: IntelligenceContext[],
): Promise<GeminiResponse | null> {
  const taskPrompt = TASK_PROMPTS[taskType];
  const systemPrompt = NESSIE_INTELLIGENCE_SYSTEM_PROMPT + taskPrompt;

  const contextBlock = context.map((doc, i) =>
    `--- DOCUMENT ${i + 1} ---\nrecord_id: ${doc.record_id}\nsource: ${doc.source}\ntitle: ${doc.title}\nrecord_type: ${doc.record_type}\ncontent: ${doc.content}`,
  ).join('\n\n');

  const userMessage = `${question}\n\nVERIFIED DOCUMENTS (${context.length} results):\n\n${contextBlock}\n\nAnalyze these documents and respond.`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userMessage }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 2048,
          },
        }),
      },
    );

    if (!resp.ok) {
      console.error(`  Gemini API error: ${resp.status}`);
      return null;
    }

    const data = await resp.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    return JSON.parse(jsonMatch[0]) as GeminiResponse;
  } catch (err) {
    console.error(`  Gemini call failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ============================================================================
// SYNTHETIC CONTEXT GENERATION
// ============================================================================

/**
 * Generate synthetic document contexts for training.
 * In production, these would come from real public records in Supabase.
 * For now, we generate realistic synthetic contexts.
 */
function generateSyntheticContexts(taskType: IntelligenceTaskType, count: number): IntelligenceContext[][] {
  const contexts: IntelligenceContext[][] = [];

  const templates = [
    {
      source: 'edgar',
      record_type: 'sec_filing',
      titleTemplate: '10-K Annual Report — FY {year}',
      contentTemplate: 'UNITED STATES SECURITIES AND EXCHANGE COMMISSION. Form 10-K. Annual Report for fiscal year ended December 31, {year}. Registrant: [ORG_REDACTED]. Commission File Number: 001-{num}. Total Revenue: ${revenue}M. Net Income: ${income}M. Total Assets: ${assets}M. The registrant has filed all reports required by Section 13 or 15(d) of the Securities Exchange Act.',
    },
    {
      source: 'courtlistener',
      record_type: 'court_opinion',
      titleTemplate: '{plaintiff} v. {defendant}, {year} WL {num}',
      contentTemplate: 'OPINION OF THE COURT. {plaintiff} v. {defendant}. This matter comes before the court on {motion}. The court finds that the {entity} {finding}. HELD: {holding}.',
    },
    {
      source: 'federal_register',
      record_type: 'regulation',
      titleTemplate: 'Final Rule: {title}',
      contentTemplate: 'DEPARTMENT OF {dept}. {cfr} CFR Part {part}. Final Rule. Effective Date: {date}. Summary: This rule {summary}. Compliance Required By: {deadline}.',
    },
    {
      source: 'user_upload',
      record_type: 'credential',
      titleTemplate: '{credType} — {field}',
      contentTemplate: '{issuer}. {credType} Certificate. Issued to: [NAME_REDACTED]. Date: {date}. {additionalInfo}',
    },
  ];

  for (let i = 0; i < count; i++) {
    const numDocs = taskType === 'cross_reference' ? 2 + Math.floor(Math.random() * 2) : 1 + Math.floor(Math.random() * 2);
    const docs: IntelligenceContext[] = [];

    for (let d = 0; d < numDocs; d++) {
      const tmpl = pickRandom(templates);
      const id = `PR-${tmpl.source.toUpperCase().slice(0, 3)}-${String(i * 10 + d + 1).padStart(4, '0')}`;
      const year = 2023 + Math.floor(Math.random() * 3);

      let content = tmpl.contentTemplate
        .replace(/{year}/g, String(year))
        .replace('{num}', String(10000 + Math.floor(Math.random() * 90000)))
        .replace('{revenue}', String(100 + Math.floor(Math.random() * 9900)))
        .replace('{income}', String(10 + Math.floor(Math.random() * 500)))
        .replace('{assets}', String(500 + Math.floor(Math.random() * 50000)))
        .replace('{plaintiff}', '[NAME_REDACTED]')
        .replace('{defendant}', pickRandom(['Board of Professional Engineers', 'Department of Education', 'State Bar', 'Medical Board']))
        .replace('{motion}', pickRandom(['motion for summary judgment', 'petition for review', 'appeal from final order']))
        .replace('{entity}', pickRandom(['respondent', 'petitioner', 'licensee']))
        .replace('{finding}', pickRandom(['failed to maintain required credentials', 'was in substantial compliance', 'violated professional conduct rules']))
        .replace('{holding}', pickRandom(['The revocation is affirmed', 'The license suspension is reversed', 'Remanded for further proceedings']))
        .replace('{dept}', pickRandom(['EDUCATION', 'HEALTH AND HUMAN SERVICES', 'LABOR', 'COMMERCE']))
        .replace('{cfr}', String(20 + Math.floor(Math.random() * 30)))
        .replace('{part}', String(100 + Math.floor(Math.random() * 900)))
        .replace('{date}', `${['January', 'April', 'July', 'October'][Math.floor(Math.random() * 4)]} 1, ${year}`)
        .replace('{summary}', pickRandom(['amends accreditation standards', 'updates continuing education requirements', 'establishes new reporting obligations']))
        .replace('{deadline}', `${['June', 'September', 'December'][Math.floor(Math.random() * 3)]} 30, ${year + 1}`)
        .replace('{issuer}', pickRandom(['State Board of Accountancy', 'California Board of Registered Nursing', 'ABET', 'PMI']))
        .replace('{credType}', pickRandom(['Professional License', 'Board Certification', 'Program Accreditation']))
        .replace('{field}', pickRandom(['Accounting', 'Nursing', 'Engineering', 'Project Management']))
        .replace('{additionalInfo}', pickRandom(['Status: Active. Expires: December 2026.', 'Accreditation Cycle: 2024-2030.', 'License in good standing.']));

      docs.push({
        record_id: id,
        source: tmpl.source,
        title: tmpl.titleTemplate
          .replace('{year}', String(year))
          .replace('{plaintiff}', '[NAME_REDACTED]')
          .replace('{defendant}', 'Board of Professional Engineers')
          .replace('{num}', String(10000 + Math.floor(Math.random() * 90000)))
          .replace('{title}', pickRandom(['Amendments to Accreditation Standards', 'Updated Licensing Requirements']))
          .replace('{credType}', pickRandom(['Professional License', 'Board Certification']))
          .replace('{field}', pickRandom(['Accounting', 'Nursing'])),
        record_type: tmpl.record_type,
        content,
        content_hash: createHash('sha256').update(content).digest('hex').slice(0, 12),
      });
    }

    contexts.push(docs);
  }

  return contexts;
}

// ============================================================================
// MAIN PIPELINE
// ============================================================================

async function main() {
  console.log('=== Nessie Intelligence Distillation v2 (NMT-11) ===\n');
  console.log(`Target: ${TARGET_PER_TYPE} examples per task type (${TARGET_PER_TYPE * 5} total)`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('');

  const allExamples: IntelligenceTrainingExample[] = [];
  const taskTypes: IntelligenceTaskType[] = [
    'compliance_qa', 'risk_analysis', 'document_summary', 'recommendation', 'cross_reference',
  ];

  // Step 1: Convert seed pairs to training examples
  console.log('Step 1: Converting seed pairs...');
  for (const pair of SEED_INTELLIGENCE_PAIRS) {
    allExamples.push(qaPairToTrainingExample(pair));
  }
  console.log(`  ${allExamples.length} seed examples loaded.\n`);

  // Step 2: Load existing examples if output file exists
  if (existsSync(OUTPUT_PATH)) {
    console.log('Step 2: Loading existing examples...');
    const existing = readFileSync(OUTPUT_PATH, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as IntelligenceTrainingExample);
    allExamples.push(...existing);
    console.log(`  ${existing.length} existing examples loaded.\n`);
  }

  // Step 3: Generate new examples per task type
  for (const taskType of taskTypes) {
    const existingCount = allExamples.filter(e => e.taskType === taskType).length;
    const needed = Math.max(0, TARGET_PER_TYPE - existingCount);

    console.log(`\nStep 3 [${taskType}]: Need ${needed} more (have ${existingCount}/${TARGET_PER_TYPE})`);

    if (needed === 0 || DRY_RUN) {
      if (DRY_RUN && needed > 0) {
        console.log(`  [DRY RUN] Would generate ${needed} examples for ${taskType}`);
      }
      continue;
    }

    const templates = QUESTION_TEMPLATES[taskType];
    const contextSets = generateSyntheticContexts(taskType, needed);

    for (let i = 0; i < needed; i++) {
      const question = fillTemplate(pickRandom(templates));
      const context = contextSets[i];

      process.stdout.write(`  Distilling ${i + 1}/${needed}...`);

      const response = await callGeminiTeacher(taskType, question, context);

      if (!response) {
        console.log(' SKIP (teacher failed)');
        continue;
      }

      // Build training example
      const pair: IntelligenceQAPair = {
        id: `DISTILL-${taskType}-${String(i + 1).padStart(4, '0')}`,
        taskType,
        domain: context[0]?.source === 'edgar' ? 'sec'
          : context[0]?.source === 'courtlistener' ? 'legal'
          : context[0]?.source === 'federal_register' ? 'regulatory'
          : 'professional',
        question,
        context,
        answer: response.analysis,
        citations: response.citations.map(c => ({
          record_id: c.record_id,
          excerpt: c.excerpt,
        })),
        confidence: response.confidence,
      };

      const example = qaPairToTrainingExample(pair);
      const error = validateExample(example);

      if (error) {
        console.log(` INVALID (${error})`);
        continue;
      }

      allExamples.push(example);
      console.log(' OK');

      // Rate limiting — 1 req/sec to stay within Gemini quota
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Step 4: Deduplicate
  console.log('\nStep 4: Deduplicating...');
  const deduped = deduplicateExamples(allExamples);
  console.log(`  ${allExamples.length} → ${deduped.length} after dedup`);

  // Step 5: Show distribution
  console.log('\nStep 5: Distribution:');
  const stats = getDistributionStats(deduped);
  for (const [type, stat] of Object.entries(stats)) {
    console.log(`  ${type}: ${stat.count} examples (domains: ${JSON.stringify(stat.domains)})`);
  }

  // Step 6: Export
  if (!DRY_RUN) {
    console.log(`\nStep 6: Exporting to ${OUTPUT_PATH}...`);
    const dir = resolve(OUTPUT_PATH, '..');
    mkdirSync(dir, { recursive: true });
    const jsonl = deduped.map(e => JSON.stringify(e)).join('\n');
    writeFileSync(OUTPUT_PATH, jsonl);
    console.log(`  ${deduped.length} examples exported.`);
  } else {
    console.log(`\n[DRY RUN] Would export ${deduped.length} examples to ${OUTPUT_PATH}`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
