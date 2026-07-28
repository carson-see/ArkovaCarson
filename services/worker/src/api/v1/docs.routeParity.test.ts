/**
 * pentest-prep (API contract audit) — served-spec / mounted-route parity.
 *
 * A pen tester enumerates the API from what we publish at
 * `GET /api/docs/spec.json` (served from `openApiSpec` in ./docs.ts, the
 * `Link: </api/docs/spec.json>; rel="service-desc"` header on every v1
 * response, and the `GET /api/v1/openapi.json` 301). If a route is mounted
 * in `router.ts` but absent from `openApiSpec`, the pentester's own map of
 * the surface is wrong from day one.
 *
 * This test dynamically extracts the ACTUAL routes registered on a set of
 * v1 leaf routers (via Express's own `router.stack`, not a hand-transcribed
 * list) and asserts each one is documented in the served spec. It also
 * re-reads `router.ts` to confirm each router is still mounted at the
 * prefix this test assumes — so a prefix change in router.ts fails this
 * test instead of silently invalidating it.
 *
 * SCOPE: covers the routers touched by the pentest-prep audit (the ones
 * that had missing/incorrect spec entries). It is NOT yet wired to every
 * v1 router — extending `MOUNTS` below is the intended path to widen
 * coverage; the extraction + assertion logic is router-agnostic.
 *
 * Modeled on the v2 parity protection (`api/v2/openapi.test.ts`,
 * `api/v2/mcpParity.test.ts`), adapted for v1's plain-object TS spec.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Route module graphs under test import `config.js` (directly or via
// `utils/db.js`), which validates required env vars eagerly at module load
// (`export const config = loadConfig()`). This test only inspects router
// `.stack` shapes — it never calls a handler or touches the DB/config
// values — so a minimal stub is enough (same pattern as the sibling
// `*.test.ts` files in this directory, e.g. attestations.test.ts).
vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../../config.js', () => ({
  config: { bitcoinNetwork: 'signet', frontendUrl: 'https://app.arkova.ai' },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { Router } from 'express';
import { openApiSpec } from './docs.js';
import { verifyProofRouter } from './verify-proof.js';
import { attestationsRouter } from './attestations.js';
import { webhooksRouter } from './webhooks.js';
import { cleVerifyRouter } from './cle-verify.js';
import { aiReviewRouter } from './ai-review.js';
import { aiIntegrityRouter } from './ai-integrity.js';
import { aiEmbedRouter } from './ai-embed.js';
import { aiFeedbackRouter } from './ai-feedback.js';

type ExpressMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface RouteLayer {
  route?: {
    path: string;
    methods: Partial<Record<ExpressMethod, boolean>>;
  };
}

interface MountedRoute {
  method: ExpressMethod;
  expressPath: string;
}

/** Reads the routes a router itself owns — no mount-prefix guessing needed,
 *  this is the router's own `.stack`, which Express populates directly from
 *  `router.get(...)`/`router.post(...)` etc. calls. The express-types Router
 *  shape doesn't structurally match our minimal `RouteLayer` view (it's a
 *  much richer internal type), so this narrows via `unknown` rather than
 *  forcing every call site to fight the express-types generics. */
function extractOwnRoutes(router: Router): MountedRoute[] {
  const stack = (router as unknown as { stack: RouteLayer[] }).stack;
  const routes: MountedRoute[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods) as ExpressMethod[]) {
      if (layer.route.methods[method]) {
        routes.push({ method, expressPath: layer.route.path });
      }
    }
  }
  return routes;
}

/** Express `:param` segments become OpenAPI `{param}` segments. */
function toOpenApiPath(expressPath: string): string {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function toFullPath(prefix: string, expressPath: string): string {
  return expressPath === '/' ? prefix : `${prefix}${expressPath}`;
}

const routerTsSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'router.ts'),
  'utf-8',
);

/**
 * Confirms `router.ts` still mounts `varName` at `prefix`, so a mount-path
 * change can't silently desync this test's assumptions from reality.
 */
function assertStillMountedAt(varName: string, prefix: string): void {
  const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mountRe = new RegExp(`router\\.use\\(\\s*['"\`]${escapedPrefix}['"\`][^;]*\\b${varName}\\b`);
  expect(
    mountRe.test(routerTsSource),
    `router.ts no longer appears to mount ${varName} at '${prefix}' — update the MOUNTS table in docs.routeParity.test.ts to match the real mount point.`,
  ).toBe(true);
}

interface MountEntry {
  varName: string;
  router: Router;
  prefix: string;
}

const MOUNTS: MountEntry[] = [
  { varName: 'verifyProofRouter', router: verifyProofRouter, prefix: '/verify' },
  { varName: 'attestationsRouter', router: attestationsRouter, prefix: '/attestations' },
  { varName: 'webhooksRouter', router: webhooksRouter, prefix: '/webhooks' },
  { varName: 'cleVerifyRouter', router: cleVerifyRouter, prefix: '/cle' },
  { varName: 'aiReviewRouter', router: aiReviewRouter, prefix: '/ai/review' },
  { varName: 'aiIntegrityRouter', router: aiIntegrityRouter, prefix: '/ai/integrity' },
  { varName: 'aiEmbedRouter', router: aiEmbedRouter, prefix: '/ai/embed' },
  { varName: 'aiFeedbackRouter', router: aiFeedbackRouter, prefix: '/ai/feedback' },
];

describe('served v1 OpenAPI spec — mounted route parity (pentest-prep)', () => {
  it.each(MOUNTS)('every route mounted under $prefix ($varName) is documented in openApiSpec', ({ varName, router, prefix }) => {
    assertStillMountedAt(varName, prefix);

    const routes = extractOwnRoutes(router);
    // A router with zero routes extracted means the stack-walk itself broke
    // (e.g. Express internals changed shape) — fail loud, not silently green.
    expect(routes.length).toBeGreaterThan(0);

    for (const { method, expressPath } of routes) {
      const fullPath = toFullPath(prefix, expressPath);
      const openApiPath = toOpenApiPath(fullPath);
      const operation = openApiSpec.paths[openApiPath]?.[method];
      expect(
        operation,
        `${method.toUpperCase()} ${openApiPath} is mounted (router.ts: ${varName}) but missing from openApiSpec.paths — a pen tester enumerating from /api/docs/spec.json would never find it.`,
      ).toBeDefined();
    }
  });
});
