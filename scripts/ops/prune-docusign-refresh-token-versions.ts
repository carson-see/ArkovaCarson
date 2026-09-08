#!/usr/bin/env -S npx tsx
/**
 * scripts/ops/prune-docusign-refresh-token-versions.ts
 *
 * Backlog cleanup for DocuSign refresh-token secrets in GCP Secret Manager.
 *
 * WHY: the worker refreshes each DocuSign grant twice an hour (connect-failures
 * poll at :00, listener-drift at :15), DocuSign rotates the refresh token on
 * every refresh, and until the retention fix in
 * `services/worker/src/integrations/connectors/docusign-token-store.ts` the
 * store only ever appended versions. Secret Manager bills every ENABLED or
 * DISABLED version per month, so one prod secret reached 1,645 enabled versions
 * (~$99/month, +~$6/month per day). Only `versions/latest` is ever read.
 *
 * WHAT: for each DocuSign refresh-token secret, list ENABLED versions, keep the
 * newest `--keep` (default 2), and DESTROY the rest, oldest first, in batches.
 *
 * SAFETY:
 *   - Dry run is the default and calls nothing but list endpoints.
 *   - `--apply` additionally requires env CONFIRM_DESTROY_SECRET_VERSIONS to
 *     equal the exact secret id being pruned. `--all --apply` is refused: apply
 *     one secret at a time, each with its own confirm.
 *   - Refuses (exit 1, before any API call) any secret id that does not match
 *     the DocuSign refresh-token naming pattern
 *     `arkova-docusign-[member-]<owner>-<32 hex>-refresh-token`.
 *   - Never calls `:access`; no payload is ever fetched, printed, or logged.
 *   - Never destroys the newest `--keep` versions (numeric version order, not
 *     lexical — `10` sorts after `9`).
 *   - Destroying a version is IRREVERSIBLE. Get explicit approval first.
 *
 * Usage (dry run — always first):
 *   GCP_ACCESS_TOKEN=$(gcloud auth print-access-token) \
 *     npx tsx scripts/ops/prune-docusign-refresh-token-versions.ts --project arkova1 --all
 *   GCP_ACCESS_TOKEN=$(gcloud auth print-access-token) \
 *     npx tsx scripts/ops/prune-docusign-refresh-token-versions.ts --project arkova1 --secret <id>
 *
 * Usage (apply — destroys versions):
 *   GCP_ACCESS_TOKEN=$(gcloud auth print-access-token) CONFIRM_DESTROY_SECRET_VERSIONS=<id> \
 *     npx tsx scripts/ops/prune-docusign-refresh-token-versions.ts --project arkova1 --secret <id> --apply
 *
 * Auth: GCP_ACCESS_TOKEN in env (the caller's identity, e.g.
 * `GCP_ACCESS_TOKEN=$(gcloud auth print-access-token)`). The script never
 * shells out.
 *
 * Exit codes: 0 done; 1 validation/refusal (nothing destroyed); 2 an API call
 * failed (dry run: nothing destroyed; apply: see the printed summary for what
 * was destroyed before the failure).
 */
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

export const EXIT_SUCCESS = 0;
export const EXIT_VALIDATION = 1;
export const EXIT_API_FAILURE = 2;

/**
 * Exact shape produced by `buildDocusignRefreshTokenSecretName` /
 * `buildDocusignMemberRefreshTokenSecretName` in the worker's token store:
 * `arkova-docusign-` + optional `member-` + owner id (org or user, 1-64 safe
 * chars) + `-` + 32 lowercase hex (sha256 prefix of the account id) +
 * `-refresh-token`. Anything else is refused.
 */
export const DOCUSIGN_REFRESH_TOKEN_SECRET_ID_RE =
  /^arkova-docusign-(?:member-)?[A-Za-z0-9_-]{1,64}-[0-9a-f]{32}-refresh-token$/;

const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const VERSION_NUMBER_RE = /\/versions\/(\d+)$/;
const SECRET_MANAGER_BASE = 'https://secretmanager.googleapis.com/v1';
const LIST_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 50;
const DEFAULT_KEEP = 2;
const DEFAULT_BATCH_SIZE = 50;
const DESTROY_CONCURRENCY = 8;

