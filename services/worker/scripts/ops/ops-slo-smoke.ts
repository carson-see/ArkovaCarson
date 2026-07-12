#!/usr/bin/env -S npx tsx
import { pathToFileURL } from 'node:url';

type CheckStatus = 'pass' | 'fail' | 'skip';

export interface OpsSloSmokeOptions {
  workerUrl: string;
  dashboardUrl: string | null;
  adminJwt: string;
  nonAdminJwt: string;
  workerIamToken: string | null;
  timeoutMs: number;
}

interface HttpResult {
  status: number;
  body: unknown;
}

interface SmokeCheck {
  name: string;
  status: CheckStatus;
  http_status?: number;
  code?: string | null;
  detail: string;
}

export interface OpsSloSmokeResult {
  ok: boolean;
  worker_url: string;
  dashboard_url: string | null;
  endpoint: '/api/admin/ops-slo-stats';
  checks: SmokeCheck[];
}

interface SmokeDeps {
  fetchImpl?: typeof fetch;
}

function parseArgTokens(argv: string[]): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex >= 0) {
      values.set(withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1));
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags.add(withoutPrefix);
      continue;
    }

    values.set(withoutPrefix, next);
    i += 1;
  }
  return { values, flags };
}

function normalizeUrl(raw: string, label: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label} must be a non-empty URL.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label} must use http or https.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not include credentials.`);
  }

  parsed.hash = '';
  parsed.search = '';
  let pathname = parsed.pathname;
  while (pathname.endsWith('/') && pathname.length > 1) {
    pathname = pathname.slice(0, -1);
  }

  return `${parsed.origin}${pathname === '/' ? '' : pathname}`;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): OpsSloSmokeOptions {
  const { values } = parseArgTokens(argv);
  for (const forbidden of ['admin-jwt', 'non-admin-jwt', 'worker-iam-token']) {
    if (values.has(forbidden)) {
      throw new Error(`Do not pass --${forbidden} on the command line; use environment variables instead.`);
    }
  }

  const workerUrl = values.get('worker-url') ?? env.WORKER_URL ?? env.STAGING_API_BASE ?? '';
  const adminJwt = (env.OPS_SLO_ADMIN_JWT ?? '').trim();
  const nonAdminJwt = (env.OPS_SLO_NON_ADMIN_JWT ?? '').trim();
  if (!adminJwt) throw new Error('OPS_SLO_ADMIN_JWT is required.');
  if (!nonAdminJwt) throw new Error('OPS_SLO_NON_ADMIN_JWT is required.');

  const timeoutMs = Number(values.get('timeout-ms') ?? env.OPS_SLO_SMOKE_TIMEOUT_MS ?? '10000');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number.');
  }

  const dashboardUrl = values.get('dashboard-url') ?? env.OPS_SLO_DASHBOARD_URL ?? '';
  return {
    workerUrl: normalizeUrl(workerUrl, '--worker-url / WORKER_URL / STAGING_API_BASE'),
    dashboardUrl: dashboardUrl.trim() ? normalizeUrl(dashboardUrl, '--dashboard-url / OPS_SLO_DASHBOARD_URL') : null,
    adminJwt,
    nonAdminJwt,
    workerIamToken: (env.WORKER_IAM_TOKEN ?? env.CLOUD_RUN_IDENTITY_TOKEN ?? '').trim() || null,
    timeoutMs,
  };
}

function codeFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 500);
  }
}

async function getJson(args: {
  url: string;
  jwt: string | null;
  workerIamToken: string | null;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<HttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (args.jwt) headers.Authorization = `Bearer ${args.jwt}`;
  if (args.workerIamToken) headers['X-Serverless-Authorization'] = `Bearer ${args.workerIamToken}`;

  try {
    const res = await args.fetchImpl(args.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    return { status: res.status, body: await readBody(res) };
  } finally {
    clearTimeout(timeout);
  }
}

async function getDashboard(args: {
  url: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<HttpResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const res = await args.fetchImpl(args.url, {
      method: 'GET',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
    });
    return { status: res.status, body: await readBody(res) };
  } finally {
    clearTimeout(timeout);
  }
}

function hasOpsSloShape(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  return Boolean(
    record.anchorSecuredRate
    && record.connectorQueue
    && record.creditConservation
    && record.webhookDelivery
    && record.apiErrors
    && typeof record.overallBreach === 'boolean'
    && typeof record.checkedAt === 'string',
  );
}

function checkResult(name: string, http: HttpResult, pass: boolean, detail: string): SmokeCheck {
  return {
    name,
    status: pass ? 'pass' : 'fail',
    http_status: http.status,
    code: codeFromBody(http.body),
    detail,
  };
}

export async function runOpsSloSmoke(
  options: OpsSloSmokeOptions,
  deps: SmokeDeps = {},
): Promise<OpsSloSmokeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const workerUrl = normalizeUrl(options.workerUrl, 'workerUrl');
  const dashboardUrl = options.dashboardUrl ? normalizeUrl(options.dashboardUrl, 'dashboardUrl') : null;
  const endpoint = '/api/admin/ops-slo-stats' as const;
  const url = `${workerUrl}${endpoint}`;
  const checks: SmokeCheck[] = [];

  const unauth = await getJson({
    url,
    jwt: null,
    workerIamToken: options.workerIamToken,
    timeoutMs: options.timeoutMs,
    fetchImpl,
  });
  checks.push(checkResult(
    'unauth_rejected',
    unauth,
    unauth.status === 401 || unauth.status === 403,
    'Unauthenticated request must not read OPS SLO stats.',
  ));

  const nonAdmin = await getJson({
    url,
    jwt: options.nonAdminJwt,
    workerIamToken: options.workerIamToken,
    timeoutMs: options.timeoutMs,
    fetchImpl,
  });
  checks.push(checkResult(
    'non_admin_forbidden',
    nonAdmin,
    nonAdmin.status === 403,
    'Authenticated non-admin JWT must be forbidden by the platform-admin gate.',
  ));

  const admin = await getJson({
    url,
    jwt: options.adminJwt,
    workerIamToken: options.workerIamToken,
    timeoutMs: options.timeoutMs,
    fetchImpl,
  });
  checks.push(checkResult(
    'platform_admin_stats_success',
    admin,
    admin.status === 200 && hasOpsSloShape(admin.body),
    'Platform-admin JWT must return the OPS SLO stats contract.',
  ));

  if (dashboardUrl) {
    const dashboard = await getDashboard({ url: dashboardUrl, timeoutMs: options.timeoutMs, fetchImpl });
    checks.push(checkResult(
      'dashboard_route_smoke',
      dashboard,
      dashboard.status >= 200 && dashboard.status < 400,
      'Dashboard route should serve successfully when a frontend target URL is configured.',
    ));
  } else {
    checks.push({
      name: 'dashboard_route_smoke',
      status: 'skip',
      detail: 'Set OPS_SLO_DASHBOARD_URL or --dashboard-url to smoke the frontend /admin/ops-slo route.',
    });
  }

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    worker_url: workerUrl,
    dashboard_url: dashboardUrl,
    endpoint,
    checks,
  };
}

function usage(): string {
  return `
OPS SLO dashboard smoke

Required app-layer JWTs are environment-only:
  OPS_SLO_ADMIN_JWT=<platform-admin Supabase JWT>
  OPS_SLO_NON_ADMIN_JWT=<authenticated non-admin Supabase JWT>

Target:
  WORKER_URL=https://... npm run smoke:ops-slo
  # or STAGING_API_BASE=https://... npm run smoke:ops-slo

Protected Cloud Run target:
  WORKER_IAM_TOKEN="$(gcloud auth print-identity-token --audiences=https://...)" \\
  OPS_SLO_ADMIN_JWT=... OPS_SLO_NON_ADMIN_JWT=... WORKER_URL=https://... npm run smoke:ops-slo

Optional dashboard route:
  OPS_SLO_DASHBOARD_URL=https://app.example.test/admin/ops-slo npm run smoke:ops-slo
`.trim();
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return;
  }

  const options = parseArgs(process.argv.slice(2));
  const result = await runOpsSloSmoke(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
