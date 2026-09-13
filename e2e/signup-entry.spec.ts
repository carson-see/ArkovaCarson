/**
 * SCRUM-4031 / UAT-01: public signup must never ask for a retired beta invite.
 * No seeded session or account writes are needed for this entry-point check.
 * The real confirmation-required signup is covered by auth.spec.ts.
 * Run the app with VITE_BETA_INVITE_CODE set to exercise stale deployments.
 */
import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

for (const width of [1280, 375]) {
  test(`signup is immediately available at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/signup');

    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await expect(page.getByLabel('Full name')).toBeVisible();
    await expect(page.getByLabel('Email address')).toBeVisible();
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Confirm password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Google', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'LinkedIn', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
    await expect(page.getByLabel('Invite code')).toHaveCount(0);
    await expect(page.getByText(/closed beta/i)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    // Keyboard navigation follows the same usable form order at both widths.
    await page.getByRole('button', { name: 'Google', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'LinkedIn', exact: true })).toBeFocused();
    for (const label of ['Full name', 'Email address', 'Password', 'Confirm password']) {
      await page.keyboard.press('Tab');
      await expect(page.getByLabel(label, { exact: true })).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeFocused();

    await page.getByLabel('Email address').fill('uat-signup@example.com');
    await page.getByLabel('Password', { exact: true }).fill('valid-password-123');
    await page.getByLabel('Confirm password').fill('different-password-123');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(/Passwords do not match/);
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeEnabled();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    await testInfo.attach(`signup-${width}px`, {
      body: await page.screenshot({ fullPage: true, animations: 'disabled' }),
      contentType: 'image/png',
    });

    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  });
}

/**
 * SCRUM-5024 — a partner link must park the referral code and leave no trace of
 * it in the address bar. `localStorage` is the canonical store (the visitor may
 * finish signing up in a later page load, or after an email round trip), and
 * the parameter is stripped so it cannot ride into a bookmark or a Referer.
 */
for (const width of [1280, 375]) {
  test(`a partner ?ref link is captured and stripped at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/signup?ref=abcd2345&utm_source=partner');

    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();

    // Stripped from the URL, and the unrelated parameter survives.
    expect(new URL(page.url()).searchParams.get('ref')).toBeNull();
    expect(new URL(page.url()).searchParams.get('utm_source')).toBe('partner');

    // Parked, normalised to upper case, under the canonical key.
    const parked = await page.evaluate(() => window.localStorage.getItem('arkova.referral'));
    expect(parked).not.toBeNull();
    expect(JSON.parse(parked as string).code).toBe('ABCD2345');

    // A malformed code is discarded rather than parked — it would only ever
    // come back `unknown_code` from record_org_referral.
    await page.evaluate(() => window.localStorage.removeItem('arkova.referral'));
    await page.goto('/signup?ref=not-a-code');
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('ref')).toBeNull();
    expect(await page.evaluate(() => window.localStorage.getItem('arkova.referral'))).toBeNull();
  });
}
