#!/usr/bin/env tsx
/**
 * Gemini Golden v6 — Smoke Test
 *
 * Single-call verification that a v6 endpoint is up and emits valid
 * v6-shaped output (credentialType, subType, description, confidence).
 *
 * Run BEFORE the 50-sample eval to catch auth/endpoint/schema issues early.
 *
 * Usage:
 *   GEMINI_TUNED_MODEL=projects/.../endpoints/<v6-id> \
 *     npx tsx scripts/smoke-test-gemini-golden-v6.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenvConfig({ path: resolve(__dirname, '../.env') });

const SAMPLE_TEXT = `The Regents of the University of Michigan, on the recommendation of the Faculty of the College of Engineering, have conferred upon [NAME_REDACTED] the degree of Bachelor of Science in Computer Science with all the rights, privileges, and responsibilities thereunto appertaining. Conferred on the Third Day of May, Two Thousand Twenty-Five. Ann Arbor, Michigan. President of the University. Chair, Board of Regents. Dean, College of Engineering. Diploma No. UM-2025-ENG-04821.`;

const { GeminiProvider } = await import('../src/ai/gemini.js');

async function main(): Promise<void> {
  const tuned = process.env.GEMINI_TUNED_MODEL;
  if (!tuned) {
    console.error('ERROR: GEMINI_TUNED_MODEL must be set to a v6 endpoint path');
    process.exit(1);
  }
  console.log(`--- Gemini Golden v6 smoke test ---`);
  console.log(`Endpoint: ${tuned}`);
  console.log('');

  const provider = new GeminiProvider();
  const start = Date.now();
  const result = await provider.extractMetadata({
    strippedText: SAMPLE_TEXT,
    credentialType: 'DEGREE',
    fingerprint: 'a'.repeat(64),
  });
  const latencyMs = Date.now() - start;

  const fields = result.fields as Record<string, unknown>;
  console.log(`Latency:          ${latencyMs}ms`);
  console.log(`Provider:         ${result.provider}`);
  console.log(`Model version:    ${result.modelVersion ?? '(unknown)'}`);
  console.log(`Tokens used:      ${result.tokensUsed ?? '?'}`);
  console.log(`Confidence:       ${result.confidence.toFixed(3)}`);
  console.log(`credentialType:   ${fields.credentialType}`);
  console.log(`subType:          ${fields.subType ?? '(missing)'}`);
  console.log(`description:      ${fields.description ?? '(missing)'}`);
  console.log(`issuerName:       ${fields.issuerName}`);
  console.log(`issuedDate:       ${fields.issuedDate}`);
  console.log(`fieldOfStudy:     ${fields.fieldOfStudy}`);
  console.log(`degreeLevel:      ${fields.degreeLevel}`);
  console.log(`jurisdiction:     ${fields.jurisdiction}`);
  console.log('');

  // Smoke gates
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [
    { name: 'credentialType=DEGREE', pass: fields.credentialType === 'DEGREE', detail: String(fields.credentialType) },
    { name: 'subType present', pass: typeof fields.subType === 'string' && (fields.subType as string).length > 0, detail: String(fields.subType) },
    { name: 'description present', pass: typeof fields.description === 'string' && (fields.description as string).length > 0, detail: String(fields.description).slice(0, 80) },
    { name: 'issuerName contains "Michigan"', pass: /michigan/i.test(String(fields.issuerName ?? '')), detail: String(fields.issuerName) },
    { name: 'latency < 5s (smoke threshold)', pass: latencyMs < 5000, detail: `${latencyMs}ms` },
  ];
  console.log('Smoke checks:');
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'}  ${c.name}  →  ${c.detail}`);
  }
  const allPass = checks.every(c => c.pass);
  console.log('');
  console.log(allPass ? '✓ SMOKE PASS — run full eval next' : '✗ SMOKE FAIL — fix before running full eval');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
