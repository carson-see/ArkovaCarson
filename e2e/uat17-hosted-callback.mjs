// Real hosted Auth callback probe. Secrets arrive only through the process
// environment; no traces, HAR, videos, URLs, or browser state are persisted.
/* global sessionStorage, document, window */
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { URL, URLSearchParams } from 'node:url';

const app = new URL(process.env.UAT17_BROWSER_APP_URL || 'https://invalid.invalid');
const project = process.env.UAT17_BROWSER_PROJECT_REF || '';
const confirmed = process.env.UAT17_BROWSER_CONFIRMED_CALLBACK || '';
const consumed = process.env.UAT17_BROWSER_CONSUMED_CALLBACK || '';
const email = process.env.UAT17_BROWSER_PENDING_EMAIL || '';
const output = resolve('artifacts/uat17-email/hosted-browser');
let browser;
try {
  if (app.protocol !== 'https:' || app.username || app.password || app.port
      || app.pathname !== '/' || app.search || app.hash
      || /(^|\.)arkova\.ai$/.test(app.hostname)
      || !/^[a-z]{20}$/.test(project) || project === 'vzwyaatejekddvltxyye'
      || !/^delivered\+uat17-[a-f0-9]+@resend\.dev$/.test(email)) {
    throw new Error('Invalid isolated browser fixture');
  }
  for (const raw of [confirmed, consumed]) {
    const url = new URL(raw);
    if (url.origin !== app.origin || url.pathname !== '/auth/callback') {
      throw new Error('Unbound callback');
    }
  }
  if (!new URLSearchParams(new URL(confirmed).hash.slice(1)).has('access_token')
      || new URLSearchParams(new URL(consumed).hash.slice(1)).get('error_code') !== 'otp_expired') {
    throw new Error('Missing expected callback state');
  }
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true });
  for (const width of [1280, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    let forbiddenRequest = false;
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if ((/(^|\.)arkova\.ai$/.test(url.hostname)
          || url.hostname.endsWith('.run.app')
          || (url.hostname.endsWith('.supabase.co') && url.hostname !== `${project}.supabase.co`))
          && url.origin !== app.origin) {
        forbiddenRequest = true;
        await route.abort();
        return;
      }
      await route.continue();
    });
    // The API fixture represents signup in this same tab. This hint correlates
    // the consumed-link visit; authoritative getUser still validates identity.
    await context.addInitScript((pendingEmail) => {
      sessionStorage.setItem('arkova_pending_signup_email', pendingEmail);
    }, email);
    const page = await context.newPage();
    await page.goto(confirmed, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const gate = page.getByTestId('mfa-enrollment-required');
    await expect(gate).toBeVisible({ timeout: 45_000 });
    await expect(gate.getByRole('button', { name: 'Verify & continue' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('mfa-enrollment-error')).toHaveCount(0);
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    if (!fits || forbiddenRequest) throw new Error('Hosted layout or target isolation failed');
    // Both the QR and manual TOTP secret are sensitive, including on test users.
    await page.screenshot({ path: resolve(output, `mfa-${width}.png`), fullPage: true,
      mask: [gate.locator('img'), gate.locator('code')] });
    await page.goto(consumed, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(gate).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText('This link has expired')).toHaveCount(0);
    if (forbiddenRequest) throw new Error('Hosted target isolation failed');
    await context.close();
  }
  process.stdout.write(JSON.stringify({ hostedBrowserPassed: true, widths: [1280, 375],
    checks: ['confirmed_callback_requires_mfa', 'consumed_link_returns_to_mfa', 'layout_fits', 'isolated_requests'],
    secretRedaction: 'QR and manual entry masked; no traces or session state' }) + '\n');
} catch {
  // Playwright exceptions may include a URL fragment or page content. Never
  // print the original exception; a failing probe remains a hard failure.
  process.stderr.write('UAT-17 hosted callback browser probe failed; inspect the isolated app and sanitized evidence.\n');
  process.exitCode = 1;
} finally {
  await browser?.close();
}
