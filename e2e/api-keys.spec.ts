/**
 * API Keys & Verification Flow E2E Tests (QA-E2E-02)
 *
 * Tests the full API key lifecycle and developer documentation flow:
 * - Navigate to Settings > API Keys as authenticated org admin
 * - Create a new API key with name and scopes
 * - Verify the key is displayed and can be copied
 * - Navigate to the Developers page and verify documentation
 * - Test the API Sandbox page loads
 *
 * @created 2026-03-27
 */

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const API_KEYS_DESCRIPTION = 'Manage API keys for programmatic access to the Verification API.';
const DEVELOPER_OVERVIEW_LINK = /Developer Platform|API Documentation|developer overview/i;
const API_KEY_SECRET_PATTERN = /^ak_(live|test)_[a-f0-9]{64}$/;

// ── Shared per-IP rate-limit de-race (post-#2220 revoke-flip flake) ─────────
//
// Every request this suite sends the worker shares ONE server-side rate-limit
// bucket: the limiters in services/worker/src/utils/rateLimit.ts key on bare
// `req.ip` with an empty scope, and in the CI E2E environment every request
// arrives from the same loopback address (`::1`). Three limiter passes
// increment that single bucket per dashboard call (`apiIpShadowGuard` mounted
// at /api AND unprefixed in services/worker/src/index.ts, plus the v1
// anonRateLimiter), and the strictest of them 429s the whole bucket at 60 per
// 60s window. A UI flow that must land several worker mutations in sequence
// (create → revoke → delete) therefore races the rest of the suite's
// accumulated traffic: when the bucket crosses 60 mid-flow, the revoke PATCH
// 429s, the card never flips to "Revoked", and the spec fails — the ✘✘✓
// pattern on main run 32623769492 (worker-log artifact:
// `key:"::1", count:60, maxRequests:60`).
//
// De-race, test-side only: before starting the flow, poll a cheap /api/v1
// path FROM THE PAGE (same browser network stack — hence same source IP — as
// the app's own workerFetch calls) and read the X-RateLimit-* headers the
// worker exposes on every /api/v1 response (Access-Control-Expose-Headers,
// services/worker/src/api/v1/router.ts). Proceed only once the shared bucket
// has `needed` requests of headroom under the 60/window gate, waiting out the
// window when it does not. No product limiter is raised and no bypass is
// added — the spec simply stops assuming the bucket is fresh.

/** Mirrors the workerClient URL resolution (src/lib/workerClient.ts). */
const E2E_WORKER_BASE = process.env.VITE_WORKER_URL || 'http://localhost:3001';

/**
 * The strictest limiter sharing the bare-IP bucket: `apiIpShadowGuard`
 * (services/worker/src/index.ts), 60 requests per 60s window. A successful
 * probe's X-RateLimit-Limit reports the LAST limiter in the chain (the v1
 * anon limiter, 100), so shared-bucket headroom must be measured against this
 * constant rather than the header's own limit.
 */
const SHARED_IP_BUCKET_LIMIT = 60;

async function waitForSharedRateLimitHeadroom(page: Page, needed: number): Promise<void> {
  const deadline = Date.now() + 150_000;
  for (;;) {
    const probe = await page.evaluate(async (base: string) => {
      try {
        const res = await fetch(`${base}/api/v1/e2e-rate-headroom-probe`, { cache: 'no-store' });
        return {
          status: res.status,
          limit: res.headers.get('x-ratelimit-limit'),
          remaining: res.headers.get('x-ratelimit-remaining'),
          reset: res.headers.get('x-ratelimit-reset'),
          retryAfter: res.headers.get('retry-after'),
        };
      } catch {
        return null;
      }
    }, E2E_WORKER_BASE);

    // Worker unreachable: nothing to de-race — the spec's own error branches
    // (keyCreatedTitle.or(errorAlert)) already cover a dead worker.
    if (probe === null) return;

    if (probe.status !== 429) {
      if (!probe.limit || !probe.remaining) return; // headers absent — cannot measure, do not gate
      const used = Number(probe.limit) - Number(probe.remaining);
      if (SHARED_IP_BUCKET_LIMIT - used >= needed) return;
    }

    if (Date.now() > deadline) {
      throw new Error(
        'waitForSharedRateLimitHeadroom: shared per-IP rate-limit bucket never freed up',
      );
    }

    // Sleep to the window boundary: Retry-After on a 429 (exposed by the
    // global CORS middleware even when the guard rejects before the v1
    // router), X-RateLimit-Reset (unix seconds) otherwise; short re-poll if
    // neither header came back. +1s pad absorbs runner/worker clock skew.
    let waitMs = 5_000;
    if (probe.status === 429 && probe.retryAfter) {
      waitMs = Number(probe.retryAfter) * 1_000 + 1_000;
    } else if (probe.reset) {
      waitMs = Math.max(0, Number(probe.reset) * 1_000 - Date.now()) + 1_000;
    }
    await page.waitForTimeout(Math.min(waitMs, 65_000));
  }
}

