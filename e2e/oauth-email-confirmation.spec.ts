/** Real app UI with mocked external boundaries. Server authority is covered separately
 * by tests/rls/oauth-email-confirmation.test.ts and the native candidate GoTrue fixture.
 * This does not prove Google consent, hosted Auth configuration, or real email receipt.
 * Run: playwright test --config playwright.uat03.config.ts */
import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const email = 'uat03-browser@example.invalid';
type AssuranceLevel = 'aal1' | 'aal2';

function session(role = 'arkova_email_pending', aal: AssuranceLevel = 'aal1') {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return {
    access_token: `${encode({ alg: 'HS256' })}.${encode({ sub: '53bd5736-d4b0-4cde-ac7d-f8df655c9248', session_id: 'uat03-browser-session', role, aal, aud: 'authenticated', exp: now + 3600, iat: now })}.${Buffer.alloc(32).toString('base64url')}`,
    refresh_token: 'owned-browser-fixture-refresh', token_type: 'bearer', expires_at: now + 3600, expires_in: 3600,
    user: { id: '53bd5736-d4b0-4cde-ac7d-f8df655c9248', email, role: 'authenticated', aud: 'authenticated', app_metadata: { provider: 'google' }, user_metadata: {}, email_confirmed_at: new Date().toISOString(), created_at: new Date().toISOString() },
  };
}
async function setup(page: Page, options: { failSend?: boolean; withUser?: boolean; initialRole?: string; initialAal?: AssuranceLevel; completeSession?: boolean } = {}) {
  page.on('pageerror', (error) => console.error('UAT03 browser error:', error.message));
  let current = session(options.initialRole, options.initialAal);
  if (options.withUser !== false) await page.addInitScript((value) => {
    // Seed once: a hard sign-out navigation must not resurrect this fixture.
    if (!sessionStorage.getItem('uat03-seeded')) {
      localStorage.setItem('sb-127-auth-token', JSON.stringify(value));
      sessionStorage.setItem('uat03-seeded', '1');
    }
  }, current);
  let sends = 0; let completes = 0; let sent = false; let profileReads = 0;
  await page.route('http://127.0.0.1:55321/**', async (route) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (route.request().url().includes('/rest/v1/profiles')) {
      profileReads++;
      return route.fulfill({ headers, json: { id: current.user.id, email, role: null, full_name: 'Browser fixture', requires_manual_review: false, disclaimer_accepted_at: new Date().toISOString() } });
    }
    if (route.request().url().includes('/auth/v1/logout')) return route.fulfill({ status: 204, headers });
    if (route.request().url().includes('/auth/v1/user')) return route.fulfill({ headers, json: current.user });
    if (route.request().url().includes('/auth/v1/token')) return route.fulfill({ headers, json: current });
    return route.fulfill({ headers, json: [] });
  });
  await page.route('http://127.0.0.1:55301/**', async (route) => {
    const url = route.request().url();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
    const headers = { 'Access-Control-Allow-Origin': '*' };
    if (url.endsWith('/send')) {
      sends++;
      if (options.failSend && sends === 1) return route.fulfill({ status: 503, headers, json: { error: 'Email delivery is unavailable. Please try again.' } });
      sent = true;
      return route.fulfill({ headers, json: { required: true, sent: true, retryAfterSeconds: 90 } });
    }
    if (url.endsWith('/complete')) {
      completes++;
      if (options.completeSession) current = session('authenticated', 'aal1');
      return route.fulfill({ headers, json: { complete: true, session: options.completeSession ? current : null } });
    }
    if (url.includes('/api/auth/email-confirmation')) return route.fulfill({ headers, json: { required: true, sent, retryAfterSeconds: sent ? 90 : 0 } });
    return route.fulfill({ headers, json: {} });
  });
  return { sends: () => sends, completes: () => completes, profileReads: () => profileReads };
}

test('pending route shows sent/cooldown and fits desktop and mobile', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/signup$/);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByText(/We sent a confirmation link/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Resend in/ })).toBeDisabled();
  expect(calls.sends()).toBe(1);
  expect(calls.profileReads()).toBe(0);
  await mkdir('output/playwright/uat03', { recursive: true });
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('button', { name: "I've confirmed my email" })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `output/playwright/uat03/check-email-${width}.png`, fullPage: true });
  }
});

test('failed email never claims sent and retry reaches sent state', async ({ page }) => {
  const calls = await setup(page, { failSend: true });
  await page.goto('/signup');
  await expect(page.getByRole('alert')).toContainText('Email delivery is unavailable');
  await expect(page.getByText(/We sent a confirmation link/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Resend confirmation email' }).click();
  await expect(page.getByText(/We sent a confirmation link/)).toBeVisible();
  expect(calls.sends()).toBe(2);
});

test('email link is stripped and needs explicit confirmation before account switch', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/signup#token=browser-mailbox-proof&type=oauth_confirmation');
  await expect(page.getByRole('button', { name: 'Confirm email and continue' })).toBeVisible();
  await expect(page).toHaveURL(/\/signup$/);
  expect(calls.completes()).toBe(0);
  await expect(page.getByText(/If another account is open/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm email and continue' }).click();
  await expect(page.getByText('Your email is confirmed. Sign in to continue setting up your account.')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in to continue' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  expect(calls.completes()).toBe(1);
});

test('using another account signs out locally and leaves the proof screen', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/signup#token=browser-mailbox-proof&type=oauth_confirmation');
  await page.getByRole('button', { name: 'Use a different account' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  expect(calls.completes()).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('sb-127-auth-token'))).toBeNull();
});

for (const path of ['/signup', '/login']) {
  test(`post-MFA authenticated ${path} still reaches onboarding`, async ({ page }) => {
    const calls = await setup(page, { initialRole: 'authenticated', initialAal: 'aal2' });
    await page.goto(path);
    await expect(page).toHaveURL(/\/onboarding\/role$/);
    await expect(page.getByRole('heading', { name: 'Welcome to Arkova', level: 3 })).toBeVisible();
    expect(calls.profileReads()).toBeGreaterThan(0);
    expect(calls.sends()).toBe(0);
  });
}

test('confirmed AAL1 token reaches mandatory MFA without reading a profile', async ({ page }) => {
  const calls = await setup(page, { completeSession: true });
  await page.goto('/signup#token=browser-mailbox-proof&type=oauth_confirmation');
  await expect(page.getByRole('button', { name: 'Confirm email and continue' })).toBeVisible();
  expect(calls.profileReads()).toBe(0);
  await page.getByRole('button', { name: 'Confirm email and continue' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId('mfa-enrollment-required')).toBeVisible();
  await expect(page.locator('#main-content')).toBeHidden();
  expect(calls.profileReads()).toBe(0);
});
