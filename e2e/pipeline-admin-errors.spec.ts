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

const WORKER_PIPELINE_STATS_PATTERN = /\/api\/admin\/pipeline-stats(?:[?#].*)?$/;

test.describe('SCRUM-1260 R1-6 — Pipeline error banner', () => {
  test('renders explicit fallback banner when worker /api/admin/pipeline-stats fails', async ({ orgBAdminPage }) => {
    // Intercept BEFORE navigating so the very first stats fetch hits the mock.
    await orgBAdminPage.route(WORKER_PIPELINE_STATS_PATTERN, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'pipeline_stats_unavailable' }),
      });
    });

    await orgBAdminPage.goto('/admin/pipeline');

    // Page must NOT silently mask the worker/cache failure. When the direct RPC
    // fallback succeeds in local CI, the dashboard should show a fallback banner
    // instead of the hard-error banner.
    await expect(orgBAdminPage.getByTestId('pipeline-stats-fallback')).toBeVisible({ timeout: 15_000 });
    await expect(orgBAdminPage.getByTestId('pipeline-stats-fallback')).toContainText('Worker/cache source failed');
  });
});
