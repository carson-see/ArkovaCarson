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
