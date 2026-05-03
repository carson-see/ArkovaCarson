/**
 * SCRUM-1260 (R1-6) — Treasury error-state E2E coverage.
 *
 * Splits the treasury-specific cases out of pipeline-admin-errors.spec.ts so
 * the e2e file layout matches the ticket AC ("e2e/pipeline-admin-errors.spec.ts,
 * e2e/treasury-errors.spec.ts"). The pipeline spec keeps the pipeline-only
 * cases; this file owns:
 *
 *   - 8s error/stale flip (was 75s pre-fix)
 *   - no browser→mempool.space fallback when worker fails (Forensic 1)
 *
 * @see src/hooks/useTreasuryBalance.ts (SCRUM-1260 hook site)
 */

import { test, expect, getServiceClient } from './fixtures';

const WORKER_TREASURY_PATTERN = /\/api\/treasury\/(balance|stats|status)/;
const serviceClient = getServiceClient();

test.describe('SCRUM-1260 R1-6 — Treasury error / stale state', () => {
  test.beforeEach(async () => {
    await serviceClient.from('treasury_cache').delete().eq('id', 1);
  });

  test('treasury hook surfaces error within ~8s, not 60s', async ({ orgBAdminPage }) => {
    await orgBAdminPage.route(WORKER_TREASURY_PATTERN, async (route) => {
      // Match the hook's WORKER_TIMEOUT_MS=8_000 by stalling slightly past it
      // so the AbortController path runs without hanging the route handler.
      await new Promise<void>((resolve) => setTimeout(resolve, 8_200));
      await route.fulfill({
        status: 504,
        contentType: 'application/json',
        body: '{"error":"timeout"}',
      });
    });

    const start = Date.now();
    await orgBAdminPage.goto('/admin/treasury');

    await expect(orgBAdminPage.getByTestId('treasury-balance-error')).toBeVisible({ timeout: 12_000 });

    // 15s upper bound — generous for slow CI; the hook targets 8s.
    expect(Date.now() - start).toBeLessThan(15_000);
  });

  test('does NOT fall back to direct mempool.space balance polling when worker fails', async ({ orgBAdminPage }) => {
    await orgBAdminPage.route(WORKER_TREASURY_PATTERN, (route) =>
      route.fulfill({ status: 503, body: '{"error":"unavailable"}' }),
    );

    // Mempool.space is still allowed for receipts/price/fees enrichment per
    // the hook's documented exception (these are display-only, no security-
    // state impact). What we forbid is BALANCE polling — the leak Forensic 1
    // flagged was 4 mempool calls per tick covering balance + receipts + price
    // + fees as a single fallback chain. Tighten to: balance must come from
    // worker/cache only; if both are unavailable, the hook surfaces stale-or-
    // unavailable. We assert by counting mempool /address/<ADDR>/utxo calls
    // (the balance-equivalent endpoint).
    let mempoolBalanceHits = 0;
    await orgBAdminPage.route(/mempool\.space\/api\/address\/[^/]+\/utxo/, (route) => {
      mempoolBalanceHits++;
      return route.fulfill({ status: 200, body: '[]' });
    });

    await orgBAdminPage.goto('/admin/treasury');

    // Wait for the hook's failure state to render — by then any balance
    // fallback would already have fired.
    await expect(orgBAdminPage.getByTestId('treasury-balance-error')).toBeVisible({ timeout: 12_000 });

    expect(mempoolBalanceHits).toBe(0);
  });
});
