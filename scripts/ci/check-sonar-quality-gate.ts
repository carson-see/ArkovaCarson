#!/usr/bin/env tsx
/**
 * SCRUM-1304 / SCRUM-1681 — SonarCloud quality-gate verification CI script.
 *
 * The SonarCloud project quality gate is configured in the SonarCloud UI,
 * not in git. This script polls the SonarCloud API and asserts the gate
 * matches the contract documented in `sonar-project.properties`, and that
 * the project New Code Definition cannot drift back to `previous_version`:
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
const ORGANIZATION = 'carson-see';
const SONAR_BASE = 'https://sonarcloud.io';
const NEW_CODE_TYPE_KEY = 'sonar.leak.period.type';
const NEW_CODE_PERIOD_KEY = 'sonar.leak.period';
const NEW_CODE_RESET_FLOOR = '2026-05-05';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface RequiredCondition {
  metric: string;
  op: 'GT' | 'LT';
  threshold: string;
  description: string;
}

interface SonarSetting {
  key: string;
  value?: string;
}

type SonarSettings = Record<string, string | undefined>;

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

function authHeader(token: string): string {
  const tokenWithDelimiter = `${token}:`;
  const encoded = Buffer.from(tokenWithDelimiter).toString('base64');
  return `Basic ${encoded}`;
}

// Allow-list of acceptable SonarCloud gate names. The repo's gate is
// "Sonar way" (project-default); a fork could be named "Sonar way (Built-in)".
// We never let an arbitrary string from the API reach a fetch URL — the API
// response is matched against this fixed set, and the FIXED literal is the
// value that flows into the URL. SonarCloud taint analysis (S8476)
// recognizes string literals as untainted.
const ALLOWED_GATE_NAMES: readonly string[] = [
  'Sonar way',
  'Sonar way (Built-in)',
] as const;

async function fetchProjectGate(token: string): Promise<QualityGate> {
  const auth = authHeader(token);
  const projectRes = await fetch(
    `${SONAR_BASE}/api/qualitygates/get_by_project?organization=${encodeURIComponent(ORGANIZATION)}&project=${encodeURIComponent(PROJECT_KEY)}`,
    { headers: { Authorization: auth } },
  );
  if (!projectRes.ok) {
    throw new Error(`SonarCloud API ${projectRes.status}: ${await projectRes.text()}`);
  }
  const { qualityGate } = (await projectRes.json()) as {
    qualityGate: { name: string };
  };

  // Lookup the API-returned name in our fixed allow-list and use the
  // matching literal — never the API value itself. If the gate is renamed
  // to something we don't recognize, fail loud so an operator updates this
  // list rather than silently letting a tainted string flow into the URL.
  const allowedName = ALLOWED_GATE_NAMES.find((candidate) => candidate === qualityGate.name);
  if (!allowedName) {
    throw new Error(
      `SonarCloud quality gate "${qualityGate.name.length}-char value" is not in the allow-list. ` +
        `Update ALLOWED_GATE_NAMES in scripts/ci/check-sonar-quality-gate.ts.`,
    );
  }

  const showRes = await fetch(
    `${SONAR_BASE}/api/qualitygates/show?organization=${encodeURIComponent(ORGANIZATION)}&name=${encodeURIComponent(allowedName)}`,
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
    conditions: detail.conditions.map((c) => ({
      metric: c.metric,
      op: c.op as QualityGateCondition['op'],
      error: c.error,
    })),
  };
}

async function fetchProjectSettings(token: string): Promise<SonarSettings> {
  const auth = authHeader(token);
  const keys = [NEW_CODE_TYPE_KEY, NEW_CODE_PERIOD_KEY].join(',');
  const settingsRes = await fetch(
    `${SONAR_BASE}/api/settings/values?component=${encodeURIComponent(PROJECT_KEY)}&keys=${encodeURIComponent(keys)}`,
    { headers: { Authorization: auth } },
  );
  if (!settingsRes.ok) {
    throw new Error(`SonarCloud settings ${settingsRes.status}: ${await settingsRes.text()}`);
  }
  const { settings } = (await settingsRes.json()) as { settings: SonarSetting[] };
  return Object.fromEntries(settings.map((setting) => [setting.key, setting.value]));
}

export interface VerifyResult {
  ok: boolean;
  missing: string[];
  weak: string[];
  gateName: string;
}

export interface NewCodeDefinitionResult {
  ok: boolean;
  failures: string[];
  baselineType: string;
  baselineValue: string;
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

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeValue(value: string): string {
  return value.replaceAll(/[\r\n]+/g, ' ');
}

function isRealIsoDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  );
}

export function shouldFailOnMissingToken(env: Partial<Pick<NodeJS.ProcessEnv, 'CI' | 'GITHUB_ACTIONS'>> = process.env): boolean {
  return env.CI === 'true' || env.GITHUB_ACTIONS === 'true';
}

export function verifyNewCodeDefinition(
  settings: SonarSettings,
  today: string = utcToday(),
): NewCodeDefinitionResult {
  const baselineType = settings[NEW_CODE_TYPE_KEY] ?? '';
  const baselineValue = settings[NEW_CODE_PERIOD_KEY] ?? '';
  const failures: string[] = [];

  if (!baselineType) {
    failures.push(`${NEW_CODE_TYPE_KEY} missing; expected date`);
  } else if (baselineType !== 'date') {
    failures.push(`${NEW_CODE_TYPE_KEY} is ${safeValue(baselineType)}; expected date`);
  }

  if (!baselineValue) {
    failures.push(`${NEW_CODE_PERIOD_KEY} missing; expected YYYY-MM-DD date >= ${NEW_CODE_RESET_FLOOR}`);
  } else if (baselineValue === 'previous_version') {
    failures.push(`${NEW_CODE_PERIOD_KEY} is previous_version; expected YYYY-MM-DD date >= ${NEW_CODE_RESET_FLOOR}`);
  } else if (!ISO_DATE.test(baselineValue)) {
    failures.push(`${NEW_CODE_PERIOD_KEY} is ${safeValue(baselineValue)}; expected YYYY-MM-DD date`);
  } else if (!isRealIsoDate(baselineValue)) {
    failures.push(`${NEW_CODE_PERIOD_KEY} ${baselineValue} is not a real calendar date`);
  } else if (baselineValue < NEW_CODE_RESET_FLOOR) {
    failures.push(`${NEW_CODE_PERIOD_KEY} ${baselineValue} is before reset floor ${NEW_CODE_RESET_FLOOR}`);
  } else if (baselineValue > today) {
    failures.push(`${NEW_CODE_PERIOD_KEY} ${baselineValue} is in the future relative to ${today}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    baselineType,
    baselineValue,
  };
}

async function main(): Promise<void> {
  const token = readToken();
  if (!token) {
    if (shouldFailOnMissingToken()) {
      console.error('SCRUM-1304/SCRUM-1681: SONARCLOUD_TOKEN unset in CI — failing closed.');
      process.exit(1);
    }
    console.log('SCRUM-1304/SCRUM-1681: SONARCLOUD_TOKEN unset — skipping gate verification (local dev OK).');
    return;
  }

  let gate: QualityGate;
  let settings: SonarSettings;
  try {
    [gate, settings] = await Promise.all([
      fetchProjectGate(token),
      fetchProjectSettings(token),
    ]);
  } catch (err) {
    // err.message is a synthetic string from our own throw sites; safe to log.
    const msg = String((err as Error).message).replaceAll(/[\r\n]+/g, ' ');
    console.error(`SCRUM-1304/SCRUM-1681: failed to fetch SonarCloud gate/settings — ${msg}`);
    process.exit(2);
  }

  const result = verifyGate(gate);
  const ncdResult = verifyNewCodeDefinition(settings);
  // Strip newlines from gate name before logging (defense-in-depth — SonarCloud's
  // own API is trusted but log injection rules treat any external string as suspect).
  const safeGateName = result.gateName.replaceAll(/[\r\n]+/g, ' ');
  if (result.ok && ncdResult.ok) {
    console.log(
      `SCRUM-1304/SCRUM-1681 ✅ SonarCloud gate "${safeGateName}" satisfies all 5 required conditions; ` +
        `New Code Definition is ${ncdResult.baselineType}/${ncdResult.baselineValue}.`,
    );
    return;
  }

  console.error(`SCRUM-1304/SCRUM-1681 ❌ SonarCloud project "${PROJECT_KEY}" does NOT satisfy the CI contract:`);
  if (!result.ok) {
    console.error(`Quality Gate "${safeGateName}" does NOT satisfy sonar-project.properties:`);
  }
  for (const m of result.missing) console.error(`  missing condition: ${m}`);
  for (const w of result.weak) console.error(`  too weak:          ${w}`);
  for (const failure of ncdResult.failures) console.error(`  new-code drift:   ${failure}`);
  console.error('');
  console.error('Fix: update SonarCloud Quality Gate / New Code Definition in https://sonarcloud.io/project/overview?id=carson-see_ArkovaCarson');
  process.exit(1);
}

// pathToFileURL for cross-platform
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
