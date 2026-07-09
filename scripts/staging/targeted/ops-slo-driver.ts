#!/usr/bin/env -S npx tsx
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

type CheckName = 'unauthenticated' | 'non_admin_forbidden' | 'platform_admin_stats';
type CheckStatus = 'pass' | 'fail';

export interface OpsSloDriverConfig {
  workerUrl: string;
  adminJwt: string;
  nonAdminJwt: string;
  cloudRunIdentityToken: string | null;
  cloudRunAudience: string;
  durationMin: number;
  intervalMs: number;
  concurrency: number;
  timeoutMs: number;
  evidenceOut: string | null;
  admissionOut: string | null;
  dryRun: boolean;
}

interface DriverArgs {
  durationMin: number;
  intervalMs: number;
  concurrency: number;
  timeoutMs: number;
  evidenceOut: string | null;
  admissionOut: string | null;
  dryRun: boolean;
}

interface HttpResult {
  status: number;
  body: unknown;
  latencyMs: number;
}

interface CheckResult {
  name: CheckName;
  status: CheckStatus;
  http_status: number;
  latency_ms: number;
  detail: string;
  body?: unknown;
}

export interface OpsSloEvidence {
  driver: 'ops-slo';
  pr: 1441;
  changed_behavior: 'GET /api/admin/ops-slo-stats platform-admin SLO stats contract';
  worker_url: string;
  endpoint: '/api/admin/ops-slo-stats';
  started_at: string;
  ended_at: string;
  duration_min: number;
  interval_ms: number;
  concurrency: number;
  cycles: number;
  all_expected: boolean;
  checks: CheckResult[];
}

export interface AdmissionBlocked {
  pr: 1441;
  driver: 'ops-slo';
  status: 'blocked';
  blocked_at: string;
  exact_head_required: '97b8e7555f74da3ceeb45d259e956201b4d32874';
  changed_behavior: 'GET /api/admin/ops-slo-stats platform-admin SLO stats contract';
  missing: string[];
  notes: string[];
}

const ENDPOINT = '/api/admin/ops-slo-stats' as const;
const DEFAULT_DURATION_MIN = 720;
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 10_000;

