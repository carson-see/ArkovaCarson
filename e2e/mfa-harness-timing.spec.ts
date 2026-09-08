import { test, expect } from '@playwright/test';
import { submitTotpCodeWithBoundaryRetry, waitForMfaManagementOutcome } from './helpers/mfa';

// Browser timing regression tests; these never contact Supabase.
test.use({ storageState: { cookies: [], origins: [] } });
const publicRfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // gitleaks:allow
const fields = { codeTestId: 'code', submitTestId: 'submit', errorTestId: 'error' };

test('submission waits for the asynchronous successful transition', async ({ page }) => {
  await page.setContent(`<form id="form"><input data-testid="code"><button data-testid="submit" type="button"
    onclick="setTimeout(() => document.querySelector('#form').remove(), 300)">Verify</button></form>`);
  await submitTotpCodeWithBoundaryRetry(page, publicRfcSecret, fields);
  expect(await page.getByTestId('code').isVisible()).toBe(false);
});

test('a delayed platform failure fails the probe instead of returning before it arrives', async ({ page }) => {
  await page.setContent(`<input data-testid="code"><button data-testid="submit" type="button"
    onclick="setTimeout(() => document.querySelector('#error').hidden = false, 300)">Verify</button>
    <div id="error" data-testid="error" hidden>Authentication unavailable</div>`);
  await expect(submitTotpCodeWithBoundaryRetry(page, publicRfcSecret, fields)).rejects.toThrow('MFA verification failed');
});

test('management waits for a delayed step-up prompt instead of assuming immediate enrollment', async ({ page }) => {
  await page.setContent(`<div data-testid="twofactor-stepup" hidden>Verify your existing authenticator</div>
    <script>setTimeout(() => document.querySelector('div').hidden = false, 300)</script>`);
  expect(await waitForMfaManagementOutcome(page, 'twofactor-qr')).toBe('stepUp');
});

test('management reports a delayed API error instead of timing out at a missing QR', async ({ page }) => {
  await page.setContent(`<div data-testid="twofactor-error" hidden>Authentication unavailable</div>
    <script>setTimeout(() => document.querySelector('div').hidden = false, 300)</script>`);
  await expect(waitForMfaManagementOutcome(page, 'twofactor-qr')).rejects.toThrow('MFA management failed');
});
