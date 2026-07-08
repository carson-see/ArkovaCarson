/**
 * scripts/staging/targeted/driver-core.ts
 *
 * Shared foundation for the TARGETED soak drivers under
 * scripts/staging/targeted/*. Unlike the generic `load-harness.ts --mode mixed`
 * (which only proves the worker is up), a targeted driver hits the EXACT changed
 * surface of a specific PR, drives each of its documented branches, and captures
 * the response body that proves the branch was reached — which is what §1.12 +
 * the Staging Soak Evidence Gate demand of a per-PR soak.
 *
 * This module carries only the reusable plumbing:
 *   - outcome recording keyed by a human "label" (one label per changed branch)
 *   - status classification against a per-request allowed-status set
 *     (a 404 is EXPECTED evidence for the RECORD_NOT_FOUND branch, not a failure)
 *   - a structured evidence summary (status mix, per-branch counts, captured
 *     bodies) suitable to drop into a PR's `## Staging Soak Evidence` block
 *   - body helpers (JSON parse + snippet, proof_error_code capture)
 *   - the shared `fireLabeled` HTTP fire that records latency + captures body
 *
 * The per-driver files supply the actual endpoints, auth, and fixtures.
 */

import { parseArgs } from 'node:util';

// ─── Outcome + stats types ──────────────────────────────────────────────────

export type JsonBody = Record<string, unknown> | unknown[] | string | null;

export interface DriverOutcome {
  /** Human label for the changed branch this request exercises. */
  label: string;
  endpoint: string;
  method: string;
  status: number;
  latencyMs: number;
  /** Whether the observed status was in the caller's allowed-status set. */
  expected: boolean;
  /** Parsed/truncated response body, retained only for capture-worthy outcomes. */
  capturedBody?: JsonBody;
}

interface LabelSlot {
  expected: number;
  unexpected: number;
  latencyMs: number[];
  byStatus: Record<number, number>;
}

export interface DriverStats {
  startedAt: number;
  outcomes: DriverOutcome[];
  byLabel: Record<string, LabelSlot>;
}

export function newDriverStats(): DriverStats {
  return { startedAt: Date.now(), outcomes: [], byLabel: {} };
}

export function recordOutcome(stats: DriverStats, o: DriverOutcome): void {
  stats.outcomes.push(o);
  const slot = stats.byLabel[o.label] ?? {
    expected: 0,
    unexpected: 0,
    latencyMs: [],
    byStatus: {},
  };
  if (o.expected) slot.expected++;
  else slot.unexpected++;
  slot.latencyMs.push(o.latencyMs);
  slot.byStatus[o.status] = (slot.byStatus[o.status] ?? 0) + 1;
  stats.byLabel[o.label] = slot;
}

/**
 * A response is "expected" when its status is in the allowed set. Status 0
 * (transport failure) is NEVER expected — even if a caller foolishly allows it,
 * a dropped connection is not soak evidence.
 */
export function classifyStatus(status: number, allowed: readonly number[]): boolean {
  if (status === 0) return false;
  return allowed.includes(status);
}

// ─── Percentiles ────────────────────────────────────────────────────────────

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

// ─── Evidence summary ───────────────────────────────────────────────────────

export interface EvidenceMeta {
  driver: string;
  apiBase: string;
  pr: string;
}

export interface CapturedBodyRecord {
  label: string;
  endpoint: string;
  status: number;
  body: JsonBody;
}

export interface DriverEvidence {
  driver: string;
  pr: string;
  apiBase: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  totalRequests: number;
  /** True only when EVERY outcome landed in its allowed-status set. */
  allExpected: boolean;
  byLabel: Record<
    string,
    {
      expected: number;
      unexpected: number;
      p50Ms: number;
      p95Ms: number;
      p99Ms: number;
      byStatus: Record<number, number>;
    }
  >;
  capturedBodies: CapturedBodyRecord[];
}

