#!/usr/bin/env tsx
/**
 * Full Gemini Golden v2 Eval — 100 samples, per-field F1 scoring.
 * Uses service account auth (never gcloud CLI).
 *
 * Usage: cd services/worker && GOOGLE_APPLICATION_CREDENTIALS=/Users/carson/arkova-sa-key.json npx tsx scripts/eval-gemini-golden-v2-full.ts
 */

import { GoogleAuth } from 'google-auth-library';
import { GEMINI_GENERATION_MODEL } from '../src/ai/gemini-config.js';
import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import { GOLDEN_DATASET_PHASE10 } from '../src/ai/eval/golden-dataset-phase10.js';
import { GOLDEN_DATASET_PHASE11 } from '../src/ai/eval/golden-dataset-phase11.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ENDPOINT = 'projects/270018525501/locations/us-central1/endpoints/6659012403474202624';
const SAMPLE_SIZE = 100;

const SYSTEM_INSTRUCTION = `You are a credential metadata extraction assistant for Arkova, a document verification platform.
Your task is to extract structured metadata fields from PII-stripped credential text.
IMPORTANT RULES:
- The input text has already been PII-stripped.
- Do NOT attempt to reconstruct any redacted PII.
- Return a valid JSON object with only the fields you can confidently extract.
- If you cannot determine a field, OMIT it entirely.
- Dates MUST be in ISO 8601 format (YYYY-MM-DD).
- The "confidence" field MUST be a number from 0.0 to 1.0 reflecting extraction certainty.
EXTRACTABLE FIELDS:
- credentialType, issuerName, issuedDate, expiryDate, jurisdiction, fieldOfStudy,
  registrationNumber, licenseNumber, accreditingBody, degreeLevel, creditHours,
  creditType, fraudSignals
Return ONLY valid JSON. No markdown, no explanation.`;

const KEY_FIELDS = ['credentialType', 'issuerName', 'issuedDate', 'expiryDate', 'jurisdiction', 'fieldOfStudy', 'degreeLevel', 'licenseNumber', 'accreditingBody'];