export function isDocusignRefreshTokenSecretId(secretId: string): boolean {
  return DOCUSIGN_REFRESH_TOKEN_SECRET_ID_RE.test(secretId);
}

export interface PruneCliArgs {
  project: string;
  secret?: string;
  all: boolean;
  keep: number;
  batchSize: number;
  maxDestroy?: number;
  apply: boolean;
}

export function parseCliArgs(argv: string[]): PruneCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string', multiple: true },
      secret: { type: 'string', multiple: true },
      all: { type: 'boolean', multiple: true },
      keep: { type: 'string', multiple: true },
      'batch-size': { type: 'string', multiple: true },
      'max-destroy': { type: 'string', multiple: true },
      apply: { type: 'boolean', multiple: true },
    },
    strict: true,
    allowPositionals: false,
  });
  for (const [flag, value] of Object.entries(values)) {
    if (Array.isArray(value) && value.length > 1) {
      throw new Error(`--${flag} was given more than once`);
    }
  }
  const one = <T>(v: T[] | undefined): T | undefined => (v?.length ? v[0] : undefined);
  const int = (flag: string, raw: string | undefined, fallback: number | undefined): number | undefined => {
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new Error(`--${flag} must be a non-negative integer`);
    return Number(raw);
  };

  const project: string = one<string>(values.project) ?? 'arkova1';
  if (!PROJECT_ID_RE.test(project)) throw new Error(`--project "${project}" is not a valid GCP project id`);
  const secret: string | undefined = one<string>(values.secret);
  const all = Boolean(one(values.all));
  if (!secret && !all) throw new Error('pass --secret <id> or --all');
  if (secret && all) throw new Error('--secret and --all are mutually exclusive');
  if (secret && !isDocusignRefreshTokenSecretId(secret)) {
    throw new Error(`refusing: --secret "${secret}" does not match the DocuSign refresh-token secret pattern`);
  }
  const keep = int('keep', one(values.keep), DEFAULT_KEEP) as number;
  if (keep < 1) throw new Error('--keep must be at least 1 (the latest version is the live token)');
  const batchSize = int('batch-size', one(values['batch-size']), DEFAULT_BATCH_SIZE) as number;
  if (batchSize < 1) throw new Error('--batch-size must be at least 1');
  const maxDestroy = int('max-destroy', one(values['max-destroy']), undefined);
  const apply = Boolean(one(values.apply));
  if (apply && all) throw new Error('refusing: --all --apply is not allowed; apply one --secret at a time with its own confirm');
  return { project, secret, all, keep, batchSize, maxDestroy, apply };
}

export interface SecretVersionRow {
  name: string;
  state?: string;
  createTime?: string;
}

export interface PrunePlan {
  secretId: string;
  enabledCount: number;
  keep: number;
  /** Version numbers to destroy, oldest first. */
  destroy: number[];
  /** Versions kept (newest `keep`). */
  kept: number[];
  oldestEnabled?: { version: number; createTime?: string };
  newestEnabled?: { version: number; createTime?: string };
}

