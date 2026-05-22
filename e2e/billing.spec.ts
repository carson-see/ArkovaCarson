/**
 * Billing E2E Tests (QA-E2E-01)
 *
 * Verifies the current dedicated billing overview, checkout result pages,
 * and billing navigation.
 *
 * Stripe test mode — no real charges are made.
 *
 * @created 2026-03-27
 */

import { test, expect, SEED_USERS } from './fixtures';

test.use({ storageState: { cookies: [], origins: [] } });

const mockBillingInfo = {
  plan: {
    name: 'Beta',
    recordsIncluded: 25,
  },
  usage: {
    recordsUsed: 3,
    recordsLimit: 25,
    percentUsed: 12,
  },
  billing: {
    status: 'active',
  },
  status: 'active',
};

async function mockBillingStatus(page: import('@playwright/test').Page) {
  await page.route('**/api/billing/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockBillingInfo),
    });
  });
}

async function mockBillingUnavailable(page: import('@playwright/test').Page) {
  await page.route('**/api/billing/status', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'billing unavailable' }),
    });
  });
}

async function expectBillingOverview(page: import('@playwright/test').Page) {
  await expect(
    page.getByRole('heading', { name: 'Billing & Subscription' })
  ).toBeVisible({ timeout: 10000 });

  await expect(
    page.getByText('Manage your plan, view usage, and update payment methods.')
  ).toBeVisible();

  await expect(
    page.getByRole('heading', { name: 'Current Plan' })
  ).toBeVisible({ timeout: 15000 });
}

async function expectBillingUnavailable(page: import('@playwright/test').Page) {
  await expect(
    page.getByRole('heading', { name: 'Billing & Subscription' })
  ).toBeVisible({ timeout: 10000 });

  await expect(
    page.getByText('Unable to load billing data')
  ).toBeVisible({ timeout: 15000 });

  await expect(
    page.getByText('We could not confirm your billing status. Refresh the page or try again.')
  ).toBeVisible();

  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
}

function userMenuButton(page: import('@playwright/test').Page) {
  return page.locator('header').getByRole('button', { name: /Jamie Demo.*User/i });
}

