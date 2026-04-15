#!/usr/bin/env npx tsx
/**
 * Check Training Status — monitors Nessie (Together.ai) and Gemini (Vertex AI) jobs.
 *
 * Usage:
 *   npx tsx scripts/check-training-status.ts
 */

import { execSync } from 'node:child_process';
import 'dotenv/config';

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY || '';
const NESSIE_JOB_ID = 'ft-dc9dcbfd-b020';
const GEMINI_JOB = 'projects/270018525501/locations/us-central1/tuningJobs/6967412616062828544';

async function checkNessie() {
  console.log('=== NESSIE v6 (Together.ai) ===');
  const resp = await fetch(`https://api.together.xyz/v1/fine-tunes/${NESSIE_JOB_ID}`, {
    headers: { 'Authorization': `Bearer ${TOGETHER_API_KEY}` },
  });
  const data = await resp.json() as Record<string, unknown>;
  console.log(`  Status:      ${data.status}`);
  console.log(`  Output:      ${data.output_name || 'pending'}`);
  console.log(`  Created:     ${data.created_at}`);

  const events = (data.events || []) as Array<Record<string, string>>;
  if (events.length > 0) {
    console.log(`  Last event:  ${events[events.length - 1]?.message || events[events.length - 1]}`);
  }

  if (data.status === 'completed') {
    console.log(`\n  MODEL READY: ${data.output_name}`);
    console.log(`  Deploy to RunPod to use.`);
  }

  return data.status as string;
}

async function checkGemini() {
  console.log('\n=== GEMINI Golden v5 (Vertex AI) ===');
  try {
    const token = execSync('gcloud auth print-access-token', { encoding: 'utf-8' }).trim();
    const resp = await fetch(
      `https://us-central1-aiplatform.googleapis.com/v1/${GEMINI_JOB}`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    );
    const data = await resp.json() as Record<string, unknown>;
    console.log(`  State:       ${data.state}`);
    console.log(`  Display:     ${data.tunedModelDisplayName}`);
    console.log(`  Base:        ${data.baseModel}`);

    const endpoint = data.tunedModelEndpointName as string | undefined;
    if (endpoint) {
      console.log(`  Endpoint:    ${endpoint}`);
    }

    const tunedModel = data.tunedModel as Record<string, unknown> | undefined;
    if (tunedModel) {
      console.log(`  Model:       ${tunedModel.model || tunedModel.name}`);
      console.log(`  Endpoint:    ${tunedModel.endpoint}`);
    }

    if (data.state === 'JOB_STATE_SUCCEEDED') {
      console.log(`\n  MODEL READY — update GEMINI_TUNED_MODEL in .env`);
      if (tunedModel?.endpoint) {
        console.log(`  New value: ${tunedModel.endpoint}`);
      }
    }

    return data.state as string;
  } catch (err) {
    console.log(`  Error: ${err}`);
    return 'ERROR';
  }
}

async function main() {
  console.log(`Training Status Check — ${new Date().toISOString()}\n`);

  const nessieStatus = await checkNessie();
  const geminiStatus = await checkGemini();

  console.log('\n=== SUMMARY ===');
  console.log(`  Nessie v6:  ${nessieStatus}`);
  console.log(`  Gemini v5:  ${geminiStatus}`);

  if (nessieStatus === 'completed' && geminiStatus === 'JOB_STATE_SUCCEEDED') {
    console.log('\n  BOTH COMPLETE — ready for deployment!');
  }
}

main().catch(console.error);
