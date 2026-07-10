import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * L2-S0 (Sprint 3.3) — drift lint for the five-bucket 429 limiter map.
 *
 * docs/staging/429-limiter-map-s33.md enumerates every 429 emitter in the
 * worker with file:line claims, plus two DEAD-CODE claims (perOrgRateLimit
 * never mounted; x402 payer limiter orphaned). A stale map is worse than no
 * map — the S3.3 exit criterion 3a (CTO memo R2) hangs attribution buckets
 * off these exact locations. This test fails when the tree drifts:
 *
 *   1. Every row of the map's machine-readable "Claims ledger" table must
 *      still hold: the named file's named LINE must contain the named text.
 *   2. The structurally-zero claims must stay true: if someone mounts
 *      perOrgRateLimit or wires the x402 payer limiter, this test fails and
 *      forces the map (and the attribution spec) to be revised.
 *
 * If this test fails after your change: update the map's ledger row(s) AND
 * re-read the attribution spec section — a moved/mounted limiter usually
 * changes bucket wiring, not just a line number.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const MAP_PATH = join(REPO_ROOT, 'docs', 'staging', '429-limiter-map-s33.md');
const WORKER_SRC = join(REPO_ROOT, 'services', 'worker', 'src');

interface LedgerClaim {
  id: string;
  file: string;
  line: number;
  needle: string;
}

/** Split a markdown table row on unescaped pipes; unescape \| afterwards. */
function splitRow(row: string): string[] {
  return row
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function parseClaimsLedger(): LedgerClaim[] {
  const doc = readFileSync(MAP_PATH, 'utf8');
  const begin = doc.indexOf('<!-- claims:begin -->');
  const end = doc.indexOf('<!-- claims:end -->');
  expect(begin, 'map must contain a <!-- claims:begin --> marker').toBeGreaterThan(-1);
  expect(end, 'map must contain a <!-- claims:end --> marker').toBeGreaterThan(begin);

  const rows = doc
    .slice(begin, end)
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .slice(2); // drop header + separator rows

  return rows.map((row) => {
    const cells = splitRow(row);
    expect(cells.length, `ledger row needs 4 cells: ${row}`).toBeGreaterThanOrEqual(4);
    const [id, file, line, needle] = cells;
    return { id, file, line: Number(line), needle };
  });
}

/** Recursively list .ts files under a dir. */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('429 limiter map — file:line claims ledger', () => {
  it('the map document exists', () => {
    expect(existsSync(MAP_PATH), `expected ${MAP_PATH}`).toBe(true);
  });

  it('every ledger claim still holds against the tree (file exists, line contains text)', () => {
    const claims = parseClaimsLedger();
    expect(claims.length, 'the ledger must carry the full emitter inventory').toBeGreaterThanOrEqual(20);

    const failures: string[] = [];
    for (const claim of claims) {
      const filePath = join(REPO_ROOT, claim.file);
      if (!existsSync(filePath)) {
        failures.push(`[${claim.id}] missing file: ${claim.file}`);
        continue;
      }
      const lines = readFileSync(filePath, 'utf8').split('\n');
      const actual = lines[claim.line - 1] ?? '<past end of file>';
      if (!actual.includes(claim.needle)) {
        failures.push(
          `[${claim.id}] ${claim.file}:${claim.line} drifted.\n    expected to contain: ${claim.needle}\n    actual line:         ${actual.trim()}`,
        );
      }
    }
    expect(failures, `\n${failures.join('\n')}\n\nThe tree drifted from docs/staging/429-limiter-map-s33.md — update the map's Claims ledger (and re-check the attribution spec).`).toEqual([]);
  });

  it('names the five attribution buckets exactly (CTO R2 exit criterion 3a)', () => {
    const doc = readFileSync(MAP_PATH, 'utf8');
    for (const bucket of [
      'anon-IP',
      'keyed',
      'aiRateLimiter',
      'usageTracking-monthly',
      'upstream-model',
    ]) {
      expect(doc, `bucket "${bucket}" must be named in the map`).toContain(bucket);
    }
    // Buckets measure different populations at different layers — a sum is
    // meaningless and R2 bans it outright.
    expect(doc).toContain('never summed');
    expect(doc).toContain('structurally_zero');
  });
});

describe('429 limiter map — dead-code claims stay true', () => {
  const allWorkerTs = tsFilesUnder(WORKER_SRC).filter(
    (f) => !f.endsWith('.test.ts') && !f.includes('__tests__'),
  );

  it('perOrgRateLimit is still UNMOUNTED (no non-test consumer imports requireOrgQuota)', () => {
    const consumers = allWorkerTs.filter(
      (f) =>
        !f.endsWith('perOrgRateLimit.ts') &&
        /perOrgRateLimit|requireOrgQuota/.test(readFileSync(f, 'utf8')),
    );
    expect(
      consumers,
      'perOrgRateLimit gained a consumer — the map\'s "structurally_zero (unmounted)" row and the five-bucket spec must be revised, and the SCALE-01 bug updated',
    ).toEqual([]);
  });

  it('x402 payer rate limiter is still an orphan (no non-test consumer)', () => {
    const consumers = allWorkerTs.filter(
      (f) =>
        !f.endsWith('x402PayerRateLimit.ts') &&
        /x402PayerRateLimit|createPayerRateLimiter/.test(readFileSync(f, 'utf8')),
    );
    expect(
      consumers,
      'x402PayerRateLimit gained a consumer — the map\'s orphan row must be revised and its bug updated',
    ).toEqual([]);
  });
});
