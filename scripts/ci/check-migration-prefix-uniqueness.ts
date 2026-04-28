#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1287 (R4-2) — block NEW migration filename prefix collisions.
 *
 * Why: `npx supabase db reset` orders migrations lexicographically; two
 * `0258_*` files (or two `20260427_*` timestamps) apply in undefined
 * order. The canonical fix is `npx supabase migration new <topic>`,
 * which produces a fresh timestamp.
 *
 * 12 existing collisions are grandfathered in this baseline. Any NEW
 * collision is a CI failure.
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO = process.env.MIGRATION_PREFIX_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations');
const BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'migration-prefix-baseline.json');

interface Baseline {
  /** Prefixes that already collide and are grandfathered. */
  grandfathered: string[];
}

function extractPrefix(filename: string): string | null {
  // Match leading 4-digit numeric ("0258_...") or full timestamp ("20260427_...")
  const m = filename.match(/^(\d{4,})_/);
  return m ? m[1] : null;
}

function loadBaseline(): Set<string> {
  if (!existsSync(BASELINE_PATH)) return new Set();
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  return new Set(raw.grandfathered);
}

function main(): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('_'))
    .sort();

  const byPrefix = new Map<string, string[]>();
  for (const file of files) {
    const prefix = extractPrefix(file);
    if (!prefix) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push(file);
  }

  const grandfathered = loadBaseline();
  const novel: Array<{ prefix: string; files: string[] }> = [];
  for (const [prefix, list] of byPrefix) {
    if (list.length <= 1) continue;
    if (grandfathered.has(prefix)) continue;
    novel.push({ prefix, files: list });
  }

  if (novel.length === 0) {
    console.log(
      `✅ No new migration prefix collisions ` +
        `(${grandfathered.size} grandfathered).`,
    );
    return;
  }

  console.error(`::error::SCRUM-1287: ${novel.length} new migration prefix collision(s):`);
  for (const v of novel) {
    console.error(`  ${v.prefix} → ${v.files.join(', ')}`);
  }
  console.error('');
  console.error('Use `npx supabase migration new <topic>` for new migrations — it produces');
  console.error('a fresh timestamp prefix that cannot collide. Or rename one of the colliding');
  console.error('files to a free prefix.');
  process.exit(1);
}

main();
