/**
 * scripts/staging/targeted/runtime.ts
 *
 * Live-rig plumbing shared by every targeted driver: the Cloud Run IAM token,
 * the service-role Supabase seeder, evidence-file writing, and the driver run
 * loop that fires the plan repeatedly until the soak duration elapses.
 *
 * This module talks to gcloud / Supabase / the network, so it is intentionally
 * kept thin and OUT of the unit-tested branch logic (which lives in each
 * driver's pure `plan*()` + the shared driver-core). Only the two pure helpers
 * (writeEvidenceFile, bearerHeader) are unit-tested; the rest runs against a
 * real isolated rig during an actual soak.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { newDriverStats, type DriverStats } from './driver-core';
import { makeDbExecutor, type FixtureExecutor } from './fixtures';

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────────

export function bearerHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function writeEvidenceFile(path: string | undefined, evidence: unknown): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`\n[evidence] written: ${path}`);
}

// ─── IAM token (Cloud Run --no-allow-unauthenticated) ───────────────────────

const SAFE_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin';
let cachedIamToken = '';
let iamFetchedAt = 0;
const IAM_TTL_MS = 30 * 60_000;

function resolveGcloudPath(): string {
  const override = process.env.GCLOUD_PATH;
  if (override) return override;
  try {
    return execFileSync('/usr/bin/which', ['gcloud'], { // NOSONAR S4036 — absolute path, no PATH lookup
      encoding: 'utf8',
      env: { ...process.env, PATH: SAFE_PATH },
    }).trim();
  } catch {
    return '/usr/local/bin/gcloud';
  }
}

function fetchIamToken(): string {
  const env = process.env.STAGING_GCP_IDENTITY;
  if (env) return env.trim();
  const bin = resolveGcloudPath();
  return execFileSync(bin, ['auth', 'print-identity-token'], { encoding: 'utf8' }).trim();
}

export function iamToken(): string {
  if (!cachedIamToken || Date.now() - iamFetchedAt > IAM_TTL_MS) {
    cachedIamToken = fetchIamToken();
    iamFetchedAt = Date.now();
  }
  return cachedIamToken;
}

/** Authorization header carrying the Cloud Run IAM identity token. */
export function iamAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...bearerHeader(iamToken()), ...extra };
}

// ─── Service-role Supabase seeder ───────────────────────────────────────────

let cachedExecutor: FixtureExecutor | null = null;

async function serviceRoleExecutor(): Promise<FixtureExecutor> {
  if (cachedExecutor) return cachedExecutor;
  const url = process.env.STAGING_SUPABASE_URL;
  const key = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'STAGING_SUPABASE_URL + STAGING_SUPABASE_SERVICE_ROLE_KEY are required to seed targeted-soak fixtures.',
    );
  }
  const { createClient } = await import('@supabase/supabase-js');
  cachedExecutor = makeDbExecutor(createClient(url, key) as never);
  return cachedExecutor;
}

/** Seed rows into `table` on the isolated rig via the service-role client. */
export async function seedViaServiceRole(
  table: string,
  rows: ReadonlyArray<object>,
): Promise<Array<Record<string, unknown>>> {
  const exec = await serviceRoleExecutor();
  return exec(table, rows);
}

// ─── Driver run loop ────────────────────────────────────────────────────────

export interface DriverContext {
  apiBase: string;
  durationMin: number;
  dryRun: boolean;
  log: (msg: string) => void;
}

export interface RunDriverOpts<P> {
  apiBase: string;
  args: { durationMin: number; dryRun: boolean; evidenceOut?: string };
  label: string;
  stats: DriverStats;
  /** Seed fixtures + build the request plan. */
  plan: (ctx: DriverContext) => Promise<P>;
  /** Fire the whole plan once (one pass). */
  fireOnce: (ctx: DriverContext, plan: P) => Promise<void>;
}

/**
 * Seed once, then fire the plan on a fixed cadence until the duration elapses.
 * Under `--dry-run`, prints the plan and returns without seeding or firing.
 */
export async function runDriver<P>(opts: RunDriverOpts<P>): Promise<void> {
  const ctx: DriverContext = {
    apiBase: opts.apiBase,
    durationMin: opts.args.durationMin,
    dryRun: opts.args.dryRun,
    log: (msg) => console.log(`[${opts.label}] ${msg}`),
  };

  ctx.log(`api_base=${opts.apiBase} duration=${opts.args.durationMin}min dry_run=${opts.args.dryRun}`);

  if (opts.args.dryRun) {
    ctx.log('--dry-run: skipping seed + fire.');
    return;
  }

  const plan = await opts.plan(ctx);
  const endAt = Date.now() + opts.args.durationMin * 60_000;
  // Cadence: one pass per 30s keeps steady pressure on the changed branches
  // without hammering (each pass is only a handful of requests).
  const PASS_INTERVAL_MS = 30_000;
  let pass = 0;
  while (Date.now() < endAt) {
    await opts.fireOnce(ctx, plan);
    pass++;
    const remaining = endAt - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(PASS_INTERVAL_MS, remaining)));
  }
  ctx.log(`completed ${pass} pass(es).`);
}

/** Re-export so drivers can build a fresh stats object without a second import. */
export { newDriverStats };
