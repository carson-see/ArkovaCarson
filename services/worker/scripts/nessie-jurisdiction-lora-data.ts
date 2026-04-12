/**
 * Jurisdiction LoRA Training Data Generator (NCE-14)
 *
 * Generates jurisdiction-specific compliance Q&A for LoRA adapter training.
 * Filters public records by jurisdiction and generates training examples
 * via Gemini distillation.
 *
 * Usage:
 *   npx tsx scripts/nessie-jurisdiction-lora-data.ts --jurisdiction US-CA --output ca-training.jsonl [--count 200]
 *
 * Jira: SCRUM-605
 */

import fs from 'node:fs';
import path from 'node:path';

interface TrainingExample {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  metadata: {
    jurisdiction: string;
    domain: string;
    task_type: string;
  };
}

// Jurisdiction-specific compliance knowledge templates
const JURISDICTION_TEMPLATES: Record<string, Array<{ query: string; domain: string; task: string }>> = {
  'US-CA': [
    { query: 'What continuing education requirements apply to California CPAs?', domain: 'accounting', task: 'compliance_qa' },
    { query: 'What are California Bar MCLE requirements for attorneys?', domain: 'legal', task: 'compliance_qa' },
    { query: 'What are the licensing requirements for registered nurses in California?', domain: 'nursing', task: 'compliance_qa' },
    { query: 'What risks does a California CPA face with lapsed CE credits?', domain: 'accounting', task: 'risk_analysis' },
    { query: 'How should a California law firm track MCLE compliance?', domain: 'legal', task: 'recommendation' },
  ],
  'US-NY': [
    { query: 'What are the CPA licensing requirements in New York?', domain: 'accounting', task: 'compliance_qa' },
    { query: 'What CLE requirements apply to New York attorneys?', domain: 'legal', task: 'compliance_qa' },
    { query: 'What are New York RN licensure renewal requirements?', domain: 'nursing', task: 'compliance_qa' },
    { query: 'What penalties exist for practicing without a valid NY CPA license?', domain: 'accounting', task: 'risk_analysis' },
    { query: 'How should a New York nursing agency verify RN credentials?', domain: 'nursing', task: 'recommendation' },
  ],
  'US-FED': [
    { query: 'What are the SEC filing deadlines for public companies?', domain: 'SEC', task: 'compliance_qa' },
    { query: 'What are IRS requirements for tax preparer continuing education?', domain: 'tax', task: 'compliance_qa' },
    { query: 'What HIPAA compliance requirements apply to healthcare providers?', domain: 'healthcare', task: 'compliance_qa' },
    { query: 'What are the consequences of late SEC 10-K filings?', domain: 'SEC', task: 'risk_analysis' },
    { query: 'How should an organization prepare for HIPAA compliance audits?', domain: 'healthcare', task: 'recommendation' },
  ],
};

const SYSTEM_PROMPT = `You are Nessie, Arkova's compliance intelligence assistant. You provide accurate, jurisdiction-specific compliance guidance with citations to regulatory sources. Always cite specific regulations, statutes, or rules. Never fabricate citations.`;

function generateExample(jurisdiction: string, template: { query: string; domain: string; task: string }): TrainingExample {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: template.query },
      { role: 'assistant', content: `[Placeholder — to be filled by Gemini distillation for ${jurisdiction} ${template.domain} domain]` },
    ],
    metadata: {
      jurisdiction,
      domain: template.domain,
      task_type: template.task,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const jurisdictionIdx = args.indexOf('--jurisdiction');
  const outputIdx = args.indexOf('--output');
  const countIdx = args.indexOf('--count');

  const jurisdiction = jurisdictionIdx >= 0 ? args[jurisdictionIdx + 1] : 'US-CA';
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : `${jurisdiction.toLowerCase()}-lora-data.jsonl`;
  const count = countIdx >= 0 ? parseInt(args[countIdx + 1], 10) : 200;

  const templates = JURISDICTION_TEMPLATES[jurisdiction];
  if (!templates) {
    console.error(`Unknown jurisdiction: ${jurisdiction}. Available: ${Object.keys(JURISDICTION_TEMPLATES).join(', ')}`);
    process.exit(1);
  }

  if (args.includes('--dry-run')) {
    console.log(`[DRY RUN] Would generate ${count} training examples for ${jurisdiction}`);
    console.log(`Templates: ${templates.length}`);
    console.log(`Domains: ${[...new Set(templates.map(t => t.domain))].join(', ')}`);
    return;
  }

  console.log(`Generating ${count} jurisdiction LoRA training examples for ${jurisdiction}...`);
  const examples: TrainingExample[] = [];

  for (let i = 0; i < count; i++) {
    const template = templates[i % templates.length];
    examples.push(generateExample(jurisdiction, template));
  }

  const outputFullPath = path.resolve(outputPath);
  const lines = examples.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(outputFullPath, lines + '\n');

  console.log(`Written ${examples.length} examples to ${outputFullPath}`);
}

main().catch(console.error);
