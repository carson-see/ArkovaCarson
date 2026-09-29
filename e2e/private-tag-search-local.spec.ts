/** Real page/CSS regression with synthetic HTTP boundaries; no hosted or RLS proof. */
import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';

const userId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const supabase = 'http://127.0.0.1:55321';
const worker = 'http://127.0.0.1:55301';

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== '', 'Runs only with the synthetic Round 3 config.');
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 1200 }]) {
  test(`${viewport.width}px private-tag search debounces, preserves scope, and recovers`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const user = { id: userId, email: 'round3@example.invalid', role: 'authenticated', aud: 'authenticated', email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {}, factors: [{ id: 'round3-factor', factor_type: 'totp', status: 'verified' }] };
    const session = { access_token: `${encode({ alg: 'HS256' })}.${encode({ sub: userId, session_id: 'private-tag-local-session', role: 'authenticated', aal: 'aal2', exp: now + 3600, iat: now, amr: [{ method: 'totp', timestamp: now }] })}.fixture`, refresh_token: 'round3-fixture', expires_at: now + 3600, expires_in: 3600, token_type: 'bearer', user }; // gitleaks:allow — route-mocked local session; no hosted issuer accepts it
    await page.addInitScript(value => localStorage.setItem('sb-127-auth-token', JSON.stringify(value)), session);

    const tagQueries: string[] = [];
    let allowTagQuery = false;
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://127.0.0.1:5213') return route.continue();
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
      if (url.origin === 'https://fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (url.origin === worker) return route.fulfill({ headers, json: {} });
      if (url.origin !== supabase) return route.abort();
      if (url.pathname === '/auth/v1/user') return route.fulfill({ headers, json: user });
      if (url.pathname === '/auth/v1/token') return route.fulfill({ headers, json: session });
      if (url.pathname === '/rest/v1/profiles') return route.fulfill({ headers, json: { id: userId, email: user.email, full_name: 'Round 3 User', role: 'INDIVIDUAL', org_id: orgId, requires_manual_review: false } });
      if (url.pathname === '/rest/v1/org_members') return route.fulfill({ headers, json: [{ id: '44444444-4444-4444-8444-444444444444', org_id: orgId, role: 'member', joined_at: '2026-09-01T00:00:00.000Z' }] });
      if (url.pathname === '/rest/v1/rpc/get_public_org_profiles') return route.fulfill({ headers, json: [{ id: orgId, display_name: 'Example Organization', legal_name: null, domain: null, org_prefix: null }] });
      if (url.pathname === '/rest/v1/anchors' && url.search.includes('anchor_private_tags')) {
        tagQueries.push(url.search);
        if (!allowTagQuery) {
          return route.fulfill({ status: 403, headers, json: { code: '42501', message: 'synthetic unavailable', details: null, hint: null } });
        }
        return route.fulfill({ headers, json: [{
          id: '33333333-3333-4333-8333-333333333333', filename: 'synthetic-audit-record.pdf',
          fingerprint: 'a'.repeat(64), status: 'SECURED', created_at: '2026-09-27T12:00:00.000Z',
          chain_timestamp: '2026-09-27T12:05:00.000Z', file_size: 42, credential_type: null,
          chain_tx_id: null, chain_block_height: null, public_id: 'synthetic-public-id', metadata: {},
          folder_id: null, anchor_private_tags: [{ tag: 'internal-review', normalized_tag: 'internal-review', scope: 'user', owner_user_id: userId, org_id: null }],
        }] });
      }
      return route.fulfill({ headers, json: [] });
    });

    await page.goto('/records');
    const input = page.getByRole('textbox', { name: 'Private tag', exact: true });
    await expect(input).toBeVisible();
    await input.fill('internal');
    await input.fill('internal-review');
    await page.waitForTimeout(200);
    expect(tagQueries).toHaveLength(0);
    await expect.poll(() => tagQueries.length).toBeGreaterThan(0);
    await expect(page.getByText('Private tag results could not be loaded.', { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(tagQueries.length).toBeGreaterThan(0);
    for (const query of tagQueries) {
      expect(query).toContain('anchor_private_tags.normalized_tag=eq.internal-review');
      expect(query).toContain(`anchor_private_tags.owner_user_id=eq.${userId}`);
      expect(query).toContain('anchor_private_tags.org_id=is.null');
    }

    const attemptsBeforeRetry = tagQueries.length;
    allowTagQuery = true;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText('Private tag results could not be loaded.', { exact: true })).toHaveCount(0);
    expect(tagQueries.length).toBeGreaterThan(attemptsBeforeRetry);
    await expect(page.getByText('synthetic-audit-record.pdf', { exact: true })).toBeVisible();
    const scope = page.getByRole('combobox', { name: 'Private tag scope', exact: true });
    await expect(scope).toBeVisible();
    const userQueryCount = tagQueries.length;
    await scope.click();
    await page.getByRole('option', { name: 'Organization tags', exact: true }).click();
    await expect.poll(() => tagQueries.length).toBeGreaterThan(userQueryCount);
    const organizationQuery = tagQueries.at(-1)!;
    expect(organizationQuery).toContain('anchor_private_tags.scope=eq.organization');
    expect(organizationQuery).toContain(`anchor_private_tags.org_id=eq.${orgId}`);
    expect(organizationQuery).not.toContain('anchor_private_tags.owner_user_id');
    await expect(page.getByText('synthetic-audit-record.pdf', { exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Organization tags', exact: true })).toBeHidden();
    await expect(page.getByText('Folder, status, and filename filters apply to the current private-tag page.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator('main').evaluate((element) => { element.scrollTop = 0; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: testInfo.outputPath(`private-tag-${viewport.width}.png`), fullPage: true });
  });
}
