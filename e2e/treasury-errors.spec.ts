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
 * Network-boundary mempool stubs (post-#1600): the hook's fetchAll fans out to
 * THREE legs and `await Promise.all([worker, health, mempoolAllSettled])` — the
 * balance-error banner only renders after ALL three settle. Before #1600 the
 * dev/prod CSP omitted mempool.space, so the display-only enrichment fetches
 * (txs / prices / fees) were CSP-blocked and rejected instantly; the combined
 * promise was gated purely by the worker's 8s timeout and the error surfaced on
 * time. #1600 added `https://mempool.space` to `connect-src` (index.html +
 * vercel.json), so those fetches now hit the LIVE network in CI. A live /
 * tarpitting mempool leg (its `AbortSignal.timeout` does not reliably abort the
 * in-flight fetch) kept `Promise.all` from settling inside the 12s assertion
 * window, so `balanceError` never set and `treasury-balance-error` never
 * rendered — the deterministic 3/3 regression this file fixes. We stub the
 * enrichment legs at the network boundary (immediate failure) so the leg
 * settles instantly and the worker-timeout path drives the ~8s error exactly as
 * SCRUM-1260 intends. Now that CSP permits mempool.space, Playwright `route()`
 * intercepts these requests without a `bypassCSP` context.
 *
 * @see src/hooks/useTreasuryBalance.ts (SCRUM-1260 hook site)
 * @see e2e/treasury-observability.spec.ts (worker-UP sibling; same mock boundary)
 */

import type { Page } from '@playwright/test';
import { test, expect, getServiceClient } from './fixtures';

const WORKER_TREASURY_PATTERN =
  /\/api\/treasury\/(?:balance|stats|status|health|x402-stats)(?:[?#].*)?$/;

// Display-only enrichment legs the hook fetches DIRECTLY from mempool.space
// (path-anchored so they match regardless of the mempool base URL).
const MEMPOOL_TXS = /mempool\.space\/api\/address\/[^/]+\/txs(?:[?#].*)?$/;
const MEMPOOL_PRICES = /mempool\.space\/api\/v1\/prices(?:[?#].*)?$/;
const MEMPOOL_FEES = /mempool\.space\/api\/v1\/fees\/recommended(?:[?#].*)?$/;

const serviceClient = getServiceClient();

/**
 * Fail the three display-only mempool enrichment legs (txs / prices / fees)
 * FAST and deterministically at the network boundary. Keeps the hook's
 * `Promise.all` from ever awaiting a live third-party call, so the balance
 * error/stale timing is driven solely by the worker legs under test. Leaves the
 * `/address/<addr>/utxo` balance-equivalent endpoint UNROUTED here so each
 * test can install its own sovereignty counter on it.
 */
async function stubMempoolEnrichmentFailFast(page: Page): Promise<void> {
  for (const pattern of [MEMPOOL_TXS, MEMPOOL_PRICES, MEMPOOL_FEES]) {
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"unavailable"}',
      }),
    );
  }
}

test.describe('SCRUM-1260 R1-6 — Treasury error / stale state', () => {
  test.beforeEach(async () => {
    await serviceClient.from('treasury_cache').delete().eq('id', 1);
  });

  test('treasury hook surfaces error within ~8s, not 60s', async ({ orgBAdminPage }) => {
    // Enrichment legs must fail fast at the network boundary — otherwise the
    // hook's Promise.all awaits a LIVE mempool.space call (allowed by the
    // #1600 CSP) that can outlive the 8s worker-timeout budget, and the
    // balance-error banner never renders inside the assertion window.
    await stubMempoolEnrichmentFailFast(orgBAdminPage);

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
    // state impact) — but we stub those legs at the network boundary rather
    // than let them reach LIVE mempool.space (allowed by the #1600 CSP), which
    // would reintroduce the flaky third-party dependency SCRUM-1260 called out.
    await stubMempoolEnrichmentFailFast(orgBAdminPage);

    // What we forbid is BALANCE polling — the leak Forensic 1 flagged was 4
    // mempool calls per tick covering balance + receipts + price + fees as a
    // single fallback chain. Tighten to: balance must come from worker/cache
    // only; if both are unavailable, the hook surfaces stale-or-unavailable. We
    // assert by counting mempool /address/<ADDR>/utxo calls (the balance-
    // equivalent endpoint) — this route stays distinct from the enrichment
    // stubs above so a stray balance poll still registers on the counter.
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
