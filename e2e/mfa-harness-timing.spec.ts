import { test, expect, type Page } from '@playwright/test';
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
  // No MFA round trip happened at all here, and the message must say so
  // rather than blaming a verification that never ran. It also quotes what
  // the screen showed, which is the only signal available in that case.
  const failure = await submitTotpCodeWithBoundaryRetry(page, publicRfcSecret, fields).catch((err: Error) => err.message);
  expect(failure).toContain('no rejected /auth/v1/factors/:id/challenge or /verify response was observed');
  expect(failure).toContain('Authentication unavailable');
});

// The three PRs that hit this in CI (#2442/#2485/#2496, 2026-09-08) could not
// be triaged from the logs because the probe threw one generic string and
// dropped the GoTrue `code` it had already parsed. These pin the replacement
// contract: endpoint, HTTP status, GoTrue code, and the on-screen message.
async function stubMfaEndpointRejection(
  page: Page,
  endpoint: 'challenge' | 'verify',
  body: Record<string, unknown>,
  status: number,
) {
  await page.route(`**/auth/v1/factors/*/${endpoint}`, (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
  );
  // Give the page a real origin so the stubbed relative URL resolves and can
  // be intercepted; setContent keeps that origin.
  await page.goto('/');
  await page.setContent(`<input data-testid="code"><button data-testid="submit" type="button"
    onclick="fetch('/auth/v1/factors/abc/${endpoint}', { method: 'POST' })
      .then(() => document.querySelector('#error').hidden = false)">Verify</button>
    <div id="error" data-testid="error" hidden>That code was not accepted</div>`);
}

test('a rejected verify names the endpoint, status, GoTrue code and the on-screen message', async ({ page }) => {
  // Current GoTrue body shape: the string code lives in `code`.
  await stubMfaEndpointRejection(page, 'verify', {
    code: 'mfa_ip_address_mismatch',
    msg: 'Challenge and verify IP addresses mismatch.',
  }, 422);

  const failure = await submitTotpCodeWithBoundaryRetry(page, publicRfcSecret, fields).catch((err: Error) => err.message);
  expect(failure).toContain('MFA verify rejected');
  expect(failure).toContain('HTTP 422');
  expect(failure).toContain('code=mfa_ip_address_mismatch');
  expect(failure).toContain('Challenge and verify IP addresses mismatch.');
  expect(failure).toContain('That code was not accepted');
});

test('a rejected challenge is attributed to challenge(), not to a verification that never ran', async ({ page }) => {
  // Older GoTrue body shape: `code` is the HTTP status and the string code is
  // in `error_code`. The numeric one must never be reported as the code.
  await stubMfaEndpointRejection(page, 'challenge', {
    code: 429,
    error_code: 'over_request_rate_limit',
    msg: 'Request rate limit reached',
  }, 429);

  const failure = await submitTotpCodeWithBoundaryRetry(page, publicRfcSecret, fields).catch((err: Error) => err.message);
  expect(failure).toContain('MFA challenge rejected');
  expect(failure).toContain('code=over_request_rate_limit');
  expect(failure).not.toContain('code=429');
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