async function signInAsIndividual(page: import('@playwright/test').Page) {
  await page.goto('/login');

  if (page.url().includes('/login')) {
    await expect(page.getByLabel('Email address')).toBeVisible({ timeout: 10000 });
    await page.getByLabel('Email address').fill(SEED_USERS.individual.email);
    await page.getByLabel('Password').fill(SEED_USERS.individual.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await expect(userMenuButton(page))
    .toBeVisible({ timeout: 10000 });
}

async function openAsIndividual(page: import('@playwright/test').Page, path: string) {
  await signInAsIndividual(page);
  await page.goto(path);
}

test.describe('Billing', () => {
  test.describe('Billing Page', () => {
    test('billing page loads with heading and subtitle', async ({ individualPage }) => {
      await mockBillingStatus(individualPage);
      await openAsIndividual(individualPage, '/billing');

      await expectBillingOverview(individualPage);
    });

    test('current plan details are displayed', async ({ individualPage }) => {
      await mockBillingStatus(individualPage);
      await openAsIndividual(individualPage, '/billing');
      await expectBillingOverview(individualPage);

      await expect(individualPage.getByText('Your subscription details')).toBeVisible();
      await expect(individualPage.getByText('Active')).toBeVisible();
      await expect(individualPage.getByText('Beta')).toBeVisible();
    });

    test('billing action buttons are visible', async ({ individualPage }) => {
      await mockBillingStatus(individualPage);
      await openAsIndividual(individualPage, '/billing');
      await expectBillingOverview(individualPage);

      await expect(individualPage.getByRole('button', { name: /Manage Billing/i })).toBeVisible();
      await expect(individualPage.getByRole('button', { name: /Upgrade Plan/i })).toBeVisible();
    });

    test('usage section shows secured record usage', async ({ individualPage }) => {
      await mockBillingStatus(individualPage);
      await openAsIndividual(individualPage, '/billing');
      await expectBillingOverview(individualPage);

      await expect(individualPage.getByRole('heading', { name: /Monthly Usage/i })).toBeVisible();
      await expect(individualPage.getByText('Records secured')).toBeVisible();
      await expect(individualPage.getByText(/^\d+$/).first()).toBeVisible();
    });

    test('fee account section shows payment method state', async ({ individualPage }) => {
      await mockBillingStatus(individualPage);
      await openAsIndividual(individualPage, '/billing');
      await expectBillingOverview(individualPage);

      await expect(individualPage.getByRole('heading', { name: /Fee Account/i })).toBeVisible();
      await expect(individualPage.getByText('Payment method for subscription billing')).toBeVisible();
      await expect(
        individualPage.getByText(/\*\*\*\* \*\*\*\* \*\*\*\*/)
          .or(individualPage.getByText('No payment method on file.'))
      ).toBeVisible();
    });

    test('billing history section is visible', async ({ individualPage }) => {
      await mockBillingStatus(individualPage);
      await openAsIndividual(individualPage, '/billing');
      await expectBillingOverview(individualPage);

      await expect(individualPage.getByText('Billing History')).toBeVisible();
      await expect(individualPage.getByText('View and download past receipts')).toBeVisible();
      await expect(individualPage.getByRole('button', { name: /View History/i })).toBeVisible();
    });

    test('billing page shows retry state when billing status is unavailable', async ({ individualPage }) => {
      await mockBillingUnavailable(individualPage);
      await openAsIndividual(individualPage, '/billing');

      await expectBillingUnavailable(individualPage);
      await expect(individualPage.getByRole('heading', { name: 'Current Plan' })).not.toBeVisible();
    });
  });

  test.describe('Billing Actions', () => {
    test('Manage Billing button keeps user on billing page when portal is unavailable', async ({ individualPage }) => {
      await mockBillingStatus(individualPage);
      await openAsIndividual(individualPage, '/billing');
      await expectBillingOverview(individualPage);

      await individualPage.getByRole('button', { name: /Manage Billing/i }).click();
      await expect(individualPage).toHaveURL(/\/billing$/);
      await expectBillingOverview(individualPage);
    });

    test('Upgrade Plan button keeps user on billing page when plan comparison is unavailable', async ({ individualPage }) => {
      await mockBillingStatus(individualPage);
      await openAsIndividual(individualPage, '/billing');
      await expectBillingOverview(individualPage);

      await individualPage.getByRole('button', { name: /Upgrade Plan/i }).click();
      await expect(individualPage).toHaveURL(/\/billing$/);
      await expectBillingOverview(individualPage);
    });
  });

  test.describe('Checkout Result Pages', () => {
    test('checkout success page loads with confirmation', async ({ individualPage }) => {
      await openAsIndividual(individualPage, '/billing/success');

      await expect(
        individualPage.getByText('Subscription Activated')
      ).toBeVisible({ timeout: 10000 });

      await expect(
        individualPage.getByRole('link', { name: /Go to Dashboard/i })
      ).toBeVisible();

      await expect(
        individualPage.getByRole('link', { name: /View Billing Details/i })
      ).toBeVisible();
    });

    test('checkout cancel page loads with cancel message', async ({ individualPage }) => {
      await openAsIndividual(individualPage, '/billing/cancel');

      await expect(
        individualPage.getByRole('heading', { name: 'Checkout Cancelled' })
      ).toBeVisible({ timeout: 10000 });

      await expect(
        individualPage.getByRole('link', { name: /Back to Plans/i })
      ).toBeVisible();

      await expect(
        individualPage.getByRole('link', { name: /Go to Dashboard/i })
      ).toBeVisible();
    });

    test('checkout cancel page navigates back to billing', async ({ individualPage }) => {
      await openAsIndividual(individualPage, '/billing/cancel');

      await expect(
        individualPage.getByRole('heading', { name: 'Checkout Cancelled' })
      ).toBeVisible({ timeout: 10000 });

      await Promise.all([
        individualPage.waitForURL(/\/billing/, { timeout: 10000 }),
        individualPage.getByRole('link', { name: /Back to Plans/i }).click(),
      ]);
      await expectBillingUnavailable(individualPage);
    });
  });

  test.describe('Navigation', () => {
    test('header settings menu item navigates to settings page', async ({ individualPage }) => {
      await mockBillingStatus(individualPage);
      await openAsIndividual(individualPage, '/billing');
      await expectBillingOverview(individualPage);

      await userMenuButton(individualPage).click();
      await individualPage.getByRole('menuitem', { name: 'Settings' }).click();

      await expect(individualPage).toHaveURL(/\/settings/, { timeout: 10000 });
    });
  });
});
