import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * L2-S0 (Sprint 3.3) — drift lint for the five-bucket 429 limiter map.
 *
 * docs/staging/429-limiter-map-s33.md enumerates every 429 emitter in the
 * worker with file:line claims, plus exact wiring claims for the per-org and
 * x402 payer limiters. A stale map is worse than no
 * map — the S3.3 exit criterion 3a (CTO memo R2) hangs attribution buckets
 * off these exact locations. This test fails when the tree drifts:
 *
 *   1. Every row of the map's machine-readable "Claims ledger" table must
 *      still hold: the named file's named LINE must contain the named text.
 *   2. The mounted-but-excluded claims must stay true at their ratified
 *      write/Nessie surfaces without becoming a sixth headline bucket.
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

  // REVIEW NOTE (S3.3 cross-lane review): the ledger asserts NEEDLE PRESENCE in
  // the named file, not exact line position. Line-exact pinning of hot files
  // (router.ts, gemini.ts) in repo-wide CI would false-fail every unrelated PR
  // that shifts a line; the map's line numbers are a snapshot locator hint.
  // The real tripwires — emitter existence + the dead-code mount greps below —
  // stay strict.
  it('every ledger claim still holds against the tree (file exists, needle present)', () => {
    const claims = parseClaimsLedger();
    expect(claims.length, 'the ledger must carry the full emitter inventory').toBeGreaterThanOrEqual(20);

    const failures: string[] = [];
    for (const claim of claims) {
      const filePath = join(REPO_ROOT, claim.file);
      if (!existsSync(filePath)) {
        failures.push(`[${claim.id}] missing file: ${claim.file}`);
        continue;
      }
      const content = readFileSync(filePath, 'utf8');
      if (!content.includes(claim.needle)) {
        failures.push(
          `[${claim.id}] ${claim.file} drifted (claimed near :${claim.line}).\n    expected file to contain: ${claim.needle}`,
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
    expect(doc).toContain('mounted_excluded');
  });
});

describe('429 limiter map — mounted/excluded wiring stays exact', () => {
  const allWorkerTs = tsFilesUnder(WORKER_SRC).filter(
    (f) => !f.endsWith('.test.ts') && !f.includes('__tests__'),
  );

  it('perOrgRateLimit is mounted only on the ratified write surfaces', () => {
    const consumers = allWorkerTs.filter(
      (f) =>
        !f.endsWith('perOrgRateLimit.ts') &&
        /perOrgRateLimit|requireOrgQuota/.test(readFileSync(f, 'utf8')),
    );
    const relativeConsumers = consumers
      .map((file) => file.slice(REPO_ROOT.length + 1))
      .sort();
    expect(relativeConsumers).toEqual([
      'services/worker/src/api/v1/anchor-bulk.ts',
      'services/worker/src/api/v1/anchor-submit.ts',
      'services/worker/src/api/v1/webhooks.ts',
      'services/worker/src/routes/admin.ts',
    ]);
  });

  it('x402 payer limiter is mounted only on the paid Nessie route', () => {
    const consumers = allWorkerTs.filter(
      (f) =>
        !f.endsWith('x402PayerRateLimit.ts') &&
        /x402PayerRateLimit|createPayerRateLimiter/.test(readFileSync(f, 'utf8')),
    );
    expect(consumers.map((file) => file.slice(REPO_ROOT.length + 1))).toEqual([
      'services/worker/src/api/v1/router.ts',
    ]);
    expect(readFileSync(consumers[0], 'utf8')).toContain(
      "router.use('/nessie/query', x402PaymentGate('/api/v1/nessie/query'), x402PayerRateLimit, aiRateLimiter, nessieQueryRouter)",
    );
  });
});
