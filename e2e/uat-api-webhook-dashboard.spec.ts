/**
 * Exact-component browser qualification for API-key and webhook settings.
 * Auth, Supabase, and worker I/O are stubbed at the network boundary; this
 * proves rendered behavior and geometry, not backend/RLS integration.
 */
import { test, expect, type Page } from "@playwright/test";

const SUPABASE = "http://127.0.0.1:54321";
const WORKER = "http://localhost:3001";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const user = {
  id: USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "admin@uat.arkova.test",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Dashboard Admin" },
  identities: [],
  created_at: "2026-01-01T00:00:00.000Z",
};
const jwtPart = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const accessToken = `${jwtPart({ alg: "none", typ: "JWT" })}.${jwtPart({ sub: USER_ID, role: "authenticated", aal: "aal2", session_id: "uat-session", exp: Math.floor(Date.now() / 1000) + 3600 })}.uat`;
const session = {
  access_token: accessToken,
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: "uat-fake-refresh",
  user,
};
const profile = {
  id: USER_ID,
  email: user.email,
  full_name: "Dashboard Admin",
  role: "ORG_ADMIN",
  org_id: ORG_ID,
  is_platform_admin: false,
  subscription_tier: "organization",
  disclaimer_accepted_at: "2026-01-01T00:00:00.000Z",
};

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  };
}

async function authenticate(page: Page) {
  await page.addInitScript(
    ([key, value]) => localStorage.setItem(key, JSON.stringify(value)),
    ["sb-127-auth-token", session] as const,
  );
}

async function stubBackends(page: Page, endpointReadFails = false) {
  await page.route(`${SUPABASE}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: { "access-control-allow-origin": "*" },
      });
    if (path.startsWith("/auth/v1/user")) return route.fulfill(json(user));
    if (path.startsWith("/auth/v1/token")) return route.fulfill(json(session));
    if (path.startsWith("/auth/v1/")) return route.fulfill(json({}));
    if (path.startsWith("/rest/v1/profiles"))
      return route.fulfill(json(profile));
    if (path.startsWith("/rest/v1/webhook_endpoints"))
      return route.fulfill(
        endpointReadFails
          ? json({ message: "private database detail" }, 500)
          : json([
              {
                id: "ep-1",
                url: "https://receiver.example/webhooks",
                events: ["anchor.secured"],
                is_active: true,
                created_at: "2026-09-01T00:00:00.000Z",
              },
            ]),
      );
    if (path.startsWith("/rest/v1/webhook_delivery_logs"))
      return route.fulfill(json([]));
    if (path.startsWith("/rest/v1/")) return route.fulfill(json([]));
    return route.fulfill(json({}));
  });
  await page.route(`${WORKER}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: { "access-control-allow-origin": "*" },
      });
    if (path === "/api/v1/keys") return route.fulfill(json({ keys: [] }));
    if (path === "/api/v1/usage")
      return route.fulfill(
        json({
          used: 0,
          limit: 1000,
          remaining: 1000,
          reset_date: "2026-10-01T00:00:00.000Z",
          month: "2026-09",
          keys: [],
        }),
      );
    if (path.endsWith("/dlq")) return route.fulfill(json({ entries: [] }));
    if (path === "/api/notifications/unread-count")
      return route.fulfill(json({ count: 0 }));
    return route.fulfill(json({}));
  });
}

// Playwright requires fixture parameters to use an object destructuring pattern.
// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "",
    "Run with uat-api-webhook-dashboard.config.ts only.",
  );
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`${viewport.width}px dashboard`, () => {
    test.use({ viewport });

    test("key capabilities are accurate and fit the viewport", async ({
      page,
    }, testInfo) => {
      await stubBackends(page);
      await authenticate(page);
      await page.goto("/settings/api-keys");
      await page.getByRole("button", { name: "Create API Key" }).click();
      for (const name of [
        "Verify",
        "Batch",
        "Usage",
        "Webhook management",
        "Agent management",
      ])
        await expect(page.getByRole("checkbox", { name })).toBeVisible();
      await expect(
        page.getByRole("checkbox", { name: "Rules admin" }),
      ).toHaveCount(0);
      await expect(page.getByRole("dialog")).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({
        path: testInfo.outputPath(`api-key-scopes-${viewport.width}.png`),
      });
    });

    test("webhook picker disables dark events and fits the viewport", async ({
      page,
    }, testInfo) => {
      await stubBackends(page);
      await authenticate(page);
      await page.goto("/settings/webhooks");
      await page.getByRole("button", { name: "Add Endpoint" }).click();
      await expect(
        page.getByRole("checkbox", { name: /Anchor Secured/i }),
      ).toBeEnabled();
      await expect(
        page.getByRole("checkbox", { name: /Anchor Revocation Confirmed/i }),
      ).toBeEnabled();
      await expect(
        page.getByRole("checkbox", { name: /Attestation Active/i }),
      ).toBeEnabled();
      await expect(
        page.getByRole("checkbox", { name: /Record Verified/i }),
      ).toBeDisabled();
      await expect(
        page.getByRole("checkbox", { name: /Anchor Batch Secured/i }),
      ).toBeDisabled();
      await expect(page.getByRole("dialog")).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({
        path: testInfo.outputPath(`webhook-events-${viewport.width}.png`),
      });
    });

    test("webhook read failure is retryable, generic, and not an empty state", async ({
      page,
    }, testInfo) => {
      await stubBackends(page, true);
      await authenticate(page);
      await page.goto("/settings/webhooks");
      await expect(
        page.getByText(/Unable to load webhook endpoints/),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Try again" }),
      ).toBeVisible();
      await expect(
        page.getByText("No webhook endpoints configured"),
      ).toHaveCount(0);
      await expect(page.getByText(/private database detail/)).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({
        path: testInfo.outputPath(`webhook-error-${viewport.width}.png`),
      });
    });
  });
}
