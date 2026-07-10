#!/usr/bin/env npx tsx
/**
 * scripts/ci/check-s33-sequencing-gate.ts — L2-S1 (Sprint 3.3).
 *
 * Rig-day sequencing gate: refuses to declare the S3.3 isolated-rig window
 * startable while either of these holds:
 *
 *   1. ANY open PR is DB-mutating (touches `supabase/migrations/`, seed, or a
 *      regenerated `database.types.ts`). An unmerged migration means the schema
 *      a freshly provisioned isolated rig replays via `db push --linked` is
 *      about to change — the rig's `clean_mirror` claim would be stale on
 *      arrival and every soak on it would be evidence against the wrong schema.
 *      DB-surface classification REUSES the check-staging-evidence detector
 *      (`PATH_RULES` — the T3 migration rule) so this gate can never drift from
 *      the tier detector, plus the schema artifacts that ride a migration.
 *
 *   2. Prod cannot be shown green. The prod-green probe is a STUB for now
 *      (explicit `S33_PROD_GREEN=true|false` operator env; anything else is
 *      `unknown`) and the gate FAILS CLOSED on `unknown` — wiring to the
 *      release-evidence cron / a read-only /api/health probe is follow-up work.
 *      The stub never guesses green.
 *
 * Read-only: enumerates open PRs via `gh pr list` (no mutation, no rig/Supabase
 * contact). Exit 0 = window startable; exit 1 = blocked with actionable lines.
 *
 * Usage:
 *   npx tsx scripts/ci/check-s33-sequencing-gate.ts
 *   S33_PROD_GREEN=true npx tsx scripts/ci/check-s33-sequencing-gate.ts
 */

import { execFileSync } from 'node:child_process';

import { PATH_RULES } from './check-staging-evidence';

// ── Pure core (unit-tested) ──────────────────────────────────────────────────

export interface OpenPrSummary {
  number: number;
  title: string;
  isDraft: boolean;
  files: string[];
}

export type ProdGreen = 'green' | 'red' | 'unknown';

export interface SequencingInput {
  openPrs: OpenPrSummary[];
  prodGreen: ProdGreen;
}

export interface SequencingResult {
  ok: boolean;
  blockers: string[];
}

/**
 * The DB-mutating subset of the staging-evidence path detector: every
 * PATH_RULES entry that targets the supabase schema surface. Derived (not
 * copied) so a new supabase path rule automatically widens this gate.
 */
export const DB_MUTATING_RULES = PATH_RULES.filter((rule) =>
  rule.pattern.source.includes('supabase'),
);

/**
 * Schema artifacts that ride a migration but live outside supabase/migrations:
 * the regenerated types files, the seed, and staging-only SQL. Any of these in
 * an open PR means DB state is about to move.
 */
const DB_SCHEMA_ARTIFACTS_RE =
  /^(supabase\/(migrations|seed)|src\/types\/database\.types\.ts$|services\/worker\/src\/types\/database\.types\.ts$|scripts\/staging\/migrations\/)/;

export function isDbMutatingFile(file: string): boolean {
  return (
    DB_MUTATING_RULES.some((rule) => rule.pattern.test(file)) || DB_SCHEMA_ARTIFACTS_RE.test(file)
  );
}

export interface DbMutatingPr extends OpenPrSummary {
  dbFiles: string[];
}

/** The subset of open PRs that touch a DB-mutating surface. */
export function dbMutatingPrs(prs: OpenPrSummary[]): DbMutatingPr[] {
  const out: DbMutatingPr[] = [];
  for (const pr of prs) {
    const dbFiles = pr.files.filter(isDbMutatingFile);
    if (dbFiles.length > 0) out.push({ ...pr, dbFiles });
  }
  return out;
}

/** Parse `gh pr list --json number,title,isDraft,files` output. Throws on malformed input — a parse failure must fail the gate, never pass it. */
export function parseGhPrListJson(raw: string): OpenPrSummary[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('gh pr list output is not an array — refusing to evaluate the gate on it.');
  }
  return parsed.map((entry) => {
    const e = entry as {
      number?: unknown;
      title?: unknown;
      isDraft?: unknown;
      files?: Array<{ path?: unknown }>;
    };
    if (typeof e.number !== 'number' || typeof e.title !== 'string' || !Array.isArray(e.files)) {
      throw new Error(`gh pr list entry malformed: ${JSON.stringify(entry).slice(0, 200)}`);
    }
    return {
      number: e.number,
      title: e.title,
      isDraft: e.isDraft === true,
      files: e.files
        .map((f) => (typeof f?.path === 'string' ? f.path : ''))
        .filter((p) => p.length > 0),
    };
  });
}

/**
 * Prod-green STUB. Reads only an explicit operator assertion; anything else is
 * `unknown` (and the gate fails closed on unknown). Follow-up: wire the
 * release-evidence cron / read-only /api/health + gcloud revision check here.
 */
export function resolveProdGreen(env: Record<string, string | undefined>): ProdGreen {
  if (env.S33_PROD_GREEN === 'true') return 'green';
  if (env.S33_PROD_GREEN === 'false') return 'red';
  return 'unknown';
}

export function evaluateSequencingGate(input: SequencingInput): SequencingResult {
  const blockers: string[] = [];

  for (const pr of dbMutatingPrs(input.openPrs)) {
    blockers.push(
      `open DB-mutating PR #${pr.number}${pr.isDraft ? ' (draft)' : ''} — "${pr.title}" touches: ${pr.dbFiles.join(', ')}. ` +
        'Merge (or close) it before the rig window: an unmerged migration makes every freshly-replayed rig schema stale on arrival.',
    );
  }

  if (input.prodGreen === 'red') {
    blockers.push('prod is asserted RED (S33_PROD_GREEN=false) — do not start the rig window.');
  } else if (input.prodGreen === 'unknown') {
    blockers.push(
      'prod state is UNKNOWN — the gate fails closed. Verify prod in-session (read-only /api/health + gcloud revision) and re-run with S33_PROD_GREEN=true|false.',
    );
  }

  return { ok: blockers.length === 0, blockers };
}

// ── Runtime (thin; needs gh on PATH) ─────────────────────────────────────────

function listOpenPrs(): OpenPrSummary[] {
  const raw = execFileSync(
    'gh',
    ['pr', 'list', '--state', 'open', '--json', 'number,title,isDraft,files', '--limit', '100'],
    { encoding: 'utf8' },
  );
  return parseGhPrListJson(raw);
}

function main(): void {
  const openPrs = listOpenPrs();
  const prodGreen = resolveProdGreen(process.env);
  const result = evaluateSequencingGate({ openPrs, prodGreen });

  console.log(`S3.3 sequencing gate — open PRs: ${openPrs.length}, prod: ${prodGreen}`);
  if (result.ok) {
    console.log('PASS: no open DB-mutating PRs and prod asserted green — rig window startable.');
    return;
  }
  console.error('BLOCKED — the S3.3 rig window may not start:');
  for (const blocker of result.blockers) {
    console.error(`  - ${blocker}`);
  }
  process.exitCode = 1;
}

// Only auto-run when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
