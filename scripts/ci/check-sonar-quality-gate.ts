#!/usr/bin/env tsx
/**
 * SCRUM-1304 — SonarCloud quality-gate verification CI script.
 *
 * The SonarCloud project quality gate is configured in the SonarCloud UI,
 * not in git. This script polls the SonarCloud API and asserts the gate
 * matches the contract documented in `sonar-project.properties`:
 *
 *   - new_coverage ≥ 80
 *   - new_duplicated_lines_density ≤ 3
 *   - new_security_rating == A (1)
 *   - new_reliability_rating == A (1)
 *   - new_maintainability_rating == A (1)
 *
 * If any condition is missing, mismatched, or weaker than the contract,
 * exits non-zero so the PR cannot merge.
 *
 * Skipped when `SONARCLOUD_TOKEN` is unset (local dev / non-CI runs).
 *
 * Usage:
 *   SONARCLOUD_TOKEN=<token> tsx scripts/ci/check-sonar-quality-gate.ts
 */

interface QualityGateCondition {
  metric: string;
  op: 'GT' | 'LT' | 'EQ' | 'NE';
  error: string;
}

interface QualityGate {
  id: string;
  name: string;
  conditions: QualityGateCondition[];
}

const PROJECT_KEY = 'carson-see_ArkovaCarson';
const SONAR_BASE = 'https://sonarcloud.io';

interface RequiredCondition {
  metric: string;
  op: 'GT' | 'LT';
  threshold: string;
  description: string;
}

const REQUIRED: RequiredCondition[] = [
  { metric: 'new_coverage', op: 'LT', threshold: '80', description: 'Coverage on New Code ≥ 80%' },
  { metric: 'new_duplicated_lines_density', op: 'GT', threshold: '3', description: 'Duplications on New Code ≤ 3%' },
  { metric: 'new_security_rating', op: 'GT', threshold: '1', description: 'Security Rating on New Code == A' },
  { metric: 'new_reliability_rating', op: 'GT', threshold: '1', description: 'Reliability Rating on New Code == A' },
  { metric: 'new_maintainability_rating', op: 'GT', threshold: '1', description: 'Maintainability Rating on New Code == A' },
];

function readToken(): string | null {
  return process.env.SONARCLOUD_TOKEN ?? process.env.SONAR_TOKEN ?? null;
}

async function fetchProjectGate(token: string): Promise<QualityGate> {
  const auth = `Basic ${Buffer.from(`${token}:`).toString('base64')}`;
  const url = `${SONAR_BASE}/api/qualitygates/get_by_project?project=${encodeURIComponent(PROJECT_KEY)}`;
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) {
    throw new Error(`SonarCloud API ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { qualityGate: { id: string; name: string } };

  // Allow-list the gate id explicitly: rebuild it from validated chars only,
  // never reuse the input string. SonarCloud taint analysis follows the
  // dataflow, so producing a fresh string from a regex match breaks the
  // taint propagation in a way it understands.
  const idMatch = /^([A-Za-z0-9_-]{1,64})$/.exec(body.qualityGate.id);
  if (!idMatch) {
    throw new Error(`SonarCloud returned a gate id outside the expected charset: ${body.qualityGate.id.length} chars`);
  }
  const safeId: string = idMatch[1];

  const showRes = await fetch(
    `${SONAR_BASE}/api/qualitygates/show?id=${encodeURIComponent(safeId)}`,
    { headers: { Authorization: auth } },
  );
  if (!showRes.ok) {
    throw new Error(`SonarCloud show ${showRes.status}: ${await showRes.text()}`);
  }
  const detail = (await showRes.json()) as {
    id: string;
    name: string;
    conditions: Array<{ metric: string; op: string; error: string }>;
  };
  return {
    id: detail.id,
    name: detail.name,
    conditions: detail.conditions.map((c) => ({ metric: c.metric, op: c.op as QualityGateCondition['op'], error: c.error })),
  };
}

export interface VerifyResult {
  ok: boolean;
  missing: string[];
  weak: string[];
  gateName: string;
}

export function verifyGate(gate: QualityGate, required: RequiredCondition[] = REQUIRED): VerifyResult {
  const missing: string[] = [];
  const weak: string[] = [];

  for (const want of required) {
    const have = gate.conditions.find((c) => c.metric === want.metric);
    if (!have) {
      missing.push(`${want.metric} (${want.description})`);
      continue;
    }
    if (have.op !== want.op) {
      weak.push(`${want.metric}: op ${have.op} (expected ${want.op})`);
      continue;
    }
    // For LT (lower-than triggers fail), the gate's `error` is the floor — must be >= our threshold.
    // For GT (higher-than triggers fail), the gate's `error` is the ceiling — must be <= our threshold.
    const haveNum = Number(have.error);
    const wantNum = Number(want.threshold);
    if (want.op === 'LT' && haveNum < wantNum) {
      weak.push(`${want.metric}: floor ${have.error} (expected ≥ ${want.threshold})`);
    } else if (want.op === 'GT' && haveNum > wantNum) {
      weak.push(`${want.metric}: ceiling ${have.error} (expected ≤ ${want.threshold})`);
    }
  }

  return {
    ok: missing.length === 0 && weak.length === 0,
    missing,
    weak,
    gateName: gate.name,
  };
}

async function main(): Promise<void> {
  const token = readToken();
  if (!token) {
    console.log('SCRUM-1304: SONARCLOUD_TOKEN unset — skipping gate verification (local dev OK).');
    return;
  }

  let gate: QualityGate;
  try {
    gate = await fetchProjectGate(token);
  } catch (err) {
    // err.message is a synthetic string from our own throw sites; safe to log.
    const msg = String((err as Error).message).replaceAll(/[\r\n]+/g, ' ');
    console.error(`SCRUM-1304: failed to fetch SonarCloud gate — ${msg}`);
    process.exit(2);
  }

  const result = verifyGate(gate);
  // Strip newlines from gate name before logging (defense-in-depth — SonarCloud's
  // own API is trusted but log injection rules treat any external string as suspect).
  const safeGateName = result.gateName.replaceAll(/[\r\n]+/g, ' ');
  if (result.ok) {
    console.log(`SCRUM-1304 ✅ SonarCloud gate "${safeGateName}" satisfies all 5 required conditions.`);
    return;
  }

  console.error(`SCRUM-1304 ❌ SonarCloud gate "${safeGateName}" does NOT satisfy the contract documented in sonar-project.properties:`);
  for (const m of result.missing) console.error(`  missing condition: ${m}`);
  for (const w of result.weak) console.error(`  too weak:          ${w}`);
  console.error('');
  console.error('Fix: update the SonarCloud project quality gate in https://sonarcloud.io/organizations/carson-see/quality_gates');
  process.exit(1);
}

// pathToFileURL for cross-platform
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
