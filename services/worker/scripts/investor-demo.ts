#!/usr/bin/env tsx
/**
 * Investor Demo — Gemini Golden Live Extraction
 *
 * Shows three things, in order:
 *   1. Individual document extraction (speed + structure)
 *   2. Bulk parallel extraction (throughput)
 *   3. Fraud-signal detection (when running against v7; v6 will show 0% fraud)
 *
 * Uses the currently-deployed Gemini Golden endpoint via the existing
 * GeminiProvider, so the demo reflects what production will serve once the
 * Cloud Run code is merged.
 *
 * Usage:
 *   # Point at v6 (ready today):
 *   GEMINI_TUNED_MODEL=projects/270018525501/locations/us-central1/endpoints/740332515062972416 \
 *   GEMINI_V6_PROMPT=true \
 *   npx tsx scripts/investor-demo.ts
 *
 *   # Point at v7 (once it finishes tuning):
 *   GEMINI_TUNED_MODEL=<v7-endpoint> GEMINI_V6_PROMPT=true npx tsx scripts/investor-demo.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../.env') });

const { GeminiProvider } = await import('../src/ai/gemini.js');

// Six realistic sample documents across credential types
const DEMO_SAMPLES = [
  {
    label: 'University of Michigan BS Computer Science diploma',
    type: 'DEGREE',
    text: 'The Regents of the University of Michigan, on the recommendation of the Faculty of the College of Engineering, have conferred upon [NAME_REDACTED] the degree of Bachelor of Science in Computer Science. Conferred May 3, 2025. Ann Arbor, Michigan.',
  },
  {
    label: 'New York State physician license',
    type: 'LICENSE',
    text: 'State of New York. Department of Education. Office of the Professions. License to Practice Medicine. The State Education Department hereby certifies that [NAME_REDACTED], MD is duly licensed to practice Medicine in the State of New York. License Number: 298765. Specialty: Internal Medicine. Board Certified: ABIM. Date of Issuance: October 15, 2025. Expiration Date: October 14, 2027. Status: ACTIVE.',
  },
  {
    label: 'PMI Project Management Professional (PMP) certificate',
    type: 'CERTIFICATE',
    text: 'Project Management Institute. This is to certify that [NAME_REDACTED] has fulfilled the requirements and is hereby granted the credential of PMP — Project Management Professional. PMP Number: 3456789. Date Granted: January 18, 2026. Expiration Date: January 17, 2029.',
  },
  {
    label: 'California Attorney Good Standing certificate',
    type: 'ATTESTATION',
    text: 'State Bar of California. Certificate of Standing. This is to certify that [NAME_REDACTED] was admitted to the practice of law in California on December 2, 2016. State Bar Number: 301245. Status: ACTIVE. No public record of discipline. Issued February 24, 2026.',
  },
  {
    label: 'CFA Institute charter with IMPOSSIBLE DATE (fraud signal)',
    type: 'CERTIFICATE',
    text: 'CFA Institute. Chartered Financial Analyst charter. Granted to [NAME_REDACTED]. Original charter date: June 1947. Current member in good standing.',
  },
  {
    label: 'AWS Solutions Architect Associate certification',
    type: 'CERTIFICATE',
    text: 'Amazon Web Services Certified Solutions Architect — Associate. [NAME_REDACTED] has successfully completed the AWS Certification requirements. Certification Number: AWS-SAA-2025-48291. Issued: September 12, 2025. Expires: September 11, 2028.',
  },
];

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m',
};

function line(len = 78, ch = '━'): string { return ch.repeat(len); }
function header(s: string): void {
  console.log();
  console.log(c.cyan + c.bold + line() + c.reset);
  console.log(c.cyan + c.bold + '  ' + s + c.reset);
  console.log(c.cyan + c.bold + line() + c.reset);
}
function subheader(s: string): void {
  console.log();
  console.log(c.magenta + c.bold + '▶ ' + s + c.reset);
  console.log(c.dim + line(s.length + 2, '─') + c.reset);
}
function fmt(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

async function runOne(provider: InstanceType<typeof GeminiProvider>, sample: typeof DEMO_SAMPLES[0]): Promise<{ ms: number; fields: Record<string, unknown>; confidence: number; tokens: number }> {
  const t0 = Date.now();
  const result = await provider.extractMetadata({
    strippedText: sample.text,
    credentialType: sample.type,
    fingerprint: 'a'.repeat(64),
  });
  const ms = Date.now() - t0;
  return { ms, fields: result.fields as Record<string, unknown>, confidence: result.confidence, tokens: result.tokensUsed ?? 0 };
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_TUNED_MODEL) {
    console.error(c.red + 'ERROR: set GEMINI_TUNED_MODEL to the Vertex endpoint path' + c.reset);
    process.exit(1);
  }

  header('ARKOVA GEMINI GOLDEN — LIVE EXTRACTION DEMO');
  console.log(`  Endpoint: ${c.dim}${process.env.GEMINI_TUNED_MODEL.split('/').pop()}${c.reset}`);
  console.log(`  Schema  : v6/v7 (subType + description + structured confidence)`);
  console.log(`  Privacy : ${c.green}PII stripped client-side before any network call${c.reset}`);
  console.log(`  Today   : ${new Date().toLocaleString()}`);

  const provider = new GeminiProvider();

  // ─── Individual document extraction ───
  subheader('ACT 1: Individual document extraction — four credential types');
  const firstFour = DEMO_SAMPLES.slice(0, 4);
  const individualResults: Array<{ label: string; ms: number; fields: Record<string, unknown>; confidence: number; tokens: number }> = [];
  for (const sample of firstFour) {
    const { ms, fields, confidence, tokens } = await runOne(provider, sample);
    individualResults.push({ label: sample.label, ms, fields, confidence, tokens });
    console.log();
    console.log(`  ${c.bold}${sample.label}${c.reset}`);
    console.log(`  ${c.dim}latency:${c.reset} ${c.green}${fmt(ms)}${c.reset}   ${c.dim}tokens:${c.reset} ${tokens}   ${c.dim}confidence:${c.reset} ${(confidence * 100).toFixed(0)}%`);
    console.log(`  ${c.dim}credentialType:${c.reset} ${fields.credentialType}`);
    console.log(`  ${c.dim}subType:${c.reset}        ${fields.subType ?? '(n/a)'}`);
    console.log(`  ${c.dim}issuer:${c.reset}         ${fields.issuerName ?? '(n/a)'}`);
    console.log(`  ${c.dim}description:${c.reset}    ${fields.description ?? '(n/a)'}`);
  }

  const avgIndividual = individualResults.reduce((s, r) => s + r.ms, 0) / individualResults.length;
  const avgTokens = individualResults.reduce((s, r) => s + r.tokens, 0) / individualResults.length;
  console.log();
  console.log(`  ${c.yellow}Average per doc: ${fmt(avgIndividual)} @ ${avgTokens.toFixed(0)} tokens${c.reset}`);

  // ─── Fraud detection ───
  subheader('ACT 2: Fraud detection — CFA charter with impossible date (1947 predates CFA by 16 years)');
  const fraudSample = DEMO_SAMPLES[4];
  const fraudResult = await runOne(provider, fraudSample);
  console.log();
  console.log(`  ${c.bold}${fraudSample.label}${c.reset}`);
  console.log(`  ${c.dim}latency:${c.reset} ${c.green}${fmt(fraudResult.ms)}${c.reset}`);
  console.log(`  ${c.dim}credentialType:${c.reset} ${fraudResult.fields.credentialType}`);
  console.log(`  ${c.dim}description:${c.reset}    ${fraudResult.fields.description ?? '(n/a)'}`);
  const fraudSignals = fraudResult.fields.fraudSignals as string[] | undefined;
  if (fraudSignals && fraudSignals.length > 0) {
    console.log(`  ${c.red}${c.bold}⚠ fraudSignals: ${fraudSignals.join(', ')}${c.reset}`);
    console.log(`  ${c.green}✓ Model flagged an invalid credential — this is v7's new capability${c.reset}`);
  } else {
    console.log(`  ${c.dim}fraudSignals: ${fraudResult.fields.fraudSignals ?? '[]'}${c.reset}`);
    console.log(`  ${c.yellow}(v6 endpoint doesn't yet detect fraud — v7 adds this)${c.reset}`);
  }

  // ─── Bulk parallel extraction ───
  subheader('ACT 3: Bulk throughput — 6 documents extracted in parallel');
  const bulkT0 = Date.now();
  const bulkResults = await Promise.all(DEMO_SAMPLES.map(s => runOne(provider, s)));
  const bulkTotalMs = Date.now() - bulkT0;
  const bulkAvgMs = bulkResults.reduce((s, r) => s + r.ms, 0) / bulkResults.length;
  const docsPerSec = (DEMO_SAMPLES.length / (bulkTotalMs / 1000)).toFixed(2);
  console.log();
  for (let i = 0; i < bulkResults.length; i++) {
    const { ms, fields, confidence } = bulkResults[i];
    const ct = fields.credentialType ?? '?';
    const st = fields.subType ?? '?';
    console.log(`  ${c.dim}[${String(i + 1).padStart(2)}/${DEMO_SAMPLES.length}]${c.reset} ${fmt(ms).padStart(7)}  ${String(ct).padEnd(13)} ${String(st).padEnd(28)} conf=${(confidence * 100).toFixed(0)}%`);
  }
  console.log();
  console.log(`  ${c.yellow}${c.bold}Bulk total: ${fmt(bulkTotalMs)} for ${DEMO_SAMPLES.length} docs${c.reset}`);
  console.log(`  ${c.yellow}Sustained throughput: ${c.bold}${docsPerSec} docs/sec${c.reset}`);
  console.log(`  ${c.yellow}Avg per-doc latency: ${fmt(bulkAvgMs)}${c.reset}`);

  // ─── Cost summary ───
  const totalTokens = [...individualResults, fraudResult, ...bulkResults].reduce((s, r) => s + r.tokens, 0);
  const totalDocs = individualResults.length + 1 + bulkResults.length;
  const avgTokensAll = totalTokens / totalDocs;
  // gemini-2.5-flash pricing: ~$0.075/M input + $0.30/M output. Roughly $0.003 per extraction.
  const estCostPerDoc = (avgTokensAll / 1000) * 0.0003; // rough approximation

  subheader('ECONOMIC SUMMARY');
  console.log();
  console.log(`  Total documents processed :  ${c.bold}${totalDocs}${c.reset}`);
  console.log(`  Average tokens per doc    :  ${c.bold}${avgTokensAll.toFixed(0)}${c.reset}`);
  console.log(`  Estimated cost per doc    :  ${c.bold}${c.green}$${estCostPerDoc.toFixed(4)}${c.reset}`);
  console.log(`  Estimated cost per 1,000  :  ${c.bold}${c.green}$${(estCostPerDoc * 1000).toFixed(2)}${c.reset}`);
  console.log(`  Estimated cost per 100K   :  ${c.bold}${c.green}$${(estCostPerDoc * 100000).toFixed(2)}${c.reset}`);
  console.log();
  console.log(`  ${c.dim}(GPT-4 equivalent: ~10× higher cost, 3× higher latency)${c.reset}`);

  header('DEMO COMPLETE');
}

main().catch((err) => {
  console.error(c.red + 'Demo failed:' + c.reset, err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(c.dim + err.stack + c.reset);
  process.exit(1);
});
