#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1306 (R0-7-FU1) rule: feedback_local_matches_prod.
 *
 * Compares the local migration ledger's resulting table set against a
 * cached snapshot of the prod schema (`scripts/ci/snapshots/prod-tables.json`).
 * Catches drift like "table only created locally" or "demo seed table never
 * promoted to prod" — the failure mode memory/feedback_local_matches_prod.md
 * was written for.
 *
 * Why a snapshot vs live MCP: live Supabase MCP isn't available in CI, and
 * a daily snapshot dump is good enough for catch-on-merge drift. Operator
 * refreshes the snapshot post-major-migration via Supabase MCP `list_tables`
 * (helper script deferred — for now the snapshot is hand-maintained).
 *
 * Warn-only when the snapshot is missing (bootstrap state). Override via
 * PR label `local-matches-prod-skip`.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasLabel, REPO } from '../lib/ciContext.js';

const MIGRATIONS_DIR = resolve(REPO, 'supabase/migrations');
const SNAPSHOT_FILE =
  process.env.PROD_TABLES_FILE ?? resolve(REPO, 'scripts/ci/snapshots/prod-tables.json');

function localTableSet(): Set<string> {
  const tables = new Set<string>();
  if (!existsSync(MIGRATIONS_DIR)) return tables;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const raw = readFileSync(resolve(MIGRATIONS_DIR, f), 'utf8');
    // Strip line + block comments before scanning. Migration rollback hints
    // (`-- Rollback: DROP TABLE foo`) and helper SQL inside SECDEF function
    // bodies otherwise polluted the DROP detection. Trust CREATE TABLE
    // statements only — explicit drops on already-created tables are rare
    // enough that false positives are acceptable; we'd rather over-report
    // than silently miss a real prod-vs-local table.
    const sql = raw
      .split('\n')
      .filter((line) => !/^\s*--/.test(line))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // Captures schema (group 1) + table (group 2). When schema is anything
    // other than `public` (or absent), skip — this rule scans the public.* set.
    // Without splitting these out, `CREATE TABLE auth.foo` would otherwise
    // match `auth` as the table name and false-flag a non-existent drift.
    const createRe =
      /(?:^|;)\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?([a-z_][a-z0-9_]*)"?\.)?"?([a-z_][a-z0-9_]*)"?/gim;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(sql)) !== null) {
      const schema = (m[1] ?? 'public').toLowerCase();
      if (schema !== 'public') continue;
      tables.add(m[2].toLowerCase());
    }
  }
  return tables;
}

interface SnapshotShape {
  tables: { name: string; schema?: string }[];
  _known_drift?: {
    in_migrations_only?: { name: string; reason: string }[];
    in_prod_only?: { name: string; reason: string }[];
  };
}

interface ParsedSnapshot {
  prod: Set<string>;
  drift: { migrationsOnly: Set<string>; prodOnly: Set<string> };
}

// Read + parse the snapshot file once and return both the prod-table set
// and the known-drift allow-lists. Returns null if the file is missing
// (bootstrapping case).
function loadSnapshot(): ParsedSnapshot | null {
  if (!existsSync(SNAPSHOT_FILE)) return null;
  const raw = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as
    | { name: string; schema?: string }[]
    | SnapshotShape;
  const arr = Array.isArray(raw) ? raw : raw.tables;
  const prod = new Set(
    arr
      .filter((t) => !t.schema || t.schema === 'public')
      .map((t) => t.name.toLowerCase()),
  );
  const driftSpec = Array.isArray(raw) ? undefined : raw._known_drift;
  return {
    prod,
    drift: {
      migrationsOnly: new Set(
        (driftSpec?.in_migrations_only ?? []).map((t) => t.name.toLowerCase()),
      ),
      prodOnly: new Set((driftSpec?.in_prod_only ?? []).map((t) => t.name.toLowerCase())),
    },
  };
}

export function run(): { ok: boolean; message: string } {
  if (hasLabel('local-matches-prod-skip')) {
    return {
      ok: true,
      message: '🏷️  feedback_local_matches_prod: skipped (PR label `local-matches-prod-skip`).',
    };
  }

  const local = localTableSet();
  const snapshot = loadSnapshot();

  if (!snapshot) {
    return {
      ok: true,
      message:
        `⏳ feedback_local_matches_prod: snapshot at ${SNAPSHOT_FILE} not found — bootstrapping run, skipping. ` +
        'Refresh snapshot after a known-good prod schema window (operator step).',
    };
  }

  const { prod, drift } = snapshot;
  const onlyLocal = [...local]
    .filter((t) => !prod.has(t) && !drift.migrationsOnly.has(t))
    .sort((a, b) => a.localeCompare(b));
  const onlyProd = [...prod]
    .filter((t) => !local.has(t) && !drift.prodOnly.has(t))
    .sort((a, b) => a.localeCompare(b));

  if (onlyLocal.length === 0 && onlyProd.length === 0) {
    const allowedSize = drift.migrationsOnly.size + drift.prodOnly.size;
    const note = allowedSize > 0 ? ` (${allowedSize} known-drift entries allowed)` : '';
    return {
      ok: true,
      message: `✅ feedback_local_matches_prod: clean (${local.size} tables in migrations, ${prod.size} in prod)${note}.`,
    };
  }

  const lines: string[] = [];
  if (onlyLocal.length > 0) {
    lines.push(
      `⚠️  ${onlyLocal.length} table(s) in migrations but NOT in prod snapshot — ${onlyLocal.join(', ')}`,
    );
  }
  if (onlyProd.length > 0) {
    lines.push(
      `⚠️  ${onlyProd.length} table(s) in prod snapshot but NOT in migrations — ${onlyProd.join(', ')}`,
    );
  }
  return { ok: false, message: `feedback_local_matches_prod:\n${lines.join('\n')}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
