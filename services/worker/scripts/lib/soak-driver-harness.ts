/**
 * Shared scaffolding for the T2/T3 soak drivers (`pr3083-*`, `pr3084-*`,
 * `pr3086-*`, `pr3087-*` in `services/worker/scripts/`).
 *
 * WHY THIS EXISTS (SonarCloud duplication finding, PR #3092)
 * -----------------------------------------------------------------------
 * The four drivers were authored independently and each hand-rolled the same
 * CLI arg parsing, evidence-row emission, Supabase credential resolution,
 * fixture-user creation/sign-in, safe target-URL joining, and the
 * live-mode cycle loop (deadline tracking, per-cycle try/catch, exit-status
 * aggregation). That copy-paste pushed New Code duplication to 16.9% (gate:
 * <=3%) and is also why every driver's own `main()` tripped the S3776
 * cognitive-complexity gate — the loop/try-catch/deadline logic lived
 * inline in each one. Extracting it here fixes both: each driver's `main()`
 * now delegates the loop to `runLiveLoop` instead of containing it, and the
 * duplicated blocks collapse to a single implementation imported four times.
 *
 * Behavior is unchanged: every function here is a byte-for-byte extraction
 * of what each driver already did (fixture sign-in every cycle, exit code 1
 * on any failed probe, self-test rows marked `evidenceForSoak:false`, etc).
 *
 * Never import this from `services/worker/src/` — offline tooling only.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Probes — the shared pass/fail primitive every driver's classifiers return.
// ---------------------------------------------------------------------------

export interface ProbeResult {
  name: string;
  status: 'pass' | 'fail';
  detail: string;
}

export function makeProbe(name: string, ok: boolean, detail: string): ProbeResult {
  return { name, status: ok ? 'pass' : 'fail', detail };
}

/** A cycle passes only if every probe in it passed. One failure fails the row. */
export function aggregateProbes(probes: ProbeResult[]): 'pass' | 'fail' {
  return probes.some((p) => p.status === 'fail') ? 'fail' : 'pass';
}

