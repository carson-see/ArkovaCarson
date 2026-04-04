#!/usr/bin/env tsx
/**
 * Quick eval of Gemini Golden v2 on 50 random golden dataset samples.
 * Uses service account auth (never gcloud CLI).
 *
 * Usage: cd services/worker && npx tsx scripts/eval-gemini-golden-v2.ts
 */

import { GoogleAuth } from 'google-auth-library';
import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import { GOLDEN_DATASET_PHASE10 } from '../src/ai/eval/golden-dataset-phase10.js';
import { GOLDEN_DATASET_PHASE11 } from '../src/ai/eval/golden-dataset-phase11.js';

const ENDPOINT = 'projects/270018525501/locations/us-central1/endpoints/6659012403474202624';

// System instruction matching the training format — tuned models MUST use this
const SYSTEM_INSTRUCTION = `You are a credential metadata extraction assistant for Arkova, a document verification platform.

Your task is to extract structured metadata fields from PII-stripped credential text.

IMPORTANT RULES:
- The input text has already been PII-stripped. Personal names, SSNs, emails, and phone numbers have been replaced with redaction tokens like [NAME_REDACTED], [SSN_REDACTED], etc.
- Do NOT attempt to reconstruct any redacted PII.
- Extract only the metadata fields listed below.
- Return a valid JSON object with only the fields you can confidently extract.
- If you cannot determine a field, OMIT it entirely.
- Dates MUST be in ISO 8601 format (YYYY-MM-DD).
- The "confidence" field MUST be a number from 0.0 to 1.0 reflecting extraction certainty.

EXTRACTABLE FIELDS:
- credentialType: DEGREE, LICENSE, CERTIFICATE, CLE, PUBLICATION, SEC_FILING, REGULATION, PROFESSIONAL, LEGAL, OTHER
- issuerName: Organization that issued the credential
- issuedDate: Date issued (YYYY-MM-DD)
- expiryDate: Expiration date if applicable (YYYY-MM-DD)
- jurisdiction: Geographic jurisdiction
- fieldOfStudy: Subject area or field
- registrationNumber / licenseNumber: Official number
- accreditingBody: Accrediting organization
- degreeLevel: Bachelor, Master, Doctorate, Associate, etc.
- creditHours: CLE credit hours (number)
- creditType: CLE credit type (Ethics, General, etc.)
- fraudSignals: Array of fraud indicator strings

Return ONLY valid JSON. No markdown, no explanation.`;

async function main() {
  const allEntries = [...(FULL_GOLDEN_DATASET || []), ...GOLDEN_DATASET_PHASE10, ...GOLDEN_DATASET_PHASE11];
  const unique = new Map<string, (typeof allEntries)[0]>();
  for (const e of allEntries) unique.set(e.id, e);
  const entries = Array.from(unique.values());
  const sample = entries.sort(() => Math.random() - 0.5).slice(0, 50);

  console.log('Entries:', entries.length, 'Sample:', sample.length);

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const tokenRes = await client.getAccessToken();
  const token = tokenRes.token!;

  let correct = 0, total = 0, errors = 0;
  const perType: Record<string, { correct: number; total: number }> = {};

  for (let i = 0; i < sample.length; i++) {
    const entry = sample[i];
    const gt = entry.groundTruth;
    const userPrompt = `Extract metadata from the following PII-stripped credential text.
Credential type hint: ${entry.credentialTypeHint}${entry.issuerHint ? `\nIssuer hint: ${entry.issuerHint}` : ''}

--- BEGIN CREDENTIAL TEXT ---
${entry.strippedText.slice(0, 1500)}
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
      const parsed = JSON.parse(text);
      const ct = gt.credentialType!;
      if (!perType[ct]) perType[ct] = { correct: 0, total: 0 };
      perType[ct].total++;
      total++;
      if (parsed.credentialType === ct) { correct++; perType[ct].correct++; }
      if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/50 acc=${(correct / total * 100).toFixed(1)}%`);
    } catch { errors++; }
    if (i % 5 === 4) await new Promise((r) => setTimeout(r, 1000));
  }

  console.log();
  console.log('=== Gemini Golden v2 Quick Eval (credentialType accuracy) ===');
  console.log(`Overall: ${(correct / total * 100).toFixed(1)}% (${correct}/${total})`);
  console.log(`Errors: ${errors}`);
  console.log();
  for (const [t, s] of Object.entries(perType).sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${t}: ${(s.correct / s.total * 100).toFixed(0)}% (${s.correct}/${s.total})`);
  }
}

main().catch((err) => {
  console.error('EVAL FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