function parseCliArgs(argv: string[]): DriverArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) throw new Error(`Unexpected positional argument: ${raw}`);
    const arg = raw.slice(2);
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      values.set(arg.slice(0, eq), arg.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags.add(arg);
      continue;
    }
    values.set(arg, next);
    i += 1;
  }

  for (const forbidden of ['admin-jwt', 'non-admin-jwt', 'cloud-run-identity-token']) {
    if (values.has(forbidden)) {
      throw new Error(`Do not pass --${forbidden}; use environment variables so secrets stay out of shell history.`);
    }
  }

  const numberArg = (name: string, fallback: number): number => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number.`);
    return value;
  };

  return {
    durationMin: numberArg('duration-min', DEFAULT_DURATION_MIN),
    intervalMs: numberArg('interval-ms', DEFAULT_INTERVAL_MS),
    concurrency: Math.floor(numberArg('concurrency', DEFAULT_CONCURRENCY)),
    timeoutMs: numberArg('timeout-ms', DEFAULT_TIMEOUT_MS),
    evidenceOut: values.get('evidence-out') ?? null,
    admissionOut: values.get('admission-out') ?? null,
    dryRun: flags.has('dry-run'),
  };
}

function normalizeUrl(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} must use http or https.`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not include credentials.`);
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function firstEnv(env: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = (env[name] ?? '').trim();
    if (value) return value;
  }
  return '';
}

export function missingAdmissionInputs(env: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = [];
  if (!firstEnv(env, ['WORKER_URL', 'STAGING_API_BASE'])) {
    missing.push('WORKER_URL or STAGING_API_BASE for the deployed PR #1441 tag URL');
  }
  if (!firstEnv(env, ['OPS_SLO_ADMIN_JWT', 'STAGING_ADMIN_JWT'])) {
    missing.push('OPS_SLO_ADMIN_JWT or STAGING_ADMIN_JWT for a platform-admin Supabase JWT');
  }
  if (!firstEnv(env, ['OPS_SLO_NON_ADMIN_JWT', 'STAGING_NON_ADMIN_JWT'])) {
    missing.push('OPS_SLO_NON_ADMIN_JWT or STAGING_NON_ADMIN_JWT for an authenticated non-admin Supabase JWT');
  }
  if (!firstEnv(env, ['WORKER_IAM_TOKEN', 'CLOUD_RUN_IDENTITY_TOKEN', 'STAGING_GCP_IDENTITY'])) {
    missing.push('WORKER_IAM_TOKEN, CLOUD_RUN_IDENTITY_TOKEN, or STAGING_GCP_IDENTITY for Cloud Run tag ingress when the service is IAM-protected');
  }
  if (!firstEnv(env, ['CLOUD_RUN_AUDIENCE', 'STAGING_GCP_AUDIENCE', 'WORKER_URL', 'STAGING_API_BASE'])) {
    missing.push('CLOUD_RUN_AUDIENCE or STAGING_GCP_AUDIENCE for the Cloud Run identity-token audience');
  }
  return missing;
}

export function buildBlockedAdmission(
  missing: string[],
  now = new Date(),
): AdmissionBlocked {
  return {
    pr: 1441,
    driver: 'ops-slo',
    status: 'blocked',
    blocked_at: now.toISOString(),
    exact_head_required: '97b8e7555f74da3ceeb45d259e956201b4d32874',
    changed_behavior: 'GET /api/admin/ops-slo-stats platform-admin SLO stats contract',
    missing,
    notes: [
      'Do not start a T2 soak until the admin request returns 200, the non-admin request returns 403, and the unauthenticated request returns 401 against the exact deployed PR tag.',
      'Generic /health traffic is not change coverage for OPS-03.',
      'The driver refuses command-line JWT/token arguments to avoid leaking secrets into shell history.',
    ],
  };
}

export function parseConfig(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): OpsSloDriverConfig {
  const args = parseCliArgs(argv);
  const workerUrl = normalizeUrl(firstEnv(env, ['WORKER_URL', 'STAGING_API_BASE']), 'WORKER_URL / STAGING_API_BASE');
  const cloudRunAudience = normalizeUrl(
    firstEnv(env, ['CLOUD_RUN_AUDIENCE', 'STAGING_GCP_AUDIENCE', 'WORKER_URL', 'STAGING_API_BASE']),
    'CLOUD_RUN_AUDIENCE / STAGING_GCP_AUDIENCE',
  );
  return {
    workerUrl,
    adminJwt: firstEnv(env, ['OPS_SLO_ADMIN_JWT', 'STAGING_ADMIN_JWT']),
    nonAdminJwt: firstEnv(env, ['OPS_SLO_NON_ADMIN_JWT', 'STAGING_NON_ADMIN_JWT']),
    cloudRunIdentityToken: firstEnv(env, ['WORKER_IAM_TOKEN', 'CLOUD_RUN_IDENTITY_TOKEN', 'STAGING_GCP_IDENTITY']) || null,
    cloudRunAudience,
    ...args,
  };
}

function headers(jwt: string | null, cloudRunIdentityToken: string | null): Record<string, string> {
  const out: Record<string, string> = { Accept: 'application/json' };
  if (jwt) out.Authorization = `Bearer ${jwt}`;
  if (cloudRunIdentityToken) out['X-Serverless-Authorization'] = `Bearer ${cloudRunIdentityToken}`;
  return out;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 1000);
  }
}

async function getJson(
  url: string,
  requestHeaders: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<HttpResult> {
  const controller = new AbortController();
  const started = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: requestHeaders, signal: controller.signal });
    return { status: res.status, body: await readBody(res), latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

function surfaceAvailable(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  return Boolean(value && typeof value === 'object' && typeof (value as Record<string, unknown>).available === 'boolean');
}

export function hasOpsSloContract(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return (
    surfaceAvailable(record, 'anchorSecuredRate')
    && surfaceAvailable(record, 'connectorQueue')
    && surfaceAvailable(record, 'creditConservation')
    && surfaceAvailable(record, 'webhookDelivery')
    && surfaceAvailable(record, 'apiErrors')
    && typeof record.overallBreach === 'boolean'
    && typeof record.checkedAt === 'string'
  );
}

function toCheck(
  name: CheckName,
  result: HttpResult,
  pass: boolean,
  detail: string,
  captureBody = false,
): CheckResult {
  return {
    name,
    status: pass ? 'pass' : 'fail',
    http_status: result.status,
    latency_ms: result.latencyMs,
    detail,
    ...(captureBody ? { body: result.body } : {}),
  };
}

export async function runOneCycle(
  config: OpsSloDriverConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckResult[]> {
  const url = `${config.workerUrl}${ENDPOINT}`;
  const unauth = await getJson(url, headers(null, config.cloudRunIdentityToken), config.timeoutMs, fetchImpl);
  const nonAdmin = await getJson(url, headers(config.nonAdminJwt, config.cloudRunIdentityToken), config.timeoutMs, fetchImpl);
  const admin = await getJson(url, headers(config.adminJwt, config.cloudRunIdentityToken), config.timeoutMs, fetchImpl);

  return [
    toCheck('unauthenticated', unauth, unauth.status === 401, 'No app JWT must be rejected at the admin route.'),
    toCheck('non_admin_forbidden', nonAdmin, nonAdmin.status === 403, 'Authenticated non-admin JWT must be forbidden.'),
    toCheck(
      'platform_admin_stats',
      admin,
      admin.status === 200 && hasOpsSloContract(admin.body),
      'Platform-admin JWT must return the five-surface OPS SLO stats contract.',
      true,
    ),
  ];
}

function writeJson(path: string | null, value: unknown): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export async function runDriver(config: OpsSloDriverConfig): Promise<OpsSloEvidence> {
  const startedAt = new Date();
  const endAt = Date.now() + config.durationMin * 60_000;
  const checks: CheckResult[] = [];
  let cycles = 0;

  if (config.dryRun) {
    return {
      driver: 'ops-slo',
      pr: 1441,
      changed_behavior: 'GET /api/admin/ops-slo-stats platform-admin SLO stats contract',
      worker_url: config.workerUrl,
      endpoint: ENDPOINT,
      started_at: startedAt.toISOString(),
      ended_at: new Date().toISOString(),
      duration_min: config.durationMin,
      interval_ms: config.intervalMs,
      concurrency: config.concurrency,
      cycles: 0,
      all_expected: false,
      checks,
    };
  }

  while (Date.now() < endAt) {
    const batches = Array.from({ length: config.concurrency }, () => runOneCycle(config));
    for (const result of await Promise.all(batches)) checks.push(...result);
    cycles += config.concurrency;
    if (checks.some((check) => check.status === 'fail')) break;
    const remaining = endAt - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(config.intervalMs, remaining)));
  }

  return {
    driver: 'ops-slo',
    pr: 1441,
    changed_behavior: 'GET /api/admin/ops-slo-stats platform-admin SLO stats contract',
    worker_url: config.workerUrl,
    endpoint: ENDPOINT,
    started_at: startedAt.toISOString(),
    ended_at: new Date().toISOString(),
    duration_min: config.durationMin,
    interval_ms: config.intervalMs,
    concurrency: config.concurrency,
    cycles,
    all_expected: checks.length > 0 && checks.every((check) => check.status === 'pass'),
    checks,
  };
}

function usage(): string {
  return `
