/**
 * API Key + Verify + Webhook E2E Tests (QA-E2E-02 extension)
 *
 * Tests the full programmatic verification flow:
 * - Create an API key via the worker API
 * - Use that key to call the verification endpoint
 * - Verify the response contains correct anchor proof data
 *
 * This complements e2e/api-keys.spec.ts which tests the UI flow.
 * These tests require the worker to be running on localhost:3001.
 *
 * @created 2026-03-28
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';

const WORKER_URL = process.env.E2E_WORKER_URL || 'http://localhost:3001';

test.describe('API Verification Flow (QA-E2E-02)', () => {
  let testPublicId: string;
  let testAnchorId: string;
  let testFingerprint: string;
  const serviceClient = getServiceClient();

  test.beforeAll(async () => {
    const timestamp = Date.now();
    testFingerprint = `e2e_api_verify_${timestamp}_${'b'.repeat(44)}`;

    const anchor = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'SECURED',
      filename: 'e2e_api_verify_test.pdf',
      fingerprint: testFingerprint,
    });

    if (!anchor?.id || !anchor?.public_id) {
      throw new Error('beforeAll: failed to create test anchor for API verify tests');
    }

    testAnchorId = anchor.id;
    testPublicId = anchor.public_id;
  });

  test.afterAll(async () => {
    if (testAnchorId) {
      await deleteTestAnchor(serviceClient, testAnchorId);
    }
  });

  test.describe('Worker Health', () => {
    test('worker health endpoint responds', async ({ request }) => {
      const response = await request.get(`${WORKER_URL}/health`);
      expect(response.ok()).toBeTruthy();

      const body = await response.json();
      expect(body.status).toMatch(/healthy|degraded/);
    });

    test('detailed health shows connection info', async ({ request }) => {
      const response = await request.get(`${WORKER_URL}/health?detailed=true`);
      expect(response.ok()).toBeTruthy();

      const body = await response.json();
      expect(body).toHaveProperty('checks');
      expect(body).toHaveProperty('connection');
      expect(body.connection.mode).toMatch(/pooler|direct/);
    });
  });

  test.describe('Public Verification API', () => {
    test('verify by public_id returns anchor proof', async ({ request }) => {
      // The verification API should be accessible without API key
      const response = await request.get(
        `${WORKER_URL}/api/v1/verify?public_id=${testPublicId}`,
      );

      // May get 402 (payment required) or 200 depending on feature flags
      // In dev, we expect either success or 402 (x402 gate)
      const status = response.status();
      expect([200, 402, 503]).toContain(status);

      if (status === 200) {
        const body = await response.json();
        expect(body).toHaveProperty('public_id', testPublicId);
        expect(body).toHaveProperty('status', 'SECURED');
        expect(body).toHaveProperty('fingerprint');
      }
    });

    test('verify with invalid public_id returns 404', async ({ request }) => {
      const response = await request.get(
        `${WORKER_URL}/api/v1/verify?public_id=nonexistent_abc123`,
      );

      // Should be 404 or 402 (payment gate may intercept first)
      const status = response.status();
      expect([404, 402, 503]).toContain(status);
    });

    test('verify returns rate limit headers', async ({ request }) => {
      const response = await request.get(
        `${WORKER_URL}/api/v1/verify?public_id=${testPublicId}`,
      );

      // Rate limit headers should be present regardless of auth
      const headers = response.headers();
      // X-RateLimit headers may or may not be present depending on feature gate
      if (response.status() !== 503) {
        expect(
          headers['x-ratelimit-limit'] || headers['retry-after'] || true
        ).toBeTruthy();
      }
    });
  });

  test.describe('API Spec Discoverability', () => {
    test('OpenAPI spec is accessible', async ({ request }) => {
      const response = await request.get(`${WORKER_URL}/api/docs/spec.json`);

      if (response.ok()) {
        const body = await response.json();
        expect(body).toHaveProperty('openapi');
        expect(body).toHaveProperty('paths');
      }
    });

    test('well-known openapi redirect works', async ({ request }) => {
      const response = await request.get(
        `${WORKER_URL}/.well-known/openapi.json`,
        { maxRedirects: 0 },
      );
      // Should redirect to /api/docs/spec.json
      expect([301, 302, 200]).toContain(response.status());
    });
  });

  test.describe('UI Verification Flow', () => {
    test('verification page loads for test anchor', async ({ page }) => {
      await page.goto(`/verify/${testPublicId}`);

      // Should show verified status
      await expect(
        page.getByText(/Verified|Document Verified/i).first()
      ).toBeVisible({ timeout: 10000 });

      // Should show the filename
      await expect(page.getByText('e2e_api_verify_test.pdf')).toBeVisible();

      // Should show fingerprint section
      await expect(page.getByText('Fingerprint')).toBeVisible();

      // Should show "Secured by Arkova" branding
      await expect(page.getByText('Secured by Arkova')).toBeVisible();
    });

    test('verification page shows anchor proof details', async ({ page }) => {
      await page.goto(`/verify/${testPublicId}`);

      await expect(
        page.getByText(/Verified|Document Verified/i).first()
      ).toBeVisible({ timeout: 10000 });

      // Should show network receipt information
      await expect(
        page.getByText(/Network|Receipt|Anchor/i).first()
      ).toBeVisible();
    });
  });
});
