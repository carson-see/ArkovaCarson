/**
 * SCRUM-1277 (R3-4) — Contract test for org_id scoping on api_keys.
 *
 * Pins that the two service-role queries on api_keys in agents.ts include
 * an explicit `.eq('org_id', orgId)` chain. agent_id alone is theoretically
 * unique but the worker's defense-in-depth contract (services/worker/agents.md)
 * requires both filters on every multi-tenant query so a hypothetical
 * agent_id collision cannot cross-tenant leak.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_PATH = resolve(__dirname, 'agents.ts');

describe('SCRUM-1277 R3-4 — agents.ts api_keys queries are org-scoped', () => {
  const source = readFileSync(AGENTS_PATH, 'utf8');

  it('every SELECT/UPDATE/DELETE on api_keys is filtered by both agent_id AND org_id', () => {
    // Find all `.from('api_keys')` blocks. INSERTs are exempt — they set
    // org_id in the payload, not via .eq(). For SELECT/UPDATE/DELETE the
    // chain must include both .eq('agent_id', ...) AND .eq('org_id', ...).
    const apiKeyChunks = source.split(/\.from\(['"]api_keys['"]\)/);
    // First chunk is content BEFORE the first .from() — drop it.
    const queryBodies = apiKeyChunks.slice(1).map((chunk) => chunk.slice(0, 400));
    expect(queryBodies.length).toBeGreaterThan(0);

    let nonInsertCount = 0;
    for (const body of queryBodies) {
      // INSERTs identify themselves with `.insert(` directly after .from().
      if (/^\s*\.insert\(/.test(body)) continue;
      nonInsertCount++;
      expect(body, 'api_keys read/update missing agent_id filter').toMatch(
        /\.eq\(\s*['"]agent_id['"]/,
      );
      expect(
        body,
        `api_keys read/update missing org_id filter (SCRUM-1277):\n${body.slice(0, 200)}`,
      ).toMatch(/\.eq\(\s*['"]org_id['"]/);
    }
    expect(nonInsertCount).toBeGreaterThan(0);
  });
});
