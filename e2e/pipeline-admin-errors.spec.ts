/**
 * SCRUM-1260 (R1-6) — Pipeline error-state E2E coverage.
 *
 * Asserts the explicit error banners introduced for the "kill silent 0/0/0"
 * mandate are reachable + visible. Treasury cases live in
 * `treasury-errors.spec.ts` per the ticket AC file split.
 *
 * @see services/worker/src/api/admin-pipeline-stats.ts
 * @see src/pages/PipelineAdminPage.tsx (SCRUM-1260 banner site)
 */

import { test, expect } from './fixtures';

const WORKER_PIPELINE_STATS_PATTERN = /\/api\/admin\/pipeline-stats/;

test.describe('SCRUM-1260 R1-6 — Pipeline error banner', () => {
  test('renders explicit error banner when worker /api/admin/pipeline-stats fails', async ({ orgBAdminPage }) => {
    // Intercept BEFORE navigating so the very first stats fetch hits the mock.
    await orgBAdminPage.route(WORKER_PIPELINE_STATS_PATTERN, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'pipeline_stats_unavailable' }),
      });
    });

    await orgBAdminPage.goto('/admin/pipeline');

    // Page must NOT silently render a "0 records / 0 anchored / 0 embedded"
    // tile grid. It must surface the failure in a banner — match a banner-
    // style assertion (role=alert) so we don't false-positive on stray copy.
    await expect(orgBAdminPage.getByTestId('pipeline-stats-error')).toBeVisible({ timeout: 15_000 });
  });
});
