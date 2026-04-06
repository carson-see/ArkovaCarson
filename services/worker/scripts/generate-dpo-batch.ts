/**
 * Generate DPO Training Batch (NMT-09)
 *
 * Generates Direct Preference Optimization pairs from the FCRA/employment
 * golden dataset + existing golden datasets. Creates chosen/rejected pairs
 * using corruption strategies from nessie-dpo-data.ts.
 *
 * Output: JSONL file with DPO training pairs.
 *
 * Usage:
 *   npx tsx scripts/generate-dpo-batch.ts [--output path] [--count N]
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { GOLDEN_DATASET_PHASE13_FCRA } from '../src/ai/eval/golden-dataset-phase13-fcra.js';
import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import type { GoldenDatasetEntry } from '../src/ai/eval/types.js';

// ---------------------------------------------------------------------------
// DPO pair types
// ---------------------------------------------------------------------------

interface DPOPair {
  prompt: string;
  chosen: string;
  rejected: string;
  metadata: {
    entryId: string;
    corruptionType: string;
    credentialType: string;
  };
}

// ---------------------------------------------------------------------------
// Corruption strategies (from nessie-dpo-data.ts patterns)
// ---------------------------------------------------------------------------

function corruptHallucinatedCitation(entry: GoldenDatasetEntry): { chosen: string; rejected: string } {
  const gt = entry.groundTruth;
  const realCitation = `[${entry.id}]`;

  const chosen = JSON.stringify({
    analysis: `Based on the verified document ${realCitation}, the ${gt.credentialType ?? 'credential'} issued by ${gt.issuerName ?? 'the institution'} ${gt.issuedDate ? `on ${gt.issuedDate}` : ''} has been verified against the anchored record.`,
    citations: [{ record_id: entry.id, source: entry.source, excerpt: `Verified ${gt.credentialType ?? 'credential'}` }],
    confidence: 0.85,
    risks: [],
    recommendations: [],
  });

  const rejected = JSON.stringify({
    analysis: `Based on Federal Register document [FR-2025-FAKE-99999] and SEC filing [EDGAR-FAKE-88888], the credential has regulatory implications under 17 CFR 230.506(b). See also United States v. Smith (2024) for precedent.`,
    citations: [
      { record_id: 'FR-2025-FAKE-99999', source: 'federal_register', excerpt: 'Fabricated regulatory citation' },
      { record_id: 'EDGAR-FAKE-88888', source: 'edgar', excerpt: 'Non-existent SEC filing' },
    ],
    confidence: 0.92,
    risks: [],
    recommendations: [],
  });

  return { chosen, rejected };
}

function corruptOverconfidence(entry: GoldenDatasetEntry): { chosen: string; rejected: string } {
  const gt = entry.groundTruth;

  const chosen = JSON.stringify({
    analysis: `The available evidence provides limited information about this ${gt.credentialType ?? 'record'}. The document from ${gt.issuerName ?? 'the issuer'} appears to be from ${entry.source}, but additional verification is recommended. [${entry.id}]`,
    citations: [{ record_id: entry.id, source: entry.source, excerpt: 'Limited evidence available' }],
    confidence: 0.45,
    risks: ['Limited corroborating sources available'],
    recommendations: ['Seek additional verification from the issuing institution'],
  });

  const rejected = JSON.stringify({
    analysis: `This credential is definitively and comprehensively verified across all dimensions. The ${gt.credentialType ?? 'credential'} from ${gt.issuerName ?? 'the institution'} is 100% authentic with zero possibility of error or falsification.`,
    citations: [{ record_id: entry.id, source: entry.source, excerpt: 'Absolutely verified' }],
    confidence: 0.99,
    risks: [],
    recommendations: [],
  });

  return { chosen, rejected };
}

function corruptMissingCitations(entry: GoldenDatasetEntry): { chosen: string; rejected: string } {
  const gt = entry.groundTruth;

  const chosen = JSON.stringify({
    analysis: `The ${gt.credentialType ?? 'credential'} from ${gt.issuerName ?? 'the institution'} has been analyzed [${entry.id}]. ${gt.expiryDate ? `The credential expires on ${gt.expiryDate}.` : ''} ${gt.jurisdiction ? `Jurisdiction: ${gt.jurisdiction}.` : ''}`,
    citations: [{ record_id: entry.id, source: entry.source, excerpt: `${gt.credentialType ?? 'Credential'} record` }],
    confidence: 0.75,
    risks: gt.fraudSignals ?? [],
    recommendations: ['Verify current status with the issuing authority'],
  });

  const rejected = JSON.stringify({
    analysis: `The credential is valid and in good standing. It was issued by a reputable institution and meets all compliance requirements. The jurisdiction has no restrictions on this type of credential. All checks passed.`,
    citations: [],
    confidence: 0.80,
    risks: [],
    recommendations: [],
  });

  return { chosen, rejected };
}

function corruptIdSwap(entry: GoldenDatasetEntry, otherEntry: GoldenDatasetEntry): { chosen: string; rejected: string } {
  const gt = entry.groundTruth;

  const chosen = JSON.stringify({
    analysis: `Analysis of ${gt.credentialType ?? 'credential'} from ${gt.issuerName ?? 'the institution'} [${entry.id}]. The document is from the ${entry.source} corpus.`,
    citations: [{ record_id: entry.id, source: entry.source, excerpt: `Correct source: ${entry.id}` }],
    confidence: 0.80,
    risks: [],
    recommendations: [],
  });

  const rejected = JSON.stringify({
    analysis: `Analysis of ${gt.credentialType ?? 'credential'} from ${gt.issuerName ?? 'the institution'} [${otherEntry.id}]. The document is from the ${entry.source} corpus.`,
    citations: [{ record_id: otherEntry.id, source: otherEntry.source, excerpt: `Wrong source: ${otherEntry.id}` }],
    confidence: 0.82,
    risks: [],
    recommendations: [],
  });

  return { chosen, rejected };
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

function generatePairs(entries: GoldenDatasetEntry[], maxPairs: number): DPOPair[] {
  const pairs: DPOPair[] = [];
  const strategies = ['hallucinated_citation', 'overconfidence', 'missing_citations', 'id_swap'] as const;

  for (const entry of entries) {
    if (pairs.length >= maxPairs) break;

    for (const strategy of strategies) {
      if (pairs.length >= maxPairs) break;

      const prompt = `USER QUERY: Analyze this document for compliance risks and verify its authenticity.\n\nDOCUMENT:\n${entry.strippedText.slice(0, 1500)}\n\nProvide analysis with citations.`;

      let result: { chosen: string; rejected: string };

      switch (strategy) {
        case 'hallucinated_citation':
          result = corruptHallucinatedCitation(entry);
          break;
        case 'overconfidence':
          result = corruptOverconfidence(entry);
          break;
        case 'missing_citations':
          result = corruptMissingCitations(entry);
          break;
        case 'id_swap': {
          const other = entries.find((e) => e.id !== entry.id) ?? entries[0];
          result = corruptIdSwap(entry, other);
          break;
        }
      }

      pairs.push({
        prompt,
        chosen: result.chosen,
        rejected: result.rejected,
        metadata: {
          entryId: entry.id,
          corruptionType: strategy,
          credentialType: entry.groundTruth.credentialType ?? entry.credentialTypeHint,
        },
      });
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const outputIdx = args.indexOf('--output');
const countIdx = args.indexOf('--count');

const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : join(process.cwd(), 'dpo-training-batch.jsonl');
const maxCount = countIdx >= 0 ? parseInt(args[countIdx + 1], 10) : 500;

// Combine FCRA dataset with existing golden dataset for broader coverage
const allEntries: GoldenDatasetEntry[] = [
  ...GOLDEN_DATASET_PHASE13_FCRA,
  ...FULL_GOLDEN_DATASET.slice(0, 50), // Sample from existing
];

console.log(`Generating DPO pairs from ${allEntries.length} entries (max ${maxCount} pairs)...`);

const pairs = generatePairs(allEntries, maxCount);

// Write JSONL
const jsonl = pairs.map((p) => JSON.stringify(p)).join('\n');
writeFileSync(outputPath, jsonl + '\n', 'utf-8');

console.log(`Generated ${pairs.length} DPO pairs`);
console.log(`  - hallucinated_citation: ${pairs.filter((p) => p.metadata.corruptionType === 'hallucinated_citation').length}`);
console.log(`  - overconfidence: ${pairs.filter((p) => p.metadata.corruptionType === 'overconfidence').length}`);
console.log(`  - missing_citations: ${pairs.filter((p) => p.metadata.corruptionType === 'missing_citations').length}`);
console.log(`  - id_swap: ${pairs.filter((p) => p.metadata.corruptionType === 'id_swap').length}`);
console.log(`Output: ${outputPath}`);