OPS-03 targeted T2 driver for PR #1441.

Required environment:
  WORKER_URL or STAGING_API_BASE        deployed PR #1441 tag URL
  OPS_SLO_ADMIN_JWT or STAGING_ADMIN_JWT
  OPS_SLO_NON_ADMIN_JWT or STAGING_NON_ADMIN_JWT

Optional Cloud Run ingress:
  WORKER_IAM_TOKEN, CLOUD_RUN_IDENTITY_TOKEN, or STAGING_GCP_IDENTITY
  CLOUD_RUN_AUDIENCE or STAGING_GCP_AUDIENCE defaults to the worker URL

Example:
  WORKER_URL=https://pr-1441---...a.run.app \\
  OPS_SLO_ADMIN_JWT=... OPS_SLO_NON_ADMIN_JWT=... \\
  CLOUD_RUN_IDENTITY_TOKEN=... \\
  npx tsx scripts/staging/targeted/ops-slo-driver.ts \\
    --duration-min 720 --concurrency 2 --evidence-out docs/staging/pr-1441/ops-slo-driver.json
`.trim();
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return;
  }

  const args = parseCliArgs(process.argv.slice(2));
  const missing = missingAdmissionInputs();
  if (missing.length > 0) {
    const blocked = buildBlockedAdmission(missing);
    writeJson(args.admissionOut, blocked);
    console.error(JSON.stringify(blocked, null, 2));
    process.exitCode = 2;
    return;
  }

  const config = parseConfig(process.argv.slice(2));
  const evidence = await runDriver(config);
  writeJson(config.evidenceOut, evidence);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.all_expected) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