export function versionNumber(name: string): number | null {
  const m = VERSION_NUMBER_RE.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** Pure: decide which ENABLED versions to destroy. Never includes the newest `keep`. */
export function planPrune(
  secretId: string,
  versions: readonly SecretVersionRow[],
  opts: { keep: number; maxDestroy?: number },
): PrunePlan {
  const enabled: Array<{ version: number; createTime?: string }> = [];
  for (const v of versions) {
    if ((v.state ?? '') !== 'ENABLED') continue;
    const version = versionNumber(v.name);
    if (version === null) continue;
    enabled.push({ version, createTime: v.createTime });
  }
  enabled.sort((a, b) => b.version - a.version);
  const kept = enabled.slice(0, opts.keep).map((v) => v.version);
  const superseded = enabled.slice(opts.keep).map((v) => v.version).sort((a, b) => a - b);
  const destroy = opts.maxDestroy === undefined ? superseded : superseded.slice(0, opts.maxDestroy);
  const guard = kept.length ? Math.min(...kept) : Number.POSITIVE_INFINITY;
  if (destroy.some((v) => v >= guard)) {
    throw new Error('internal invariant violated: a kept version was selected for destruction');
  }
  return {
    secretId,
    enabledCount: enabled.length,
    keep: opts.keep,
    destroy,
    kept,
    oldestEnabled: enabled.length ? enabled[enabled.length - 1] : undefined,
    newestEnabled: enabled.length ? enabled[0] : undefined,
  };
}

export interface PruneDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface SecretPruneResult extends PrunePlan {
  applied: boolean;
  destroyed: number;
  failed: number;
}

export interface PruneRunResult {
  exitCode: number;
  apply: boolean;
  secrets: SecretPruneResult[];
}

function defaultGetAccessToken(env: NodeJS.ProcessEnv): () => Promise<string> {
  return async () => {
    const token = env.GCP_ACCESS_TOKEN?.trim();
    if (!token) {
      throw new Error('GCP_ACCESS_TOKEN is required (e.g. GCP_ACCESS_TOKEN=$(gcloud auth print-access-token))');
    }
    return token;
  };
}

async function smFetch(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetchImpl(`${SECRET_MANAGER_BASE}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

async function listMatchingSecrets(fetchImpl: typeof fetch, token: string, project: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const q = new URLSearchParams({ pageSize: String(LIST_PAGE_SIZE) });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await smFetch(fetchImpl, token, `projects/${project}/secrets?${q}`);
    if (!res.ok) throw new Error(`list secrets failed: HTTP ${res.status}`);
    const body = (await res.json()) as { secrets?: Array<{ name: string }>; nextPageToken?: string };
    for (const s of body.secrets ?? []) {
      const id = s.name.split('/secrets/')[1] ?? '';
      if (isDocusignRefreshTokenSecretId(id)) ids.push(id);
    }
    pageToken = body.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return ids.sort((a, b) => a.localeCompare(b));
}

async function listEnabledVersions(
  fetchImpl: typeof fetch,
  token: string,
  project: string,
  secretId: string,
): Promise<SecretVersionRow[]> {
  const rows: SecretVersionRow[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const q = new URLSearchParams({ pageSize: String(LIST_PAGE_SIZE), filter: 'state:ENABLED' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await smFetch(fetchImpl, token, `projects/${project}/secrets/${secretId}/versions?${q}`);
    if (!res.ok) throw new Error(`list versions failed for ${secretId}: HTTP ${res.status}`);
    const body = (await res.json()) as { versions?: SecretVersionRow[]; nextPageToken?: string };
    rows.push(...(body.versions ?? []));
    pageToken = body.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return rows;
}

async function destroyVersions(
  fetchImpl: typeof fetch,
  token: string,
  project: string,
  secretId: string,
  versions: number[],
  batchSize: number,
  out: (line: string) => void,
): Promise<{ destroyed: number; failed: number }> {
  let destroyed = 0;
  let failed = 0;
  for (let start = 0; start < versions.length; start += batchSize) {
    const batch = versions.slice(start, start + batchSize);
    for (let i = 0; i < batch.length; i += DESTROY_CONCURRENCY) {
      const chunk = batch.slice(i, i + DESTROY_CONCURRENCY);
      const results = await Promise.all(chunk.map(async (v) => {
        const res = await smFetch(fetchImpl, token, `projects/${project}/secrets/${secretId}/versions/${v}:destroy`, {
          method: 'POST',
          body: '{}',
        });
        return res.ok;
      }));
      for (const ok of results) (ok ? destroyed++ : failed++);
    }
    out(`  batch ${Math.floor(start / batchSize) + 1}: versions ${batch[0]}..${batch[batch.length - 1]} -> destroyed=${destroyed} failed=${failed}`);
  }
  return { destroyed, failed };
}

function refusal(err: (line: string) => void, message: string, apply: boolean): PruneRunResult {
  err(message);
  return { exitCode: EXIT_VALIDATION, apply, secrets: [] };
}

/** Every reason to stop before touching the API, or null when clear to proceed. */
export function preflightRefusal(args: PruneCliArgs, env: NodeJS.ProcessEnv): string | null {
  if (args.secret && !isDocusignRefreshTokenSecretId(args.secret)) {
    return `refusing: "${args.secret}" does not match the DocuSign refresh-token secret pattern`;
  }
  if (!args.apply) return null;
  if (args.all) return 'refusing: --all --apply is not allowed';
  const confirm = env.CONFIRM_DESTROY_SECRET_VERSIONS;
  if (!confirm || confirm !== args.secret) {
    return 'refusing: --apply requires CONFIRM_DESTROY_SECRET_VERSIONS to equal the exact --secret id';
  }
  return null;
}

function describeVersion(label: string, v: { version: number; createTime?: string } | undefined): string {
  if (!v) return '';
  const when = v.createTime ?? '?';
  return ` ${label}=v${v.version}@${when}`;
}

function describePlan(plan: PrunePlan): string {
  const kept = plan.kept.join(',') || '-';
  return `    enabled=${plan.enabledCount} keep=${kept} would_destroy=${plan.destroy.length}`
    + describeVersion('oldest', plan.oldestEnabled)
    + describeVersion('newest', plan.newestEnabled);
}

function summaryJson(args: PruneCliArgs, results: SecretPruneResult[]): string {
  return JSON.stringify({
    mode: args.apply ? 'apply' : 'dry-run',
    project: args.project,
    keep: args.keep,
    secrets: results.map((r) => ({
      secretId: r.secretId,
      enabled: r.enabledCount,
      kept: r.kept,
      destroyCount: r.destroy.length,
      destroyed: r.destroyed,
      failed: r.failed,
      oldestEnabled: r.oldestEnabled,
      newestEnabled: r.newestEnabled,
    })),
  }, null, 2);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runPrune(args: PruneCliArgs, deps: PruneDeps = {}): Promise<PruneRunResult> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? defaultGetAccessToken(env);

  const refused = preflightRefusal(args, env);
  if (refused) return refusal(err, refused, args.apply);

  let token: string;
  let secretIds: string[];
  try {
    token = await getAccessToken();
    secretIds = args.secret ? [args.secret] : await listMatchingSecrets(fetchImpl, token, args.project);
  } catch (e) {
    err(`error: ${errorMessage(e)}`);
    return { exitCode: EXIT_API_FAILURE, apply: args.apply, secrets: [] };
  }
  // Defence in depth: nothing that fails the pattern reaches a destroy call,
  // whichever path produced the id.
  secretIds = secretIds.filter((id) => isDocusignRefreshTokenSecretId(id));

  const maxDestroy = args.maxDestroy === undefined ? '' : ` maxDestroy=${args.maxDestroy}`;
  out(`${args.apply ? 'APPLY' : 'DRY RUN'} — project=${args.project} keep=${args.keep} batchSize=${args.batchSize}${maxDestroy} secrets=${secretIds.length}`);

  const results: SecretPruneResult[] = [];
  let exitCode = EXIT_SUCCESS;
  for (const secretId of secretIds) {
    let plan: PrunePlan;
    try {
      const versions = await listEnabledVersions(fetchImpl, token, args.project, secretId);
      plan = planPrune(secretId, versions, { keep: args.keep, maxDestroy: args.maxDestroy });
    } catch (e) {
      err(`error: ${errorMessage(e)}`);
      exitCode = EXIT_API_FAILURE;
      break;
    }
    out(`- ${secretId}`);
    out(describePlan(plan));
    if (!args.apply || plan.destroy.length === 0) {
      results.push({ ...plan, applied: false, destroyed: 0, failed: 0 });
      continue;
    }
    const { destroyed, failed } = await destroyVersions(fetchImpl, token, args.project, secretId, plan.destroy, args.batchSize, out);
    results.push({ ...plan, applied: true, destroyed, failed });
    if (failed > 0) exitCode = EXIT_API_FAILURE;
  }
  out(summaryJson(args, results));
  return { exitCode, apply: args.apply, secrets: results };
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
  let args: PruneCliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_VALIDATION;
  }
  const result = await runPrune(args);
  return result.exitCode;
}

if (isDirectEntrypoint(process.argv[1], import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = EXIT_API_FAILURE;
  });
}
