/**
 * Semantic Search E2E Tests (SCRUM-1958, subtask-4)
 *
 * Verifies the AI "smart search" panel on the authenticated dashboard:
 *   - visible when ENABLE_SEMANTIC_SEARCH is on
 *   - hidden when the flag is off
 *   - query → results render with a friendly match-strength indicator
 *   - honest empty state when the embeddings return nothing
 *   - friendly error copy on 402 / 503 / network failure
 *   - usable at a 375px mobile width
 *
 * Strategy: route interception only — no real worker, no real embeddings.
 *   - `**​/rest/v1/rpc/get_flag` is intercepted to force the feature flag.
 *   - `**​/api/v1/ai/search*` is intercepted to mock the worker response.
 * The prod credential_embeddings table is empty, so this spec never depends on
 * real search data.
 *
 * @created 2026-05-29
 */

import { test, expect } from './fixtures';
import { openDashboard } from './helpers/dashboard';
import type { Page } from '@playwright/test';

// Copy is duplicated here intentionally — E2E specs assert against the
// rendered, user-visible strings. Keep in sync with SEMANTIC_SEARCH_LABELS
// in src/lib/copy.ts.
const LABELS = {
  HEADING: 'Smart Search',
  PLACEHOLDER: 'Describe what you are looking for…',
  EMPTY_TITLE: 'No matching documents',
  MATCH_STRENGTH_STRONG: 'Strong match',
  STATUS_SECURED: 'Secured',
  ERROR_NO_CREDITS:
    'You are out of AI credits. Upgrade your plan to keep using smart search.',
  ERROR_UNAVAILABLE:
    'Smart search is temporarily unavailable. Please try again in a few minutes.',
  ERROR_NETWORK:
    'Could not reach the service. Check your connection and try again.',
} as const;

/** Force the ENABLE_SEMANTIC_SEARCH flag value the page reads via get_flag RPC. */
async function mockFlag(page: Page, enabled: boolean): Promise<void> {
  await page.route('**/rest/v1/rpc/get_flag*', async (route) => {
    let payload: { p_flag_key?: string } | null = null;
    try {
      payload = route.request().postDataJSON() as { p_flag_key?: string };
    } catch {
      payload = null;
    }

    if (payload?.p_flag_key !== 'ENABLE_SEMANTIC_SEARCH') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // get_flag returns a boolean scalar.
      body: JSON.stringify(enabled),
    });
  });
}

/** Mock a successful search with one result at the given similarity. */
async function mockSearchResults(page: Page, similarity = 0.92): Promise<void> {
  await page.route('**/api/v1/ai/search*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        query: 'diploma',
        results: [
          {
            anchorId: '11111111-1111-1111-1111-111111111111',
            publicId: 'ARK-TEST-0001',
            fileName: 'e2e-diploma.pdf',
            credentialType: 'DEGREE',
            metadata: { issuerName: 'E2E University' },
            status: 'SECURED',
            createdAt: '2025-01-01T00:00:00Z',
            similarity,
          },
        ],
        count: 1,
        threshold: 0.7,
        creditsRemaining: 41,
      }),
    });
  });
}

/** Mock an empty (but successful) search. */
async function mockSearchEmpty(page: Page): Promise<void> {
  await page.route('**/api/v1/ai/search*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        query: 'nothing matches this',
        results: [],
        count: 0,
        threshold: 0.7,
        creditsRemaining: 41,
      }),
    });
  });
}

/** Mock a worker error response with the given status. */
async function mockSearchStatus(page: Page, status: number): Promise<void> {
  await page.route('**/api/v1/ai/search*', async (route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'mocked_error' }),
    });
  });
}

/** Simulate a network failure on the search request. */
async function abortSearch(page: Page): Promise<void> {
  await page.route('**/api/v1/ai/search*', async (route) => {
    await route.abort('failed');
  });
}

async function runSearch(page: Page, query: string): Promise<void> {
  const input = page.getByPlaceholder(LABELS.PLACEHOLDER);
  await expect(input).toBeVisible({ timeout: 15_000 });
  await input.fill(query);
  await input.press('Enter');
}

