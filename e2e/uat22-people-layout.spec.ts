/** Real page/CSS regression with synthetic HTTP boundaries; no hosted writes or auth proof. */
import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';

const orgId = '22222222-2222-4222-8222-222222222222';
const userId = '11111111-1111-4111-8111-111111111111';
const supabase = 'http://127.0.0.1:55321';
const worker = 'http://127.0.0.1:55301';

for (const width of [320, 375, 1280]) {
  test(`People actions remain fully visible and operable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const user = { id: userId, email: 'layout@example.invalid', role: 'authenticated', aud: 'authenticated', email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {}, factors: [{ id: 'layout-factor', factor_type: 'totp', status: 'verified' }] };
    const session = { access_token: `${encode({ alg: 'HS256' })}.${encode({ sub: userId, session_id: 'layout-session', role: 'authenticated', aal: 'aal2', exp: now + 3600, iat: now, amr: [{ method: 'totp', timestamp: now }] })}.${Buffer.alloc(32).toString('base64url')}`, refresh_token: 'local-layout-fixture', expires_at: now + 3600, expires_in: 3600, token_type: 'bearer', user };
    await page.addInitScript(value => localStorage.setItem('sb-127-auth-token', JSON.stringify(value)), session);
    const unexpected: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://127.0.0.1:5207') return route.continue();
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
      if (url.origin === 'https://fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
      if (![supabase, worker].includes(url.origin)) { unexpected.push(url.origin); return route.abort(); }
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (url.origin === supabase) {
        if (url.pathname === '/auth/v1/user') return route.fulfill({ headers, json: user });
        if (url.pathname === '/auth/v1/token') return route.fulfill({ headers, json: session });
        if (url.pathname === '/rest/v1/profiles' && url.searchParams.has('id')) return route.fulfill({ headers, json: { id: userId, email: user.email, full_name: 'Layout Admin', role: 'INDIVIDUAL', is_platform_admin: true, org_id: null, requires_manual_review: false, disclaimer_accepted_at: new Date().toISOString() } });
        return route.fulfill({ headers, json: [] });
      }
      if (url.pathname === `/api/admin/organizations/${orgId}`) return route.fulfill({ headers, json: { organization: { id: orgId, display_name: 'Layout Organization', legal_name: 'Layout Organization', verification_status: 'UNVERIFIED', created_at: new Date().toISOString() } } });
      if (url.pathname.endsWith('/members')) return route.fulfill({ headers, json: { members: [1, 2].map(i => ({ id: `member-${i}`, email: `member-${i}@example.invalid`, fullName: `Layout Member ${i}`, role: 'INDIVIDUAL', joinedAt: '2026-09-14T00:00:00.000Z', status: 'active' })) } });
      if (url.pathname.endsWith('/invitations')) return route.fulfill({ headers, json: { invitations: [] } });
      return route.fulfill({ headers, json: {} });
    });
    await page.goto(`/organizations/${orgId}`);
    await expect(page.getByRole('heading', { name: 'Layout Organization', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'People', exact: true }).click();
    for (const name of ['Add Member', 'Invite Member']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const geometry = await button.evaluate(el => {
        const b = el.getBoundingClientRect();
        let left = 0, right = innerWidth;
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          if (['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) {
            const r = parent.getBoundingClientRect(); left = Math.max(left, r.left); right = Math.min(right, r.right);
          }
        }
        const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
        return { clipped: b.left < left - 0.5 || b.right > right + 0.5, hit: !!hit && (el === hit || el.contains(hit)), left: b.left, right: b.right, availableRight: right };
      });
      expect(geometry, `${name} must fit every clipping ancestor`).toMatchObject({ clipped: false, hit: true });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`people-actions-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Invite Member', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Invite Team Member' })).toBeVisible();
    await page.getByLabel('Email address', { exact: true }).fill('recipient@example.invalid');
    await expect(page.getByLabel('Email address', { exact: true })).toBeFocused();
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
