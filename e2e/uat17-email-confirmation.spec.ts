import { expect, test, type Page, type TestInfo } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });
const fixture = '/e2e/fixtures/uat17-email-confirmation.html';
const email = `${'long.address.'.repeat(4)}member@${'organization'.repeat(4)}.invalid`;

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function assertFitsViewport(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const button = page.getByRole('button', { name: /resend/i });
  const bounds = await button.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
}

for (const width of [1280, 375]) {
  test.describe(`email signup at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.clock.install({ time: new Date('2026-09-14T12:00:00Z') });
    });

    for (const resendFails of [false, true]) {
      test(`resend ${resendFails ? 'failure' : 'success'} preserves truthful controls`, async ({ page }, testInfo) => {
        const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
        await page.route('**/auth/v1/**', async (route) => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          if (request.method() === 'OPTIONS') return route.fulfill({ status: 204 });
          const body = request.postDataJSON() as Record<string, unknown>;
          requests.push({ path, body });
          if (path.endsWith('/signup')) {
            return route.fulfill({ json: {
              id: 'ab731777-516b-4b4c-8fab-99759f6f7651', email,
              confirmation_sent_at: '2026-09-14T12:00:00Z',
              app_metadata: { provider: 'email' }, user_metadata: {}, identities: [],
            } });
          }
          if (path.endsWith('/resend')) {
            return route.fulfill(resendFails
              ? { status: 429, json: { code: 'over_email_send_rate_limit', msg: 'Email rate limit exceeded' } }
              : { status: 200, json: {} });
          }
          throw new Error(`Unexpected Auth request: ${request.method()} ${path}`);
        });

        await page.goto(fixture);
        await page.getByLabel(/email address/i).fill(email);
        await page.getByLabel(/^password$/i).fill('fixture-only-password-0914');
        await page.getByLabel(/confirm password/i).fill('fixture-only-password-0914');
        await page.getByRole('button', { name: /create account/i }).click();
        await expect(page.getByRole('heading', { name: /check your email/i })).toBeVisible();
        await expect(page.getByText(/link expires in 15 minutes/i)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Resend in 90s' })).toBeDisabled();
        await assertFitsViewport(page, width);
        await capture(page, testInfo, `confirmation-${width}`);

        await page.clock.fastForward(90_000);
        await expect(page.getByRole('button', { name: /^resend email$/i })).toBeEnabled();
        // A previous countdown has stopped. Time spent idle must not be added
        // to the next cooldown when a later resend request completes.
        await page.clock.fastForward(30_000);
        await page.getByRole('button', { name: /^resend email$/i }).click();
        if (resendFails) {
          await expect(page.getByRole('alert')).toContainText('could not send a new verification link');
          await expect(page.getByText('A new verification link was sent.')).toHaveCount(0);
        } else {
          await expect(page.getByRole('status')).toHaveText('A new verification link was sent.');
        }
        await expect(page.getByRole('button', { name: 'Resend in 90s' })).toBeDisabled();
        await assertFitsViewport(page, width);
        expect(requests.filter((entry) => entry.path.endsWith('/signup'))).toHaveLength(1);
        const resend = requests.filter((entry) => entry.path.endsWith('/resend'));
        expect(resend).toHaveLength(1);
        expect(resend[0].body).toMatchObject({ email, type: 'signup' });
        expect(resend[0].body).not.toHaveProperty('password');
        await capture(page, testInfo, `resend-${resendFails ? 'error' : 'success'}-${width}`);
      });
    }

    test('invalid callback remains actionable without overflowing', async ({ page }, testInfo) => {
      await page.goto(`${fixture}?view=callback#error=access_denied&error_code=otp_expired`);
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByText(/link has expired/i)).toBeVisible();
      await expect(page.getByRole('link', { name: /new link/i })).toHaveAttribute('href', '/signup');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await capture(page, testInfo, `expired-link-${width}`);
    });

    test('exact-email member add remains click and keyboard actionable', async ({ page }, testInfo) => {
      await page.goto(`${fixture}?view=member`);
      const input = page.getByLabel('Member email');
      const action = page.getByRole('button', { name: 'Add member' });
      await input.fill('member@example.invalid');
      await expect(action).toBeEnabled();
      await action.click();
      await expect(page.getByRole('alert')).toContainText('Failed to add member');
      await input.fill('member@example.invalid');
      await input.press('Enter');
      await expect(page.getByRole('alert')).toContainText('Failed to add member');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await capture(page, testInfo, `member-add-${width}`);
    });
  });
}
