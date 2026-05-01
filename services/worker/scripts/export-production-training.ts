#!/usr/bin/env tsx
/**
 * Production Training Data Export for Nessie Fine-Tuning
 *
 * Pulls all public_records from production Supabase (with metadata),
 * formats as instruction-tuning JSONL for Together AI fine-tuning.
 *
 * Usage:
 *   cd services/worker
 *   SUPABASE_URL=<prod-url> SUPABASE_SERVICE_ROLE_KEY=<prod-key> npx tsx scripts/export-production-training.ts
 *
 * Or with GCP Secret Manager (auto-fetches creds):
 *   npx tsx scripts/export-production-training.ts --from-gcp
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const OUTPUT_PATH = resolve(import.meta.dirname ?? '.', '../training-data/finetune-server-8b.jsonl');
const PAGE_SIZE = 1000;

// Credential type mapping from record_type/source to our types
const SOURCE_TO_CREDENTIAL_TYPE: Record<string, string> = {
  'sec_filing': 'SEC_FILING',
  'article': 'PUBLICATION',
  'notice': 'REGULATION',
  'rule': 'REGULATION',
  'proposed_rule': 'REGULATION',
  'presidential_document': 'REGULATION',
  'accreditation': 'PROFESSIONAL',
  'charity_registration': 'CERTIFICATE',
  'opinion': 'LEGAL',
  'court_opinion': 'LEGAL',
};

interface PublicRecord {
  id: string;
  source: string;
  record_type: string;
  title: string;
  metadata: Record<string, unknown>;
  content_hash: string;
}

function getCredentialType(record: PublicRecord): string {
  return SOURCE_TO_CREDENTIAL_TYPE[record.record_type] || 'OTHER';
}

/**
 * Build the "extracted fields" ground truth from the record's metadata.
 * This is what we want Nessie to learn to produce.
 */
function buildExtractedFields(record: PublicRecord): Record<string, unknown> {
  const meta = record.metadata;
  const credType = getCredentialType(record);
  const fields: Record<string, unknown> = {
    credentialType: credType,
    confidence: 0.92, // High confidence since these are structured pipeline records
  };

  // Common fields
  if (meta.entity_name) fields.issuerName = meta.entity_name;
  if (meta.charity_legal_name) fields.issuerName = meta.charity_legal_name;
  if (meta.jurisdiction) fields.jurisdiction = meta.jurisdiction;

  // Source-specific extraction
  switch (record.source) {
    case 'edgar':
      if (meta.entity_name) fields.issuerName = meta.entity_name;
      if (meta.form_type) fields.documentType = meta.form_type;
      if (meta.filing_date) fields.issuedDate = meta.filing_date;
      if (meta.ciks) fields.registrationNumber = (meta.ciks as string[])[0];
      if (meta.tickers && (meta.tickers as string[]).length > 0) {
        fields.fieldOfStudy = 'Securities & Exchange';
      } else {
        fields.fieldOfStudy = 'Securities & Exchange';
      }
      fields.jurisdiction = 'United States';
      break;

    case 'openalex':
      if (meta.authors) fields.issuerName = (meta.authors as string[])[0] || 'Unknown';
      if (meta.journal) fields.issuerName = meta.journal;
      if (meta.publication_date) fields.issuedDate = meta.publication_date;
      if (meta.doi) fields.registrationNumber = meta.doi;
      if (meta.topics && (meta.topics as string[]).length > 0) {
        fields.fieldOfStudy = (meta.topics as string[])[0];
      } else {
        fields.fieldOfStudy = 'Academic Research';
      }
      break;

    case 'federal_register':
      if (meta.agencies && (meta.agencies as string[]).length > 0) {
        fields.issuerName = (meta.agencies as string[])[0];
      }
      if (meta.publication_date) fields.issuedDate = meta.publication_date;
      if (meta.document_number) fields.registrationNumber = meta.document_number;
      if (meta.cfr_references) fields.fieldOfStudy = 'Federal Regulation';
      else fields.fieldOfStudy = 'Federal Regulation';
      fields.jurisdiction = 'United States';
      break;

    case 'dapip':
      if (meta.institution_name) fields.issuerName = meta.institution_name;
      if (meta.accreditor) fields.accreditingBody = meta.accreditor;
      if (meta.state) fields.jurisdiction = `${meta.state}, USA`;
      fields.fieldOfStudy = 'Higher Education Accreditation';
      break;

    case 'acnc':
      if (meta.charity_legal_name) fields.issuerName = meta.charity_legal_name;
      if (meta.registration_date) fields.issuedDate = meta.registration_date;
      if (meta.abn) fields.registrationNumber = meta.abn;
      if (meta.purposes && (meta.purposes as string[]).length > 0) {
        fields.fieldOfStudy = (meta.purposes as string[])[0];
      }
      if (meta.state) fields.jurisdiction = `${meta.state}, Australia`;
      else fields.jurisdiction = 'Australia';
      fields.accreditingBody = 'Australian Charities and Not-for-profits Commission';
      break;

    case 'courtlistener':
      if (meta.court_name) fields.issuerName = meta.court_name;
      if (meta.case_name) fields.title = meta.case_name;
      if (meta.date_filed) fields.issuedDate = meta.date_filed;
      if (meta.court_id) {
        // Map court_id to jurisdiction — federal courts are US, state courts use court_id prefix
        const courtId = meta.court_id as string;
        if (['scotus', 'ca1', 'ca2', 'ca3', 'ca4', 'ca5', 'ca6', 'ca7', 'ca8', 'ca9', 'ca10', 'ca11', 'cadc', 'cafc'].includes(courtId)) {
          fields.jurisdiction = 'United States (Federal)';
        } else {
          fields.jurisdiction = 'United States';
        }
      } else if (meta.jurisdiction) {
        fields.jurisdiction = meta.jurisdiction;
      }
      if (meta.nature_of_suit && typeof meta.nature_of_suit === 'string' && meta.nature_of_suit.length > 0) {
        fields.fieldOfStudy = meta.nature_of_suit;
      } else {
        fields.fieldOfStudy = 'Case Law';
      }
      if (meta.docket_number) fields.registrationNumber = meta.docket_number;
      if (meta.citations && Array.isArray(meta.citations) && (meta.citations as string[]).length > 0) {
        fields.registrationNumber = (meta.citations as string[])[0];
      }
      break;
  }

  fields.fraudSignals = []; // Pipeline records are clean
  return fields;
}

