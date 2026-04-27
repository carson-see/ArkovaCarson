/**
 * SCRUM-1271 (R2-8) — v1 UUID leak detector (warn-only).
 *
 * Scans `services/worker/src/api/v1/*.ts` for response-shape patterns that
 * leak internal UUIDs. CLAUDE.md §6 hard-bans these in v1 responses; full
 * removal is gated on §1.8 v2 namespace + 12-month deprecation. Until then,
 * this lint surfaces new leaks at PR time so they're audible instead of
 * silent.
 *
 * Patterns flagged:
 *   • `res.json(<row>)` where the spread contains banned keys
 *   • `res.json({ ...row, ... })` spreading a row that includes banned keys
 *   • `.select('*')` followed by `res.json(data)`
 *
 * Banned keys (in v1 response position):
 *   id, org_id, user_id, agent_id, key_id, endpoint_id, attestation_id,
 *   actor_id (when not actor_public_id)
 *
 * Override: any handler that legitimately leaks (frozen pre-existing field
 * that requires v2 migration to remove) MUST add `// SCRUM-1271-EXEMPT: <reason>`
 * on the same line. The exempt registry is reviewed monthly.
 *
 * Exit code: 0 always (warn-only). Flip to 1 once the v2 cutover lands per
 * docs/runbooks/v1-uuid-leak-deprecation.md.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const V1_DIR = join(ROOT, 'services/worker/src/api/v1');

const BANNED_KEYS = [
  'id',
  'org_id',
  'user_id',
  'agent_id',
  'key_id',
  'endpoint_id',
  'attestation_id',
  'actor_id',
];

interface Finding {
  file: string;
  line: number;
  match: string;
  reason: string;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function scanFile(file: string): Finding[] {
  const content = readFileSync(file, 'utf8');
  const lines = content.split('\n');
  const findings: Finding[] = [];

  // Detect res.json patterns that look like row-spread leaks.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('SCRUM-1271-EXEMPT')) continue;

    // res.json({ ...row, ... }) where row is a DB row with banned keys
    const spreadMatch = /res\.(json|status\(\d+\)\.json)\(\s*\{\s*\.\.\.(\w+)/.exec(line);
    if (spreadMatch) {
      findings.push({
        file: relative(ROOT, file),
        line: i + 1,
        match: line.trim(),
        reason: `spreads "${spreadMatch[2]}" into v1 response — likely leaks DB UUIDs (id/org_id/...)`,
      });
      continue;
    }

    // res.json(row) or res.status(N).json(row) where row is a single identifier
    const rowMatch = /res\.(?:json|status\(\d+\)\.json)\(\s*([a-z_][a-zA-Z0-9_]*)\s*\)/.exec(line);
    if (rowMatch) {
      const ident = rowMatch[1];
      // false-positive filter: well-known sanitized response builders
      if (['response', 'payload', 'sanitized', 'publicView', 'errorResponse'].includes(ident)) {
        continue;
      }
      findings.push({
        file: relative(ROOT, file),
        line: i + 1,
        match: line.trim(),
        reason: `passes "${ident}" directly to res.json — verify it doesn't include ${BANNED_KEYS.join('/')}`,
      });
    }
  }

  return findings;
}

function main(): void {
  const files = walkTs(V1_DIR);
  let totalFindings = 0;
  for (const file of files) {
    const findings = scanFile(file);
    if (findings.length === 0) continue;
    for (const f of findings) {
      console.log(`::warning file=${f.file},line=${f.line}::SCRUM-1271 v1-uuid-leak: ${f.reason}`);
      totalFindings++;
    }
  }
  console.log(
    `\nSCRUM-1271 lint: ${totalFindings} potential v1 UUID leak${totalFindings === 1 ? '' : 's'} flagged ` +
      `(warn-only). See docs/runbooks/v1-uuid-leak-deprecation.md for the cutover plan.`,
  );
  // Warn-only: do not fail the build until v2 cutover lands.
  process.exit(0);
}

main();
