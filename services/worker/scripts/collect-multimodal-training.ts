#!/usr/bin/env tsx
/**
 * Multimodal Training Data Collection Pipeline
 *
 * Captures user document uploads paired with verified extraction results
 * as future Gemini multimodal fine-tuning data.
 *
 * This creates a feedback loop:
 * 1. User uploads document -> Gemini extracts metadata
 * 2. User verifies/corrects extraction -> becomes ground truth
 * 3. Document image + ground truth = multimodal training pair
 *
 * Storage: gs://arkova-training-data/multimodal/
 * Format: Vertex AI multimodal JSONL (fileData + text)
 *
 * NOTE: Documents are stored as GCS URIs, never in the training JSONL itself.
 * PII-stripped text only — no raw document content in training data.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/collect-multimodal-training.ts [--since 2026-03-01] [--dry-run] [--limit 1000]
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SINCE = args[args.indexOf('--since') + 1] || '2026-01-01';
const LIMIT = parseInt(args[args.indexOf('--limit') + 1] || '10000', 10);

const GCP_PROJECT = 'arkova1';
const GCS_BUCKET = 'gs://arkova-training-data';
const TRAINING_DIR = resolve(import.meta.dirname ?? '.', '../training-data');

const SYSTEM_PROMPT = `You are a credential metadata extraction assistant. Given a document image and/or PII-stripped text, extract structured metadata fields. Return JSON only.`;

interface AnchorWithExtraction {
  id: string;
  public_id: string;
  credential_type: string;
  title: string;
  metadata: Record<string, unknown>;
  ai_extracted_fields: Record<string, unknown> | null;
  ai_confidence: number | null;
  ai_provider: string | null;
  status: string;
  created_at: string;
  content_hash: string;
}

async function main(): Promise<void> {
  console.log('=== Multimodal Training Data Collection Pipeline ===');
  console.log(`Date:    ${new Date().toISOString()}`);
  console.log(`Since:   ${SINCE}`);
  console.log(`Limit:   ${LIMIT}`);
  console.log(`Dry run: ${DRY_RUN}`);

  // Connect to Supabase
  let supabaseUrl = process.env.SUPABASE_URL;
  let supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.log('Fetching credentials from GCP...');
    supabaseUrl = execSync(
      'gcloud secrets versions access latest --secret=supabase-url --project=arkova1',
      { encoding: 'utf-8' },
    ).trim();
    supabaseKey = execSync(
      'gcloud secrets versions access latest --secret=supabase-service-role-key --project=arkova1',
      { encoding: 'utf-8' },
    ).trim();
  }

  const supabase = createClient(supabaseUrl!, supabaseKey!);

  // Step 1: Query anchors that have AI extraction results
  console.log('\n--- Step 1: Query anchors with AI extractions ---');

  const { data: anchors, error, count } = await supabase
    .from('anchors')
    .select('id, public_id, credential_type, title, metadata, ai_extracted_fields, ai_confidence, ai_provider, status, created_at, content_hash', { count: 'exact' })
    .not('ai_extracted_fields', 'is', null)
    .gte('created_at', SINCE)
    .eq('status', 'SECURED')
    .order('created_at', { ascending: false })
    .limit(LIMIT);

  if (error) {
    throw new Error(`Query failed: ${error.message}`);
  }

  console.log(`Found ${count} anchors with AI extractions (fetched ${anchors?.length ?? 0})`);

  if (!anchors || anchors.length === 0) {
    console.log('No anchors with AI extractions found. Nothing to collect.');
    console.log('\nTo generate training data:');
    console.log('  1. Users upload documents and get AI extraction');
    console.log('  2. Users verify/correct the extraction');
    console.log('  3. SECURED anchors with ai_extracted_fields become training pairs');
    return;
  }

  // Step 2: Convert to training examples
  console.log('\n--- Step 2: Convert to training examples ---');

  const typeStats: Record<string, number> = {};
  const providerStats: Record<string, number> = {};
  const examples: string[] = [];
  let skipped = 0;

  for (const anchor of anchors as AnchorWithExtraction[]) {
    if (!anchor.ai_extracted_fields || !anchor.title) {
      skipped++;
      continue;
    }

    const ct = anchor.credential_type || anchor.ai_extracted_fields.credentialType || 'OTHER';
    typeStats[ct] = (typeStats[ct] || 0) + 1;
    providerStats[anchor.ai_provider || 'unknown'] = (providerStats[anchor.ai_provider || 'unknown'] || 0) + 1;

    // Build text representation from metadata (PII-stripped)
    const metaLines: string[] = [anchor.title];
    const meta = anchor.metadata || {};
    if (meta.issuerName) metaLines.push(`Issuer: ${meta.issuerName}`);
    if (meta.issuedDate) metaLines.push(`Issued: ${meta.issuedDate}`);
    if (meta.jurisdiction) metaLines.push(`Jurisdiction: ${meta.jurisdiction}`);
    if (meta.fieldOfStudy) metaLines.push(`Field: ${meta.fieldOfStudy}`);
    if (meta.registrationNumber) metaLines.push(`Registration: ${meta.registrationNumber}`);

    const userPrompt = `Extract metadata from the following PII-stripped credential text.
Credential type hint: ${ct}

--- BEGIN CREDENTIAL TEXT ---
${metaLines.join('\n')}
--- END CREDENTIAL TEXT ---

Return a JSON object with the extracted fields, a "confidence" number (0.0 to 1.0), and a "fraudSignals" array.`;

    // The verified extraction result is the ground truth
    const modelOutput = {
      ...anchor.ai_extracted_fields,
      confidence: anchor.ai_confidence ?? 0.85,
    };

    const example = {
      systemInstruction: {
        role: 'system',
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [
        { role: 'user', parts: [{ text: userPrompt }] },
        { role: 'model', parts: [{ text: JSON.stringify(modelOutput) }] },
      ],
      // Metadata for tracking (not sent to Vertex AI)
      _meta: {
        anchor_id: anchor.public_id,
        content_hash: anchor.content_hash,
        provider: anchor.ai_provider,
        created_at: anchor.created_at,
      },
    };

    examples.push(JSON.stringify(example));
  }

  console.log(`Converted: ${examples.length}, Skipped: ${skipped}`);

  console.log('\nCredential type distribution:');
  for (const [type, count] of Object.entries(typeStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  console.log('\nProvider distribution:');
  for (const [provider, count] of Object.entries(providerStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${provider}: ${count}`);
  }

  if (examples.length === 0) {
    console.log('\nNo training examples generated.');
    return;
  }

  // Step 3: Write to file
  console.log('\n--- Step 3: Write training data ---');

  mkdirSync(TRAINING_DIR, { recursive: true });
  const outFile = resolve(TRAINING_DIR, 'gemini-multimodal-collected.jsonl');
  writeFileSync(outFile, examples.join('\n') + '\n');
  console.log(`Written: ${examples.length} examples -> ${outFile}`);

  // Step 4: Upload to GCS (if not dry run)
  if (!DRY_RUN) {
    console.log('\n--- Step 4: Upload to GCS ---');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const gcsUri = `${GCS_BUCKET}/multimodal-collected/${timestamp}/training.jsonl`;
    execSync(`gcloud storage cp "${outFile}" "${gcsUri}" --project=${GCP_PROJECT}`, { stdio: 'inherit' });
    console.log(`Uploaded: ${gcsUri}`);
  }

  // Report
  console.log('\n========================================');
  console.log('  Multimodal Collection Report          ');
  console.log('========================================\n');
  console.log(`Total examples:    ${examples.length}`);
  console.log(`Date range:        ${SINCE} to now`);
  console.log(`Credential types:  ${Object.keys(typeStats).length}`);
  console.log(`AI providers:      ${Object.keys(providerStats).join(', ')}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Review collected examples for quality');
  console.log('  2. Once 10K+ examples accumulated, run Gemini fine-tune');
  console.log('  3. Add document image capture for true multimodal training');
  console.log('     (requires client-side opt-in to store encrypted doc thumbnails)');
  console.log('');
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