/**
 * Format a record as instruction-tuning conversation.
 */
function formatAsConversation(record: PublicRecord): { messages: Array<{ role: string; content: string }> } | null {
  if (!record.title || record.title.length < 10) return null;

  const credType = getCredentialType(record);
  const extractedFields = buildExtractedFields(record);

  // Build a text representation from title + metadata (simulating what stripped text looks like)
  let textRepr = record.title;
  const meta = record.metadata;

  // Add metadata context to simulate a real credential text
  const metaLines: string[] = [];
  if (meta.entity_name) metaLines.push(`Entity: ${meta.entity_name}`);
  if (meta.charity_legal_name) metaLines.push(`Organization: ${meta.charity_legal_name}`);
  if (meta.form_type) metaLines.push(`Form Type: ${meta.form_type}`);
  if (meta.filing_date) metaLines.push(`Filing Date: ${meta.filing_date}`);
  if (meta.publication_date) metaLines.push(`Publication Date: ${meta.publication_date}`);
  if (meta.registration_date) metaLines.push(`Registration Date: ${meta.registration_date}`);
  if (meta.journal) metaLines.push(`Journal: ${meta.journal}`);
  if (meta.doi) metaLines.push(`DOI: ${meta.doi}`);
  if (meta.abn) metaLines.push(`ABN: ${meta.abn}`);
  if (meta.state) metaLines.push(`State: ${meta.state}`);
  if (meta.jurisdiction) metaLines.push(`Jurisdiction: ${meta.jurisdiction}`);
  if (meta.agencies) metaLines.push(`Agencies: ${(meta.agencies as string[]).join(', ')}`);
  if (meta.purposes) metaLines.push(`Purposes: ${(meta.purposes as string[]).join(', ')}`);
  if (meta.accreditor) metaLines.push(`Accreditor: ${meta.accreditor}`);
  if (meta.institution_name) metaLines.push(`Institution: ${meta.institution_name}`);
  if (meta.document_number) metaLines.push(`Document Number: ${meta.document_number}`);
  if (meta.file_description) metaLines.push(`Description: ${meta.file_description}`);
  // CourtListener fields
  if (meta.court_name) metaLines.push(`Court: ${meta.court_name}`);
  if (meta.case_name) metaLines.push(`Case Name: ${meta.case_name}`);
  if (meta.date_filed) metaLines.push(`Date Filed: ${meta.date_filed}`);
  if (meta.docket_number) metaLines.push(`Docket Number: ${meta.docket_number}`);
  if (meta.citations && Array.isArray(meta.citations) && (meta.citations as string[]).length > 0) {
    metaLines.push(`Citation: ${(meta.citations as string[]).join('; ')}`);
  }
  if (meta.nature_of_suit) metaLines.push(`Nature of Suit: ${meta.nature_of_suit}`);
  if (meta.precedential_status) metaLines.push(`Precedential Status: ${meta.precedential_status}`);

  if (metaLines.length > 0) {
    textRepr += '\n\n' + metaLines.join('\n');
  }

  const userPrompt = `Extract metadata from the following PII-stripped credential text.\nCredential type hint: ${credType}\n\n--- BEGIN CREDENTIAL TEXT ---\n${textRepr}\n--- END CREDENTIAL TEXT ---\n\nReturn a JSON object with the extracted fields, a "confidence" number (0.0 to 1.0), and a "fraudSignals" array.`;

  // System prompt omitted from each line to reduce file size (~50KB per line otherwise).
  // Together AI fine-tune applies system prompt at job config level.
  return {
    messages: [
      { role: 'system', content: 'You are a credential metadata extraction assistant. Extract structured metadata from PII-stripped credential text. Return JSON with credentialType, issuerName, issuedDate, jurisdiction, fieldOfStudy, registrationNumber, accreditingBody, confidence (0.0-1.0), and fraudSignals array. Omit fields you cannot determine.' },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: JSON.stringify(extractedFields) },
    ],
  };
}

