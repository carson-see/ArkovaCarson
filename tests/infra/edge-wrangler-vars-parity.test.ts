/**
 * Edge wrangler `[vars]` parity — soak rig vs production (review 2026-09-05).
 *
 * @vitest-environment node
 *
 * `wrangler.soak.toml` is the isolated-rig copy of the edge worker config. A
 * var present in `wrangler.toml` but missing from the rig config is a soak
 * that does not exercise the production configuration: the code reads
 * `env.X === 'true'`, an absent var is `undefined`, and the gate quietly takes
 * the other branch. `EDGE_REQUIRE_MCP_SIGNING` is the worked example — with it
 * absent, `arkova_oracle_batch_verify` emits unsigned envelopes on the rig
 * while production fails closed, and the soak reports green (CLAUDE.md §1.11A:
 * that is a hollow soak).
 *
 * KEYS only. Values are expected to differ per environment.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PROD_CONFIG = 'services/edge/wrangler.toml';
const SOAK_CONFIG = 'services/edge/wrangler.soak.toml';

/**
 * Keys declared in the `[vars]` table of a wrangler TOML.
 *
 * Minimal parse: take the lines between the `[vars]` header and the next
 * table header, drop comments and blanks, and read the `key =` on each.
 */
function varsKeys(relativePath: string): string[] {
  const lines = readFileSync(resolve(ROOT, relativePath), 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === '[vars]');
  expect(start, `${relativePath} has no [vars] table`).toBeGreaterThan(-1);

  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) break;
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (match) keys.push(match[1]);
  }
  return keys.sort();
}

describe('services/edge wrangler [vars] parity', () => {
  it('parses a non-empty key set from both configs', () => {
    // Guards the parser itself: a regex that matched nothing would make the
    // equality assertion below pass vacuously.
    expect(varsKeys(PROD_CONFIG).length).toBeGreaterThan(0);
    expect(varsKeys(SOAK_CONFIG)).toContain('EDGE_REQUIRE_MCP_SIGNING');
  });

  it('declares the same [vars] keys in wrangler.soak.toml as in wrangler.toml', () => {
    const prod = varsKeys(PROD_CONFIG);
    const soak = varsKeys(SOAK_CONFIG);

    expect(soak.filter((key) => !prod.includes(key))).toEqual([]);
    expect(prod.filter((key) => !soak.includes(key))).toEqual([]);
    expect(soak).toEqual(prod);
  });

  it('declares no key twice in either [vars] table', () => {
    for (const config of [PROD_CONFIG, SOAK_CONFIG]) {
      const keys = varsKeys(config);
      expect(keys, `${config} declares a duplicate [vars] key`).toEqual([...new Set(keys)]);
    }
  });
});
