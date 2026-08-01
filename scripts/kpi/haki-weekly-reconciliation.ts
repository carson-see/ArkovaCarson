#!/usr/bin/env -S npx tsx
/**
 * scripts/kpi/haki-weekly-reconciliation.ts
 *
 * KPI-2 weekly reconciliation tool for the HakiChain LOI (DocuSign envelope
 * 5BE7302F, signed 2026-07-15, Exhibit A §2, KPI #2 "Verification reliability"):
 *
 *   "≥95% of documents issued via HakiChain complete
 *    issue → fingerprint → anchor → independent-verification, measured by
 *    Arkova verification logs reconciled WEEKLY against HakiChain's issued
 *    count."
 *
 * This did not exist before this file (grep-confirmed: no HakiChain/pilot
 * reconciliation tooling anywhere in the repo). It is the artifact that
 * produces the weekly evidence the LOI's KPI #2 clause requires.
 *
 * WHAT IT DOES
 *   Reads (read-only, GET-only PostgREST calls — see `pgrestGet`) two prod
 *   tables scoped to one org + one date window:
 *     - `anchors`             — the HakiChain org's issued documents
 *     - `verification_events` — Arkova's public verification lookup log
 *   and computes, PURELY from that data (`buildReconciliation`, fully unit
 *   tested with mocked rows — no network in tests):
 *     - anchors issued in the window, grouped by `anchor_status`
 *     - how many anchors completed the FULL pipeline
 *       (issue → fingerprint → anchor → verification)
 *     - the completion percentage vs the 95% KPI target
 *     - every anchor that did NOT complete, with the exact stage it stopped at
 *     - the delta vs HakiChain's self-reported issued count, WHEN supplied
 *
 * HONESTY CONSTRAINT (CLAUDE.md §1.5 / R-7 — do not weaken this)
 *   Arkova cannot see HakiChain's own issued count. This tool never invents
 *   or infers it. The delta field is `null` unless the caller supplies
 *   `--haki-issued-count` (or `--haki-issued-count-file`), and the output
 *   labels that number explicitly as HAKICHAIN'S SELF-REPORT, not something
 *   Arkova independently verified.
 *
 *   "Verification" here means: at least one `verification_events` row with
 *   `result='verified'` exists for the anchor. That table does not currently
 *   distinguish an issuer's own dashboard lookup from a non-issuer/external
 *   check (that distinction — "independent verification by a non-issuer
 *   party" — is KPI #3, a separate, stronger check with its own tooling in
 *   `scripts/kpi3/`). This tool reports the KPI #2 log-based signal only and
 *   says so in every output (`measurementNote`).
 *
 * READ-ONLY / NO SECRETS
 *   - Every DB call in this file goes through `pgrestGet`, which hardcodes
 *     `method: 'GET'` — there is no write path in this module (see the
 *     "no INSERT/UPDATE/DELETE" self-check in the test file).
 *   - No credentials are embedded. `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
 *     (or the read-only `SUPABASE_ANON_KEY` if RLS allows service-scoped
 *     reads) are read from the environment only; see `loadConfig`.
 *
 * USAGE
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/kpi/haki-weekly-reconciliation.ts \
 *       --org-id f52cd07a-6d8a-4387-9346-23babec84e5c \
 *       --window-start 2026-07-21 --window-end 2026-07-28 \
 *       [--haki-issued-count 15 | --haki-issued-count-file haki-count.json] \
 *       [--fail-below-target] [--json]
 *
 * Run weekly (see docs/partners/hakichain-kpi-reconciliation.md for the full
 * runbook + how to read the output).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

// ── constants ────────────────────────────────────────────────────────────────

/** Exhibit A §2 KPI #2 target. Do not change without a CTO/founder ruling — it
 * is a contractual number, not a tunable. */
export const KPI2_TARGET_PCT = 95;

const FINGERPRINT_RE = /^[0-9a-f]{64}$/i;
const ANCHORED_STATUS = 'SECURED';