async function main() {
  const allEntries = [...(FULL_GOLDEN_DATASET || []), ...GOLDEN_DATASET_PHASE10, ...GOLDEN_DATASET_PHASE11];
  const unique = new Map<string, (typeof allEntries)[0]>();
  for (const e of allEntries) unique.set(e.id, e);
  const entries = Array.from(unique.values());
  const sample = entries.sort(() => Math.random() - 0.5).slice(0, SAMPLE_SIZE);

  console.log(`Entries: ${entries.length}, Sample: ${sample.length}`);

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const tokenRes = await client.getAccessToken();
  const token = tokenRes.token!;

  // Per-field tracking
  const fieldStats: Record<string, { tp: number; fp: number; fn: number }> = {};
  for (const f of KEY_FIELDS) fieldStats[f] = { tp: 0, fp: 0, fn: 0 };

  const perType: Record<string, { correct: number; total: number }> = {};
  let typeCorrect = 0;
  let total = 0;
  let errors = 0;
  const confidences: number[] = [];
  const qualities: number[] = [];

  for (let i = 0; i < sample.length; i++) {
    const entry = sample[i];
    const gt = entry.groundTruth as Record<string, unknown>;

    const userPrompt = `Extract metadata from the following PII-stripped credential text.
Credential type hint: ${entry.credentialTypeHint}${entry.issuerHint ? `\nIssuer hint: ${entry.issuerHint}` : ''}

--- BEGIN CREDENTIAL TEXT ---
${entry.strippedText.slice(0, 2000)}
--- END CREDENTIAL TEXT ---

Return a JSON object with the extracted fields, a "confidence" number (0.0 to 1.0), and a "fraudSignals" array.`;

    try {
      const res = await fetch(
        `https://us-central1-aiplatform.googleapis.com/v1beta1/${ENDPOINT}:generateContent`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { role: 'system', parts: [{ text: SYSTEM_INSTRUCTION }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
          }),
        },
      );

      if (!res.ok) { errors++; continue; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = (await res.json()) as any;
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const parsed = JSON.parse(text) as Record<string, unknown>;

      total++;
      const conf = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
      confidences.push(conf);

      // Type accuracy
      const ct = gt.credentialType as string;
      if (!perType[ct]) perType[ct] = { correct: 0, total: 0 };
      perType[ct].total++;
      if (parsed.credentialType === ct) { typeCorrect++; perType[ct].correct++; }

      // Per-field F1
      let fieldHits = 0;
      for (const field of KEY_FIELDS) {
        const expected = gt[field];
        const actual = parsed[field];
        if (expected !== undefined && expected !== null && expected !== '') {
          if (actual !== undefined && actual !== null && actual !== '') {
            if (String(actual).toLowerCase() === String(expected).toLowerCase()) {
              fieldStats[field].tp++;
              fieldHits++;
            } else {
              fieldStats[field].fp++;
              fieldStats[field].fn++;
            }
          } else {
            fieldStats[field].fn++;
          }
        } else if (actual !== undefined && actual !== null && actual !== '') {
          fieldStats[field].fp++;
        }
      }

      const expectedFieldCount = KEY_FIELDS.filter(f => gt[f] !== undefined && gt[f] !== null && gt[f] !== '').length;
      qualities.push(expectedFieldCount > 0 ? fieldHits / expectedFieldCount : 1);

      if ((i + 1) % 25 === 0) {
        console.log(`  ${i + 1}/${SAMPLE_SIZE} type=${(typeCorrect / total * 100).toFixed(1)}%`);
      }
    } catch { errors++; }

    if (i % 5 === 4) await new Promise((r) => setTimeout(r, 1000));
  }

  // Compute F1 per field
  console.log(`\n=== Gemini Golden v2 Full Eval (${total} samples) ===`);
  console.log(`Type accuracy: ${(typeCorrect / total * 100).toFixed(1)}% (${typeCorrect}/${total})`);
  console.log(`Errors: ${errors}`);

  console.log('\nPer-field F1:');
  let totalF1 = 0;
  let fieldCount = 0;
  for (const [field, stats] of Object.entries(fieldStats)) {
    const precision = stats.tp + stats.fp > 0 ? stats.tp / (stats.tp + stats.fp) : 0;
    const recall = stats.tp + stats.fn > 0 ? stats.tp / (stats.tp + stats.fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    if (stats.tp + stats.fn > 0) { totalF1 += f1; fieldCount++; }
    console.log(`  ${field}: F1=${(f1 * 100).toFixed(1)}% P=${(precision * 100).toFixed(0)}% R=${(recall * 100).toFixed(0)}% (tp=${stats.tp} fp=${stats.fp} fn=${stats.fn})`);
  }
  const macroF1 = fieldCount > 0 ? totalF1 / fieldCount : 0;
  console.log(`\nMacro F1: ${(macroF1 * 100).toFixed(1)}%`);

  // Confidence correlation
  const meanConf = confidences.reduce((a, b) => a + b, 0) / confidences.length;
  const meanQual = qualities.reduce((a, b) => a + b, 0) / qualities.length;
  let num = 0, denC = 0, denQ = 0;
  for (let i = 0; i < confidences.length; i++) {
    const dc = confidences[i] - meanConf;
    const dq = qualities[i] - meanQual;
    num += dc * dq;
    denC += dc * dc;
    denQ += dq * dq;
  }
  const r = Math.sqrt(denC * denQ) > 0 ? num / Math.sqrt(denC * denQ) : 0;
  console.log(`Confidence correlation: r=${r.toFixed(3)}`);

  console.log('\nPer-type accuracy:');
  for (const [t, s] of Object.entries(perType).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${t}: ${(s.correct / s.total * 100).toFixed(0)}% (${s.correct}/${s.total})`);
  }

  // Save report
  const report = {
    timestamp: new Date().toISOString(),
    model: 'gemini-golden-v2',
    endpoint: ENDPOINT,
    samples: total,
    errors,
    typeAccuracy: typeCorrect / total,
    macroF1,
    confidenceCorrelation: r,
    perField: Object.fromEntries(Object.entries(fieldStats).map(([f, s]) => {
      const p = s.tp + s.fp > 0 ? s.tp / (s.tp + s.fp) : 0;
      const rec = s.tp + s.fn > 0 ? s.tp / (s.tp + s.fn) : 0;
      const f1 = p + rec > 0 ? 2 * p * rec / (p + rec) : 0;
      return [f, { f1, precision: p, recall: rec, ...s }];
    })),
    perType: Object.fromEntries(Object.entries(perType).map(([t, s]) => [t, { accuracy: s.correct / s.total, ...s }])),
  };

  mkdirSync(resolve(import.meta.dirname ?? '.', '../docs/eval'), { recursive: true });
  const reportFile = resolve(import.meta.dirname ?? '.', `../docs/eval/eval-gemini-golden-v2-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportFile}`);
}

main().catch((err) => {
  console.error('EVAL FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