export function summarizeEvidence(stats: DriverStats, meta: EvidenceMeta): DriverEvidence {
  const byLabel: DriverEvidence['byLabel'] = {};
  let anyUnexpected = false;
  for (const [label, slot] of Object.entries(stats.byLabel)) {
    if (slot.unexpected > 0) anyUnexpected = true;
    byLabel[label] = {
      expected: slot.expected,
      unexpected: slot.unexpected,
      p50Ms: percentile(slot.latencyMs, 50),
      p95Ms: percentile(slot.latencyMs, 95),
      p99Ms: percentile(slot.latencyMs, 99),
      byStatus: slot.byStatus,
    };
  }

  const capturedBodies: CapturedBodyRecord[] = stats.outcomes
    .filter((o) => o.capturedBody !== undefined)
    .map((o) => ({
      label: o.label,
      endpoint: o.endpoint,
      status: o.status,
      body: o.capturedBody as JsonBody,
    }));

  return {
    driver: meta.driver,
    pr: meta.pr,
    apiBase: meta.apiBase,
    startedAt: new Date(stats.startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationSec: (Date.now() - stats.startedAt) / 1000,
    totalRequests: stats.outcomes.length,
    allExpected: stats.outcomes.length > 0 && !anyUnexpected,
    byLabel,
    capturedBodies,
  };
}

// ─── Body helpers ───────────────────────────────────────────────────────────

const MAX_SNIPPET = 2048;

/**
 * Parse a raw response body into a JSON value when it is valid JSON, else
 * return a length-bounded string snippet. Bounding avoids retaining megabytes
 * of PDF bytes when a driver accidentally captures a binary export body.
 */
export function bodySnippet(raw: string): JsonBody {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as JsonBody;
    } catch {
      /* fall through to string snippet */
    }
  }
  return raw.length > MAX_SNIPPET ? raw.slice(0, MAX_SNIPPET) : raw;
}

/**
 * Read the PR-#1439 `proof_error_code` discriminator from a parsed body.
 * Returns null on the main-branch shape (which carries only `error`) or any
 * non-object body — so a driver run against a rig lacking the PR change simply
 * records a null code rather than throwing.
 */
export function captureProofErrorCode(body: JsonBody): string | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const code = (body as Record<string, unknown>).proof_error_code;
    if (typeof code === 'string') return code;
  }
  return null;
}

// ─── HTTP fire ──────────────────────────────────────────────────────────────

export interface FireOpts {
  stats: DriverStats;
  label: string;
  method: string;
  url: string;
  endpoint: string;
  headers?: Record<string, string>;
  body?: string;
  /** Statuses that count as expected soak evidence for this call. */
  allowedStatuses: readonly number[];
  /** Capture the response body into evidence (default true for the first N). */
  capture?: boolean;
}

/**
 * Fire one labeled request, record latency + expected/unexpected, and optionally
 * capture the (parsed) body. Never throws on a transport error — records status 0.
 */
export async function fireLabeled(opts: FireOpts): Promise<DriverOutcome> {
  const startedAt = Date.now();
  let status = 0;
  let capturedBody: JsonBody | undefined;
  try {
    const res = await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
    });
    status = res.status;
    const raw = await res.text();
    if (opts.capture !== false) {
      capturedBody = bodySnippet(raw);
    }
  } catch {
    status = 0;
  }
  const outcome: DriverOutcome = {
    label: opts.label,
    endpoint: opts.endpoint,
    method: opts.method,
    status,
    latencyMs: Date.now() - startedAt,
    expected: classifyStatus(status, opts.allowedStatuses),
    ...(capturedBody !== undefined ? { capturedBody } : {}),
  };
  recordOutcome(opts.stats, outcome);
  return outcome;
}

// ─── Arg parsing ────────────────────────────────────────────────────────────

export interface DriverArgs {
  durationMin: number;
  evidenceOut?: string;
  dryRun: boolean;
}

const DEFAULT_DURATION_MIN = 15;

export function parseDriverArgs(argv: string[]): DriverArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      duration: { type: 'string' },
      'evidence-out': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  let durationMin = DEFAULT_DURATION_MIN;
  if (values.duration !== undefined) {
    const n = Number.parseInt(values.duration, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--duration=${values.duration} must be a positive integer (minutes).`);
    }
    durationMin = n;
  }

  return {
    durationMin,
    evidenceOut: values['evidence-out'],
    dryRun: Boolean(values['dry-run']),
  };
}