// ── CLI args ─────────────────────────────────────────────────────────────────

const ReconciliationArgsSchema = z
  .object({
    orgId: z.string().uuid('--org-id must be a UUID'),
    windowStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '--window-start must be YYYY-MM-DD'),
    windowEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '--window-end must be YYYY-MM-DD'),
    hakiIssuedCount: z.coerce.number().int().nonnegative().optional(),
    failBelowTarget: z.boolean().default(false),
    json: z.boolean().default(false),
  })
  .refine((a) => a.windowStart <= a.windowEnd, {
    message: '--window-start must be on or before --window-end',
    path: ['windowStart'],
  });

export type ReconciliationArgs = z.infer<typeof ReconciliationArgsSchema>;

/**
 * Resolves and validates a caller-supplied file path BEFORE it is ever
 * passed to a filesystem read (SonarCloud tssecurity:S8707 — an
 * automated/LLM-driven invocation could pass a malicious
 * `--haki-issued-count-file` value). Normalizes to an absolute path under
 * the current working directory, then requires the resolved target to
 * exist and be a regular file — rejects directories, missing paths, and
 * special files (devices, FIFOs, etc. via `statSync().isFile()`) — before
 * any read is attempted.
 */
function resolveIssuedCountFilePath(rawPath: string): string {
  const resolved = resolvePath(process.cwd(), rawPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`--haki-issued-count-file does not resolve to an existing regular file: ${rawPath}`);
  }
  return resolved;
}

export function parseCliArgs(argv: string[]): ReconciliationArgs {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      'org-id': { type: 'string' },
      'window-start': { type: 'string' },
      'window-end': { type: 'string' },
      'haki-issued-count': { type: 'string' },
      'haki-issued-count-file': { type: 'string' },
      'fail-below-target': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  let hakiIssuedCount: number | undefined;
  if (values['haki-issued-count-file']) {
    const safePath = resolveIssuedCountFilePath(values['haki-issued-count-file']);
    const raw: unknown = JSON.parse(readFileSync(safePath, 'utf8'));
    // Accept either a bare number or { "issuedCount": N } for a friendlier file shape.
    const n = typeof raw === 'number' ? raw : (raw as { issuedCount?: unknown } | null)?.issuedCount;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new TypeError(`--haki-issued-count-file must contain a number or {"issuedCount": N}`);
    }
    hakiIssuedCount = n;
  } else if (values['haki-issued-count'] !== undefined) {
    hakiIssuedCount = Number(values['haki-issued-count']);
  }

  return ReconciliationArgsSchema.parse({
    orgId: values['org-id'],
    windowStart: values['window-start'],
    windowEnd: values['window-end'],
    hakiIssuedCount,
    failBelowTarget: values['fail-below-target'],
    json: values.json,
  });
}

// ── Supabase config (read-only) ────────────────────────────────────────────

export interface SupabaseConfig {
  url: string;
  readKey: string;
}

