#!/usr/bin/env -S npx tsx
/**
 * scripts/ops/audit-secret-version-counts.ts
 *
 * Infra-hygiene guard: flag every Secret Manager secret in a GCP project with
 * more than `--threshold` (default 20) ENABLED versions.
 *
 * WHY: Secret Manager bills per active (ENABLED or DISABLED) version per
 * month. A writer that appends a version on every run and never destroys the
 * old ones is invisible to `/health`, to Cloud Run, and to the billing export
 * until the bill arrives. Found 2026-09-05: one DocuSign refresh-token secret
 * at 1,645 enabled versions (~$99/month, growing ~$6/month per day) because
 * two hourly jobs each rotated the token. Twenty is well above any legitimate
 * steady state here (rotated secrets keep 1-2 live versions).
 *
 * Read-only: only list endpoints are called. Never fetches a payload.
 *
 * Usage:
 *   npx tsx scripts/ops/audit-secret-version-counts.ts --project arkova1
 *   npx tsx scripts/ops/audit-secret-version-counts.ts --project arkova1 --threshold 20 --json
 *
 * Exit codes: 0 nothing flagged; 1 at least one secret over threshold (so the
 * sweep fails loudly); 2 an API call failed.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const EXIT_CLEAN = 0;
export const EXIT_FLAGGED = 1;
export const EXIT_API_FAILURE = 2;
export const DEFAULT_THRESHOLD = 20;

const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SECRET_MANAGER_BASE = 'https://secretmanager.googleapis.com/v1';
const LIST_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 50;
const CONCURRENCY = 8;

export interface AuditCliArgs {
  project: string;
  threshold: number;
  json: boolean;
}

export function parseCliArgs(argv: string[]): AuditCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      threshold: { type: 'string' },
      json: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  const project = values.project ?? 'arkova1';
  if (!PROJECT_ID_RE.test(project)) throw new Error(`--project "${project}" is not a valid GCP project id`);
  const rawThreshold = values.threshold ?? String(DEFAULT_THRESHOLD);
  if (!/^\d+$/.test(rawThreshold) || Number(rawThreshold) < 1) throw new Error('--threshold must be a positive integer');
  return { project, threshold: Number(rawThreshold), json: Boolean(values.json) };
}

export interface SecretVersionCount {
  secretId: string;
  enabledVersions: number;
}

/** Pure: sort by count descending, then id; split into flagged / clean. */
export function summarizeVersionCounts(
  counts: readonly SecretVersionCount[],
  threshold: number,
): { flagged: SecretVersionCount[]; total: number; totalEnabledVersions: number } {
  const sorted = [...counts].sort((a, b) => b.enabledVersions - a.enabledVersions || a.secretId.localeCompare(b.secretId));
  return {
    flagged: sorted.filter((c) => c.enabledVersions > threshold),
    total: counts.length,
    totalEnabledVersions: counts.reduce((sum, c) => sum + c.enabledVersions, 0),
  };
}

export interface AuditDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface AuditRunResult {
  exitCode: number;
  counts: SecretVersionCount[];
  flagged: SecretVersionCount[];
}

function defaultGetAccessToken(env: NodeJS.ProcessEnv): () => Promise<string> {
  return async () => {
    if (env.GCP_ACCESS_TOKEN) return env.GCP_ACCESS_TOKEN;
    return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  };
}

async function smGet(fetchImpl: typeof fetch, token: string, path: string): Promise<Response> {
  return fetchImpl(`${SECRET_MANAGER_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function listSecretIds(fetchImpl: typeof fetch, token: string, project: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const q = new URLSearchParams({ pageSize: String(LIST_PAGE_SIZE) });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await smGet(fetchImpl, token, `projects/${project}/secrets?${q}`);
    if (!res.ok) throw new Error(`list secrets failed: HTTP ${res.status}`);
    const body = (await res.json()) as { secrets?: Array<{ name: string }>; nextPageToken?: string };
    for (const s of body.secrets ?? []) {
      const id = s.name.split('/secrets/')[1];
      if (id) ids.push(id);
    }
    pageToken = body.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return ids;
}

async function countEnabledVersions(fetchImpl: typeof fetch, token: string, project: string, secretId: string): Promise<number> {
  let count = 0;
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const q = new URLSearchParams({ pageSize: String(LIST_PAGE_SIZE), filter: 'state:ENABLED' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await smGet(fetchImpl, token, `projects/${project}/secrets/${encodeURIComponent(secretId)}/versions?${q}`);
    if (!res.ok) throw new Error(`list versions failed for ${secretId}: HTTP ${res.status}`);
    const body = (await res.json()) as { versions?: unknown[]; nextPageToken?: string };
    count += (body.versions ?? []).length;
    pageToken = body.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return count;
}

export async function runAudit(args: AuditCliArgs, deps: AuditDeps = {}): Promise<AuditRunResult> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken(env);

  const counts: SecretVersionCount[] = [];
  try {
    const token = await getAccessToken();
    const ids = await listSecretIds(fetchImpl, token, args.project);
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const chunk = ids.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(async (secretId) => ({
        secretId,
        enabledVersions: await countEnabledVersions(fetchImpl, token, args.project, secretId),
      })));
      counts.push(...results);
    }
  } catch (e) {
    err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return { exitCode: EXIT_API_FAILURE, counts, flagged: [] };
  }

  const summary = summarizeVersionCounts(counts, args.threshold);
  if (args.json) {
    out(JSON.stringify({ project: args.project, threshold: args.threshold, ...summary }, null, 2));
  } else {
    out(`project=${args.project} secrets=${summary.total} enabledVersions=${summary.totalEnabledVersions} threshold=${args.threshold} flagged=${summary.flagged.length}`);
    for (const c of summary.flagged) out(`  FLAG ${String(c.enabledVersions).padStart(6)}  ${c.secretId}`);
    if (summary.flagged.length === 0) out('  clean: no secret has more than the threshold of enabled versions');
  }
  return { exitCode: summary.flagged.length ? EXIT_FLAGGED : EXIT_CLEAN, counts, flagged: summary.flagged };
}

export function isDirectEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(resolvePath(argv1)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  let args: AuditCliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_API_FAILURE;
  }
  return (await runAudit(args)).exitCode;
}

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = EXIT_API_FAILURE;
  });
}
