/**
 * R-1 ratchet — the `/developers` price table must not offer a disabled
 * capability (CTO ruling 2026-08-12, final).
 *
 * `PRICING_TABLE` is a list of COMMERCIAL REPRESENTATIONS: a price next to an
 * endpoint says "pay this and it runs". Nessie is permanently disabled by
 * standing founder directive and is now hard-gated to fail closed, so a priced
 * `/nessie/query` row is a false offer.
 *
 * Deleting the row once is not the fix — nothing stopped it being re-added, and
 * a human census does not scale. This test is the ratchet. It reads the SOURCE
 * rather than rendering the page, because the claim is the literal in the array:
 * a row that never renders (behind a flag, in a collapsed section) is still a
 * published price the moment someone shows it.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'DevelopersPage.tsx'),
  'utf8',
);

/** The `PRICING_TABLE = [ … ];` literal only — not the whole file. */
function pricingTableSource(): string {
  const start = SOURCE.indexOf('const PRICING_TABLE = [');
  expect(start, 'PRICING_TABLE literal not found — did it get renamed?').toBeGreaterThan(-1);
  const end = SOURCE.indexOf('];', start);
  expect(end, 'PRICING_TABLE literal is unterminated').toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe('DevelopersPage PRICING_TABLE — R-1 claims ratchet', () => {
  it('carries no priced /nessie/query row (permanently disabled capability)', () => {
    expect(pricingTableSource()).not.toContain('/nessie/query');
  });

  it('mentions no Nessie endpoint under any spelling', () => {
    expect(pricingTableSource().toLowerCase()).not.toContain('nessie');
  });

  it('still prices the endpoints that ARE served (this is a ratchet, not a wipe)', () => {
    const table = pricingTableSource();
    for (const endpoint of [
      '/verify/:publicId',
      '/verify/batch',
      '/verify/entity',
      '/compliance/check',
      '/regulatory/lookup',
      '/cle/*',
    ]) {
      expect(table).toContain(endpoint);
    }
  });

  /**
   * R-2 is a HEDGE, not a retraction: `/ai/search` keeps its price unless the
   * Day-7 probes fail to demonstrate semantic retrieval, at which point it
   * auto-converts to RETRACT. Pinned so this PR is not read as having quietly
   * resolved R-2 while implementing R-1.
   */
  it('leaves the R-2 hedged /ai/search row in place (a separate, undecided ruling)', () => {
    expect(pricingTableSource()).toContain('/ai/search');
  });
});

describe('DevelopersPage integration claims', () => {
  it('uses the served GET verification route in the primary example', () => {
    expect(SOURCE).toContain('/api/v1/verify/ARK-2026-001');
    expect(SOURCE).not.toContain('/api/v1/verify \\\\');
    expect(SOURCE).not.toContain('"ai_metadata"');
  });

  it('links API reference buttons to the live OpenAPI document', () => {
    expect(SOURCE).toContain("const API_DOCS_URL = `${PUBLIC_API_URL}/api/docs/spec.json`");
    expect(SOURCE).not.toContain("`${PUBLIC_API_URL}/api/docs`");
  });

  it('distinguishes REST and hosted MCP authentication', () => {
    expect(SOURCE).toContain('Authorization: Bearer');
    expect(SOURCE).toContain('X-API-Key');
    expect(SOURCE).toContain('https://edge.arkova.ai/mcp');
  });

  it('offers a secure one-command hosted MCP registration', () => {
    expect(SOURCE).toContain('claude mcp add --transport http arkova https://edge.arkova.ai/mcp');
    expect(SOURCE).toContain('--header "X-API-Key: $ARKOVA_API_KEY"');
    expect(SOURCE).toContain('MCP_COPY_COMMAND');
    expect(SOURCE).toContain('MCP_KEY_PREREQUISITE');
    expect(SOURCE).not.toContain('vscode:mcp/install?');
    expect(SOURCE).not.toContain('cursor://');
  });

  it('uses version-neutral installs and registry links across a coordinated release', () => {
    expect(SOURCE).toContain('npm install arkova');
    expect(SOURCE).toContain('pip install arkova');
    expect(SOURCE).toContain('npx -y arkova-mcp-server');
    expect(SOURCE).toContain('https://www.npmjs.com/package/arkova');
    expect(SOURCE).toContain('https://pypi.org/project/arkova/');
    expect(SOURCE).not.toMatch(/arkova(?:-mcp-server)?@\d/);
    expect(SOURCE).not.toContain('CLI is not yet published');
  });
});