/** Per-assertion counters, so a reviewer can count coverage without re-reading probes. */
export function tallyProbes(probes: ProbeResult[], assertionNames: string[]): Record<string, number | boolean> {
  const counts: Record<string, number | boolean> = {};
  for (const name of assertionNames) {
    const inFamily = probes.filter((p) => p.name === name);
    counts[`${name}_ran`] = inFamily.length > 0;
    counts[`${name}_passed`] = inFamily.length > 0 && inFamily.every((p) => p.status === 'pass');
  }
  counts.probes_total = probes.length;
  counts.probes_failed = probes.filter((p) => p.status === 'fail').length;
  return counts;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export type DriverMode = 'self-test' | 'live';

export interface BaseDriverArgs {
  mode: DriverMode;
  targetUrl?: string;
  admissionJson?: string;
  evidenceJsonl?: string;
  durationMin: number;
  intervalSec: number;
}

export interface ExtraArgSpec<TArgs> {
  /** The flag as it appears on argv, e.g. `--cron-secret`. */
  flag: string;
  /** Assigns the flag's value (argv[i+1]) onto the args object. */
  apply: (args: TArgs, value: string) => void;
}

/**
 * Shared CLI parser for every soak driver's base flags
 * (`--self-test`/`--live`/`--target-url`/`--admission-json`/
 * `--evidence-jsonl`/`--duration-min`/`--interval-sec`). Drivers with extra
 * flags (pr3087's `--cron-secret`/`--bearer-token`) pass `extraSpecs`; drivers
 * with none pass an empty array.
 */
export function parseDriverArgs<TExtra extends object>(
  argv: string[],
  extraDefaults: TExtra,
  extraSpecs: Array<ExtraArgSpec<BaseDriverArgs & TExtra>>,
): BaseDriverArgs & TExtra {
  const args = {
    mode: 'self-test' as DriverMode,
    durationMin: 0,
    intervalSec: 900,
    ...extraDefaults,
  } as BaseDriverArgs & TExtra;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const extraSpec = extraSpecs.find((spec) => spec.flag === arg);
    if (extraSpec) {
      extraSpec.apply(args, argv[i += 1] ?? '');
      continue;
    }
    switch (arg) {
      case '--self-test':
        args.mode = 'self-test';
        break;
      case '--live':
        args.mode = 'live';
        break;
      case '--target-url':
        args.targetUrl = argv[i += 1];
        break;
      case '--admission-json':
        args.admissionJson = argv[i += 1];
        break;
      case '--evidence-jsonl':
        args.evidenceJsonl = argv[i += 1];
        break;
      case '--duration-min':
        args.durationMin = Number.parseInt(argv[i += 1] ?? '0', 10);
        break;
      case '--interval-sec':
        args.intervalSec = Number.parseInt(argv[i += 1] ?? '900', 10);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Evidence emission
// ---------------------------------------------------------------------------

export function emitDriverRow(row: object, evidenceJsonl?: string): void {
  const line = `${JSON.stringify(row)}\n`;
  if (evidenceJsonl) appendFileSync(evidenceJsonl, line);
  process.stdout.write(line);
}

export function readAdmissionJson(admissionJsonPath?: string): Record<string, unknown> | undefined {
  return admissionJsonPath
    ? (JSON.parse(readFileSync(admissionJsonPath, 'utf8')) as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// Supabase credentials + fixtures
// ---------------------------------------------------------------------------

export interface SupabaseCredentials {
  url: string;
  serviceRoleKey: string;
  anonKey?: string;
}

/** `requireAnonKey` is false for drivers (pr3087) that never sign a fixture user in. */
export function resolveSupabaseCredentials(
  opts: { requireAnonKey: true },
): { url: string; serviceRoleKey: string; anonKey: string };
export function resolveSupabaseCredentials(
  opts: { requireAnonKey: false },
): { url: string; serviceRoleKey: string; anonKey?: string };
export function resolveSupabaseCredentials(opts: { requireAnonKey: boolean }): SupabaseCredentials {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !serviceRoleKey || (opts.requireAnonKey && !anonKey)) {
    throw new Error(
      opts.requireAnonKey
        ? 'live mode requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY'
        : 'live mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    );
  }
  return { url, serviceRoleKey, anonKey };
}

/**
 * Idempotent fixture-auth-user lookup/creation shared by every driver: reuse
 * the `profiles` row if it already exists (a resumed/interrupted soak run),
 * otherwise create it. `password` is omitted by drivers (pr3087) that never
 * sign this user back in over HTTP.
 */
export async function ensureFixtureAuthUser(
  db: SupabaseClient,
  email: string,
  password?: string,
): Promise<string> {
  const { data: existing } = await db.from('profiles').select('id').eq('email', email).maybeSingle();
  if (existing && (existing as { id?: string }).id) return (existing as { id: string }).id;

  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    email_confirm: true,
    password: password ?? randomUUID(),
  });
  if (createError || !created?.user) {
    throw new Error(`could not create fixture auth user ${email}: ${createError?.message ?? 'unknown'}`);
  }
  return created.user.id;
}

/**
 * Signs a fixture user in FRESH — called once per cycle, never once before a
 * loop. `autoRefreshToken:false` means a token captured before a 4h/24h soak
 * eventually expires mid-run and every later cycle 401s; a per-cycle sign-in
 * is cheap next to a multi-minute interval and makes token lifetime a
 * non-issue (the incident this fixes, see each driver's own agents.md note).
 */
export async function signInFixtureUser(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<string> {
  const anon = createClient(supabaseUrl, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token) {
    throw new Error(`fixture sign-in failed for ${email}: ${error?.message ?? 'no session returned'}`);
  }
  return data.session.access_token;
}

// ---------------------------------------------------------------------------
// HTTP — safe URL joining + a shared JSON fetch helper
// ---------------------------------------------------------------------------

const ALLOWED_TARGET_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Joins a configured `targetUrl` with a fixed API path via `new URL()` —
 * never a `${targetUrl.replace(/\/+$/, '')}${path}` string concatenation.
 * That pattern (SonarCloud tssecurity:S8476/S7044 on this PR) builds a
 * request URL from unsanitized-looking string interpolation; parsing the
 * base with `new URL()` and allowlisting the scheme means a malformed or
 * unexpected `targetUrl` throws immediately instead of being interpolated
 * into a live fetch call, and `path` is always one of this file's own
 * fixed string-literal routes, never caller-supplied.
 */
export function buildRequestUrl(targetUrl: string, path: string): URL {
  const base = new URL(targetUrl);
  if (!ALLOWED_TARGET_PROTOCOLS.has(base.protocol)) {
    throw new Error(`refusing to call target URL with unsupported protocol: ${base.protocol}`);
  }
  return new URL(path, base);
}

export interface JsonHttpResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

export interface JsonHttpInit {
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Shared fetch-then-parse-JSON helper. A body that isn't valid JSON parses to `{}`. */
export async function fetchJson(targetUrl: string, path: string, init: JsonHttpInit): Promise<JsonHttpResult> {
  const url = buildRequestUrl(targetUrl, path);
  const res = await fetch(url, {
    method: init.method,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { httpStatus: res.status, body: body as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Calls `fn` immediately, then up to `attempts` more times (with `delayMs` between) until `ready`. */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  ready: (value: T) => boolean,
  attempts: number,
  delayMs: number,
): Promise<T> {
  let last: T = await fn();
  for (let i = 0; i < attempts && !ready(last); i += 1) {
    await sleep(delayMs);
    last = await fn();
  }
  return last;
}

// ---------------------------------------------------------------------------
// The live-mode cycle loop
// ---------------------------------------------------------------------------

export interface LiveLoopOptions {
  durationMinutes: number;
  intervalSeconds: number;
  /** Runs one full cycle (fresh sign-in + probes). A thrown error becomes a `cycle_error` probe. */
  runCycle: (cycle: number) => Promise<ProbeResult[]>;
  /** Called after each cycle's probes are aggregated — the driver emits its own evidence row here. */
  onCycleComplete: (cycle: number, probes: ProbeResult[], status: 'pass' | 'fail') => void;
}

/**
 * The shared live-mode runner: tracks the soak deadline, runs cycles back to
 * back with `intervalSeconds` between them, turns a thrown cycle error into
 * an explicit failed probe rather than crashing the process, and reports
 * whether ANY cycle failed so the caller can set `process.exitCode`
 * accordingly (a failed probe anywhere in the run must fail the process —
 * the CLI must never exit 0 with failed probes buried in the JSONL).
 */
export async function runLiveLoop(opts: LiveLoopOptions): Promise<{ anyCycleFailed: boolean }> {
  const deadline = Date.now() + opts.durationMinutes * 60_000;
  let cycle = 0;
  let anyCycleFailed = false;

  do {
    cycle += 1;
    let probes: ProbeResult[];
    try {
      probes = await opts.runCycle(cycle);
    } catch (error) {
      probes = [makeProbe('cycle_error', false, error instanceof Error ? error.message : 'unknown')];
    }

    const status = aggregateProbes(probes);
    if (status === 'fail') anyCycleFailed = true;
    opts.onCycleComplete(cycle, probes, status);

    if (Date.now() >= deadline) break;
    await sleep(opts.intervalSeconds * 1000);
  } while (Date.now() < deadline);

  return { anyCycleFailed };
}
