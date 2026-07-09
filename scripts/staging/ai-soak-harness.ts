#!/usr/bin/env -S npx tsx
/**
 * scripts/staging/ai-soak-harness.ts - focused live AI soak harness.
 *
 * This intentionally avoids generic health checks. Each iteration exercises
 * the changed AI flow:
 *   1. POST /api/v1/ai/extract with PII-stripped synthetic metadata text.
 *   2. POST /api/v1/ai/template with the extracted fields from step 1.
 *
 * Auth:
 *   - Authorization carries the Supabase user JWT required by app auth.
 *   - X-Serverless-Authorization carries the Cloud Run IAM identity token.
 *
 * Evidence never records JWTs, identity tokens, request text, or response field
 * values. It only records endpoint/status/latency/provider summaries.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { resolveStagingApiBase } from './load-harness-env';

export const AI_SOAK_ENDPOINTS = ['/api/v1/ai/extract', '/api/v1/ai/template'] as const;

const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin';
const IAM_TTL_MS = 30 * 60_000;
const SUPABASE_JWT_REFRESH_SKEW_MS = 5 * 60_000;
const DEFAULT_DURATION_MINUTES = 15;
const DEFAULT_RATE_PER_MINUTE = 6;
const DEFAULT_CONCURRENCY = 2;

type Env = Record<string, string | undefined>;

interface DirectJwtAuth {
  kind: 'direct-jwt';
  source: string;
  token: string;
}

interface PasswordGrantAuth {
  kind: 'supabase-password';
  supabaseUrl: string;
  anonKey: string;
  email: string;
  password: string;
}

export type AiSoakAuthConfig = DirectJwtAuth | PasswordGrantAuth;

export interface AiSoakConfig {
  apiBase: string;
  durationMinutes: number;
  ratePerMinute: number;
  concurrency: number;
  evidenceOut?: string;
  dryRun: boolean;
  requireLiveProvider: boolean;
  maxIterations?: number;
  skipCloudRunIam: boolean;
  auth: AiSoakAuthConfig;
}

export interface ExtractionFixture {
  strippedText: string;
  credentialType: string;
  fingerprint: string;
  issuerHint: string;
}

export interface EndpointOutcome {
  endpoint: string;
  status: number;
  latencyMs: number;
  ok: boolean;
  provider?: string;
  failure?: string;
}

export interface RunStats {
  startedAt: number;
  endedAt: number;
  outcomes: EndpointOutcome[];
}

interface EvidenceEndpointSummary {
  ok: number;
  fail: number;
  latencyMs: {
    p50: number;
    p95: number;
    p99: number;
  };
  byStatus: Record<string, number>;
}

export interface AiSoakEvidence {
  startedAt: string;
  endedAt: string;
  target: {
    apiBase: string;
    endpoints: typeof AI_SOAK_ENDPOINTS;
  };
  auth: {
    jwtSource: string;
    cloudRunIam: 'x-serverless-authorization' | 'skipped';
  };
  requireLiveProvider: boolean;
  totals: {
    ok: number;
    fail: number;
    requests: number;
  };
  byEndpoint: Record<string, EvidenceEndpointSummary>;
  providers: Record<string, number>;
  failures: Record<string, number>;
}

interface RuntimeAuth {
  supabaseJwt?: string;
  supabaseJwtExpiresAt: number;
  cloudRunIdentityToken?: string;
  cloudRunTokenFetchedAt: number;
}

export function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'y'].includes(value.trim().toLowerCase());
}

function parsePositiveNumber(label: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return parsed;
}

function parsePositiveInteger(label: string, value: string | undefined, fallback: number): number {
  const parsed = parsePositiveNumber(label, value, fallback);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  return parsed;
}

function findFirstEnv(env: Env, keys: string[]): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return { key, value };
  }
  return undefined;
}

function looksLikeJwt(value: string): boolean {
  return value.split('.').length === 3;
}

function requireJwtShape(source: string, token: string): string {
  if (!looksLikeJwt(token)) {
    throw new Error(`${source} must contain a JWT-looking token with three dot-separated segments.`);
  }
  return token;
}

export function resolveAiSoakAuth(env: Env): AiSoakAuthConfig {
  const directJwt = findFirstEnv(env, ['AI_SOAK_JWT', 'STAGING_SUPABASE_JWT', 'STAGING_AUTH_JWT']);
  if (directJwt) {
    return {
      kind: 'direct-jwt',
      source: directJwt.key,
      token: requireJwtShape(directJwt.key, directJwt.value),
    };
  }

  const supabaseUrl = (env.AI_SOAK_SUPABASE_URL ?? env.STAGING_SUPABASE_URL)?.trim();
  const anonKey = (env.AI_SOAK_SUPABASE_ANON_KEY ?? env.STAGING_SUPABASE_ANON_KEY)?.trim();
  const email = env.AI_SOAK_USER_EMAIL?.trim();
  const password = env.AI_SOAK_USER_PASSWORD?.trim();

  if (supabaseUrl && anonKey && email && password) {
    return {
      kind: 'supabase-password',
      supabaseUrl,
      anonKey,
      email,
      password,
    };
  }

  throw new Error(
    'AI soak requires a live Supabase user JWT via AI_SOAK_JWT, STAGING_SUPABASE_JWT, or STAGING_AUTH_JWT; ' +
      'or a password-grant login via AI_SOAK_SUPABASE_URL/STAGING_SUPABASE_URL, ' +
      'AI_SOAK_SUPABASE_ANON_KEY/STAGING_SUPABASE_ANON_KEY, AI_SOAK_USER_EMAIL, and AI_SOAK_USER_PASSWORD.',
  );
}

export function buildConfigFromArgv(argv: string[], env: Env = process.env): AiSoakConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      duration: { type: 'string', default: String(DEFAULT_DURATION_MINUTES) },
      rate: { type: 'string', default: String(DEFAULT_RATE_PER_MINUTE) },
      concurrency: { type: 'string', default: String(DEFAULT_CONCURRENCY) },
      'max-iterations': { type: 'string' },
      'evidence-out': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'allow-mock-provider': { type: 'boolean', default: false },
      'skip-cloud-run-iam': { type: 'boolean', default: false },
    },
  });

  return {
    apiBase: resolveStagingApiBase(env),
    durationMinutes: parsePositiveNumber('duration', values.duration, DEFAULT_DURATION_MINUTES),
    ratePerMinute: parsePositiveNumber('rate', values.rate, DEFAULT_RATE_PER_MINUTE),
    concurrency: parsePositiveInteger('concurrency', values.concurrency, DEFAULT_CONCURRENCY),
    maxIterations: values['max-iterations'] === undefined
      ? undefined
      : parsePositiveInteger('max-iterations', values['max-iterations'], 1),
    evidenceOut: values['evidence-out'],
    dryRun: values['dry-run'] === true,
    requireLiveProvider: values['allow-mock-provider'] !== true,
    skipCloudRunIam: values['skip-cloud-run-iam'] === true || parseBooleanEnv(env.AI_SOAK_SKIP_IAM),
    auth: resolveAiSoakAuth(env),
  };
}

export function buildExtractionFixture(iteration: number, nonce: string = randomUUID()): ExtractionFixture {
  const strippedText = [
    'Great Lakes Compliance Institute',
    'Continuing Professional Education Certificate',
    'Recipient: [NAME_REDACTED]',
    `Course ID: AI-SOAK-${iteration}`,
    'Issued: 2026-05-12',
    'Credits: 4.0 Ethics',
    'Jurisdiction: Michigan',
    'License identifier: [IDENTIFIER_REDACTED]',
    'This synthetic fixture contains extracted-style metadata only.',
  ].join('\n');

  return {
    strippedText,
    credentialType: 'CPE',
    issuerHint: 'Great Lakes Compliance Institute',
    fingerprint: createHash('sha256').update(`${nonce}:${strippedText}`).digest('hex'),
  };
}

export function isLiveExtractionProvider(provider: string | undefined, degraded: boolean | undefined): boolean {
  if (!provider || degraded === true) return false;
  const normalized = provider.toLowerCase();
  return !normalized.includes('mock') && !normalized.includes('fallback') && normalized !== 'cache';
}

export function buildRequestHeaders(params: {
  supabaseJwt: string;
  cloudRunIdentityToken?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.supabaseJwt}`,
    'Content-Type': 'application/json',
    'User-Agent': 'arkova-ai-soak-harness/1.0',
    'X-Arkova-Soak': 'ai-template-review',
  };

  if (params.cloudRunIdentityToken) {
    headers['X-Serverless-Authorization'] = `Bearer ${params.cloudRunIdentityToken}`;
  }

  return headers;
}

async function loginForSupabaseJwt(auth: PasswordGrantAuth): Promise<{ token: string; expiresAt: number }> {
  const base = auth.supabaseUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: auth.anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: auth.email,
      password: auth.password,
    }),
  });

  if (!response.ok) {
    throw new Error(`Supabase password grant failed with HTTP ${response.status}.`);
  }

  const json = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof json.access_token !== 'string') {
    throw new Error('Supabase password grant did not return an access_token.');
  }

  const expiresInSeconds = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in)
    ? json.expires_in
    : 3600;
  return {
    token: requireJwtShape('Supabase password grant access_token', json.access_token),
    expiresAt: Date.now() + Math.max(60, expiresInSeconds) * 1000,
  };
}

async function ensureSupabaseJwt(config: AiSoakConfig, runtimeAuth: RuntimeAuth): Promise<string> {
  if (config.auth.kind === 'direct-jwt') return config.auth.token;
  if (
    runtimeAuth.supabaseJwt &&
    Date.now() < runtimeAuth.supabaseJwtExpiresAt - SUPABASE_JWT_REFRESH_SKEW_MS
  ) {
    return runtimeAuth.supabaseJwt;
  }

  const login = await loginForSupabaseJwt(config.auth);
  runtimeAuth.supabaseJwt = login.token;
  runtimeAuth.supabaseJwtExpiresAt = login.expiresAt;
  return runtimeAuth.supabaseJwt;
}

function resolveGcloudPath(env: Env): string {
  const override = env.GCLOUD_PATH?.trim();
  if (override) return override;
  try {
    const out = execFileSync('/usr/bin/which', ['gcloud'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: SAFE_PATH },
    });
    return out.trim();
  } catch {
    return '/usr/local/bin/gcloud';
  }
}

export function resolveCloudRunIamAudience(apiBase: string, env: Env = process.env): string {
  const override = (env.AI_SOAK_CLOUD_RUN_AUDIENCE ?? env.STAGING_GCP_AUDIENCE)?.trim();
  if (override) return override;

  const url = new URL(apiBase);
  const separator = '---';
  const separatorIndex = url.hostname.indexOf(separator);
  if (separatorIndex > 0) {
    url.hostname = url.hostname.slice(separatorIndex + separator.length);
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  }

  return apiBase;
}

function fetchCloudRunIdentityToken(apiBase: string, env: Env): string {
  const envToken = env.STAGING_GCP_IDENTITY?.trim();
  if (envToken) return envToken;

  const audience = resolveCloudRunIamAudience(apiBase, env);
  const gcloud = resolveGcloudPath(env);
  try {
    const out = execFileSync(gcloud, ['auth', 'print-identity-token', `--audiences=${audience}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: SAFE_PATH },
    });
    return out.trim();
  } catch (err) {
    throw new Error(`Could not fetch Cloud Run IAM token via ${gcloud}: ${err instanceof Error ? err.message : err}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function ensureCloudRunIdentityToken(
  config: AiSoakConfig,
  runtimeAuth: RuntimeAuth,
  env: Env,
): Promise<string | undefined> {
  if (config.skipCloudRunIam) return undefined;
  if (
    runtimeAuth.cloudRunIdentityToken &&
    Date.now() - runtimeAuth.cloudRunTokenFetchedAt < IAM_TTL_MS
  ) {
    return runtimeAuth.cloudRunIdentityToken;
  }

  runtimeAuth.cloudRunIdentityToken = fetchCloudRunIdentityToken(config.apiBase, env);
  runtimeAuth.cloudRunTokenFetchedAt = Date.now();
  return runtimeAuth.cloudRunIdentityToken;
}

function extractTemplateFields(json: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(json)) return undefined;
  return isPlainObject(json.fields) ? json.fields : undefined;
}

function isTemplateResponse(json: unknown): boolean {
  if (!isPlainObject(json)) return false;
  return (
    typeof json.templateType === 'string' &&
    typeof json.documentTitle === 'string' &&
    Array.isArray(json.sections) &&
    Array.isArray(json.tags)
  );
}

async function postJson(params: {
  config: AiSoakConfig;
  runtimeAuth: RuntimeAuth;
  env: Env;
  endpoint: typeof AI_SOAK_ENDPOINTS[number];
  body: unknown;
}): Promise<{ outcome: EndpointOutcome; json: unknown }> {
  const startedAt = Date.now();
  let status = 0;
  let json: unknown;
  let ok = false;
  let failure: string | undefined;

  try {
    const supabaseJwt = await ensureSupabaseJwt(params.config, params.runtimeAuth);
    const cloudRunIdentityToken = await ensureCloudRunIdentityToken(params.config, params.runtimeAuth, params.env);
    const response = await fetch(`${params.config.apiBase}${params.endpoint}`, {
      method: 'POST',
      headers: buildRequestHeaders({
        supabaseJwt,
        cloudRunIdentityToken,
      }),
      body: JSON.stringify(params.body),
    });

    status = response.status;
    json = await readJson(response);
    ok = response.ok;
    if (!ok) failure = `http_${status}`;
  } catch (err) {
    failure = err instanceof Error ? err.name : 'request_error';
  }

  return {
    json,
    outcome: {
      endpoint: params.endpoint,
      status,
      latencyMs: Date.now() - startedAt,
      ok,
      failure,
    },
  };
}

async function runIteration(params: {
  config: AiSoakConfig;
  runtimeAuth: RuntimeAuth;
  env: Env;
  iteration: number;
}): Promise<EndpointOutcome[]> {
  const fixture = buildExtractionFixture(params.iteration);
  const extract = await postJson({
    config: params.config,
    runtimeAuth: params.runtimeAuth,
    env: params.env,
    endpoint: '/api/v1/ai/extract',
    body: fixture,
  });

  if (isPlainObject(extract.json)) {
    const provider = typeof extract.json.provider === 'string' ? extract.json.provider : undefined;
    extract.outcome.provider = provider;
    if (
      extract.outcome.ok &&
      params.config.requireLiveProvider &&
      !isLiveExtractionProvider(provider, extract.json.degraded === true)
    ) {
      extract.outcome.ok = false;
      extract.outcome.failure = 'non_live_provider';
    }
  }

  const fields = extractTemplateFields(extract.json);
  const confidence = isPlainObject(extract.json) && typeof extract.json.confidence === 'number'
    ? extract.json.confidence
    : undefined;

  if (!extract.outcome.ok || !fields || confidence === undefined) {
    return [extract.outcome];
  }

  const template = await postJson({
    config: params.config,
    runtimeAuth: params.runtimeAuth,
    env: params.env,
    endpoint: '/api/v1/ai/template',
    body: { fields, confidence },
  });

  if (template.outcome.ok && !isTemplateResponse(template.json)) {
    template.outcome.ok = false;
    template.outcome.failure = 'malformed_template_response';
  }

  return [extract.outcome, template.outcome];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[index];
}

export function summarizeRun(stats: RunStats, config: AiSoakConfig): AiSoakEvidence {
  const byEndpoint: Record<string, EvidenceEndpointSummary> = {};
  const providers: Record<string, number> = {};
  const failures: Record<string, number> = {};

  for (const endpoint of AI_SOAK_ENDPOINTS) {
    const outcomes = stats.outcomes.filter((outcome) => outcome.endpoint === endpoint);
    const latencies = outcomes.map((outcome) => outcome.latencyMs);
    byEndpoint[endpoint] = {
      ok: outcomes.filter((outcome) => outcome.ok).length,
      fail: outcomes.filter((outcome) => !outcome.ok).length,
      latencyMs: {
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
      },
      byStatus: outcomes.reduce<Record<string, number>>((acc, outcome) => {
        acc[String(outcome.status)] = (acc[String(outcome.status)] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }

  for (const outcome of stats.outcomes) {
    if (outcome.provider) providers[outcome.provider] = (providers[outcome.provider] ?? 0) + 1;
    if (outcome.failure) failures[outcome.failure] = (failures[outcome.failure] ?? 0) + 1;
  }

  const ok = stats.outcomes.filter((outcome) => outcome.ok).length;
  const fail = stats.outcomes.length - ok;

  return {
    startedAt: new Date(stats.startedAt).toISOString(),
    endedAt: new Date(stats.endedAt).toISOString(),
    target: {
      apiBase: config.apiBase,
      endpoints: AI_SOAK_ENDPOINTS,
    },
    auth: {
      jwtSource: config.auth.kind === 'direct-jwt' ? config.auth.source : 'supabase-password-grant',
      cloudRunIam: config.skipCloudRunIam ? 'skipped' : 'x-serverless-authorization',
    },
    requireLiveProvider: config.requireLiveProvider,
    totals: {
      ok,
      fail,
      requests: stats.outcomes.length,
    },
    byEndpoint,
    providers,
    failures,
  };
}

export async function runAiSoak(
  config: AiSoakConfig,
  env: Env = process.env,
): Promise<AiSoakEvidence> {
  const runtimeAuth: RuntimeAuth = {
    supabaseJwtExpiresAt: 0,
    cloudRunTokenFetchedAt: 0,
  };
  const stats: RunStats = { startedAt: Date.now(), endedAt: Date.now(), outcomes: [] };
  const endAt = stats.startedAt + config.durationMinutes * 60_000;
  const spacingMs = 60_000 / config.ratePerMinute;
  const active = new Set<Promise<void>>();
  let iteration = 0;
  let nextStartAt = Date.now();

  while (Date.now() < endAt && (config.maxIterations === undefined || iteration < config.maxIterations)) {
    while (active.size >= config.concurrency) {
      await Promise.race(active);
    }

    const currentIteration = iteration;
    const task = runIteration({ config, runtimeAuth, env, iteration: currentIteration })
      .then((outcomes) => {
        stats.outcomes.push(...outcomes);
      })
      .finally(() => {
        active.delete(task);
      });
    active.add(task);

    iteration += 1;
    if (config.maxIterations !== undefined && iteration >= config.maxIterations) {
      break;
    }

    nextStartAt += spacingMs;
    const waitMs = nextStartAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
  }

  await Promise.all(active);
  stats.endedAt = Date.now();
  return summarizeRun(stats, config);
}

function writeEvidence(path: string, evidence: AiSoakEvidence): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
}

function buildDryRunEvidence(config: AiSoakConfig): AiSoakEvidence {
  const now = Date.now();
  return summarizeRun({ startedAt: now, endedAt: now, outcomes: [] }, config);
}

export async function main(argv = process.argv.slice(2), env: Env = process.env): Promise<void> {
  const config = buildConfigFromArgv(argv, env);

  if (config.dryRun) {
    const evidence = buildDryRunEvidence(config);
    console.log(JSON.stringify({
      dryRun: true,
      durationMinutes: config.durationMinutes,
      ratePerMinute: config.ratePerMinute,
      concurrency: config.concurrency,
      maxIterations: config.maxIterations ?? null,
      evidence,
    }, null, 2));
    return;
  }

  const evidence = await runAiSoak(config, env);
  if (config.evidenceOut) writeEvidence(config.evidenceOut, evidence);
  console.log(JSON.stringify(evidence, null, 2));
  if (evidence.totals.fail > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`::error::${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
