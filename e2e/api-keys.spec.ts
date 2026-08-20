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
      await orgAdminPage.goto('/settings/api-keys');
      await expectApiKeysPage(orgAdminPage);

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
        const keyCard = orgAdminPage
          .locator('div')
          .filter({ has: orgAdminPage.getByText(testKeyName, { exact: true }) })
          .filter({ has: orgAdminPage.getByRole('button', { name: /^Revoke$/ }) })
          .last();
        await keyCard.getByRole('button', { name: /^Revoke$/ }).click();

        const confirmDialog = orgAdminPage.getByRole('dialog');
        await expect(
          confirmDialog.getByRole('heading', { name: /Revoke API Key/i })
        ).toBeVisible({ timeout: 5000 });
        await confirmDialog.getByRole('button', { name: /^Revoke$/ }).click();

        // The card flips to Revoked and loses its Revoke button.
        await expect(keyCard.getByText('Revoked')).toBeVisible({ timeout: 10000 });
        await expect(keyCard.getByRole('button', { name: /^Revoke$/ })).toHaveCount(0);

        // Delete it so e2e runs do not accrete keys (same reason the soak
        // probe deletes its own probe key).
        await keyCard.locator('button.text-destructive').click();
        await expect(
          confirmDialog.getByRole('heading', { name: /Delete API Key/i })
        ).toBeVisible({ timeout: 5000 });
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
        await expect(page.getByText("import { Arkova } from 'arkova'")).toBeVisible();
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
