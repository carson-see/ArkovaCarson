/**
 * SCRUM-1260 (R1-6) — Pipeline + Treasury error-state E2E coverage.
 *
 * Asserts the explicit error banners introduced for the "kill silent 0/0/0"
 * mandate are reachable + visible. Mocks the worker endpoints to return
 * synthetic 5xx so the page enters its error path without flapping a real
 * worker outage.
 *
 * @see services/worker/src/api/admin-pipeline-stats.ts
 * @see src/pages/PipelineAdminPage.tsx (SCRUM-1260 banner site)
 * @see src/hooks/useTreasuryBalance.ts (SCRUM-1260 8s-timeout site)
 */

import { test, expect } from './fixtures';

const WORKER_PIPELINE_STATS_PATTERN = /\/api\/admin\/pipeline-stats/;
const WORKER_TREASURY_PATTERN = /\/api\/treasury\/(balance|stats)/;

test.describe('SCRUM-1260 R1-6 — Pipeline error banner', () => {
  test('renders explicit error banner when worker /api/admin/pipeline-stats fails', async ({ orgAdminPage }) => {
    // Intercept BEFORE navigating so the very first stats fetch hits the mock.
    await orgAdminPage.route(WORKER_PIPELINE_STATS_PATTERN, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'pipeline_stats_unavailable' }),
      });
    });

    await orgAdminPage.goto('/pipeline');

    // Page must NOT silently render a "0 records / 0 anchored / 0 embedded"
    // tile grid. It must surface the failure in a banner.
    await expect(
      orgAdminPage.getByText(/Pipeline stats fetch failed/i)
        .or(orgAdminPage.getByText(/unable to load/i))
        .or(orgAdminPage.getByText(/error/i))
        .or(orgAdminPage.getByText(/failed/i)),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('SCRUM-1260 R1-6 — Treasury error / stale state', () => {
  test('treasury hook surfaces error within ~8s, not 60s', async ({ orgAdminPage }) => {
    // Hang the treasury balance endpoint indefinitely so the hook hits its
    // SCRUM-1260 8s timeout. Without the timeout the previous behaviour was
    // to spin a skeleton until the worker's 60s wall-clock cap.
    await orgAdminPage.route(WORKER_TREASURY_PATTERN, async () => {
      // Never resolve — the hook's AbortController fires at 8s.
      await new Promise<void>(() => {
        // intentionally hung
      });
    });

    const start = Date.now();
    await orgAdminPage.goto('/admin/treasury');

    await expect(
      orgAdminPage.getByText(/treasury (?:balance )?(?:un)?available/i)
        .or(orgAdminPage.getByText(/stale/i))
        .or(orgAdminPage.getByText(/error/i))
        .or(orgAdminPage.getByText(/unable to/i)),
    ).toBeVisible({ timeout: 12_000 });

    // Soft assertion: the error/stale state should appear well under the
    // pre-fix 60-75s window. We use 15s as a generous upper bound to keep
    // the test stable on slow CI runners; the hook itself targets 8s.
    expect(Date.now() - start).toBeLessThan(15_000);
  });

  test('does NOT fall back to direct mempool.space calls when worker fails', async ({ orgAdminPage }) => {
    // Block worker treasury endpoints + assert the page does NOT then call
    // mempool.space directly from the browser. Forensic 1 flagged that the
    // previous fallback leaked treasury address polling via 4 mempool calls
    // per hook tick.
    await orgAdminPage.route(WORKER_TREASURY_PATTERN, (route) =>
      route.fulfill({ status: 503, body: '{"error":"unavailable"}' }),
    );

    let mempoolHits = 0;
    await orgAdminPage.route(/mempool\.space\//, (route) => {
      mempoolHits++;
      return route.fulfill({ status: 200, body: '{}' });
    });

    await orgAdminPage.goto('/admin/treasury');

    // Give the page time to render + (NOT) make fallback calls.
    await orgAdminPage.waitForTimeout(3_000);

    expect(mempoolHits).toBe(0);
  });
});