test.describe('Semantic Search panel', () => {
  test('is visible on the dashboard when the flag is on', async ({ individualPage }) => {
    await mockFlag(individualPage, true);
    await openDashboard(individualPage);

    await expect(
      individualPage.getByText(LABELS.HEADING, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(individualPage.getByPlaceholder(LABELS.PLACEHOLDER)).toBeVisible();
  });

  test('is hidden when the flag is off', async ({ individualPage }) => {
    await mockFlag(individualPage, false);
    await openDashboard(individualPage);

    // Dashboard rendered, but the smart-search panel did not mount.
    await expect(individualPage.locator('#main-content')).toContainText(
      /My Records/i,
      { timeout: 15_000 },
    );
    await expect(
      individualPage.getByText(LABELS.HEADING, { exact: true }),
    ).toHaveCount(0);
  });

  test('query renders results with a percentage match indicator', async ({ individualPage }) => {
    await mockFlag(individualPage, true);
    await mockSearchResults(individualPage, 0.92);
    await openDashboard(individualPage);

    await runSearch(individualPage, 'diploma');

    await expect(individualPage.getByText('e2e-diploma.pdf')).toBeVisible({
      timeout: 10_000,
    });
    // Friendly percentage, never a raw vector score.
    await expect(individualPage.getByText('92% match')).toBeVisible();
    await expect(
      individualPage.getByLabel(LABELS.MATCH_STRENGTH_STRONG),
    ).toBeVisible();
    await expect(individualPage.getByText(LABELS.STATUS_SECURED)).toBeVisible();
    await expect(
      individualPage.getByText('SECURED', { exact: true }),
    ).toHaveCount(0);
    await expect(individualPage.getByText(/0\.92/)).toHaveCount(0);
  });

  test('shows the honest empty state when nothing matches', async ({ individualPage }) => {
    await mockFlag(individualPage, true);
    await mockSearchEmpty(individualPage);
    await openDashboard(individualPage);

    await runSearch(individualPage, 'nothing matches this');

    await expect(individualPage.getByText(LABELS.EMPTY_TITLE)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('shows out-of-credits copy on 402', async ({ individualPage }) => {
    await mockFlag(individualPage, true);
    await mockSearchStatus(individualPage, 402);
    await openDashboard(individualPage);

    await runSearch(individualPage, 'diploma');

    await expect(individualPage.getByRole('alert')).toContainText(
      LABELS.ERROR_NO_CREDITS,
      { timeout: 10_000 },
    );
  });

  test('shows service-unavailable copy on 503', async ({ individualPage }) => {
    await mockFlag(individualPage, true);
    await mockSearchStatus(individualPage, 503);
    await openDashboard(individualPage);

    await runSearch(individualPage, 'diploma');

    await expect(individualPage.getByRole('alert')).toContainText(
      LABELS.ERROR_UNAVAILABLE,
      { timeout: 10_000 },
    );
  });

  test('shows network-error copy when the request fails', async ({ individualPage }) => {
    await mockFlag(individualPage, true);
    await abortSearch(individualPage);
    await openDashboard(individualPage);

    await runSearch(individualPage, 'diploma');

    await expect(individualPage.getByRole('alert')).toContainText(
      LABELS.ERROR_NETWORK,
      { timeout: 10_000 },
    );
  });

  test('is usable at 375px mobile width', async ({ individualPage }) => {
    await individualPage.setViewportSize({ width: 375, height: 812 });
    await mockFlag(individualPage, true);
    await mockSearchResults(individualPage, 0.88);
    await openDashboard(individualPage);

    await expect(individualPage.getByPlaceholder(LABELS.PLACEHOLDER)).toBeVisible({
      timeout: 15_000,
    });

    await runSearch(individualPage, 'diploma');

    await expect(individualPage.getByText('e2e-diploma.pdf')).toBeVisible({
      timeout: 10_000,
    });
  });
});