async function main(): Promise<void> {
  console.log('=== Arkova Nessie Training Data Export (Production) ===\n');

  // Get credentials
  let supabaseUrl = process.env.SUPABASE_URL;
  let supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (process.argv.includes('--from-gcp') || !supabaseUrl || !supabaseKey) {
    console.log('Fetching credentials from GCP Secret Manager...');
    const gcpEnv = 'GOOGLE_APPLICATION_CREDENTIALS=/Users/carson/.config/gcloud/application_default_credentials.json';
    supabaseUrl = execSync(`${gcpEnv} gcloud secrets versions access latest --secret=supabase-url --project=arkova1`, { encoding: 'utf-8' }).trim();
    supabaseKey = execSync(`${gcpEnv} gcloud secrets versions access latest --secret=supabase-service-role-key --project=arkova1`, { encoding: 'utf-8' }).trim();
    console.log(`Supabase URL: ${supabaseUrl.substring(0, 30)}...`);
  }

  const supabase = createClient(supabaseUrl!, supabaseKey!);

  // Count total records
  const { count, error: countError } = await supabase
    .from('public_records')
    .select('*', { count: 'exact', head: true })
    .not('metadata', 'is', null)
    .not('title', 'is', null);

  if (countError) {
    console.error(`ERROR: ${countError.message}`);
    process.exit(1);
  }

  console.log(`Total records to export: ${count}\n`);

  // Fetch in pages and STREAM to disk (avoid OOM on 55k+ records)
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, '', 'utf-8'); // truncate
  const stats: Record<string, number> = {};
  let totalExported = 0;
  let filtered = 0;
  let page = 0;

  while (true) {
    const { data, error } = await supabase
      .from('public_records')
      .select('id, source, record_type, title, metadata, content_hash')
      .not('metadata', 'is', null)
      .not('title', 'is', null)
      .order('created_at', { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) {
      console.error(`ERROR page ${page}: ${error.message}`);
      process.exit(1);
    }

    if (!data || data.length === 0) break;

    // Write this page's records immediately to disk
    let pageBuf = '';
    for (const record of data as PublicRecord[]) {
      const example = formatAsConversation(record);
      if (!example) {
        filtered++;
        continue;
      }

      const credType = getCredentialType(record);
      stats[credType] = (stats[credType] || 0) + 1;
      pageBuf += JSON.stringify(example) + '\n';
      totalExported++;
    }
    appendFileSync(OUTPUT_PATH, pageBuf);

    page++;
    console.log(`  Page ${page}: ${data.length} records (${totalExported} examples so far)`);

    if (data.length < PAGE_SIZE) break;
  }

  console.log(`\n=== Export Complete ===`);
  console.log(`Total exported: ${totalExported}`);
  console.log(`Filtered: ${filtered}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log(`\nBy credential type:`);
  for (const [type, cnt] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${cnt}`);
  }
  console.log(`\nNext: npx tsx scripts/start-finetune.ts --file ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