/**
 * No credentials embedded — read from the environment only. Prefers
 * `SUPABASE_SERVICE_ROLE_KEY` (needed to read across orgs regardless of the
 * caller's own RLS scope); falls back to `SUPABASE_ANON_KEY` for a narrower
 * read-only credential if that's all the operator has configured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig {
  const url = env.SUPABASE_URL;
  const readKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  if (!url) throw new Error('Required env: SUPABASE_URL');
  if (!readKey) throw new Error('Required env: SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)');
  return { url, readKey };
}

/** GET-only PostgREST fetch. There is no write method in this module. */
async function pgrestGet(cfg: SupabaseConfig, path: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${cfg.url}/rest/v1${path}`, {
      method: 'GET',
      headers: {
        apikey: cfg.readKey,
        Authorization: `Bearer ${cfg.readKey}`,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const safePath = path.split('?')[0];
      throw new Error(`Supabase GET ${safePath} → HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── DB row shapes (only the columns this tool reads) ───────────────────────

export interface AnchorRow {
  id: string;
  public_id: string | null;
  status: string; // anchor_status enum: PENDING|SECURED|REVOKED|EXPIRED|SUBMITTED|BROADCASTING|SUPERSEDED|PENDING_RESOLUTION
  fingerprint: string | null;
  created_at: string;
}

export interface VerificationEventRow {
  anchor_id: string | null;
  public_id: string;
  result: string; // 'verified' | 'revoked' | 'not_found' | 'error'
  created_at: string;
}

/**
 * Fetch the org's anchors created in [windowStart, windowEnd] (inclusive,
 * UTC date boundaries) plus every `result='verified'` verification event for
 * those anchors. Two GET requests, both read-only. `deleted_at=is.null` is
 * included deliberately: it matches the `idx_anchors_org_deleted_created`
 * partial index on `anchors(org_id, created_at DESC) WHERE deleted_at IS
 * NULL`, so the org-scoped query stays an index scan instead of a full-table
 * scan on the multi-million-row `anchors` table (observed live 2026-07-28:
 * an org_id-only filter without this predicate seq-scans and can time out).
 */
export async function fetchReconciliationInputs(
  cfg: SupabaseConfig,
  orgId: string,
  windowStart: string,
  windowEnd: string,
): Promise<{ anchors: AnchorRow[]; verificationEvents: VerificationEventRow[] }> {
  const windowEndExclusive = `${windowEnd}T23:59:59.999Z`;
  const anchors = (await pgrestGet(
    cfg,
    `/anchors?org_id=eq.${orgId}&deleted_at=is.null` +
      `&created_at=gte.${windowStart}T00:00:00.000Z&created_at=lte.${windowEndExclusive}` +
      `&select=id,public_id,status,fingerprint,created_at&order=created_at.asc`,
  )) as AnchorRow[];

  if (anchors.length === 0) {
    return { anchors: [], verificationEvents: [] };
  }

  const anchorIds = anchors.map((a) => a.id).join(',');
  const verificationEvents = (await pgrestGet(
    cfg,
    `/verification_events?anchor_id=in.(${anchorIds})&result=eq.verified` +
      `&select=anchor_id,public_id,result,created_at`,
  )) as VerificationEventRow[];

  return { anchors, verificationEvents };
}

// ── pure reconciliation logic (unit-tested with mocked rows, no network) ───

export type PipelineStage = 'fingerprint' | 'anchor' | 'verification';

export interface AnchorReconciliationRow {
  anchor_id: string;
  public_id: string | null;
  status: string;
  created_at: string;
  fingerprinted: boolean;
  anchored: boolean;
  verified: boolean;
  complete: boolean;
  /** First pipeline stage this anchor has NOT cleared; null when complete. */
  stoppedAt: PipelineStage | null;
}

export interface HakiChainComparison {
  /** HakiChain's self-reported issued count for the window, or null if not supplied. */
  reportedIssuedCount: number | null;
  /** Arkova's own count of anchors issued (rows returned) for the org+window. */
  arkovaIssuedCount: number;
  /** arkovaIssuedCount - reportedIssuedCount; null when reportedIssuedCount is null. */
  delta: number | null;
  note: string;
}

export interface ReconciliationResult {
  orgId: string;
  window: { start: string; end: string };
  generatedAt: string;
  totalIssued: number;
  byStatus: Record<string, number>;
  completedFullCycle: number;
  /** 0–100, rounded to 2 decimals. 0 when totalIssued is 0 (see completionNote). */
  completionPct: number;
  targetPct: number;
  meetsTarget: boolean;
  completionNote: string | null;
  incomplete: AnchorReconciliationRow[];
  hakiChain: HakiChainComparison;
  measurementNote: string;
}

const MEASUREMENT_NOTE =
  'ASSERTED vs MEASURED (CLAUDE.md §1.5): this reconciliation measures Arkova-observed ' +
  'state only — anchors.status and verification_events rows for this org and window. ' +
  '"Verified" means >=1 verification_events row with result=\'verified\' exists for the ' +
  'anchor; Arkova verification logs do not distinguish an issuer\'s own dashboard lookup ' +
  'from a non-issuer/external check, so this number is the KPI #2 log-based signal only, ' +
  'NOT the stronger "independent verification by a non-issuer party" KPI #3 check (see ' +
  'scripts/kpi3/). HakiChain\'s own issued count is NOT observable by Arkova and is never ' +
  'inferred here — it is only ever the caller-supplied self-report in hakiChain.reportedIssuedCount.';

export interface BuildReconciliationInput {
  orgId: string;
  windowStart: string;
  windowEnd: string;
  anchors: AnchorRow[];
  verificationEvents: VerificationEventRow[];
  hakiReportedIssuedCount?: number;
  /** Injectable for deterministic tests; defaults to `new Date().toISOString()`. */
  now?: () => string;
}

function isFingerprinted(row: AnchorRow): boolean {
  return typeof row.fingerprint === 'string' && FINGERPRINT_RE.test(row.fingerprint.trim());
}

/** First pipeline stage an incomplete anchor has NOT cleared; null when complete. */
function determineStoppedAtStage(
  complete: boolean,
  fingerprinted: boolean,
  anchored: boolean,
): PipelineStage | null {
  if (complete) return null;
  if (!fingerprinted) return 'fingerprint';
  if (!anchored) return 'anchor';
  return 'verification';
}

function buildAnchorReconciliationRow(
  anchor: AnchorRow,
  verifiedAnchorIds: ReadonlySet<string>,
  verifiedPublicIds: ReadonlySet<string>,
): AnchorReconciliationRow {
  const fingerprinted = isFingerprinted(anchor);
  const anchored = anchor.status === ANCHORED_STATUS;
  const verified =
    verifiedAnchorIds.has(anchor.id) || (anchor.public_id !== null && verifiedPublicIds.has(anchor.public_id));
  const complete = fingerprinted && anchored && verified;

  return {
    anchor_id: anchor.id,
    public_id: anchor.public_id,
    status: anchor.status,
    created_at: anchor.created_at,
    fingerprinted,
    anchored,
    verified,
    complete,
    stoppedAt: determineStoppedAtStage(complete, fingerprinted, anchored),
  };
}

/** Formats a signed delta count, e.g. `+3` or `-2` (never a bare unsigned positive). */
function formatSignedDelta(delta: number): string {
  return delta >= 0 ? `+${delta}` : `${delta}`;
}

function buildHakiChainComparison(totalIssued: number, hakiReportedIssuedCount?: number): HakiChainComparison {
  const reportedIssuedCount = hakiReportedIssuedCount ?? null;

  if (reportedIssuedCount === null) {
    return {
      reportedIssuedCount,
      arkovaIssuedCount: totalIssued,
      delta: null,
      note:
        "HakiChain's issued count was not supplied this run (--haki-issued-count / " +
        '--haki-issued-count-file). Arkova cannot observe it directly; delta is unavailable ' +
        'until HakiChain supplies it for this window.',
    };
  }

  const delta = totalIssued - reportedIssuedCount;
  return {
    reportedIssuedCount,
    arkovaIssuedCount: totalIssued,
    delta,
    note:
      `HakiChain self-reported ${reportedIssuedCount} issued; Arkova observed ${totalIssued} ` +
      `anchor(s) for this org in the window (delta ${formatSignedDelta(delta)}). ` +
      "This is HakiChain's self-report reconciled against Arkova's own count, not an " +
      'independent check of HakiChain-side data.',
  };
}

/**
 * Pure function: given already-fetched rows, compute the full KPI-2
 * reconciliation. No I/O — this is the fully unit-testable surface.
 */
export function buildReconciliation(input: BuildReconciliationInput): ReconciliationResult {
  const { orgId, windowStart, windowEnd, anchors, verificationEvents } = input;
  const now = input.now ?? (() => new Date().toISOString());

  const verifiedAnchorIds = new Set<string>();
  const verifiedPublicIds = new Set<string>();
  for (const ev of verificationEvents) {
    if (ev.result !== 'verified') continue; // defensive: caller should already filter, but never trust upstream blindly
    if (ev.anchor_id) verifiedAnchorIds.add(ev.anchor_id);
    if (ev.public_id) verifiedPublicIds.add(ev.public_id);
  }

  const byStatus: Record<string, number> = {};
  const rows: AnchorReconciliationRow[] = [];

  for (const a of anchors) {
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    rows.push(buildAnchorReconciliationRow(a, verifiedAnchorIds, verifiedPublicIds));
  }

  const totalIssued = anchors.length;
  const completedFullCycle = rows.filter((r) => r.complete).length;
  const completionPct = totalIssued === 0 ? 0 : Math.round((completedFullCycle / totalIssued) * 10_000) / 100;
  const meetsTarget = totalIssued > 0 && completionPct >= KPI2_TARGET_PCT;
  const completionNote = totalIssued === 0 ? 'no anchors issued in this window; completion % is not meaningful' : null;

  return {
    orgId,
    window: { start: windowStart, end: windowEnd },
    generatedAt: now(),
    totalIssued,
    byStatus,
    completedFullCycle,
    completionPct,
    targetPct: KPI2_TARGET_PCT,
    meetsTarget,
    completionNote,
    incomplete: rows.filter((r) => !r.complete),
    hakiChain: buildHakiChainComparison(totalIssued, input.hakiReportedIssuedCount),
    measurementNote: MEASUREMENT_NOTE,
  };
}

// ── human-readable summary ──────────────────────────────────────────────────

export function formatSummary(result: ReconciliationResult): string {
  const lines: string[] = [];
  lines.push(
    `HakiChain KPI-2 weekly reconciliation — org ${result.orgId}`,
    `  window          : ${result.window.start} .. ${result.window.end}`,
    `  generated at    : ${result.generatedAt}`,
    `  anchors issued  : ${result.totalIssued}`,
  );
  // Explicit compare function: sort by status name — Array#sort()'s default
  // coerces each [status, count] entry to a string, which happens to sort by
  // status first but relies on undocumented, type-unsafe coercion behavior.
  for (const [status, count] of Object.entries(result.byStatus).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`    - ${status}: ${count}`);
  }
  lines.push(
    `  full-cycle done : ${result.completedFullCycle} / ${result.totalIssued}`,
    `  completion      : ${result.completionPct}% (target >= ${result.targetPct}%) — ` +
      `${result.meetsTarget ? 'MEETS TARGET' : 'BELOW TARGET'}`,
  );
  if (result.completionNote) lines.push(`  note            : ${result.completionNote}`);
  lines.push(`  HakiChain delta : ${result.hakiChain.note}`);
  if (result.incomplete.length > 0) {
    lines.push(`  incomplete anchors (stopped-at stage):`);
    for (const r of result.incomplete) {
      lines.push(`    - ${r.public_id ?? r.anchor_id} [${r.status}] stopped at: ${r.stoppedAt}`);
    }
  }
  lines.push('', `  ${result.measurementNote}`);
  return lines.join('\n');
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv);
  const cfg = loadConfig();
  const { anchors, verificationEvents } = await fetchReconciliationInputs(
    cfg,
    args.orgId,
    args.windowStart,
    args.windowEnd,
  );
  const result = buildReconciliation({
    orgId: args.orgId,
    windowStart: args.windowStart,
    windowEnd: args.windowEnd,
    anchors,
    verificationEvents,
    hakiReportedIssuedCount: args.hakiIssuedCount,
  });

  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.log(formatSummary(result));
  }

  if (args.failBelowTarget && !result.meetsTarget) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