async function expectApiKeysPage(page: Page) {
  await expect(
    page.getByRole('heading', { name: 'API Keys' })
  ).toBeVisible({ timeout: 10000 });

  await expect(
    page.getByText(API_KEYS_DESCRIPTION)
  ).toBeVisible();
}

test.describe('API Keys & Verification Flow', () => {
  test.describe('API Key Settings Page', () => {
    test('API keys page loads for org admin', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/settings/api-keys');

      await expectApiKeysPage(orgAdminPage);

      // Create API Key button
      await expect(
        orgAdminPage.getByRole('button', { name: /Create API Key/i })
      ).toBeVisible();
    });

    test('empty state shows no keys message', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/settings/api-keys');
      await expectApiKeysPage(orgAdminPage);

      // If no keys exist, the empty state message should be visible
      // (may not appear if keys already exist in seed data)
      const noKeysMsg = orgAdminPage.getByText('No API keys yet. Create one to get started with the Verification API.');
      const keyStatus = orgAdminPage.getByText(/Active|Revoked|Expired/).first();

      // Either empty state or existing keys should be present
      await expect(noKeysMsg.or(keyStatus)).toBeVisible({ timeout: 10000 });
    });

    test('create API key dialog opens and shows form fields', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/settings/api-keys');
      await expectApiKeysPage(orgAdminPage);

      // Click Create API Key button
      await orgAdminPage.getByRole('button', { name: /Create API Key/i }).click();

      // Dialog should appear with form fields
      await expect(
        orgAdminPage.getByText('Create a new API key for programmatic access.')
      ).toBeVisible({ timeout: 5000 });

      // Key Name field
      await expect(orgAdminPage.getByLabel('Key Name')).toBeVisible();

      // Permissions checkboxes
      await expect(orgAdminPage.getByText('Permissions')).toBeVisible();
      await expect(orgAdminPage.getByRole('checkbox', { name: 'Records' })).toBeVisible();
      await expect(orgAdminPage.getByRole('checkbox', { name: 'Organisations' })).toBeVisible();
      await expect(orgAdminPage.getByRole('checkbox', { name: 'Search' })).toBeVisible();
      await expect(orgAdminPage.getByRole('checkbox', { name: 'Anchor writes' })).toBeVisible();
      await expect(orgAdminPage.getByRole('checkbox', { name: 'Rules admin' })).toBeVisible();

      // Expiry field
      await expect(orgAdminPage.getByLabel(/Expires In/i)).toBeVisible();
    });

    test('create API key with name and scopes', async ({ orgAdminPage }) => {
      // The create → revoke → delete flow needs ~18 worker requests' worth of
      // shared-bucket budget (each UI call costs 3 limiter increments), and a
      // saturated bucket can add up to a full 60s window of waiting before
      // the flow starts — widen the default 30s timeout accordingly.
      test.setTimeout(180_000);

      await orgAdminPage.goto('/settings/api-keys');
      await expectApiKeysPage(orgAdminPage);

      // De-race the suite's shared per-IP rate-limit bucket BEFORE starting
      // the mutating flow (see waitForSharedRateLimitHeadroom above). 35 of
      // the 60/window covers the whole flow (~18 increments) with margin.
      await waitForSharedRateLimitHeadroom(orgAdminPage, 35);

      // Open create dialog
      await orgAdminPage.getByRole('button', { name: /Create API Key/i }).click();
      await expect(orgAdminPage.getByLabel('Key Name')).toBeVisible({ timeout: 5000 });

      // Fill in key name
      const testKeyName = `E2E Test Key ${Date.now()}`;
      await orgAdminPage.getByLabel('Key Name').fill(testKeyName);

      // Search scope is pre-selected by default for new v2 API keys.
      await expect(orgAdminPage.getByRole('checkbox', { name: 'Search' })).toBeChecked();

      // Submit the form
      const createButtons = orgAdminPage.getByRole('button', { name: /Create API Key/i });
      // The submit button is the one inside the dialog (second one)
      await createButtons.last().click();

      // After creation, the secret display phase should show
      // Either the key is created successfully or there is an error
      // (worker may not be running in CI, so we check for both states)
      const dialog = orgAdminPage.getByRole('dialog');
      const keyCreatedTitle = dialog.getByRole('heading', { name: 'API Key Created' });
      const errorAlert = dialog
        .locator('[role="alert"]')
        .filter({ hasText: /failed|error|invalid|unauthorized|forbidden|too many requests|rate limit|429/i });

      await expect(keyCreatedTitle.or(errorAlert)).toBeVisible({ timeout: 15000 });

      // If key was created successfully, verify the secret and copy button
      if (await keyCreatedTitle.isVisible().catch(() => false)) {
        // Warning message about one-time display
        await expect(
          dialog.getByText('Copy this key now. It will not be shown again.')
        ).toBeVisible();

        // The key value should be displayed in a monospace alert.
        const keyDisplay = dialog.locator('[role="alert"] .font-mono');
        await expect(keyDisplay).toHaveText(API_KEY_SECRET_PATTERN);

        // Copy to Clipboard button should be visible
        await expect(
          orgAdminPage.getByRole('button', { name: /Copy to Clipboard/i })
        ).toBeVisible();

        // Done button should be visible
        await expect(
          orgAdminPage.getByRole('button', { name: /Done/i })
        ).toBeVisible();

        // Close the dialog
        await orgAdminPage.getByRole('button', { name: /Done/i }).click();

        // Verify the key appears in the list
        await expect(orgAdminPage.getByText(testKeyName)).toBeVisible({ timeout: 5000 });

        // Active badge should be shown
        await expect(
          orgAdminPage.getByText('Active').first()
        ).toBeVisible();

        // Never used label should be shown for a new key
        await expect(
          orgAdminPage.getByText('Never used').first()
        ).toBeVisible();

        // FD-P7 (CC6.8): revoke the key through the product path. This flow
        // was unreachable before the fix — the server stripped `id` from
        // every response while revoke/delete are addressed by it.
        //
        // Card locator (de-flaked): the previous locator required the card to
        // contain BOTH the key name AND a Revoke button — self-contradictory
        // after a successful revoke, because ApiKeySettings.tsx renders the
        // Revoke button only while `is_active`. Once the revoke landed, the
        // post-revoke assertions re-resolved against nothing (clean list) or
        // against an ancestor div holding some OTHER key's Revoke button, so
        // pass/fail depended on leftover keys. Anchor instead on the card
        // root (`div.shadow-card-rest`, src/components/api/ApiKeySettings.tsx)
        // containing the unique key name plus the delete button — rendered in
        // EVERY key state, active and revoked alike — so the locator resolves
        // to the same card before and after the flip. The delete-button
        // filter also excludes the API-usage card, which can list key names.
        const keyCard = orgAdminPage
          .locator('div.shadow-card-rest')
          .filter({ has: orgAdminPage.getByText(testKeyName, { exact: true }) })
          .filter({ has: orgAdminPage.locator('button.text-destructive') });

        // Click-then-verify inside toPass: the key list re-renders (react-query
        // refetch + stagger/entry animations) right when these card buttons get
        // clicked, and a click dispatched into a node that React is replacing
        // is silently lost — observed locally as "trash clicked, no dialog"
        // even after the revoke-flip fix. Re-click until the dialog actually
        // appears instead of assuming one click landed.
        const confirmDialog = orgAdminPage.getByRole('dialog');
        await expect(async () => {
          await keyCard.getByRole('button', { name: /^Revoke$/ }).click();
          await expect(
            confirmDialog.getByRole('heading', { name: /Revoke API Key/i })
          ).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 15000 });
        await confirmDialog.getByRole('button', { name: /^Revoke$/ }).click();

        // The card flips to Revoked and loses its Revoke button.
        await expect(keyCard.getByText('Revoked')).toBeVisible({ timeout: 10000 });
        await expect(keyCard.getByRole('button', { name: /^Revoke$/ })).toHaveCount(0);

        // Delete it so e2e runs do not accrete keys (same reason the soak
        // probe deletes its own probe key). Same click-then-verify pattern:
        // this click races the post-revoke refetch re-render.
        await expect(async () => {
          await keyCard.locator('button.text-destructive').click();
          await expect(
            confirmDialog.getByRole('heading', { name: /Delete API Key/i })
          ).toBeVisible({ timeout: 2000 });
        }).toPass({ timeout: 15000 });
        await confirmDialog.getByRole('button', { name: /^Delete$/ }).click();
        await expect(orgAdminPage.getByText(testKeyName)).toHaveCount(0, { timeout: 10000 });
      }
    });

    test('API docs card links to developers page', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/settings/api-keys');
      await expectApiKeysPage(orgAdminPage);

      // API Documentation card should be visible
      const docsLink = orgAdminPage.getByRole('link', { name: DEVELOPER_OVERVIEW_LINK });
      if (await docsLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        const href = await docsLink.getAttribute('href');
        expect(href).toContain('/developers');
      }
    });

    test('API usage dashboard section is visible', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/settings/api-keys');
      await expectApiKeysPage(orgAdminPage);

      // The ApiUsageDashboard renders one of four states
      // (src/components/api/ApiUsageDashboard.tsx):
      //   1. loading          -> spinner card (transient; react-query retry
      //                          backoff can hold it well past 10s)
      //   2. success          -> USAGE_TITLE heading ('API Usage')
      //   3. auth-class error -> USAGE_CREATE_KEY_HINT copy
      //   4. other error      -> USAGE_UNAVAILABLE copy
      // (!usage renders nothing — that is a regression and must FAIL here.)
      //
      // The success state must be matched via the heading role: a bare
      // getByText('API Usage') is a case-insensitive substring match that
      // ALSO hits the card description 'Monitor your Verification API
      // usage for the current billing period.' — a 2-element strict-mode
      // violation that deterministically failed this spec whenever the
      // dashboard loaded successfully (blocked #1439 / #1443).
      const usageHeading = orgAdminPage.getByRole('heading', {
        name: 'API Usage',
        exact: true,
      });
      // Copy strings mirror USAGE_UNAVAILABLE / USAGE_CREATE_KEY_HINT in
      // src/lib/copy.ts (e2e specs assert user-visible copy verbatim).
      const usageUnavailable = orgAdminPage.getByText(
        'Usage data unavailable — service not connected'
      );
      const usageCreateKeyHint = orgAdminPage.getByText(
        'Usage metrics will appear once you create your first API key'
      );

      // 20s rides out the loading spinner across react-query retries while
      // a wholly absent usage section still fails the assertion.
      await expect(
        usageHeading.or(usageUnavailable).or(usageCreateKeyHint).first()
      ).toBeVisible({ timeout: 20000 });
    });
  });

  test.describe('Developers Page', () => {
    test('developers page loads with API documentation', async ({ page }) => {
      // Developers page is public — no auth required
      await page.goto('/developers');

      // Hero section
      await expect(
        page.getByText('Developer Platform')
      ).toBeVisible({ timeout: 10000 });

      // API code example should be visible
      await expect(
        page.getByRole('button', { name: /^cURL$/i })
      ).toBeVisible();

      // Endpoint documentation
      await expect(
        page.getByRole('heading', { name: 'Verify Records' })
      ).toBeVisible();
    });

    test('developers page shows SDK examples with language tabs', async ({ page }) => {
      await page.goto('/developers');
      await expect(
        page.getByText('Developer Platform')
      ).toBeVisible({ timeout: 10000 });

      // SDK tabs should be visible (curl, typescript, python)
      const curlTab = page.getByRole('button', { name: /^cURL$/i });
      await expect(curlTab).toBeVisible({ timeout: 5000 });

      // TypeScript tab
      const tsTab = page.getByRole('button', { name: /typescript/i })
        .or(page.getByText(/TypeScript/i));
      if (await tsTab.isVisible({ timeout: 3000 }).catch(() => false)) {
        await tsTab.click();
        // Canonical SDK class is `Arkova` (packages/sdk); the stale
        // `ArkovaClient` duplicate was removed in PR #1506.
        await expect(page.getByText("import { Arkova } from '@carsonarkova/sdk'")).toBeVisible();
      }
    });

    test('developers page shows pricing table', async ({ page }) => {
      await page.goto('/developers');
      await expect(
        page.getByText('Developer Platform')
      ).toBeVisible({ timeout: 10000 });

      // Pricing information
      await expect(
        page.getByRole('cell', { name: '$0.002' }).first()
      ).toBeVisible({ timeout: 5000 });
    });

    test('developers page has link to API sandbox', async ({ page }) => {
      await page.goto('/developers');
      await expect(
        page.getByText('Developer Platform')
      ).toBeVisible({ timeout: 10000 });

      // Look for sandbox link
      const sandboxLink = page.getByRole('link', { name: /Sandbox|Try it|Playground/i });
      if (await sandboxLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        const href = await sandboxLink.getAttribute('href');
        expect(href).toContain('sandbox');
      }
    });
  });

  test.describe('API Sandbox Page', () => {
    test('sandbox page loads with endpoint selector', async ({ page }) => {
      await page.goto('/developers/sandbox');

      // Sandbox should load (may redirect to developers page if not a separate route)
      await expect(
        page.getByRole('heading', { name: /API Sandbox|API Playground|Verify Record/i })
      ).toBeVisible({ timeout: 10000 });
    });

    test('sandbox shows authentication options', async ({ page }) => {
      await page.goto('/developers/sandbox');

      // Auth section with API Key option
      const apiKeyOption = page.getByRole('button', { name: /API Key/i });
      await expect(apiKeyOption).toBeVisible({ timeout: 10000 });
    });

    test('sandbox shows endpoint parameters', async ({ page }) => {
      await page.goto('/developers/sandbox');

      // Should show parameter inputs for the selected endpoint
      await expect(
        page.getByText('Endpoint', { exact: true })
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.getByText('Parameters', { exact: true })
      ).toBeVisible({ timeout: 10000 });

      // Run/Send button should be present
      const runBtn = page.getByRole('button', { name: /Try It|Run|Send|Execute/i });
      if (await runBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await expect(runBtn).toBeVisible();
      }
    });
  });

  test.describe('Navigation Flow', () => {
    test('settings sidebar navigates to API keys page', async ({ orgAdminPage }) => {
      await orgAdminPage.goto('/settings');
      await expect(
        orgAdminPage.locator('#main-content').getByRole('heading', { name: 'Settings', exact: true })
      ).toBeVisible({ timeout: 10000 });

      // Navigate to API Keys via sidebar or settings link
      const apiKeysLink = orgAdminPage.getByRole('link', { name: /API Keys/i });
      if (await apiKeysLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await apiKeysLink.click();
        await orgAdminPage.waitForURL(/\/settings\/api-keys/, { timeout: 10000 });
        await expectApiKeysPage(orgAdminPage);
      }
    });

    test('full flow: settings -> API keys -> developers', async ({ orgAdminPage }) => {
      // Start at API keys settings
      await orgAdminPage.goto('/settings/api-keys');
      await expectApiKeysPage(orgAdminPage);

      // Navigate to developers page via link
      const devLink = orgAdminPage.getByRole('link', { name: DEVELOPER_OVERVIEW_LINK });
      if (await devLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await devLink.click();
        await orgAdminPage.waitForURL(/\/developers/, { timeout: 10000 });
        await expect(
          orgAdminPage.getByText('Developer Platform')
        ).toBeVisible();
      } else {
        // Navigate directly
        await orgAdminPage.goto('/developers');
        await expect(
          orgAdminPage.getByText('Developer Platform')
        ).toBeVisible({ timeout: 10000 });
      }

      // Navigate to sandbox
      const sandboxLink = orgAdminPage.getByRole('link', { name: /Sandbox|Try it|Playground/i });
      if (await sandboxLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await sandboxLink.click();
        await orgAdminPage.waitForURL(/\/developers\/sandbox/, { timeout: 10000 });
      }
    });
  });
});
